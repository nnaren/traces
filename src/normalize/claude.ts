/**
 * Claude Code normalizer.
 *
 * Measured facts honored here (trajectory-data-sources.md §2):
 *  - authoritative order is PHYSICAL LINE ORDER (never timestamp)
 *  - `thinking` blocks are PLAINTEXT
 *  - `usage` is per-assistant-record; we sum and label the scope (risk #9)
 *  - `cost-state` is a periodic SNAPSHOT: only the last one counts
 *  - turn boundary = `system:turn_duration` + the isMeta=false user record (dual criteria)
 *  - tool pairing is tool_use.id <-> tool_result.tool_use_id, duration from timestamps
 */
import type {
  Diagnostic, NormRecord, NormSession, NormStep, NormTurn, NormUsage, RecordFlag, SessionRef, RawLine,
} from '../types.ts';
import { CLAUDE_CAPABILITIES } from '../sources/claude.ts';
import { parseLine } from '../sources/stableRead.ts';

const iso = (t?: string): number | undefined => (t ? Date.parse(t) : undefined);

export function normalizeClaude(ref: SessionRef, lines: RawLine[]): NormSession {
  const diag: Diagnostic = {
    badLineCount: 0, unknownTypeCount: 0, unresolvedCallCount: 0, shadowedCount: 0,
    reopened: false, ttftMissingCount: 0, usageMissingCount: 0, parseErrors: [],
  };

  const objs: any[] = [];
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
    objs.push(o);
  }

  const capabilities = { ...CLAUDE_CAPABILITIES, ordering: 'physical-line-order' as const };

  const turns: NormTurn[] = [];
  const steps: NormStep[] = [];
  const records: NormRecord[] = [];
  const toolById = new Map<string, NormRecord>();

  let currentTurn = -1;
  let cwd = ref.cwd;
  let gitBranch = ref.gitBranch;
  let cliVersion = ref.cliVersion;
  let startedAt = ref.startedAt;
  let endedAt: number | undefined;
  let costUsd: number | undefined;
  const turnUsage = new Map<number, NormUsage>();

  const openTurn = (ts?: number) => {
    currentTurn = turns.length;
    turns.push({ turnIndex: currentTurn, boundaryConfidence: 'derived', startedAt: ts,
      durationMs: null, ttftMs: null });
    // P2: unknown usage stays undefined; it must never be seeded with 0.
    turnUsage.set(currentTurn, {
      scope: 'turn', cacheSemantics: capabilities.cacheSemantics, crossSourceComparable: false,
    });
    return currentTurn;
  };

  /**
   * Claude Code has no turn id. The dual criteria from the format spec are:
   *   - `system:turn_duration` closes the current turn, and
   *   - the next non-meta `user` record opens a new one.
   * Reusing the previous turn unconditionally would collapse a whole multi-turn
   * session into a single turn.
   */
  const ensureTurn = (ts?: number) => {
    const closed = currentTurn >= 0 && turns[currentTurn].endReason !== undefined;
    return currentTurn < 0 || closed ? openTurn(ts) : currentTurn;
  };

  let idSeq = 0;
  const rid = (base: string) => base + '::' + (idSeq++);

  objs.forEach((o, i) => {
    const ts = iso(o.timestamp);
    const order = i; // physical line order
    const type = o.type;
    const msg = o.message;
    const blocks: any[] = Array.isArray(msg?.content) ? msg.content : [];

    if (type === 'user') {
      const isMeta = o.isMeta === true;
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const rec = toolById.get(tr.tool_use_id);
          const out = stringify(tr.content);
          if (rec && rec.tool) {
            rec.tool.outputText = out;
            rec.tool.endedAt = ts;
            rec.tool.isError = tr.is_error === true || undefined;
            if (rec.tool.startedAt && ts) rec.tool.durationMs = (ts - rec.tool.startedAt) / 1000;
            rec.timeSeconds = rec.tool.durationMs ?? null;
            rec.isError = tr.is_error === true || undefined;
            rec.detailText = rec.detailText ? rec.detailText + '\n\n-- output --\n' + out : out;
          } else {
            diag.unresolvedCallCount++;
            records.push({ recordId: rid('toolout' + order), kind: 'tool', orderIndex: order,
              turnIndex: Math.max(currentTurn, 0), text: 'unmatched tool_result',
              detailText: out, callId: tr.tool_use_id, timeSeconds: null, startedAt: ts,
              isError: tr.is_error === true || undefined, flags: ['unresolved-output'] });
          }
        }
        return;
      }
      if (isMeta) return;
      const text = typeof msg?.content === 'string' ? msg.content : blocks.map((b) => b.text ?? '').join('\n');
      const t = ensureTurn(ts);
      if (turns[t].startedAt === undefined) turns[t].startedAt = ts;
      records.push({ recordId: rid('user' + order), kind: 'user', orderIndex: order, turnIndex: t,
        opensTurn: true, text: firstLine(text), detailText: text, timeSeconds: null, startedAt: ts, flags: [] });
      return;
    }

    if (type === 'assistant') {
      const t = ensureTurn(ts);
      const stepIndex = steps.length;
      steps.push({ stepIndex, turnIndex: t, boundaryConfidence: 'derived', startedAt: ts,
        ttftMs: null, decodeMs: null, model: msg?.model });

      // Sub-record ordering. One assistant JSONL line yields a message row AND one row
      // per tool_use block, but they all shared `order` (= the physical line index).
      // `getOwnedToolCalls` looks for sibling tools in
      // `(row.order_index, next message.order_index)`, so tools sitting at the SAME
      // order_index as their owning message fell outside that window and the inspector
      // reported "该 step 没有工具调用" for every tool-call-only message.
      // Slot the message at `order` and each tool at a fractional value just above it,
      // so a sub-record's order_index reflects its position within the source line. The
      // 0.001 stride can never collide with a real line index (the next line is the
      // integer `i+1`).
      let subOrder = order + 0.001;

      let text = '';
      for (const b of blocks) {
        if (b.type === 'thinking') {
          const text2 = b.thinking ?? '';
          // Stored on the step, not as a `context` row: thinking is model output and
          // would otherwise land in the 输入 lane. The inspector reads it from there.
          if (text2) steps[stepIndex].reasoning = { availability: 'plaintext', text: text2 };
        } else if (b.type === 'text') {
          text += (b.text ?? '') + '\n';
        }
      }
      if (text.trim()) {
        records.push({ recordId: rid('asst' + order), kind: 'message', orderIndex: order, turnIndex: t,
          stepIndex, text: firstLine(text), detailText: text.trim(), timeSeconds: null, startedAt: ts, flags: [] });
      } else if (blocks.length > 0) {
        // Tool-call-only assistant turns carry no text block; keep the row so the step
        // isn't left with bare tool calls and nothing that produced them.
        const hasToolCall = blocks.some((b: any) => b.type === 'tool_use' || b.type === 'tool-call');
        records.push({ recordId: rid('asst' + order), kind: 'message', orderIndex: order, turnIndex: t,
          stepIndex, text: hasToolCall ? '（仅工具调用）' : '（无内容）',
          timeSeconds: null, startedAt: ts, flags: [] });
      }

      // usage is per-record: sum into the turn aggregate and keep the step copy
      const u = msg?.usage;
      if (u) {
        const stepUsage: NormUsage = {
          inputTokens: u.input_tokens, cachedInputTokens: u.cache_read_input_tokens,
          cacheWriteInputTokens: u.cache_creation_input_tokens, outputTokens: u.output_tokens,
          reasoningTokens: u.output_tokens_details?.thinking_tokens, totalTokens: undefined,
          scope: 'record', cacheSemantics: capabilities.cacheSemantics, crossSourceComparable: false,
        };
        steps[stepIndex].usage = stepUsage;
        const acc = turnUsage.get(t)!;
        acc.inputTokens = (acc.inputTokens ?? 0) + (u.input_tokens ?? 0);
        acc.cachedInputTokens = (acc.cachedInputTokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        acc.cacheWriteInputTokens = (acc.cacheWriteInputTokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        acc.outputTokens = (acc.outputTokens ?? 0) + (u.output_tokens ?? 0);
        acc.reasoningTokens = (acc.reasoningTokens ?? 0) + (u.output_tokens_details?.thinking_tokens ?? 0);
        acc.totalTokens = (acc.inputTokens ?? 0) + (acc.outputTokens ?? 0);
      } else {
        diag.usageMissingCount++;
      }

      for (const b of blocks) {
        if (b.type !== 'tool_use') continue;
        const inputRaw = safeJson(b.input);
        const rec: NormRecord = {
          recordId: rid('tool' + b.id), kind: 'tool', orderIndex: subOrder, turnIndex: t, stepIndex,
          text: b.name + '(' + truncate(inputRaw, 80) + ')', detailText: inputRaw,
          toolName: b.name, callId: b.id, timeSeconds: null, startedAt: ts,
          tool: { callId: b.id, name: b.name, inputRaw, startedAt: ts, durationMs: null, depth: 0 },
          flags: [],
        };
        subOrder += 0.001;
        records.push(rec);
        toolById.set(b.id, rec);
      }
      if (ts) endedAt = ts;
      return;
    }

    if (type === 'system') {
      const st = o.subtype;
      if (st === 'turn_duration') {
        const t = Math.max(currentTurn, 0);
        const turn = turns[t];
        if (turn) {
          turn.durationMs = typeof o.durationMs === 'number' ? o.durationMs : null;
          turn.endReason = 'completed';
          turn.endedAt = ts;
          const acc = turnUsage.get(t);
          const rec = records.find((r) => r.kind === 'turn-end' && r.turnIndex === t);
          if (rec && acc && acc.totalTokens != null) rec.usage = acc;
        }
        records.push({ recordId: rid('turn-end:' + t), kind: 'turn-end', orderIndex: order,
          turnIndex: t, text: 'turn ' + t + ' duration ' + (o.durationMs ?? '?') + 'ms',
          timeSeconds: typeof o.durationMs === 'number' ? o.durationMs / 1000 : null,
          startedAt: ts,
          usage: turnUsage.get(t)?.totalTokens != null ? turnUsage.get(t) : undefined,
          flags: [] });
      } else if (st === 'stop_hook_summary') {
        records.push({ recordId: rid('stop' + order), kind: 'system', orderIndex: order,
          turnIndex: Math.max(currentTurn, 0), text: 'stop hook: ' + (o.stopReason ?? 'ok'),
          detailText: safeJson(o.hookErrors ?? o.hookInfos ?? ''), timeSeconds: null, startedAt: ts, flags: [] });
      } else {
        diag.unknownTypeCount++;
      }
      return;
    }

    if (type === 'cost-state') {
      // Periodic snapshot, NOT a delta: keep the latest only.
      if (typeof o.totalCostUSD === 'number') costUsd = o.totalCostUSD;
      return;
    }
    if (type === 'message' || type === 'summary') {
      records.push({ recordId: rid('sys' + order), kind: 'system', orderIndex: order,
        turnIndex: Math.max(currentTurn, 0), text: firstLine(stringify(msg ?? o.summary ?? '')),
        timeSeconds: null, startedAt: ts, flags: [] });
      return;
    }
    diag.unknownTypeCount++;
  });

  for (const rec of records) {
    if (rec.kind === 'tool' && rec.callId && rec.tool && !rec.tool.outputText) {
      rec.tool.unresolved = true; rec.flags.push('unresolved-call'); diag.unresolvedCallCount++;
    }
  }
  // Crash repair: an open turn with no turn_duration gets an interrupted closer
  // (mirrors DSH interruptedTurnClosers).
  const last = turns[turns.length - 1];
  if (last && !last.endReason) {
    last.endReason = 'interrupted';
    records.push({ recordId: rid('turn-abort:' + last.turnIndex), kind: 'turn-end',
      orderIndex: records.length, turnIndex: last.turnIndex, text: 'turn ' + last.turnIndex + ' interrupted (no turn_duration)',
      timeSeconds: null, flags: ['partial'] });
  }
  if (!startedAt) startedAt = objs.find((o) => o.timestamp)?.timestamp
    ? iso(objs.find((o) => o.timestamp).timestamp) : undefined;

  records.sort((a, b) => a.orderIndex - b.orderIndex);
  const session: NormSession = {
    source: 'claude-code', sessionId: ref.sessionId, cwd, gitBranch, cliVersion, capabilities,
    startedAt, endedAt, turns, steps, records, diagnostics: diag,
  };
  if (costUsd !== undefined) {
    (session as any).costUsd = costUsd;
  }
  return session;
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
function stringify(v: unknown): string { return Array.isArray(v) ? v.map((x) => stringify(x)).join('\n') : safeJson(v); }
