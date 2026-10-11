/**
 * Navigation history for the viewer.
 *
 * The trajectory viewer is a graph, not a list: a tool call opens the subagent session it
 * spawned, that session has its own tool calls, and the timeline jumps around inside one
 * session. Retracing that by hand means remembering ids, so ← / → walk a stack of points.
 *
 * Kept as pure functions (and tested) because the React plumbing around them is hard to
 * exercise: the interesting rules are "re-selecting where you already are must not grow the
 * stack", "a new jump drops the abandoned future", and the two disable conditions.
 *
 * `S` is the caller's source-id union. It stays generic so this module needs no knowledge
 * of the app's sources and the caller keeps its narrow type instead of casting.
 */

export interface NavPoint<S extends string = string> {
  source: S;
  sessionId: string;
  /** The record the point was scrolled to, or null for "top of the session". */
  recordId: string | null;
}

export interface NavState<S extends string = string> {
  stack: Array<NavPoint<S>>;
  /** Cursor into `stack`; -1 means nothing visited yet. */
  idx: number;
}

export const EMPTY_NAV: NavState<any> = { stack: [], idx: -1 };

/** Clicking rows inside one long session must not grow the stack without bound. */
export const NAV_MAX = 100;

export function samePoint<S extends string>(a: NavPoint<S> | undefined, b: NavPoint<S>): boolean {
  return !!a && a.source === b.source && a.sessionId === b.sessionId
    && (a.recordId ?? null) === (b.recordId ?? null);
}

/** Record a jump, dropping anything after the cursor (the future the user abandoned). */
export function pushPoint<S extends string>(nav: NavState<S>, p: NavPoint<S>): NavState<S> {
  if (samePoint(nav.stack[nav.idx], p)) return nav;
  const stack = [...nav.stack.slice(0, nav.idx + 1), p].slice(-NAV_MAX);
  return { stack, idx: stack.length - 1 };
}

export const canBack = <S extends string>(nav: NavState<S>): boolean => nav.idx > 0;
export const canForward = <S extends string>(nav: NavState<S>): boolean =>
  nav.idx < nav.stack.length - 1;

/**
 * Move the cursor one step. Returns the point to open, or null when already at the end —
 * in which case the state is returned unchanged so callers can skip the work.
 */
export function stepBack<S extends string>(nav: NavState<S>): { nav: NavState<S>; point: NavPoint<S> | null } {
  if (!canBack(nav)) return { nav, point: null };
  const idx = nav.idx - 1;
  return { nav: { stack: nav.stack, idx }, point: nav.stack[idx] };
}

export function stepForward<S extends string>(nav: NavState<S>): { nav: NavState<S>; point: NavPoint<S> | null } {
  if (!canForward(nav)) return { nav, point: null };
  const idx = nav.idx + 1;
  return { nav: { stack: nav.stack, idx }, point: nav.stack[idx] };
}
