/**
 * DSH (DeepSeek Harness) normalizer.
 *
 * Honors the facts that make DSH the richest source:
 *  - EXPLICIT `turn/start|end` and `step/start|end` (boundaryConfidence = 'explicit')
 *  - `seq` is dense and gap-free; it is the authoritative order
 *  - `surfaceOp:'replace'` shadows a seq range but we KEEP the records (flagged)
 *  - unknown event types are REFUSED unless `ignorable === true` (risk #12)
 *  - `assistant/message` carries plaintext reasoning chunks and per-record usage
 */
import type {
  Diagnostic, NormRecord, NormSession, NormStep, NormTurn, NormUsage, RecordFlag, SessionRef, RawLine,
} from '../types.ts';
import { DSH_CAPABILITIES } from '../sources/dsh.ts';
import { parseLine } from '../sources/stableRead.ts';

const iso = (t?: string): number | undefined => (typeof t === 'number' ? t : t ? Date.parse(t) : undefined);

export interface DshRefusal { sessionId: string; type: string; seq: number; }

/**
 * Header versions we know how to read, ascending.
 *
 * Measured across every session in this machine's ~/.dsh: version 0 (30 sessions,
 * legacy), version 3 (7) and version 4 (4). The current checkout's writer constant is
 * SESSION_FORMAT_VERSION = 3 (deepseek-harness packages/core/session/src/types.ts:88),
 * yet version 4 logs already exist on disk — so "the writer constant" and "the highest
 * version you will find in the wild" are NOT the same thing. Both facts matter.
 *
 * Anything outside this list is refused rather than silently mis-parsed (R5).
 */
export const SUPPORTED_DSH_VERSIONS = [0, 1, 2, 3, 4];

export function normalizeDsh(
  ref: SessionRef, lines: RawLine[], refusals?: DshRefusal[],
): NormSession {
  const diag: Diagnostic = {
    badLineCount: 0, unknownTypeCount: 0, unresolvedCallCount: 0, shadowedCount: 0,
    reopened: false, ttftMissingCount: 0, usageMissingCount: 0, parseErrors: [],
  };

  const events: any[] = [];
  let header: any;
  for (const l of lines) {
    const o = parseLine(l);
    if (!o) {
      if (l.parseError !== undefined) {
        diag.badLineCount++;
        if (diag.parseErrors.length < 20) {
          diag.parseErrors.push({ lineNo: l.lineNo, message: l.parseError, snippet: l.text.slice(0, 200) });
        }
      }
      continue;
    }
    if (o.type === 'session' && !header) {
      header = o;
      // R5: route on the PARSED header version, never the filename, and refuse a version
      // we do not understand rather than silently mis-parsing it.
      if (typeof header.version === 'number' && !SUPPORTED_DSH_VERSIONS.includes(header.version)) {
        refusals?.push({ sessionId: ref.sessionId, type: 'session/unsupported-version', seq: -1 });
        diag.unknownTypeCount++;
      }
      continue;
    }
    if (typeof o.seq === 'number') events.push(o);
  }

  events.sort((a, b) => a.seq - b.seq); // authoritative order
  const capabilities = { ...DSH_CAPABILITIES, ordering: 'seq' as const };

  const known = new Set([
    'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'developer/message',
    'system/message', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result',
    'request/header', 'request/context', 'compaction/start', 'compaction/summary', 'compaction/prune',
    'compaction/end', 'subagent/descriptor', 'subagent/catalog', 'hook/invoked', 'hook/result',
    'llm/retry-started', 'llm/retry', 'image/offload', 'agent/inbox/spliced', 'session/title',
    'session/end-seed', 'session/notification', 'command/run', 'command/done',
    'reasoning-chunks', 'text-chunks', 'tool-call-chunks', 'assistant/chunk',
    'sandbox/mode', 'approval/policy', 'permission/preset', 'session/title-llm-request',
    'web/deepseek-search-llm-request', 'queue/message', 'model/changed',
    // Measured on this machine's logs; previously unknown and therefore refused.
    'todo/write', 'model/selection', 'deliverables/presented',
    'approval/asked', 'approval/decided',
  ]);

  // Shadowing arrives two ways and BOTH must be honored:
  //   1. `surfaceOp: {op:'replace', startSeq, endSeq}` on the event envelope
  //   2. compaction events carrying `shadowedSeqs` / `shadowedRange` in their data
  // In both cases the records are KEPT and merely flagged; nothing is dropped.
  const shadowed = new Set<number>();
  for (const e of events) {
    const op = e.surfaceOp;
    if (op && typeof op === 'object' && op.op === 'replace') {
      for (let s = op.startSeq; s <= op.endSeq; s++) shadowed.add(s);
    }
    const d = e.data ?? {};
    if (Array.isArray(d.shadowedSeqs)) for (const s of d.shadowedSeqs) shadowed.add(Number(s));
    if (d.shadowedRange && typeof d.shadowedRange === 'object') {
      const r = d.shadowedRange;
      const from = r.startSeq ?? r.from ?? r.start;
      const to = r.endSeq ?? r.to ?? r.end;
      if (Number.isFinite(from) && Number.isFinite(to)) for (let s = from; s <= to; s++) shadowed.add(s);
    }
  }

  const turns: NormTurn[] = [];
  const steps: NormStep[] = [];
  const records: NormRecord[] = [];
  const turnByNum = new Map<number, number>();
  const stepByKey = new Map<string, number>();
  const toolByCallId = new Map<string, NormRecord>();

  let currentTurn = -1;
  let currentStep = -1;
  let startedAt = iso(header?.createdAt);
  let endedAt: number | undefined;
  const turnUsage = new Map<number, NormUsage>();

  const openTurn = (turnNum: number | undefined, ts?: number) => {
    currentTurn = turns.length;
    turns.push({ turnIndex: currentTurn, sourceTurnId: turnNum != null ? String(turnNum) : undefined,
      boundaryConfidence: 'explicit', startedAt: ts, durationMs: null, ttftMs: null });
    if (turnNum != null) turnByNum.set(turnNum, currentTurn);
    // P2: leave unknown usage undefined instead of seeding zeros.
    turnUsage.set(currentTurn, { scope: 'turn', cacheSemantics: capabilities.cacheSemantics,
      crossSourceComparable: false });
    return currentTurn;
  };
  const openStep = (key: string, ts?: number) => {
    currentStep = steps.length;
    steps.push({ stepIndex: currentStep, turnIndex: Math.max(currentTurn, 0),
      boundaryConfidence: 'explicit', startedAt: ts, ttftMs: null, decodeMs: null });
    stepByKey.set(key, currentStep);
    return currentStep;
  };
  const flagsFor = (seq: number): RecordFlag[] => (shadowed.has(seq) ? ['shadowed'] : []);

  let idSeq = 0;
  const rid = (base: string) => base + '::' + (idSeq++);

  for (const e of events) {
    const type = e.type as string;
    const data = e.data ?? {};
    const ts = iso(e.time);
    const seq = e.seq as number;

    if (!known.has(type)) {
      if (e.ignorable === true) { diag.unknownTypeCount++; continue; }
      diag.unknownTypeCount++;
      refusals?.push({ sessionId: ref.sessionId, type, seq });
      continue;
    }

    switch (type) {
      case 'turn/start': {
        openTurn(data.turn, ts);
        break;
      }
      case 'turn/end': {
        const t = turnByNum.get(data.turn) ?? Math.max(currentTurn, 0);
        const turn = turns[t];
        if (turn) {
          turn.endedAt = ts;
          if (turn.startedAt && ts) turn.durationMs = ts - turn.startedAt;
          turn.endReason = data.reason ?? 'completed';
        }
        endedAt = ts ?? endedAt;
        const acc = turnUsage.get(t);
        const hasUsage = acc?.totalTokens != null;
        if (!hasUsage) diag.usageMissingCount++;
        records.push({ recordId: rid('turn-end:' + t), kind: 'turn-end', orderIndex: seq, turnIndex: t,
          text: 'turn ' + t + ' ' + reasonLabel(data.reason),
          timeSeconds: turn?.durationMs != null ? turn.durationMs / 1000 : null,
          startedAt: ts, usage: hasUsage ? acc : undefined, flags: flagsFor(seq) });
        break;
      }
      case 'step/start': {
        const key = data.turn + ':' + data.step;
        openStep(key, ts);
        break;
      }
      case 'step/end': {
        const key = data.turn + ':' + data.step;
        const idx = stepByKey.get(key) ?? Math.max(currentStep, 0);
        const step = steps[idx];
        if (step) {
          step.endedAt = ts;
          if (step.startedAt && ts) {
            const total = ts - step.startedAt;
            if (step.ttftMs != null) step.decodeMs = Math.max(0, total - step.ttftMs);
          }
        }
        break;
      }
      case 'user/message':
      case 'developer/message':
      case 'system/message': {
        const t = currentTurn < 0 ? openTurn(data.turn, ts) : currentTurn;
        const text = messageText(data.message);
        records.push({ recordId: rid(type + ':' + seq), kind: type === 'user/message' ? 'user' : 'context',
          orderIndex: seq, turnIndex: t, stepIndex: currentStep, opensTurn: type === 'user/message',
          text: firstLine(text), detailText: text, timeSeconds: null, startedAt: ts, flags: flagsFor(seq) });
        break;
      }
      case 'assistant/message': {
        const t = currentTurn < 0 ? openTurn(data.turn, ts) : currentTurn;
        const stepIdx = currentStep < 0 ? openStep(String(t) + ':auto', ts) : currentStep;
        const message = data.message ?? {};
        const blocks: any[] = Array.isArray(message.content) ? message.content : [];
        let text = '';
        let thinking = '';
        for (const b of blocks) {
          if (b.type === 'thinking' || b.type === 'reasoning') thinking += (b.thinking ?? b.text ?? '') + '\n';
          else if (b.type === 'text') text += (b.text ?? '') + '\n';
        }
        // token-level stream: derive first token time + throughput
        const stream: any[] = Array.isArray(data.stream) ? data.stream : [];
        let ttft: number | undefined;
        let chunkCount = 0;
        for (const s of stream) {
          if (s.type === 'chunk') { ttft ??= iso(s.time); chunkCount++; continue; }
          const t0 = iso(s.time0);
          if (t0 != null && chunkCount === 0) ttft = t0;
          chunkCount += Array.isArray(s.dt) ? s.dt.length : 0;
        }
        const step = steps[stepIdx];
        if (step) {
          if (ttft != null && step.ttftMs == null) step.ttftMs = Math.max(0, ttft - (step.startedAt ?? ttft));
          if (thinking) step.reasoning = { availability: 'plaintext', text: thinking.trim() };
        }
        const usage: NormUsage | undefined = data.usage ? {
          inputTokens: data.usage.inputTokens, cachedInputTokens: data.usage.cacheReadTokens,
          cacheWriteInputTokens: data.usage.cacheWriteTokens, outputTokens: data.usage.outputTokens,
          reasoningTokens: data.usage.reasoningTokens, totalTokens: data.usage.totalTokens,
          scope: 'record', cacheSemantics: capabilities.cacheSemantics, crossSourceComparable: false,
        } : undefined;
        if (usage && step) step.usage = usage;
        if (usage) {
          const acc = turnUsage.get(t);
          if (acc) {
            acc.inputTokens = (acc.inputTokens ?? 0) + (usage.inputTokens ?? 0);
            acc.cachedInputTokens = (acc.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
            acc.outputTokens = (acc.outputTokens ?? 0) + (usage.outputTokens ?? 0);
            acc.reasoningTokens = (acc.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
            acc.totalTokens = (acc.totalTokens ?? 0) + (usage.totalTokens ?? 0);
          }
        } else diag.usageMissingCount++;
        if (thinking) {
          records.push({ recordId: rid('think:' + seq), kind: 'context', orderIndex: seq, turnIndex: t,
            stepIndex: stepIdx, text: firstLine(thinking), detailText: thinking.trim(),
            timeSeconds: null, startedAt: ts, flags: flagsFor(seq) });
        }
        if (text.trim()) {
          records.push({ recordId: rid('asst:' + seq), kind: 'message', orderIndex: seq, turnIndex: t,
            stepIndex: stepIdx, text: firstLine(text), detailText: text.trim(), timeSeconds: null,
            startedAt: ts, usage, flags: flagsFor(seq) });
        }
        break;
      }
      case 'tool/call': {
        const t = currentTurn < 0 ? openTurn(data.turn, ts) : currentTurn;
        const inputRaw = typeof data.arguments === 'string' ? data.arguments : safeJson(data.arguments);
        const rec: NormRecord = {
          recordId: rid('tool:' + data.callId), kind: 'tool', orderIndex: seq, turnIndex: t,
          stepIndex: currentStep, text: data.name + '(' + truncate(inputRaw, 80) + ')',
          detailText: inputRaw, toolName: data.name, callId: data.callId, timeSeconds: null, startedAt: ts,
          tool: { callId: data.callId, name: data.name, inputRaw, startedAt: ts, durationMs: null, depth: 0 },
          flags: flagsFor(seq),
        };
        records.push(rec);
        if (data.callId) toolByCallId.set(String(data.callId), rec);
        break;
      }
      case 'tool/result': {
        const msg = data.message ?? {};
        const src = msg.source ?? {};
        const callId = src.callId != null ? String(src.callId) : undefined;
        const rec = callId ? toolByCallId.get(callId) : undefined;
        const content = stringify(msg.content);
        const err = data.error;
        if (rec && rec.tool) {
          rec.tool.outputText = content;
          rec.tool.endedAt = ts;
          rec.tool.isError = err ? true : undefined;
          if (rec.tool.startedAt && ts) rec.tool.durationMs = (ts - rec.tool.startedAt) / 1000;
          rec.timeSeconds = rec.tool.durationMs ?? null;
          rec.isError = err ? true : undefined;
          rec.errorName = err?.name;
          rec.detailText = rec.detailText ? rec.detailText + '\n\n-- output --\n' + content : content;
          if (err) rec.flags.push('partial');
        } else {
          diag.unresolvedCallCount++;
          records.push({ recordId: rid('toolout:' + seq), kind: 'tool', orderIndex: seq,
            turnIndex: Math.max(currentTurn, 0), text: 'unmatched tool/result',
            detailText: content, callId, timeSeconds: null, startedAt: ts, flags: ['unresolved-output'] });
        }
        break;
      }
      case 'request/context': {
        // DSH-side model identity (the only source when Codex itself writes nothing).
        if (currentStep >= 0 && typeof data.model === 'string') steps[currentStep].model = data.model;
        break;
      }
      case 'model/selection': {
        if (typeof data.model === 'string') {
          if (currentStep >= 0) steps[currentStep].model = data.model;
          else if (steps.length === 0) { const s = openStep('auto', ts); steps[s].model = data.model; }
        }
        records.push({ recordId: rid('model:' + seq), kind: 'system', orderIndex: seq,
          turnIndex: Math.max(currentTurn, 0), stepIndex: currentStep,
          text: 'model -> ' + (data.model ?? '?') + ' (' + (data.provider ?? '?') + ')',
          timeSeconds: null, startedAt: ts, flags: flagsFor(seq) });
        break;
      }
      case 'todo/write': {
        const todos = Array.isArray(data.todos) ? data.todos : [];
        const text = todos.map((x: any) => (x.status ?? '?') + ' ' + (x.content ?? '')).join('\n');
        records.push({ recordId: rid('todo:' + seq), kind: 'context', orderIndex: seq,
          turnIndex: Math.max(currentTurn, 0), stepIndex: currentStep,
          text: 'todos (' + todos.length + '): ' + firstLine(text),
          detailText: text || safeJson(data), timeSeconds: null, startedAt: ts, flags: flagsFor(seq) });
        break;
      }
      case 'approval/asked': {
        records.push({ recordId: rid('approval:' + seq), kind: 'system', orderIndex: seq,
          turnIndex: Math.max(currentTurn, 0), stepIndex: currentStep,
          text: 'approval requested: ' + (data.toolName ?? '?'),
          detailText: safeJson(data), timeSeconds: null, startedAt: ts, flags: flagsFor(seq) });
        break;
      }
      case 'approval/decided': {
        records.push({ recordId: rid('approval:' + seq), kind: 'system', orderIndex: seq,
          turnIndex: Math.max(currentTurn, 0), stepIndex: currentStep,
          text: 'approval ' + (data.outcome ?? '?'),
          detailText: safeJson(data), timeSeconds: null, startedAt: ts, flags: flagsFor(seq) });
        break;
      }
      case 'deliverables/presented': {
        records.push({ recordId: rid('deliv:' + seq), kind: 'system', orderIndex: seq,
          turnIndex: Math.max(currentTurn, 0), stepIndex: currentStep,
          text: 'deliverables presented (' + (Array.isArray(data.files) ? data.files.length : 0) + ')',
          detailText: safeJson(data), timeSeconds: null, startedAt: ts, flags: flagsFor(seq) });
        break;
      }
      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/prune': {
        records.push({ recordId: rid(type + ':' + seq), kind: 'compacted', orderIndex: seq,
          turnIndex: Math.max(currentTurn, 0), text: type.replace('compaction/', '') +
          (data.shadowedSeqs ? ' (' + data.shadowedSeqs + ' seq shadowed)' : ''),
          timeSeconds: null, startedAt: ts, flags: flagsFor(seq) });
        diag.shadowedCount += Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0;
        break;
      }
      case 'request/header': {
        records.push({ recordId: rid('req:' + seq), kind: 'request-header', orderIndex: seq,
          turnIndex: Math.max(currentTurn, 0), stepIndex: currentStep,
          text: 'request header (' + (data.reason ?? '') + ')',
          detailText: data.header ? safeJson(data.header.config ?? data.header) : undefined,
          timeSeconds: null, startedAt: ts, flags: flagsFor(seq) });
        break;
      }
      case 'subagent/descriptor': {
        records.push({ recordId: rid('sub:' + seq), kind: 'system', orderIndex: seq,
          turnIndex: Math.max(currentTurn, 0),
          text: 'subagent ' + (data.agentName ?? data.name ?? '?'),
          detailText: safeJson(data), timeSeconds: null, startedAt: ts, flags: flagsFor(seq) });
        break;
      }
      default:
        break;
    }
  }

  for (const rec of records) {
    if (rec.kind === 'tool' && rec.callId && rec.tool && !rec.tool.outputText) {
      rec.tool.unresolved = true; rec.flags.push('unresolved-call'); diag.unresolvedCallCount++;
    }
  }
  const open = turns.find((t) => !t.endReason);
  if (open) open.endReason = 'interrupted';

  return {
    source: 'dsh', sessionId: ref.sessionId, cwd: header?.cwd ?? ref.cwd, cliVersion: undefined,
    capabilities, startedAt, endedAt, turns, steps, records, diagnostics: diag,
  };
}

/** Extract human-readable text from a DSH message envelope ({role, content[]}). */
function messageText(message: any): string {
  if (message == null) return '';
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map(messageText).filter(Boolean).join('\n');
  if (Array.isArray(message.content)) return message.content.map(messageText).filter(Boolean).join('\n');
  if (typeof message.text === 'string') return message.text;
  if (typeof message.thinking === 'string') return message.thinking;
  return safeJson(message);
}

/** turn/end `reason` may be a string or a structured object. */
function reasonLabel(r: any): string {
  if (r == null) return 'completed';
  if (typeof r === 'string') return r;
  if (typeof r === 'object') return r.kind ?? r.type ?? r.code ?? safeJson(r);
  return String(r);
}

function firstLine(s: string, max = 160): string {
  const t = (s ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? '';
  return t.length > max ? t.slice(0, max) + '\u2026' : t;
}
function truncate(s: string, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '\u2026' : t;
}
function safeJson(v: unknown): string { try { return typeof v === 'string' ? v : (JSON.stringify(v) ?? ''); } catch { return ''; } }
function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? (x.text ?? stringify(x)) : String(x))).join('\n');
  if (typeof v === 'object' && 'text' in (v as any)) return String((v as any).text);
  return safeJson(v);
}
