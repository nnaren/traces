import { describe, expect, it } from 'vitest';
import { normalizeClaude } from '../src/normalize/claude.ts';
import { splitLines } from '../src/sources/stableRead.ts';
import type { SessionRef } from '../src/types.ts';

const REF: SessionRef = { source: 'claude-code', sessionId: 'c1', path: '/tmp/c1.jsonl' };
const run = (lines: any[]) => normalizeClaude(REF, splitLines(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')));
/** Round to the sub-order stride's precision, for exactness assertions. */
const round3 = (v: number) => Math.round(v * 1000) / 1000;

const user = (t: string, ts: string, extra: any = {}) => ({ type: 'user', uuid: 'u' + t, parentUuid: null, sessionId: 'c1', cwd: '/w', timestamp: ts, message: { role: 'user', content: t }, ...extra });
const assistant = (blocks: any[], ts: string, extra: any = {}) => ({ type: 'assistant', uuid: 'a' + ts, sessionId: 'c1', cwd: '/w', timestamp: ts, message: { role: 'assistant', model: 'claude-x', content: blocks, usage: { input_tokens: 100, output_tokens: 10, output_tokens_details: { thinking_tokens: 4 } } }, ...extra });

describe('claude code normalization', () => {
  it('orders by physical line position, never by timestamp', () => {
    const s = run([
      user('first', '2026-01-01T00:00:03.000Z'),
      user('second', '2026-01-01T00:00:01.000Z'), // earlier timestamp, later line
    ]);
    expect(s.capabilities.ordering).toBe('physical-line-order');
    expect(s.records.filter((r) => r.kind === 'user').map((r) => r.detailText)).toEqual(['first', 'second']);
  });

  it('exposes plaintext thinking (the thing Codex cannot show)', () => {
    const s = run([
      user('hi', '2026-01-01T00:00:00.000Z'),
      assistant([{ type: 'thinking', thinking: 'the user greeted me', signature: 'sig' }, { type: 'text', text: 'hello' }], '2026-01-01T00:00:01.000Z'),
    ]);
    const think = s.records.find((r) => r.detailText === 'the user greeted me')!;
    expect(think).toBeTruthy();
    expect(s.steps[0].reasoning?.availability).toBe('plaintext');
  });

  /**
   * REGRESSION: Claude spans several JSONL lines per API response, so a response's tools sit
   * inside its assistant message's line and needed a fractional slot to sort after it. That
   * slot was accumulated (`order += 0.001`), and binary floating point drifts: 1.001 + 0.001
   * is 1.0019999999999998. The ledger displayed the result verbatim as `1.00199995`.
   *
   * The values must be EXACT and must stay strictly between their own line and the next, or
   * the sibling window `(order_index, next order_index)` stops matching.
   */
  it('slots a response\'s tools at exact fractional offsets, with no float drift', () => {
    const tools = Array.from({ length: 8 }, (_, i) => (
      { type: 'tool_use', id: 'tu' + i, name: 'Bash', input: { command: 'cmd' + i } }));
    const s = run([
      user('go', '2026-01-01T00:00:00.000Z'),
      assistant(tools, '2026-01-01T00:00:01.000Z'),
      user('next', '2026-01-01T00:00:02.000Z'),
    ]);
    const idx = s.records.filter((r) => r.kind === 'tool').map((r) => r.orderIndex).sort((a, b) => a - b);
    expect(idx).toHaveLength(8);
    // Exact expected values, compared as numbers rather than strings so a drift of 1e-16 fails.
    expect(idx).toEqual([1.001, 1.002, 1.003, 1.004, 1.005, 1.006, 1.007, 1.008]);
    for (const v of idx) {
      expect(Math.abs(round3(v) - v), `${v} drifted`).toBeLessThan(1e-9);
    }
    // Every slot must still sort before the following user line, or tools would be attributed
    // to the wrong response.
    const nextLine = Math.min(...s.records.filter((r) => r.kind === 'user' && r.detailText === 'next').map((r) => r.orderIndex));
    for (const v of idx) expect(v).toBeLessThan(nextLine);
  });

  it('pairs tool_use with tool_result and derives duration from timestamps', () => {
    const s = run([
      user('go', '2026-01-01T00:00:00.000Z'),
      assistant([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }], '2026-01-01T00:00:01.000Z'),
      { type: 'user', uuid: 'r1', sessionId: 'c1', cwd: '/w', timestamp: '2026-01-01T00:00:03.500Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a b c' }] } },
    ]);
    const tool = s.records.find((r) => r.kind === 'tool')!;
    expect(tool.callId).toBe('tu1');
    expect(tool.tool!.outputText).toBe('a b c');
    expect(tool.timeSeconds).toBeCloseTo(2.5, 3);
    expect(s.diagnostics.unresolvedCallCount).toBe(0);
  });

  it('flags an unmatched tool_result instead of dropping it', () => {
    const s = run([
      user('go', '2026-01-01T00:00:00.000Z'),
      { type: 'user', uuid: 'r1', sessionId: 'c1', timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }] } },
    ]);
    expect(s.records.some((r) => r.flags.includes('unresolved-output'))).toBe(true);
  });

  it('sums per-record usage into the turn and labels the scope', () => {
    const s = run([
      user('hi', '2026-01-01T00:00:00.000Z'),
      assistant([{ type: 'text', text: 'a' }], '2026-01-01T00:00:01.000Z'),
      assistant([{ type: 'text', text: 'b' }], '2026-01-01T00:00:02.000Z'),
      { type: 'system', subtype: 'turn_duration', durationMs: 5000, timestamp: '2026-01-01T00:00:05.000Z' },
    ]);
    expect(s.steps).toHaveLength(2);
    expect(s.steps.every((st) => st.usage?.scope === 'record')).toBe(true);
    const endRec = s.records.find((r) => r.kind === 'turn-end')!;
    expect(endRec.usage!.scope).toBe('turn');
    expect(endRec.usage!.inputTokens).toBe(200);
    expect(endRec.usage!.outputTokens).toBe(20);
    expect(endRec.usage!.crossSourceComparable).toBe(false);
  });

  it('takes cost from the LAST cost-state snapshot, never summing them', () => {
    const s = run([
      user('hi', '2026-01-01T00:00:00.000Z'),
      { type: 'cost-state', totalCostUSD: 1.5, timestamp: '2026-01-01T00:00:01.000Z' },
      { type: 'cost-state', totalCostUSD: 4.25, timestamp: '2026-01-01T00:00:02.000Z' },
    ]);
    expect((s as any).costUsd).toBe(4.25);
  });

  // REGRESSION: ensureTurn used to return the current turn unconditionally, collapsing
  // every user/assistant pair in a session onto turn 0.
  it('opens a NEW turn after each turn_duration (multi-turn)', () => {
    const turnEnd = (ms: number, ts: string) => ({ type: 'system', subtype: 'turn_duration', durationMs: ms, timestamp: ts });
    const s = run([
      user('q1', '2026-01-01T00:00:00.000Z'), assistant([{ type: 'text', text: 'a1' }], '2026-01-01T00:00:01.000Z'), turnEnd(1000, '2026-01-01T00:00:02.000Z'),
      user('q2', '2026-01-01T00:00:03.000Z'), assistant([{ type: 'text', text: 'a2' }], '2026-01-01T00:00:04.000Z'), turnEnd(2000, '2026-01-01T00:00:05.000Z'),
      user('q3', '2026-01-01T00:00:06.000Z'), assistant([{ type: 'text', text: 'a3' }], '2026-01-01T00:00:07.000Z'), turnEnd(3000, '2026-01-01T00:00:08.000Z'),
    ]);
    expect(s.turns).toHaveLength(3);
    const byTurn = s.records.filter((r) => r.kind === 'user').map((r) => r.turnIndex);
    expect(byTurn).toEqual([0, 1, 2]);
    // each turn keeps its own duration
    expect(s.turns.map((t) => t.durationMs)).toEqual([1000, 2000, 3000]);
  });

  it('P2: turn usage stays undefined when the source reported none', () => {
    const s = run([
      user('q', '2026-01-01T00:00:00.000Z'),
      { type: 'assistant', uuid: 'a', sessionId: 'c1', timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'a' }] } },
      { type: 'system', subtype: 'turn_duration', durationMs: 900, timestamp: '2026-01-01T00:00:02.000Z' },
    ]);
    const end = s.records.find((r) => r.kind === 'turn-end')!;
    expect(end.usage).toBeUndefined();
  });

  it('closes an unterminated turn as interrupted (crash repair)', () => {
    const s = run([
      user('hi', '2026-01-01T00:00:00.000Z'),
      assistant([{ type: 'text', text: 'partial' }], '2026-01-01T00:00:01.000Z'),
    ]);
    expect(s.turns.some((t) => t.endReason === 'interrupted')).toBe(true);
  });

  it('ignores isMeta system injections as user turns', () => {
    const s = run([
      user('real', '2026-01-01T00:00:00.000Z'),
      { type: 'user', uuid: 'm', sessionId: 'c1', timestamp: '2026-01-01T00:00:00.500Z', isMeta: true,
        message: { role: 'user', content: 'injected system note' } },
    ]);
    const users = s.records.filter((r) => r.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].detailText).toBe('real');
  });

  it('survives a corrupt line and counts it', () => {
    const buf = Buffer.from(JSON.stringify(user('a', '2026-01-01T00:00:00.000Z')) + '\n{ oops\n'
      + JSON.stringify(user('b', '2026-01-01T00:00:02.000Z')) + '\n');
    const s = normalizeClaude(REF, splitLines(buf));
    expect(s.diagnostics.badLineCount).toBe(1);
    expect(s.records.filter((r) => r.kind === 'user')).toHaveLength(2);
  });
});
