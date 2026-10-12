import { describe, expect, it } from 'vitest';
import { ancestorsOf, buildSessionTree, collectBranch, countDescendants, flattenTree } from '../web/lib/sessionTree.ts';
import type { SessionRow } from '../web/lib/api.ts';

/**
 * Grouping the session list by spawn parent.
 *
 * The shape is measured from this machine's codex rollouts: 177 subagents under 55 parents,
 * nesting to depth 4, and 33 children on a single parent. Critically, 28 subagents carry
 * `parentSessionId` but NO `subagentDepth` (the "guardian" spawns), so placement has to key
 * off the parent link — using depth would silently scatter them back to the top level.
 */

let seq = 0;
function s(over: Partial<SessionRow> = {}): SessionRow {
  return {
    source: 'codex', sessionId: 's' + (seq++), capabilities: {} as any, diagnostics: {},
    recordCount: 1, turnCount: 1, stepCount: 1, ...over,
  };
}
const id = (n: SessionNodeId) => n.session.sessionId;
type SessionNodeId = { session: SessionRow };

describe('buildSessionTree', () => {
  it('nests a subagent under the conversation that spawned it', () => {
    const parent = s({ sessionId: 'P' });
    const child = s({ sessionId: 'C', parentSessionId: 'P', agentNickname: 'Sagan', subagentDepth: 1 });
    const roots = buildSessionTree([parent, child]);
    expect(roots).toHaveLength(1);
    expect(id(roots[0])).toBe('P');
    expect(roots[0].children.map(id)).toEqual(['C']);
  });

  it('leaves a root conversation at the top level', () => {
    const roots = buildSessionTree([s({ sessionId: 'P' })]);
    expect(roots.map(id)).toEqual(['P']);
  });

  /**
   * The one outcome worse than the old flat list: `/api/sessions` is capped by `limit`, so a
   * subagent can be present while its parent is not. NESTING an orphan would drop it from
   * the UI entirely, so an absent parent must leave the session at the top level.
   */
  it('keeps an orphan at the top level when its parent was not loaded', () => {
    const orphan = s({ sessionId: 'C', parentSessionId: 'P-missing' });
    const roots = buildSessionTree([orphan]);
    expect(roots.map(id)).toEqual(['C']);
  });

  it('nests to depth 4, matching the deepest codex spawn chain', () => {
    const chain = ['A', 'B', 'C', 'D', 'E'].map((x, i) =>
      s({ sessionId: x, parentSessionId: i === 0 ? undefined : ['A', 'B', 'C', 'D'][i - 1], subagentDepth: i }));
    const roots = buildSessionTree(chain);
    expect(roots).toHaveLength(1);
    expect(countDescendants(roots[0])).toBe(4);
  });

  /** 28 of 177 subagents have a parent but no depth — they must still nest. */
  it('nests a subagent that has no recorded depth (guardian spawns)', () => {
    const roots = buildSessionTree([
      s({ sessionId: 'P' }),
      s({ sessionId: 'C', parentSessionId: 'P', subagentDepth: null }),
    ]);
    expect(roots[0].children.map(id)).toEqual(['C']);
  });

  it('treats a self-parent as a root instead of recursing forever', () => {
    const roots = buildSessionTree([s({ sessionId: 'X', parentSessionId: 'X' })]);
    expect(roots.map(id)).toEqual(['X']);
  });

  it('breaks a parent cycle without losing either session', () => {
    const roots = buildSessionTree([
      s({ sessionId: 'A', parentSessionId: 'B' }),
      s({ sessionId: 'B', parentSessionId: 'A' }),
    ]);
    const flat = JSON.stringify(roots);
    expect(flat).toContain('"A"');
    expect(flat).toContain('"B"');
  });

  it('preserves input order among siblings', () => {
    const roots = buildSessionTree([
      s({ sessionId: 'P' }),
      s({ sessionId: 'c1', parentSessionId: 'P' }),
      s({ sessionId: 'c2', parentSessionId: 'P' }),
      s({ sessionId: 'c3', parentSessionId: 'P' }),
    ]);
    expect(roots[0].children.map(id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('groups many children under one parent (33 measured on this machine)', () => {
    const kids = Array.from({ length: 33 }, (_, i) => s({ sessionId: 'k' + i, parentSessionId: 'P' }));
    const roots = buildSessionTree([s({ sessionId: 'P' }), ...kids]);
    expect(roots[0].children).toHaveLength(33);
    expect(countDescendants(roots[0])).toBe(33);
  });
});

describe('flattenTree', () => {
  const tree = () => buildSessionTree([
    s({ sessionId: 'P' }),
    s({ sessionId: 'C', parentSessionId: 'P' }),
    s({ sessionId: 'G', parentSessionId: 'C' }),
  ]);

  it('reports nesting depth so the view can indent', () => {
    expect(flattenTree(tree(), () => false).map((r) => [id(r.node), r.depth])).toEqual([
      ['P', 0], ['C', 1], ['G', 2],
    ]);
  });

  it('hides the children of a collapsed node', () => {
    const rows = flattenTree(tree(), (id) => id === 'P');
    expect(rows.map((r) => id(r.node))).toEqual(['P']);
  });

  it('still shows a collapsed node\'s own children when the PARENT is open', () => {
    const rows = flattenTree(tree(), (id) => id === 'C');
    expect(rows.map((r) => id(r.node))).toEqual(['P', 'C']);
  });
});

describe('ancestorsOf', () => {
  const all = [
    s({ sessionId: 'P' }),
    s({ sessionId: 'C', parentSessionId: 'P' }),
    s({ sessionId: 'G', parentSessionId: 'C' }),
  ];

  /** A search hit on a subagent is useless if its collapsed parent hides it. */
  it('opens the whole ancestor chain of a match', () => {
    expect([...ancestorsOf([all[2]], all)].sort()).toEqual(['C', 'P']);
  });

  it('returns nothing for a root match', () => {
    expect(ancestorsOf([all[0]], all).size).toBe(0);
  });

  it('tolerates a match whose parent is absent', () => {
    expect(ancestorsOf([s({ sessionId: 'O', parentSessionId: 'nope' })], all).size).toBe(0);
  });

  /**
   * REGRESSION: the view fed `ancestorsOf(visible, sessions)` unconditionally. With no search
   * query `visible` IS every session, so every parent came back "forced open" and the collapse
   * control was inert — `isCollapsed` could never return true for a node with children.
   *
   * This pins the reason the caller must gate on an active query: for a full (unsearched)
   * list, the ancestor set of everything is every branch, which collapses nothing.
   */
  it('returns EVERY branch when given the whole list — which is why callers must gate on a query', () => {
    const open = ancestorsOf(all, all);
    expect([...open].sort()).toEqual(['C', 'P']);
  });
});

describe('collectBranch', () => {
  it('collects the node and every descendant, for collapse-all', () => {
    const roots = buildSessionTree([
      s({ sessionId: 'P' }),
      s({ sessionId: 'C', parentSessionId: 'P' }),
      s({ sessionId: 'G', parentSessionId: 'C' }),
      s({ sessionId: 'X' }),
    ]);
    const into = new Set<string>();
    collectBranch(roots[0], into);
    expect([...into].sort()).toEqual(['C', 'G', 'P']);
  });

  it('collecting from every root then collapses the whole list to its top level', () => {
    const roots = buildSessionTree([
      s({ sessionId: 'P' }),
      s({ sessionId: 'C', parentSessionId: 'P' }),
      s({ sessionId: 'G', parentSessionId: 'C' }),
      s({ sessionId: 'X' }),
    ]);
    const into = new Set<string>();
    for (const r of roots) collectBranch(r, into);
    expect(flattenTree(roots, (id) => into.has(id)).map((r) => r.node.session.sessionId))
      .toEqual(['P', 'X']);
  });
});