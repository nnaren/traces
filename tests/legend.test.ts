import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGEND, LEGEND_KINDS, STRUCTURAL_KINDS, allHidden, isGroupHidden, toggleGroup } from '../web/lib/legend.ts';

/**
 * The legend doubles as the kind filter, so a wrong mapping fails quietly: a label bound to
 * a kind nothing emits simply stops filtering, and a kind omitted from every group can
 * never be shown again once hidden. These tests pin the mapping against the kinds the
 * normalizers actually produce.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const normDir = path.join(REPO, 'src', 'normalize');

/** Record kinds the normalizers emit, read from the union in types.ts. */
function declaredKinds(): string[] {
  const ts = readFileSync(path.join(REPO, 'src', 'types.ts'), 'utf8');
  const m = /export type NormRecordKind =([\s\S]*?);/.exec(ts);
  expect(m, 'NormRecordKind union not found').toBeTruthy();
  return [...m![1].matchAll(/'([\w-]+)'/g)].map((x) => x[1]);
}

/**
 * Map every selector to its declaration block, splitting comma-grouped selector lists.
 *
 * Splitting matters: `context` and `compacted` share one block
 * (`.tl-span[…'context'], .tl-span[…'compacted']{…}`), so a naive `selector{` match finds
 * neither and the checks below would silently skip them.
 */
function cssRules(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const sel of m[1].split(',')) {
      const key = sel.trim();
      if (key) out.set(key, m[2]);
    }
  }
  return out;
}

describe('legend mapping', () => {
  it('covers every content kind the normalizers can emit', () => {
    const known = new Set(declaredKinds());
    const missing = [...known].filter((k) => !LEGEND_KINDS.includes(k) && !STRUCTURAL_KINDS.includes(k));
    // A kind in neither list is invisible to the filter: once hidden it could never come
    // back, and its swatch would have no legend entry.
    expect(missing, 'kinds with no legend switch and not marked structural').toEqual([]);
  });

  it('does not invent kinds that no normalizer emits', () => {
    const known = new Set(declaredKinds());
    const bogus = LEGEND_KINDS.filter((k) => !known.has(k));
    expect(bogus, 'legend references kinds that do not exist').toEqual([]);
  });

  /**
   * Structural kinds stay permanently visible: hiding a turn boundary leaves its records
   * looking unordered, and `request-header` names the model and parameters behind a step.
   */
  it('keeps structural kinds out of the legend', () => {
    for (const k of STRUCTURAL_KINDS) expect(LEGEND_KINDS).not.toContain(k);
  });

  it('has no kind claimed by two groups', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const g of LEGEND) {
      for (const k of g.kinds) {
        if (seen.has(k)) dupes.push(`${k}: ${seen.get(k)} + ${g.label}`);
        seen.set(k, g.label);
      }
    }
    // Two switches owning one kind would fight: turning one off would look like the other
    // had failed.
    expect(dupes).toEqual([]);
  });

  /**
   * Every swatch class must exist, or the legend shows an unstyled box. The colours are
   * also what tie the legend to the strip, so a missing one is a real loss of meaning.
   */
  it('has a stylesheet rule for every swatch class', () => {
    const rules = cssRules(readFileSync(path.join(REPO, 'web', 'styles.css'), 'utf8'));
    for (const g of LEGEND) {
      expect(rules.has(`.sw.${g.sw}`), `missing .sw.${g.sw} in styles.css`).toBe(true);
    }
  });

  /**
   * The legend's job is to predict the strip. A swatch whose colour (or opacity) differs
   * from the block it stands for is worse than no legend at all — the hook swatch was once
   * a hollow ring while its block was a solid faded bar, so the two could not be matched up.
   */
  it('paints every swatch in the same colour the timeline uses for that kind', () => {
    const rules = cssRules(readFileSync(path.join(REPO, 'web', 'styles.css'), 'utf8'));
    // The swatch paints via `background`, the block via its `--bar` custom property. Two
    // extractors, because reading a block with the swatch's pattern silently yields
    // `undefined` for every kind and the comparison then "passes" on garbage.
    const swatchColor = (body: string) => /background:\s*var\((--[\w-]+)\)/.exec(body)?.[1];
    const barColor = (body: string) => /--bar:\s*var\((--[\w-]+)\)/.exec(body)?.[1];
    const opacityOf = (body: string) => /(?:^|;)\s*opacity:\s*([\d.]+)/.exec(body)?.[1] ?? '1';
    const mismatches: string[] = [];

    for (const g of LEGEND) {
      const swatch = rules.get(`.sw.${g.sw}`);
      expect(swatch, `.sw.${g.sw} not found`).toBeTruthy();
      expect(swatchColor(swatch!), `.sw.${g.sw} has no background colour`).toBeTruthy();
      for (const kind of g.kinds) {
        // The block rule is lane-scoped; the lane is an implementation detail here, so any
        // lane matching this kind counts.
        const block = [...rules.entries()]
          .find(([sel]) => sel.startsWith('.tl-span[') && sel.includes(`[data-kind='${kind}']`))?.[1];
        expect(block, `no .tl-span rule for kind '${kind}'`).toBeTruthy();
        expect(barColor(block!), `.tl-span for '${kind}' has no --bar colour`).toBeTruthy();
        if (swatchColor(swatch!) !== barColor(block!)) {
          mismatches.push(`${g.label}/${kind}: swatch ${swatchColor(swatch!)} vs strip ${barColor(block!)}`);
        }
        if (opacityOf(swatch!) !== opacityOf(block!)) {
          mismatches.push(`${g.label}/${kind}: swatch opacity ${opacityOf(swatch!)} vs strip ${opacityOf(block!)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('exposes every group kind in LEGEND_KINDS', () => {
    expect([...LEGEND_KINDS].sort()).toEqual(LEGEND.flatMap((g) => [...g.kinds]).sort());
  });
});

describe('group toggling', () => {
  const ctx = LEGEND.find((g) => g.label === '上下文')!;

  it('starts fully visible', () => {
    for (const g of LEGEND) expect(isGroupHidden(g, new Set())).toBe(false);
    expect(allHidden(new Set())).toBe(false);
  });

  // `上下文` covers two kinds; hiding must take both, or the ledger keeps showing 压缩 rows
  // after the user switched off the only label that mentions them.
  it('hides every kind in a multi-kind group in one click', () => {
    const next = toggleGroup(new Set(), ctx);
    expect([...next].sort()).toEqual(['compacted', 'context']);
    expect(isGroupHidden(ctx, next)).toBe(true);
  });

  it('restores the whole group on the next click', () => {
    const hidden = toggleGroup(new Set(), ctx);
    const shown = toggleGroup(hidden, ctx);
    expect(shown.size).toBe(0);
    expect(isGroupHidden(ctx, shown)).toBe(false);
  });

  /**
   * A half-hidden group must still read as ON and restore on click — otherwise it takes two
   * clicks to bring back, which feels like a stuck control.
   */
  it('treats a partially hidden group as on, and hides the rest when clicked', () => {
    const partial = new Set(['context']);
    expect(isGroupHidden(ctx, partial)).toBe(false);
    const next = toggleGroup(partial, ctx);
    expect([...next].sort()).toEqual(['compacted', 'context']);
  });

  it('does not mutate the set it is given', () => {
    const before = new Set(['tool']);
    toggleGroup(before, LEGEND.find((g) => g.label === '工具')!);
    expect([...before]).toEqual(['tool']);
  });

  it('reports all-hidden only when every filterable kind is off', () => {
    const everything = new Set(LEGEND_KINDS);
    expect(allHidden(everything)).toBe(true);
    const almost = new Set(LEGEND_KINDS.filter((k) => k !== 'hook'));
    expect(allHidden(almost)).toBe(false);
  });

  // Structural kinds are not switchable, so they must never count toward "all hidden".
  it('ignores structural kinds when deciding all-hidden', () => {
    const set = new Set([...LEGEND_KINDS, ...STRUCTURAL_KINDS]);
    expect(allHidden(set)).toBe(true);
  });
});