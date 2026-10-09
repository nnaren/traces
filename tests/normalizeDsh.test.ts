import { describe, expect, it } from 'vitest';
import { normalizeDsh, type DshRefusal } from '../src/normalize/dsh.ts';
import { splitLines } from '../src/sources/stableRead.ts';
import type { SessionRef } from '../src/types.ts';

const REF: SessionRef = { source: 'dsh', sessionId: 'd1', path: '/tmp/d1' };

let seq = 0;
const ev = (type: string, data: any, extra: any = {}) =>
  ({ type, seq: seq++, time: 1788518400000 + seq * 100, data, ...extra });
const header = { type: 'session', version: 3, id: 'd1', createdAt: 1788518400000, cwd: '/w' };

/** Run the normalizer over [header, ...events] and also return the refusal ledger. */
function run(events: any[], opts: { seq?: number } = {}): { s: ReturnType<typeof normalizeDsh>; refusals: DshRefusal[] } {
  seq = opts.seq ?? 0;
  const refusals: DshRefusal[] = [];
  const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
  const s = normalizeDsh(REF, splitLines(Buffer.from(lines.join('\n') + '\n')), refusals);
  return { s, refusals };
}

const userMsg = (turn: number, step: number, text: string) =>
  ev('user/message', { turn, step, message: { role: 'user', content: [{ type: 'text', text }] } });

describe('dsh normalization', () => {
  it('treats seq as the authoritative order even when time goes backwards', () => {
    const { s } = run([
      { type: 'turn/start', seq: 0, time: 1788518400000, data: { turn: 1 } },
      ev('user/message', { turn: 1, message: { role: 'user', content: [{ type: 'text', text: 'B' }] } }).constructor === Object
        ? { type: 'user/message', seq: 2, time: 1788518400500, data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: 'B' }] } } }
        : {},
      { type: 'user/message', seq: 1, time: 1788518400100, data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: 'A' }] } } },
    ], { seq: 3 });
    expect(s.capabilities.ordering).toBe('seq');
    const users = s.records.filter((r) => r.kind === 'user').map((r) => r.detailText);
    expect(users).toEqual(['A', 'B']);
  });

  it('marks turn and step boundaries as explicit (unlike codex/claude)', () => {
    const { s } = run([ev('turn/start', { turn: 1 }), ev('step/start', { turn: 1, step: 1 }), userMsg(1, 1, 'hi')]);
    expect(s.turns[0].boundaryConfidence).toBe('explicit');
    expect(s.steps[0].boundaryConfidence).toBe('explicit');
  });

  it('REFUSES an unknown non-ignorable event type (risk #12)', () => {
    const { s, refusals } = run([ev('mystery/event', { a: 1 })]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].type).toBe('mystery/event');
    expect(s.diagnostics.unknownTypeCount).toBeGreaterThan(0);
  });

  it('skips an unknown event marked ignorable', () => {
    const { s, refusals } = run([ev('plugin/thing', { a: 1 }, { ignorable: true }), ev('turn/start', { turn: 1 })]);
    expect(refusals).toHaveLength(0);
    expect(s.turns).toHaveLength(1);
  });

  it('KEEPS records in a shadowed range and flags them (surfaceOp replace)', () => {
    const { s } = run([
      ev('turn/start', { turn: 1 }),
      ev('user/message', { turn: 1, message: { role: 'user', content: [{ type: 'text', text: 'kept' }] } }),
      ev('compaction/prune', { shadowedSeqs: [1] }),
    ]);
    expect(s.records.some((r) => r.kind === 'user' && r.detailText === 'kept')).toBe(true);
    expect(s.records.filter((r) => r.flags.includes('shadowed')).length).toBeGreaterThan(0);
  });

  it('pairs tool/call with tool/result and derives duration', () => {
    const { s } = run([
      ev('turn/start', { turn: 1 }), ev('step/start', { turn: 1, step: 1 }),
      ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }),
      ev('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }], source: { callId: 'c1' } } }),
    ]);
    const tool = s.records.find((r) => r.kind === 'tool')!;
    expect(tool.tool!.outputText).toBe('ok');
    expect(tool.tool!.durationMs).toBeGreaterThan(0);
    expect(s.diagnostics.unresolvedCallCount).toBe(0);
  });

  it('R7: takes the model from request/context when Codex writes nothing', () => {
    const { s } = run([
      ev('turn/start', { turn: 1 }), ev('step/start', { turn: 1, step: 1 }),
      ev('request/context', { provider: 'minimax-cn', model: 'MiniMax-M3', contextWindow: 1000000 }),
    ]);
    expect(s.steps[0].model).toBe('MiniMax-M3');
  });

  it('renders model/selection and todo/write instead of refusing them', () => {
    const { s, refusals } = run([
      ev('turn/start', { turn: 1 }), ev('step/start', { turn: 1, step: 1 }),
      ev('model/selection', { provider: 'p', model: 'M' }),
      ev('todo/write', { todos: [{ status: 'pending', content: 'do it' }] }),
    ]);
    expect(refusals).toHaveLength(0);
    expect(s.records.some((r) => r.text.includes('model -> M'))).toBe(true);
    expect(s.records.some((r) => r.text.includes('do it'))).toBe(true);
  });

  it('R5: refuses an unknown header version instead of mis-parsing it', () => {
    const refusals: DshRefusal[] = [];
    seq = 0;
    const lines = [
      JSON.stringify({ type: 'session', version: 99, id: 'd1', createdAt: 1788518400000 }),
      JSON.stringify(ev('turn/start', { turn: 1 })),
    ];
    normalizeDsh(REF, splitLines(Buffer.from(lines.join('\n') + '\n')), refusals);
    expect(refusals.some((r) => r.type === 'session/unsupported-version')).toBe(true);
  });

  it('extracts readable text from a message envelope', () => {
    const { s } = run([ev('turn/start', { turn: 1 }), userMsg(1, 0, 'plain text')]);
    const u = s.records.find((r) => r.kind === 'user')!;
    expect(u.detailText).toBe('plain text');
  });

  it('closes an unterminated turn as interrupted', () => {
    const { s } = run([ev('turn/start', { turn: 1 }), userMsg(1, 0, 'hi')]);
    expect(s.turns.some((t) => t.endReason === 'interrupted')).toBe(true);
  });
});
