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

  /**
   * Claude Code splits ONE API response across consecutive `assistant` lines: a line
   * carrying the thinking/text blocks, then a line carrying the tool_use blocks. They are
   * one model call, not two — measured on this machine's logs:
   *
   *   message.id  identical        (06ec85c9… on both lines)
   *   usage       byte-identical   (same input/output/cache counters)
   *   stop_reason identical        (tool_use)
   *   parentUuid of line N+1 == uuid of line N
   *
   * Treating them as separate model calls gave each its own `stepIndex`, which split one
   * assistant turn into a "助手（无内容）" row plus an orphan "助手 Write{…}" row. The
   * ledger's fold can only join a tool to a message in the SAME step, so the two halves
   * could never be brought back together. Keyed here so both lines share one step and one
   * message row (and so the shared `usage` is only counted once).
   */
  let lastAsstMsgId: string | undefined;
  let curRec: NormRecord | undefined;
  /** Whether `curRec.detailText` is real assistant OUTPUT (vs a reasoning/placeholder
   *  summary). Only real output may be appended to; a placeholder must be REPLACED, so
   *  reasoning can never leak into the 输出 tab. */
  let curRecHasText = false;
  /**
   * Sub-record slotting for a single Claude API response.
   *
   * One response spans several JSONL lines, and its tool calls sit INSIDE the line of the
   * assistant message that issued them, so they share that line's physical index. Tools at
   * the same `order_index` as their owning message fell outside the `(order_index, next
   * order_index)` window the sibling query uses, so they get a fractional slot above it.
   *
   * `curSubSeq` is a COUNT, not a running total. Accumulating `order += 0.001` drifts —
   * 1.001 + 0.001 is 1.0019999999999998 in binary floating point — which reached the ledger
   * as order indices like `1.00199995`. Computing the value from the count each time keeps
   * it exact for any realistic number of tools.
   */
  const SUB_STRIDE = 0.001;
  let curSubBase = 0;
  let curSubSeq = 0;
  /** Exact value for the `seq`-th sub-record of the response based at `curSubBase`. */
  const subOrder = (seq: number): number => {
    // Round to the stride's precision: `base + seq * 0.001` is already exact for the ranges
    // here, but the rounding is what guarantees it against any future stride change.
    const scale = 1 / SUB_STRIDE;
    return Math.round((curSubBase + seq * SUB_STRIDE) * scale) / scale;
  };

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
      const msgId = typeof msg?.id === 'string' ? msg.id : undefined;

      // A second line of the SAME response reuses the previous step instead of opening a
      // new one (see lastAsstMsgId). Without this the thinking line and the tool_use line
      // of one model call became two steps, and no fold could ever reunite them.
      const reuseStep = msgId !== undefined && msgId === lastAsstMsgId && curRec !== undefined;
      const stepIndex = reuseStep ? curRec!.stepIndex! : steps.length;
      if (!reuseStep) {
        steps.push({ stepIndex, turnIndex: t, boundaryConfidence: 'derived', startedAt: ts,
          ttftMs: null, decodeMs: null, model: msg?.model });
        lastAsstMsgId = msgId;
        curRec = undefined;
        curRecHasText = false;
        // Sub-record ordering. Assistant sub-records all shared `order` (the physical line
        // index) and `getOwnedToolCalls` looks for siblings in
        // `(row.order_index, next message.order_index)`, so tools sitting at the SAME
        // order_index as their owning message fell outside the window. Slot the message at
        // the response's first line order and each tool at a fractional value above it.
        // The 0.001 stride can never collide with a real line index.
        curSubBase = order;
        curSubSeq = 0;
      }

      let text = '';
      let thinking = '';
      let hasToolCall = false;
      for (const b of blocks) {
        if (b.type === 'thinking' || b.type === 'reasoning') {
          thinking += (b.thinking ?? b.text ?? '') + '\n';
        } else if (b.type === 'text') {
          text += (b.text ?? '') + '\n';
        } else if (b.type === 'tool_use' || b.type === 'tool-call') {
          hasToolCall = true;
        }
      }
      if (thinking.trim()) {
        // Kept on the step (the inspector reads it from there) AND, when the response has
        // no assistant text of its own, used as the message row's summary — otherwise a
        // reasoning-bearing response would render as a contentless "（无内容）" row.
        steps[stepIndex].reasoning = { availability: 'plaintext', text: thinking.trim() };
      }

      const body = text.trim();
      if (curRec) {
        // A later line of the same response folds into the ONE row already emitted.
        if (body) {
          // REPLACE a reasoning/placeholder summary; only APPEND to real output text.
          // Concatenating here would have put the model's thinking into the 输出 tab.
          const merged = curRecHasText && curRec.detailText ? curRec.detailText + '\n' + body : body;
          curRec.kind = 'message';
          curRec.detailText = merged;
          curRec.text = firstLine(merged);
          curRecHasText = true;
        }
      } else if (body) {
        curRec = { recordId: rid('asst' + order), kind: 'message', orderIndex: order, turnIndex: t,
          stepIndex, text: firstLine(body), detailText: body, timeSeconds: null, startedAt: ts, flags: [] };
        curRecHasText = true;
        records.push(curRec);
      } else if (thinking.trim()) {
        // Reasoning-only response: label it 推理 so the row is never mistaken for model
        // output, and so it can still own the tool calls that follow in the same response.
        curRec = { recordId: rid('rsn' + order), kind: 'reasoning', orderIndex: order, turnIndex: t,
          stepIndex, text: firstLine(thinking), detailText: thinking.trim(),
          timeSeconds: null, startedAt: ts, flags: [] };
        records.push(curRec);
      } else if (hasToolCall) {
        // Tool-only response. The tool records ARE its content and render as their own 工具
        // rows, exactly as DSH and Codex do. Emitting a "（仅工具调用）" placeholder here is
        // what made a single step read as TWO 助手 rows — the assistant row plus a fake one
        // carrying nothing but the tool call.
      } else if (blocks.length > 0) {
        // Unrecognised blocks with no text and no tools: keep a row so the step is not
        // silently blank rather than dropping whatever the source recorded.
        curRec = { recordId: rid('asst' + order), kind: 'message', orderIndex: order, turnIndex: t,
          stepIndex, text: '（无内容）', timeSeconds: null, startedAt: ts, flags: [] };
        records.push(curRec);
      }

      // usage is per-record: sum into the turn aggregate and keep the step copy.
      // A split response repeats the SAME usage on every line, so it may only be counted
      // once — otherwise a turn with a tool call reports double its real token cost.
      const u = msg?.usage;
      if (u) {
        const stepUsage: NormUsage = {
          inputTokens: u.input_tokens, cachedInputTokens: u.cache_read_input_tokens,
          cacheWriteInputTokens: u.cache_creation_input_tokens, outputTokens: u.output_tokens,
          reasoningTokens: u.output_tokens_details?.thinking_tokens, totalTokens: undefined,
          scope: 'record', cacheSemantics: capabilities.cacheSemantics, crossSourceComparable: false,
        };
        steps[stepIndex].usage = stepUsage;
        if (!reuseStep) {
          const acc = turnUsage.get(t)!;
          acc.inputTokens = (acc.inputTokens ?? 0) + (u.input_tokens ?? 0);
          acc.cachedInputTokens = (acc.cachedInputTokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          acc.cacheWriteInputTokens = (acc.cacheWriteInputTokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          acc.outputTokens = (acc.outputTokens ?? 0) + (u.output_tokens ?? 0);
          acc.reasoningTokens = (acc.reasoningTokens ?? 0) + (u.output_tokens_details?.thinking_tokens ?? 0);
          acc.totalTokens = (acc.inputTokens ?? 0) + (acc.outputTokens ?? 0);
        }
      } else if (!reuseStep) {
        diag.usageMissingCount++;
      }

      for (const b of blocks) {
        if (b.type !== 'tool_use') continue;
        const inputRaw = safeJson(b.input);
        const rec: NormRecord = {
          recordId: rid('tool' + b.id), kind: 'tool', orderIndex: subOrder(++curSubSeq), turnIndex: t, stepIndex,
          text: b.name + '(' + truncate(inputRaw, 80) + ')', detailText: inputRaw,
          toolName: b.name, callId: b.id, timeSeconds: null, startedAt: ts,
          tool: { callId: b.id, name: b.name, inputRaw, startedAt: ts, durationMs: null, depth: 0 },
          flags: [],
        };
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
