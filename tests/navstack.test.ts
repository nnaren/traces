import { describe, expect, it } from 'vitest';
import {
  EMPTY_NAV, canBack, canForward, pushPoint, samePoint, stepBack, stepForward,
  type NavPoint, type NavState,
} from '../web/lib/navstack.ts';

/**
 * The ← / → buttons walk a stack of visited places.
 *
 * These rules are the whole feature: a jump must not duplicate the current point, a new
 * jump must discard the abandoned future (or "forward" would lead somewhere the user never
 * went), and the two buttons must be disabled at the ends of the stack.
 */

const p = (sessionId: string, recordId: string | null = null): NavPoint =>
  ({ source: 'codex', sessionId, recordId });

/** Fold a list of jumps into the state the app would hold. */
const pushAll = (points: NavPoint[], from: NavState = EMPTY_NAV): NavState =>
  points.reduce((nav, point) => pushPoint(nav, point), from);

describe('navigation history', () => {
  it('starts empty with both directions disabled', () => {
    expect(EMPTY_NAV.stack).toHaveLength(0);
    expect(canBack(EMPTY_NAV)).toBe(false);
    expect(canForward(EMPTY_NAV)).toBe(false);
    expect(stepBack(EMPTY_NAV).point).toBeNull();
    expect(stepForward(EMPTY_NAV).point).toBeNull();
  });

  it('records a jump and enables only 后退', () => {
    const nav = pushAll([p('A')]);
    expect(nav.stack).toHaveLength(1);
    expect(nav.idx).toBe(0);
    expect(canBack(nav)).toBe(false);   // nowhere to go yet
    expect(canForward(nav)).toBe(false);
  });

  it('walks back and forward across sessions', () => {
    const nav = pushAll([p('A'), p('B'), p('C')]);
    expect(nav.idx).toBe(2);
    expect(canBack(nav)).toBe(true);
    expect(canForward(nav)).toBe(false);

    const b1 = stepBack(nav);
    expect(b1.point!.sessionId).toBe('B');
    const b2 = stepBack(b1.nav);
    expect(b2.point!.sessionId).toBe('A');
    expect(canBack(b2.nav)).toBe(false);

    const f1 = stepForward(b2.nav);
    expect(f1.point!.sessionId).toBe('B');
    expect(stepForward(f1.nav).point!.sessionId).toBe('C');
  });

  it('treats a record inside a session as its own point', () => {
    const nav = pushAll([p('A'), p('A', 'r1'), p('A', 'r2')]);
    expect(nav.stack).toHaveLength(3);
    expect(stepBack(nav).point!.recordId).toBe('r1');
    // ...and going back to the session top is distinct from its first record.
    const back = stepBack(stepBack(nav).nav);
    expect(back.point!.recordId).toBeNull();
  });

  it('does not grow the stack when the same place is selected again', () => {
    const nav = pushAll([p('A'), p('A', 'r1')]);
    const again = pushPoint(nav, p('A', 'r1'));
    expect(again).toBe(nav);              // same object: no re-render, no extra entry
    expect(again.stack).toHaveLength(2);
  });

  it('drops the abandoned future when jumping from the middle', () => {
    const nav = pushAll([p('A'), p('B'), p('C')]);
    const back = stepBack(nav);            // now at B, with C ahead
    const jumped = pushPoint(back.nav, p('D'));
    expect(jumped.stack.map((s) => s.sessionId)).toEqual(['A', 'B', 'D']);
    expect(canForward(jumped)).toBe(false); // C is gone, as in a browser
    expect(jumped.idx).toBe(2);
  });

  it('caps the stack so a long session of row-clicks cannot grow without bound', () => {
    let nav: NavState = EMPTY_NAV;
    for (let i = 0; i < 250; i++) nav = pushPoint(nav, p('A', 'r' + i));
    expect(nav.stack.length).toBeLessThanOrEqual(100);
    expect(nav.idx).toBe(nav.stack.length - 1);
    // The most recent points survive; the oldest are dropped.
    expect(nav.stack[nav.idx].recordId).toBe('r249');
  });

  it('compares points including the record', () => {
    expect(samePoint(p('A'), p('A'))).toBe(true);
    expect(samePoint(p('A', 'r1'), p('A', 'r1'))).toBe(true);
    expect(samePoint(p('A'), p('A', 'r1'))).toBe(false);
    expect(samePoint(p('A'), p('B'))).toBe(false);
    expect(samePoint(undefined, p('A'))).toBe(false);
  });

  it('never moves the cursor past either end', () => {
    const nav = pushAll([p('A')]);
    expect(stepBack(nav).nav.idx).toBe(0);
    expect(stepForward(nav).nav.idx).toBe(0);
  });
});
