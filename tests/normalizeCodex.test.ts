import { describe, expect, it } from 'vitest';
import { normalizeCodex } from '../src/normalize/codex.ts';
import { splitLines } from '../src/sources/stableRead.ts';
import type { SessionRef } from '../src/types.ts';

const REF: SessionRef = { source: 'codex', sessionId: 's1', path: '/tmp/s1.jsonl' };
const buf = (lines: Array<any | string>) => Buffer.from(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');

/**
 * Codex's echo for a REAL human message (see tests/codexUserVsContext.test.ts).
 *
 * Deliberately carries NO `ordinal`: an echo must never make a pre-0.147 fixture look
 * like it has the ordinal layer (R1 falls back to physical-line-order when it doesn't),
 * and the echo produces no record so its position is irrelevant.
 */
const userEcho = (text: string, ordinal: number) => ({
  type: 'event_msg', timestamp: '2026-08-20T10:00:01.050Z',
  payload: {
    type: 'item_completed',
    item: { type: 'UserMessage', id: 'um_' + ordinal, client_id: 'c' + ordinal, content: [{ type: 'text', text }] },
  },
});

/**
 * These fixtures model a human talking to Codex, so every role=user message gets the
 * `UserMessage` echo Codex really writes for human input. The normalizer uses that echo to
 * separate human questions from injected context (`<environment_context>`, `<skill>`, …);
 * without it every message here would be classified as injected 上下文.
 *
 * The echo carries a fractional ordinal so it slots next to its message without colliding
 * with the fixture's own integer ordinals. It produces no record — it is only consumed by
 * the classifier — so record counts are unaffected.
 */
const run = (lines: Array<any | string>) => {
  const out: Array<any | string> = [];
  for (const l of lines) {
    out.push(l);
    if (typeof l !== 'string' && l?.type === 'response_item'
      && l.payload?.type === 'message' && l.payload.role === 'user') {
      const text = (l.payload.content ?? []).map((c: any) => c.text ?? '').filter(Boolean).join('\n');
      out.push(userEcho(text, (l.ordinal ?? 0) + 0.5));
    }
  }
  return normalizeCodex(REF, splitLines(buf(out)));
};

const meta = (extra: any = {}) => ({ type: 'session_meta', timestamp: '2026-08-20T10:00:00.000Z', payload: { session_id: 's1', cwd: '/w', cli_version: '0.153.4', ...extra } });
const started = (id: string) => ({ type: 'event_msg', ordinal: 1, timestamp: '2026-08-20T10:00:01.000Z', payload: { type: 'task_started', turn_id: id } });
const userMsg = (t: string, ord: number) => ({ type: 'response_item', ordinal: ord, timestamp: '2026-08-20T10:00:01.100Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] } });
const asstMsg = (t: string, ord: number) => ({ type: 'response_item', ordinal: ord, timestamp: '2026-08-20T10:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] } });
const call = (id: string, ord: number) => ({ type: 'response_item', ordinal: ord, timestamp: '2026-08-20T10:00:02.500Z', payload: { type: 'function_call', call_id: id, name: 'shell', arguments: '{"cmd":"ls"}' } });
const output = (id: string, ord: number) => ({ type: 'response_item', ordinal: ord, timestamp: '2026-08-20T10:00:03.000Z', payload: { type: 'function_call_output', call_id: id, output: 'ok' } });
const complete = (id: string, ord: number, ttft: number | undefined) => {
  const p: any = { type: 'task_complete', turn_id: id, duration_ms: 3124, completed_at: 1788518402 };
  if (ttft !== undefined) p.time_to_first_token_ms = ttft;
  return { type: 'event_msg', ordinal: ord, timestamp: '2026-08-20T10:00:04.000Z', payload: p };
};

describe('codex normalization', () => {
  it('uses ordinal when present', () => {
    const s = run([meta(), started('t1'), userMsg('hi', 2), asstMsg('yo', 3), complete('t1', 4, 100)]);
    expect(s.capabilities.ordering).toBe('ordinal');
    expect(s.records.map((r) => r.orderIndex)).toEqual([...s.records.map((r) => r.orderIndex)].sort((a, b) => a - b));
  });

  it('R1: falls back to physical-line-order on pre-0.147 sessions with no ordinal', () => {
    const s = run([
      { type: 'session_meta', timestamp: '2026-07-07T10:00:00.000Z', payload: { session_id: 's1', cli_version: '0.142.5' } },
      { type: 'event_msg', timestamp: '2026-07-07T10:00:01.000Z', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'response_item', timestamp: '2026-07-07T10:00:01.100Z', payload: { type: 'message', role: 'user', content: [{ text: 'hi' }] } },
    ]);
    expect(s.capabilities.ordering).toBe('physical-line-order');
    expect(s.records.length).toBeGreaterThan(0);
    expect(s.diagnostics.badLineCount).toBe(0);
  });

  it('pairs tool calls by call_id (not id) and computes duration', () => {
    const s = run([meta(), started('t1'), userMsg('go', 2), call('c1', 3), output('c1', 4), complete('t1', 5, 50)]);
    const tool = s.records.find((r) => r.kind === 'tool')!;
    expect(tool.callId).toBe('c1');
    expect(tool.tool!.outputText).toBe('ok');
    expect(tool.timeSeconds).toBeCloseTo(0.5, 3);
    expect(s.diagnostics.unresolvedCallCount).toBe(0);
  });

  it('keeps orphan calls flagged instead of dropping them', () => {
    const s = run([meta(), started('t1'), userMsg('go', 2), call('c1', 3), complete('t1', 4, 10)]);
    const tool = s.records.find((r) => r.kind === 'tool')!;
    expect(tool.flags).toContain('unresolved-call');
    expect(s.diagnostics.unresolvedCallCount).toBeGreaterThan(0);
  });

  it('keeps orphan outputs flagged instead of dropping them', () => {
    const s = run([meta(), started('t1'), userMsg('go', 2), output('ghost', 3), complete('t1', 4, 10)]);
    const orphan = s.records.find((r) => r.flags.includes('unresolved-output'));
    expect(orphan).toBeTruthy();
    expect(orphan!.detailText).toBe('ok');
  });

  it('survives a corrupt middle line and counts it', () => {
    const s = run([meta(), started('t1'), '{ broken json', userMsg('after', 2), complete('t1', 3, 10)]);
    expect(s.diagnostics.badLineCount).toBe(1);
    expect(s.records.some((r) => r.kind === 'user')).toBe(true);
  });

  it('flags encrypted reasoning with byte count and shows no content', () => {
    const s = run([meta(), started('t1'), userMsg('x', 2), {
      type: 'response_item', ordinal: 3, timestamp: '2026-08-20T10:00:02.000Z',
      payload: { type: 'reasoning', summary: [], content: null, encrypted_content: 'AAAA', internal_chat_message_metadata_passthrough: {} },
    }, complete('t1', 4, 10)]);
    const r = s.records.find((x) => x.flags.includes('reasoning-encrypted'))!;
    expect(r).toBeTruthy();
    expect(r.detailText ?? '').toBe('');
    expect(r.text).toContain('4 bytes');
  });

  it('treats plaintext reasoning (DeepSeek-style) as available', () => {
    const s = run([meta(), started('t1'), userMsg('x', 2), {
      type: 'response_item', ordinal: 3, timestamp: '2026-08-20T10:00:02.000Z',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'the user said hi' }], content: null, encrypted_content: null },
    }, complete('t1', 4, 10)]);
    const r = s.records.find((x) => x.kind === 'context' && x.detailText)!;
    expect(r.detailText).toBe('the user said hi');
    expect(s.steps.some((st) => st.reasoning?.availability === 'plaintext')).toBe(true);
  });

  it('records missing TTFT honestly instead of inventing it', () => {
    const s = run([meta(), started('t1'), userMsg('x', 2), complete('t1', 3, undefined)]);
    expect(s.turns[0].ttftMs).toBeNull();
    expect(s.diagnostics.ttftMissingCount).toBeGreaterThan(0);
  });

  it('marks an aborted turn as interrupted', () => {
    const s = run([meta(), started('t1'), userMsg('x', 2),
      { type: 'event_msg', ordinal: 3, timestamp: '2026-08-20T10:00:09.000Z', payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' } }]);
    expect(s.turns[0].endReason).toBe('interrupted');
  });

  it('R7: maps token_usage_record to per-response usage', () => {
    const s = run([meta(), started('t1'), userMsg('x', 2),
      { type: 'turn_context', ordinal: 3, timestamp: '2026-08-20T10:00:01.500Z', payload: { turn_id: 't1', model: 'deepseek-v4-flash' } },
      { type: 'token_usage_record', ordinal: 4, timestamp: '2026-08-20T10:00:02.000Z', payload: { usage: { input_tokens: 17105, output_tokens: 66, total_tokens: 17171 } } }]);
    const step = s.steps.find((st) => st.usage);
    expect(step!.usage!.scope).toBe('per-response');
    expect(step!.usage!.totalTokens).toBe(17171);
    expect(step!.model).toBe('deepseek-v4-flash');
  });

  // REGRESSION: a whole multi-turn session used to collapse into ONE turn because
  // ensureTurn reused currentTurn unconditionally. Turn count must follow task_started.
  it('opens a NEW turn for every task_started / turn_id (multi-turn)', () => {
    const s = run([
      meta(),
      started('t1'), userMsg('first question', 2), asstMsg('first answer', 3), complete('t1', 4, 100),
      started('t2'), userMsg('second question', 6), asstMsg('second answer', 7), complete('t2', 8, 200),
      started('t3'), userMsg('third question', 10), asstMsg('third answer', 11), complete('t3', 12, 300),
    ]);
    expect(s.turns).toHaveLength(3);
    expect(s.turns.map((t) => t.sourceTurnId)).toEqual(['t1', 't2', 't3']);
    // each turn keeps ITS OWN duration, not just the last one
    expect(s.turns.map((t) => t.durationMs)).toEqual([3124, 3124, 3124]);
    // users must be distributed across turns, not all on turn 0
    const byTurn = s.records.filter((r) => r.kind === 'user').map((r) => r.turnIndex);
    expect(byTurn).toEqual([0, 1, 2]);
  });

  it('keeps per-turn usage separate across turns', () => {
    const mk = (ord: number, total: number) => ({
      type: 'event_msg', ordinal: ord, timestamp: '2026-08-20T10:00:05.000Z',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: total, output_tokens: 1, total_tokens: total } } },
    });
    const s = run([meta(), started('t1'), userMsg('a', 2), mk(3, 111), complete('t1', 4, 10),
      started('t2'), userMsg('b', 6), mk(7, 222), complete('t2', 8, 20)]);
    const endRecords = s.records.filter((r) => r.kind === 'turn-end');
    expect(endRecords).toHaveLength(2);
    expect(endRecords[0].usage!.totalTokens).toBe(111);
    expect(endRecords[1].usage!.totalTokens).toBe(222);
  });

  it('P2: a turn with no reported usage stays undefined, never 0', () => {
    const s = run([meta(), started('t1'), userMsg('x', 2), complete('t1', 3, 10)]);
    const end = s.records.find((r) => r.kind === 'turn-end')!;
    expect(end.usage).toBeUndefined();
    expect(s.diagnostics.usageMissingCount).toBeGreaterThan(0);
  });

  it('assigns the model from turn_context to the step (R3)', () => {
    const s = run([meta(), started('t1'),
      { type: 'turn_context', ordinal: 2, timestamp: '2026-08-20T10:00:01.500Z', payload: { turn_id: 't1', model: 'gpt-5.6-sol' } },
      userMsg('x', 3), asstMsg('y', 4), complete('t1', 5, 10)]);
    expect(s.steps.some((st) => st.model === 'gpt-5.6-sol')).toBe(true);
  });

  /**
   * REGRESSION (rollout 01a11705-58a8-7e83-b4b5-681c407bcf23, MiniMax-M3 over /v1/responses):
   * the provider emitted `arguments: ""` for all 43 calls, so the ledger showed a flat
   * `exec_command()` that reads like a deliberate no-argument call. Both real failure
   * shapes are covered below — serde_json choking on the empty string, and schema
   * validation rejecting empty args coerced to `{}`.
   */
  describe('arguments lost upstream (arguments: "")', () => {
    const emptyCall = (id: string, ord: number, name = 'exec_command') => ({
      type: 'response_item', ordinal: ord, timestamp: '2026-08-20T10:00:02.500Z',
      payload: { type: 'function_call', call_id: id, name, arguments: '' },
    });
    const failOut = (id: string, ord: number, out: string) => ({
      type: 'response_item', ordinal: ord, timestamp: '2026-08-20T10:00:03.000Z',
      payload: { type: 'function_call_output', call_id: id, output: out },
    });
    const PARSE_ERR = 'failed to parse function arguments: EOF while parsing a value at line 1 column 0';

    it('flags a blank-args call that failed JSON parsing', () => {
      const s = run([meta(), started('t1'), userMsg('go', 2),
        emptyCall('c1', 3), failOut('c1', 4, PARSE_ERR), complete('t1', 5, 10)]);
      const tool = s.records.find((r) => r.kind === 'tool')!;
      expect(tool.flags).toContain('missing-arguments');
      expect(tool.tool!.argsMissing).toBe(true);
      expect(tool.text).toBe('exec_command(⚠ 参数缺失)');
      expect(tool.tool!.inputRaw).toBe('');
      // the raw failure text is still preserved verbatim for evidence
      expect(tool.tool!.outputText).toBe(PARSE_ERR);
    });

    it('flags a blank-args call rejected by schema validation', () => {
      const s = run([meta(), started('t1'), userMsg('go', 2),
        emptyCall('c2', 3, 'create_thread'),
        failOut('c2', 4, "Wall time: 0.0053 seconds\nOutput: Invalid tool arguments: missing field `prompt`"),
        complete('t1', 5, 10)]);
      const tool = s.records.find((r) => r.kind === 'tool')!;
      expect(tool.flags).toContain('missing-arguments');
      expect(tool.text).toBe('create_thread(⚠ 参数缺失)');
    });

    // The critical negative: `exec_command()` with no arguments is a VALID call that
    // succeeds. Flagging it would mark hundreds of healthy records as data loss.
    it('does NOT flag a legitimately argument-less call that succeeded', () => {
      const s = run([meta(), started('t1'), userMsg('go', 2),
        emptyCall('c3', 3), failOut('c3', 4, "Wall time: 0.0043 seconds\nOutput:"),
        complete('t1', 5, 10)]);
      const tool = s.records.find((r) => r.kind === 'tool')!;
      expect(tool.flags).not.toContain('missing-arguments');
      expect(tool.tool!.argsMissing).toBeUndefined();
      expect(tool.text).toBe('exec_command()');
    });

    // Guard against flagging on the error text alone when arguments were actually sent:
    // a truncated/partially-streamed payload can surface the same wording.
    it('does NOT flag a call whose arguments arrived intact', () => {
      const s = run([meta(), started('t1'), userMsg('go', 2),
        call('c4', 3), failOut('c4', 4, 'command not found: nosuch'), complete('t1', 5, 10)]);
      const tool = s.records.find((r) => r.kind === 'tool')!;
      expect(tool.flags).not.toContain('missing-arguments');
      expect(tool.tool!.inputRaw).toBe('{"cmd":"ls"}');
    });

    it('stays silent when the output never arrives (already unresolved-call)', () => {
      const s = run([meta(), started('t1'), userMsg('go', 2),
        emptyCall('c5', 3), complete('t1', 4, 10)]);
      const tool = s.records.find((r) => r.kind === 'tool')!;
      expect(tool.flags).toContain('unresolved-call');
      expect(tool.flags).not.toContain('missing-arguments');
    });
  });
});
