import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.ts';
import { cleanup, tempDir } from './helpers.ts';
import type { NormSession, SourceId } from '../src/types.ts';

/**
 * The queries behind the header's subagent menu.
 *
 * The menu is server-resolved for the same reason the inspector's jump links are: the
 * browser's session list is capped by `limit` and ordered by time, so a child can be missing
 * from it while being perfectly present in the store — "5 个子智能体" that lists four, or a
 * subagent that exists but cannot be opened. These tests pin the three facts the menu shows
 * per child: who it is, what it cost, and whether it spawned children of its own.
 *
 * A "child" here is whatever the store says it is, so the fixtures are built as normalized
 * sessions rather than raw source logs — the parent link itself is covered by the per-source
 * tests (dshSubagent / codexSubagent / claudeSubagent), which is where it is actually parsed.
 */

const dir = await tempDir('subagent-menu');
afterAll(() => cleanup(dir));

const T0 = 1_700_000_000_000;

function session(over: Partial<NormSession> & { sessionId: string }): NormSession {
  return {
    source: 'codex' as SourceId,
    capabilities: {} as any,
    turns: [], steps: [], records: [], diagnostics: {} as any,
    startedAt: T0, ...over,
  };
}

/** One assistant message carrying a usage total — the shape every source normalizes to. */
function modelRecord(id: string, orderIndex: number, totalTokens: number) {
  return {
    recordId: id, kind: 'message' as const, orderIndex,
    text: 'answer ' + id, flags: [], timeSeconds: 1,
    usage: { totalTokens, inputTokens: totalTokens, outputTokens: 0, scope: 'turn' } as any,
  };
}

/** The turn boundary: codex and claude report usage HERE and nowhere else. */
function turnEndRecord(id: string, orderIndex: number, totalTokens: number) {
  return {
    recordId: id, kind: 'turn-end' as const, orderIndex,
    text: '', flags: [], timeSeconds: null,
    usage: { totalTokens, inputTokens: totalTokens, outputTokens: 0, scope: 'turn' } as any,
  };
}

let seq = 0;
async function storeWith(sessions: NormSession[]): Promise<Store> {
  // One store per test: `Store.open` refuses a foreign DB, and these write tiny fixtures.
  const sub = dir + '/s' + (seq++);
  const s = await Store.open(sub);
  for (const n of sessions) s.writeSession(n, '/vault/' + n.sessionId + '.jsonl', '/fake/' + n.sessionId + '.jsonl');
  return s;
}

describe('childSessions — the menu list', () => {
  const kids = [
    session({ sessionId: 'c2', parentSessionId: 'P', agentNickname: 'ReviewTask-2', startedAt: T0 + 2000 }),
    session({ sessionId: 'c1', parentSessionId: 'P', agentNickname: 'ReviewTask-1', startedAt: T0 + 1000 }),
    session({ sessionId: 'c3', parentSessionId: 'P', agentNickname: 'review-filter', startedAt: T0 + 3000 }),
    // A child of ANOTHER parent, and a grandchild of P's own child — neither belongs in P's
    // direct list, and mixing them in is how a menu ends up offering sessions that do not
    // belong to the conversation being read.
    session({ sessionId: 'x1', parentSessionId: 'Q', agentNickname: 'other' }),
    session({ sessionId: 'g1', parentSessionId: 'c1', agentNickname: 'grandchild', startedAt: T0 + 1500 }),
  ];

  it('returns the direct children, in the order the parent delegated', async () => {
    const s = await storeWith([session({ sessionId: 'P' }), ...kids]);
    expect(s.childSessions('codex', 'P').map((r: any) => r.session_id)).toEqual(['c1', 'c2', 'c3']);
    s.close();
  });

  it('excludes a child of a different parent and a grandchild', async () => {
    const s = await storeWith([session({ sessionId: 'P' }), session({ sessionId: 'Q' }), ...kids]);
    const ids = s.childSessions('codex', 'P').map((r: any) => r.session_id);
    expect(ids).not.toContain('x1');
    expect(ids).not.toContain('g1');
    s.close();
  });

  it('never mixes sources: the same parent id under codex is not a dsh conversation', async () => {
    const s = await storeWith([
      session({ sessionId: 'P', source: 'dsh' }),
      session({ sessionId: 'c1', source: 'dsh', parentSessionId: 'P' }),
      session({ sessionId: 'c1', source: 'codex', parentSessionId: 'P' }),
    ]);
    expect(s.childSessions('dsh', 'P').map((r: any) => r.session_id)).toEqual(['c1']);
    expect(s.childSessions('codex', 'P').map((r: any) => r.session_id)).toEqual(['c1']);
    s.close();
  });

  it('is empty, not an error, for a session that spawned nothing', async () => {
    const s = await storeWith([session({ sessionId: 'solo' })]);
    expect(s.childSessions('codex', 'solo')).toEqual([]);
    s.close();
  });
});

describe('sessionUsageTotals — the tok column', () => {
  it('sums every usage-bearing record in the session', async () => {
    const s = await storeWith([
      session({ sessionId: 'a', records: [modelRecord('r1', 0, 100), modelRecord('r2', 1, 250)] }),
      session({ sessionId: 'b', records: [modelRecord('r3', 0, 7)] }),
    ]);
    const totals = s.sessionUsageTotals('codex', ['a', 'b']);
    expect(totals.get('a')).toBe(350);
    expect(totals.get('b')).toBe(7);
    s.close();
  });

  /**
   * The dash-vs-zero distinction: every claude-code session in this store reports no usage at
   * all. Mapping those to 0 would claim they cost nothing, which is not what "not reported"
   * means, so they are simply absent from the map.
   */
  it('leaves a session with no usage rows absent rather than reporting zero', async () => {
    const s = await storeWith([
      session({ sessionId: 'quiet', records: [{ recordId: 'r', kind: 'message', orderIndex: 0, text: 'x', flags: [], timeSeconds: null }] }),
    ]);
    const totals = s.sessionUsageTotals('codex', ['quiet']);
    expect(totals.has('quiet')).toBe(false);
    expect(totals.get('quiet')).toBeUndefined();
    s.close();
  });

  /**
   * `json_extract` THROWS on malformed JSON, which would take the whole menu down over one
   * bad row — so the aggregate is guarded rather than trusting every source's payload.
   */
  it('survives a usage blob that is not valid JSON', async () => {
    const s = await storeWith([
      session({ sessionId: 'a', records: [modelRecord('r1', 0, 100)] }),
      session({ sessionId: 'b', records: [modelRecord('r2', 0, 5)] }),
    ]);
    // Corrupt one row the way a hand-edited or truncated payload would.
    (s as any).db.prepare("UPDATE records SET usage_json='{not json' WHERE session_id='b'").run();
    const totals = s.sessionUsageTotals('codex', ['a', 'b']);
    expect(totals.get('a')).toBe(100);
    expect(totals.has('b')).toBe(false);
    s.close();
  });

  /**
   * REGRESSION, and the reason this aggregate is not a one-liner: dsh reports usage on every
   * `message` AND repeats the turn's running total on `turn-end`. Summing both counted the
   * 18.5M-token review subagent here as 37M — exactly double, and visibly inconsistent with
   * what the same session costs in the source's own UI.
   */
  it('does not double-count a dsh turn-end, which repeats the turn total', async () => {
    const s = await storeWith([
      session({
        sessionId: 'dsh-like',
        source: 'dsh',
        records: [
          modelRecord('m1', 0, 100), modelRecord('m2', 1, 250),
          turnEndRecord('end', 2, 350),   // the same 350, repeated by the boundary
        ],
      }),
    ]);
    expect(s.sessionUsageTotals('dsh', ['dsh-like']).get('dsh-like')).toBe(350);
    s.close();
  });

  /**
   * The other half of the same fix: codex and claude-code report usage ONLY on boundaries.
   * Excluding `turn-end` to fix dsh would have made every one of their sessions read as no
   * usage at all — 116 claude-code and 424 codex sessions here.
   */
  it('still counts a codex/claude session, whose usage is only on the turn boundary', async () => {
    const s = await storeWith([
      session({ sessionId: 'codex-like', source: 'codex', records: [turnEndRecord('e1', 0, 449_255)] }),
      session({ sessionId: 'claude-like', source: 'claude-code', records: [turnEndRecord('e2', 0, 20_091_446)] }),
    ]);
    expect(s.sessionUsageTotals('codex', ['codex-like']).get('codex-like')).toBe(449_255);
    expect(s.sessionUsageTotals('claude-code', ['claude-like']).get('claude-like')).toBe(20_091_446);
    s.close();
  });

  /** Several turns: each boundary repeats only its OWN turn, so they must all still sum. */
  it('sums every turn boundary of a multi-turn codex session', async () => {
    const s = await storeWith([
      session({ sessionId: 'multi', source: 'codex', records: [
        turnEndRecord('e1', 0, 100), turnEndRecord('e2', 1, 250), turnEndRecord('e3', 2, 50),
      ] }),
    ]);
    expect(s.sessionUsageTotals('codex', ['multi']).get('multi')).toBe(400);
    s.close();
  });

  it('answers for an empty id list without touching the database', async () => {
    const s = await storeWith([session({ sessionId: 'a', records: [modelRecord('r', 0, 3)] })]);
    expect(s.sessionUsageTotals('codex', []).size).toBe(0);
    s.close();
  });
});

describe('childCounts — the "N 个子代理" suffix', () => {
  it('counts each listed session\'s own children in one pass', async () => {
    const s = await storeWith([
      session({ sessionId: 'P' }),
      session({ sessionId: 'c1', parentSessionId: 'P', startedAt: T0 + 1000 }),
      session({ sessionId: 'c2', parentSessionId: 'P', startedAt: T0 + 2000 }),
      session({ sessionId: 'g1', parentSessionId: 'c1', startedAt: T0 + 1500 }),
      session({ sessionId: 'g2', parentSessionId: 'c1', startedAt: T0 + 1600 }),
      session({ sessionId: 'leaf', parentSessionId: 'P', startedAt: T0 + 3000 }),
    ]);
    const counts = s.childCounts('codex', ['c1', 'c2', 'leaf']);
    expect(counts.get('c1')).toBe(2);
    // Children with none are absent, so the caller can render "—"/nothing rather than a 0
    // that reads like "spawned zero subagents, successfully".
    expect(counts.has('c2')).toBe(false);
    expect(counts.has('leaf')).toBe(false);
    s.close();
  });
});
