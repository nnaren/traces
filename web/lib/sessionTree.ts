import type { SessionRow } from './api.ts';

/**
 * Parent/child grouping of the session list.
 *
 * A Codex subagent is a session in its own right (its own rollout file, its own id), so it
 * used to occupy a top-level card of its own — visually indistinguishable from a root
 * conversation apart from a small badge, and interleaved with unrelated work by time. The
 * spawn structure was in the data all along (`parentSessionId`) but never shaped the list.
 *
 * This module turns that flat list into a tree. It is deliberately pure and separate from
 * the component so the grouping rules — orphans, cycles, self-parents — can be tested
 * without a DOM.
 */

export interface SessionNode {
  session: SessionRow;
  children: SessionNode[];
}

/**
 * Group `sessions` under their spawning parent, preserving input order at every level.
 *
 * Four cases the data actually produces, each with a decided outcome:
 *
 *  1. Parent present in the list → nest under it (139 of 177 codex subagents).
 *  2. Parent absent → **stays a top-level card**. `/api/sessions` is capped by `limit`, so a
 *     subagent can easily outlive its parent's presence in the response. NESTING an orphan
 *     would delete it from the UI, which is the one outcome worse than the current flat list.
 *  3. `parentSessionId === sessionId` → treated as a root, not an infinitely deep child.
 *  4. A cycle (a → b → a) → the node that would close the loop is promoted to a root. The
 *     relation is corrupt data, but the session is still real and must stay reachable.
 *
 * `subagentDepth` is deliberately NOT used to decide placement: 28 of the 177 codex
 * subagents carry no depth at all (the "guardian" spawns record a parent but no depth), and
 * nesting is defined by the parent link itself.
 */
export function buildSessionTree(sessions: SessionRow[]): SessionNode[] {
  const byId = new Map<string, SessionRow>();
  for (const s of sessions) byId.set(s.sessionId, s);

  const nodeOf = new Map<string, SessionNode>();
  for (const s of sessions) nodeOf.set(s.sessionId, { session: s, children: [] });

  const roots: SessionNode[] = [];
  for (const s of sessions) {
    const node = nodeOf.get(s.sessionId)!;
    const parentId = s.parentSessionId;
    const parent = parentId && parentId !== s.sessionId ? byId.get(parentId) : undefined;
    if (!parent) {
      roots.push(node); // root conversation, or an orphan (case 2/3)
      continue;
    }
    // Walk up from the prospective parent; if we meet ourselves, this edge closes a cycle.
    let cursor: SessionRow | undefined = parent;
    let cyclic = false;
    for (let hops = 0; cursor; hops++) {
      if (cursor.sessionId === s.sessionId || hops > sessions.length) { cyclic = true; break; }
      const up: SessionRow | undefined = cursor.parentSessionId && cursor.parentSessionId !== cursor.sessionId
        ? byId.get(cursor.parentSessionId) : undefined;
      if (!up) break;
      cursor = up;
    }
    if (cyclic) roots.push(node);
    else nodeOf.get(parent.sessionId)!.children.push(node);
  }
  return roots;
}

/** Total sessions under a node, at every depth — for the "N 个子 agent" toggle count. */
export function countDescendants(node: SessionNode): number {
  let n = 0;
  for (const c of node.children) n += 1 + countDescendants(c);
  return n;
}

/**
 * Session ids that must be EXPANDED for `matches` to be visible.
 *
 * A search that hits a subagent but not its parent is the case that matters: the parent is
 * the top-level card, so a collapsed subtree would otherwise hide the only hit. Returns the
 * ancestor chain of every matched session.
 */
export function ancestorsOf(matches: SessionRow[], all: SessionRow[]): Set<string> {
  const byId = new Map<string, SessionRow>();
  for (const s of all) byId.set(s.sessionId, s);
  const open = new Set<string>();
  for (const m of matches) {
    let cursor: SessionRow | undefined = m;
    for (let hops = 0; cursor?.parentSessionId && hops <= all.length; hops++) {
      const parent = byId.get(cursor.parentSessionId);
      if (!parent || parent.sessionId === cursor.sessionId) break;
      open.add(parent.sessionId);
      cursor = parent;
    }
  }
  return open;
}

/** Every id in a subtree, the node included — for expand-all / collapse-all. */
export function collectBranch(node: SessionNode, into: Set<string>): Set<string> {
  into.add(node.session.sessionId);
  for (const c of node.children) collectBranch(c, into);
  return into;
}

/** Flatten a tree back to render order, skipping the children of collapsed nodes. */
export function flattenTree(
  roots: SessionNode[],
  isCollapsed: (sessionId: string) => boolean,
): Array<{ node: SessionNode; depth: number }> {
  const out: Array<{ node: SessionNode; depth: number }> = [];
  const walk = (nodes: SessionNode[], depth: number) => {
    for (const node of nodes) {
      out.push({ node, depth });
      if (node.children.length && !isCollapsed(node.session.sessionId)) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}