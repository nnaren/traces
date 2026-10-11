/**
 * Codex normalizer.
 *
 * Consumes BOTH layers (response_item + event_msg) - reading only one loses half
 * the information (risk #2). Resolves the per-session effective ordering (R1),
 * pairs tool calls by `call_id`, and never discards orphans.
 */
import type {
  Diagnostic, NormRecord, NormSession, NormStep, NormTurn, NormUsage, RecordFlag, SessionRef, RawLine,
  SourceCapabilities,
} from '../types.ts';
import { CODEX_CAPABILITIES } from '../sources/codex.ts';
import { parseLine } from '../sources/stableRead.ts';

const iso = (t?: string): number | undefined => (t ? Date.parse(t) : undefined);

interface Pending { raw: RawLine; obj: any; }

export function normalizeCodex(ref: SessionRef, lines: RawLine[]): NormSession {
  const diag: Diagnostic = {
    badLineCount: 0, unknownTypeCount: 0, unresolvedCallCount: 0, shadowedCount: 0,
    reopened: false, ttftMissingCount: 0, usageMissingCount: 0, parseErrors: [],
  };

  const pending: Pending[] = [];
  let hasOrdinal = false;
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
    if (typeof o.ordinal === 'number') hasOrdinal = true;
    if (['event_msg', 'response_item', 'turn_context', 'session_meta', 'token_usage_record',
      'world_state', 'inter_agent_communication_metadata'].includes(o.type)) {
      pending.push({ raw: l, obj: o });
    } else {
      // Never silently swallow a type we do not understand.
      diag.unknownTypeCount++;
    }
  }

  // R1: effective ordering resolved once per session.
  const ordering: SourceCapabilities['ordering'] = hasOrdinal ? 'ordinal' : 'physical-line-order';
  const capabilities: SourceCapabilities = { ...CODEX_CAPABILITIES, ordering };

  const turns: NormTurn[] = [];
  const steps: NormStep[] = [];
  const records: NormRecord[] = [];
  const toolByCallId = new Map<string, NormRecord>();
  // Reasoning item ids already emitted, so the two Codex layers don't duplicate them.
  const seenReasoning = new Set<string>();
  const usageByTurn = new Map<number, NormUsage>();

  let currentTurn = -1;
  let currentStep = -1;
  let cwd: string | undefined = ref.cwd;
  let cliVersion = ref.cliVersion;
  let startedAt = ref.startedAt;
  let endedAt: number | undefined;
  let prevWasToolOutput = false;

  const openTurn = (turnId: string | undefined, ts: number | undefined) => {
    currentTurn = turns.length;
    turns.push({
      turnIndex: currentTurn, sourceTurnId: turnId, boundaryConfidence: 'derived',
      startedAt: ts, durationMs: null, ttftMs: null,
    });
    // P2: start UNKNOWN, not zero. A turn with no usage must stay null so the UI
    // renders an em dash instead of a fabricated 0.
    usageByTurn.set(currentTurn, {
      scope: 'turn', cacheSemantics: capabilities.cacheSemantics, crossSourceComparable: false,
    });
    return currentTurn;
  };

  /**
   * Codex marks turn boundaries with a `turn_id` on task_started / turn_context /
   * task_complete. A NEW turn_id therefore means a NEW turn — reusing the previous
   * one would collapse a whole multi-turn session into a single turn.
   */
  const ensureTurn = (turnId?: string, ts?: number) => {
    const current = currentTurn >= 0 ? turns[currentTurn] : undefined;
    if (currentTurn < 0) return openTurn(turnId, ts);
    if (turnId !== undefined && current?.sourceTurnId !== undefined && current.sourceTurnId !== turnId) {
      return openTurn(turnId, ts);
    }
    if (turnId !== undefined && currentTurn >= 0 && turns[currentTurn].sourceTurnId === undefined) {
      turns[currentTurn].sourceTurnId = turnId;
    }
    return currentTurn;
  };

  const openStep = (ts?: number) => {
    currentStep = steps.length;
    steps.push({
      stepIndex: currentStep, turnIndex: Math.max(currentTurn, 0), boundaryConfidence: 'derived',
      startedAt: ts, ttftMs: null, decodeMs: null,
    });
    return currentStep;
  };

  // recordIds must be unique within a session even when a source reuses ids.
  let idSeq = 0;
  const rid = (base: string) => base + '::' + (idSeq++);

  const orderOf = (p: Pending): number => (typeof p.obj.ordinal === 'number' ? p.obj.ordinal : p.raw.lineNo);

  for (const p of pending) {
    const o = p.obj;
    const ts = iso(o.timestamp);
    const ptype = o.payload?.type;
    const payload = o.payload ?? {};

    if (o.type === 'session_meta') {
      cwd ??= payload.cwd; cliVersion ??= payload.cli_version; startedAt ??= iso(payload.timestamp);
      continue;
    }
    if (o.type === 'turn_context') {
      if (typeof payload.model === 'string') {
        if (steps[currentStep]) steps[currentStep].model = payload.model;
        else steps[openStep(ts)].model = payload.model;
      }
      ensureTurn(payload.turn_id, ts);
      continue;
    }
    if (o.type === 'token_usage_record') {
      const u = payload.usage ?? {};
      const step = steps[currentStep];
      if (step) {
        step.usage = {
          inputTokens: u.input_tokens, cachedInputTokens: u.cached_input_tokens,
          cacheWriteInputTokens: u.cache_write_input_tokens, outputTokens: u.output_tokens,
          reasoningTokens: u.reasoning_output_tokens, totalTokens: u.total_tokens,
          scope: 'per-response', cacheSemantics: capabilities.cacheSemantics, crossSourceComparable: false,
        };
      }
      continue;
    }
    if (o.type === 'event_msg') {
      switch (ptype) {
        case 'task_started': ensureTurn(payload.turn_id, ts); break;
        case 'token_count': {
          // `last_token_usage` is already a per-call figure whose aggregation across a
          // multi-call turn is ambiguous in Codex (capability says so). We therefore keep
          // the LAST reported values rather than pretending to sum them, and leave the
          // fields undefined when the source reported nothing.
          const info = payload.info?.last_token_usage ?? payload.info?.total_token_usage;
          const acc = usageByTurn.get(Math.max(currentTurn, 0));
          if (info && acc) {
            acc.inputTokens = info.input_tokens; acc.outputTokens = info.output_tokens;
            acc.cachedInputTokens = info.cached_input_tokens;
            acc.reasoningTokens = info.reasoning_output_tokens; acc.totalTokens = info.total_tokens;
          }
          break;
        }
        case 'task_complete': {
          const t = Math.max(currentTurn, 0);
          const turn = turns[t];
          if (turn) {
            if (typeof payload.duration_ms === 'number') turn.durationMs = payload.duration_ms;
            if (typeof payload.time_to_first_token_ms === 'number') {
              turn.ttftMs = payload.time_to_first_token_ms;
              const step = steps[currentStep];
              if (step) {
                step.ttftMs = payload.time_to_first_token_ms;
                if (step.startedAt && typeof payload.completed_at === 'number') {
                  step.decodeMs = Math.max(0, payload.completed_at * 1000 - step.startedAt - payload.time_to_first_token_ms);
                }
              }
            } else diag.ttftMissingCount++;
            if (ts) { turn.endedAt = ts; endedAt = ts; }
            turn.endReason = 'completed';
          }
          records.push({
            recordId: rid('turn-end:' + (turn?.sourceTurnId ?? t)), kind: 'turn-end', orderIndex: orderOf(p),
            turnIndex: t, text: 'turn ' + t + ' completed',
            timeSeconds: turn?.durationMs != null ? turn.durationMs / 1000 : null,
            startedAt: ts, flags: [],
          });
          prevWasToolOutput = false;
          break;
        }
        case 'item_completed': {
          // The event_msg layer mirrors the protocol items for the UI. `Reasoning` is the
          // second place the model's thinking is logged — `item.raw_content` there holds
          // the same text as `response_item.content`. Read it so a rollout whose
          // response_item layer is trimmed still shows its reasoning.
          const item = payload.item;
          if (item && typeof item === 'object' && item.type === 'Reasoning') {
            const body = reasoningBody(item.raw_content ?? item.content);
            // Mirror of the response_item handling below. The two layers share one `id`,
            // so only emit when the protocol layer has not already produced this item —
            // otherwise every reasoning block would appear twice.
            const id = typeof item.id === 'string' ? item.id : undefined;
            if (body && (!id || !seenReasoning.has(id))) {
              if (id) seenReasoning.add(id);
              records.push({
                recordId: rid('rsn-ev:' + orderOf(p)), kind: 'reasoning', orderIndex: orderOf(p),
                turnIndex: Math.max(currentTurn, 0), stepIndex: currentStep < 0 ? undefined : currentStep,
                text: firstLine(body), detailText: body.trim(), timeSeconds: null,
                startedAt: ts, flags: [],
              });
            }
          }
          break;
        }
        case 'turn_aborted': {
          const t = Math.max(currentTurn, 0);
          if (turns[t]) { turns[t].endReason = payload.reason ?? 'interrupted'; turns[t].endedAt = ts; }
          records.push({
            recordId: rid('turn-abort:' + (payload.turn_id ?? t)), kind: 'turn-end', orderIndex: orderOf(p),
            turnIndex: t, text: 'turn ' + t + ' aborted (' + (payload.reason ?? 'interrupted') + ')',
            timeSeconds: null, startedAt: ts, flags: ['partial'],
          });
          break;
        }
        default: break;
      }
      continue;
    }

    if (o.type === 'response_item') {
      const role = payload.role;
      if (payload.type === 'message') {
        const text = (payload.content ?? []).map((c: any) => c.text ?? '').filter(Boolean).join('\n');
        if (role === 'user') {
          const t = ensureTurn(undefined, ts);
          if (turns[t] && turns[t].startedAt === undefined) turns[t].startedAt = ts;
          records.push({ recordId: rid('user' + orderOf(p)), kind: 'user', orderIndex: orderOf(p),
            turnIndex: t, opensTurn: true, text: firstLine(text), detailText: text,
            timeSeconds: null, startedAt: ts, flags: [] });
        } else if (role === 'assistant') {
          const t = ensureTurn(undefined, ts);
          if (currentStep < 0 || prevWasToolOutput) openStep(ts);
          else { const st = steps[currentStep]; if (st && st.startedAt === undefined) st.startedAt = ts; }
          records.push({ recordId: rid('asst' + orderOf(p)), kind: 'message', orderIndex: orderOf(p),
            turnIndex: t, stepIndex: currentStep, text: firstLine(text), detailText: text,
            timeSeconds: null, startedAt: ts, flags: [] });
          prevWasToolOutput = false;
        } else if (role === 'developer') {
          records.push({ recordId: rid('dev' + orderOf(p)), kind: 'context', orderIndex: orderOf(p),
            turnIndex: Math.max(currentTurn, 0), text: firstLine(text), detailText: text,
            timeSeconds: null, startedAt: ts, flags: [] });
        }
        continue;
      }
      if (payload.type === 'reasoning') {
        // Measured on this machine's rollouts (2026-09-29, 153 reasoning items):
        //   summary            -> []      (always empty)
        //   encrypted_content  -> ""      (always empty)
        //   content            -> [{type:'reasoning_text', text:'…'}]   ← the real text
        // so reading only `summary` reported every step as 'absent' and threw the
        // reasoning away. `summary` is still read first for rollouts that do populate it.
        const enc = payload.encrypted_content;
        const summary = (payload.summary ?? []).map((s: any) => s.text ?? '').join('\n');
        const body = reasoningBody(payload.content);
        const text = [summary, body].filter(Boolean).join('\n');
        const bytes = typeof enc === 'string' ? enc.length : 0;
        const availability: 'plaintext' | 'encrypted' | 'absent' =
          text && !bytes ? 'plaintext' : bytes ? 'encrypted' : 'absent';
        if (currentStep < 0) openStep(ts);
        // Both Codex layers describe the same thinking: `response_item.content` and
        // `event_msg item.raw_content`, sharing one `id`. Whichever arrives first wins —
        // and it is not always the protocol layer: the event_msg mirror carries a LOWER
        // ordinal (20 vs 21 in a measured rollout), so it usually lands here first.
        const ridKey = typeof payload.id === 'string' ? payload.id : undefined;
        const alreadySeen = ridKey !== undefined && seenReasoning.has(ridKey);
        if (ridKey) seenReasoning.add(ridKey);
        // Codex reasoning is its OWN assistant block in the ledger, NOT folded into the
        // AgentMessage beside it. Measured order in a rollout:
        //   AgentMessage → tool ×N → Reasoning → tool ×N → Reasoning → …
        //
        // Deliberately NOT stored on the step either: a step can hold several Reasoning
        // items, and last-write-wins would then attribute the LAST one's text to EVERY
        // message in the step — which is how an AgentMessage ended up displaying the
        // thinking of the Reasoning block that came after it.
        if (availability === 'plaintext' && text.trim() && !alreadySeen) {
          records.push({
            recordId: rid('rsn:' + orderOf(p)), kind: 'reasoning', orderIndex: orderOf(p),
            turnIndex: Math.max(currentTurn, 0), stepIndex: currentStep < 0 ? undefined : currentStep,
            text: firstLine(text), detailText: text.trim(), timeSeconds: null,
            startedAt: ts, flags: [],
          });
        } else if (availability === 'encrypted' && !alreadySeen) {
          // Keep the failure visible: the record exists but says only that it is sealed.
          records.push({
            recordId: rid('rsn:' + orderOf(p)), kind: 'reasoning', orderIndex: orderOf(p),
            turnIndex: Math.max(currentTurn, 0), stepIndex: currentStep < 0 ? undefined : currentStep,
            text: `思考内容已加密（${bytes} 字节），无法展示`,
            timeSeconds: null, startedAt: ts, flags: ['reasoning-encrypted'],
          });
        }
        continue;
      }
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const t = Math.max(currentTurn, 0);
        const name = payload.name ?? '(unknown)';
        const inputRaw = typeof payload.arguments === 'string' ? payload.arguments
          : typeof payload.input === 'string' ? payload.input : safeJson(payload.arguments ?? payload.input);
        const rec: NormRecord = {
          recordId: rid('tool' + (payload.call_id ?? orderOf(p))), kind: 'tool', orderIndex: orderOf(p),
          turnIndex: t, stepIndex: currentStep,
          text: name + '(' + truncate(inputRaw ?? '', 80) + ')', detailText: inputRaw,
          toolName: name, callId: payload.call_id, timeSeconds: null, startedAt: ts,
          tool: { callId: payload.call_id, name, inputRaw, startedAt: ts, durationMs: null, depth: 0 },
          flags: [],
        };
        records.push(rec);
        if (payload.call_id) toolByCallId.set(payload.call_id, rec);
        continue;
      }
      if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        const callId = payload.call_id;
        const rec = callId ? toolByCallId.get(callId) : undefined;
        const out = stringify(payload.output);
        if (rec && rec.tool) {
          rec.tool.outputText = out;
          rec.tool.endedAt = ts;
          if (rec.tool.startedAt && ts) rec.tool.durationMs = (ts - rec.tool.startedAt) / 1000;
          rec.timeSeconds = rec.tool.durationMs ?? null;
          rec.detailText = rec.detailText ? rec.detailText + '\n\n-- output --\n' + out : out;
        } else {
          diag.unresolvedCallCount++;
          records.push({ recordId: rid('toolout' + orderOf(p)), kind: 'tool', orderIndex: orderOf(p),
            turnIndex: Math.max(currentTurn, 0), text: 'unmatched tool output (' + (callId ?? '?') + ')',
            detailText: out, callId, timeSeconds: null, startedAt: ts, flags: ['unresolved-output'] });
        }
        prevWasToolOutput = true;
        continue;
      }
      if (payload.type === 'agent_message') {
        records.push({ recordId: rid('agentmsg' + orderOf(p)), kind: 'message', orderIndex: orderOf(p),
          turnIndex: Math.max(currentTurn, 0), text: firstLine(payload.message ?? ''),
          detailText: payload.message, timeSeconds: null, startedAt: ts, flags: [] });
      }
    }
  }

  for (const rec of records) {
    if (rec.kind === 'tool' && rec.callId && rec.tool && !rec.tool.outputText) {
      rec.tool.unresolved = true; rec.flags.push('unresolved-call'); diag.unresolvedCallCount++;
    }
  }
  for (const [t, acc] of usageByTurn) {
    if (acc.totalTokens == null) { diag.usageMissingCount++; continue; }
    const rec = records.find((r) => r.kind === 'turn-end' && r.turnIndex === t);
    if (rec) rec.usage = acc;
  }

  records.sort((a, b) => a.orderIndex - b.orderIndex);
  return { source: 'codex', sessionId: ref.sessionId, cwd, cliVersion, capabilities,
    startedAt, endedAt, turns, steps, records, diagnostics: diag };
}

function firstLine(s: string, max = 160): string {
  const t = (s ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? '';
  return t.length > max ? t.slice(0, max) + '\u2026' : t;
}
function truncate(s: string, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '\u2026' : t;
}
function safeJson(v: unknown): string { try { return JSON.stringify(v) ?? ''; } catch { return ''; } }

/**
 * Pull the readable text out of a Codex reasoning body.
 *
 * Two shapes appear in the wild:
 *   [{type:'reasoning_text', text:'…'}]  (response_item.content)
 *   ['…']                                 (event_msg item.raw_content)
 * Anything unrecognised is returned as-is if it is already a string, else dropped.
 */
function reasoningBody(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (part && typeof part === 'object') {
      const p = part as any;
      const t = p.text ?? p.thinking ?? p.reasoning_text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.filter(Boolean).join('\n');
}
function stringify(v: unknown): string { return typeof v === 'string' ? v : safeJson(v); }
