/**
 * The timeline/ledger legend, which doubles as the record-kind filter.
 *
 * Kept as plain data in its own module rather than inline in the component: the mapping
 * from a label to the record kinds it covers is the part that can be WRONG in a way nobody
 * notices — a label wired to a kind the normalizer never emits simply stops filtering
 * anything, and a kind omitted from every group can never be shown again once hidden.
 * As data it is directly testable.
 */

export interface LegendGroup {
  label: string;
  /** Record kinds this switch covers. */
  kinds: readonly string[];
  /** Swatch class; must have a matching `.sw.<name>` rule. */
  sw: string;
}

/**
 * `kinds` is a list because one label can cover several record kinds: `上下文` is
 * `context` + `compacted` (one colour, one lane), and `工具` covers nested sub-tools.
 * Splitting those would put two identical swatches in the legend.
 */
export const LEGEND: readonly LegendGroup[] = [
  { label: '系统', kinds: ['system'], sw: 'system' },
  { label: '用户', kinds: ['user'], sw: 'user' },
  { label: '上下文', kinds: ['context', 'compacted'], sw: 'context' },
  { label: '模型', kinds: ['message'], sw: 'model' },
  { label: '工具', kinds: ['tool', 'subtool'], sw: 'tool' },
  { label: '推理', kinds: ['reasoning'], sw: 'reasoning' },
  { label: '钩子', kinds: ['hook'], sw: 'hook' },
];

/** Every kind any legend switch can control. */
export const LEGEND_KINDS: readonly string[] = LEGEND.flatMap((g) => g.kinds);

/**
 * Kinds that carry structure rather than content, and therefore have NO legend entry.
 *
 * They must stay permanently visible: hiding a turn boundary leaves its records looking
 * unordered, and `request-header` is the record that tells the reader which model and
 * parameters produced the step. None of them is something a reader wants less of.
 */
export const STRUCTURAL_KINDS: readonly string[] = ['turn-end', 'session-end', 'request-header'];

/** A group reads as off only when EVERY kind it covers is hidden. */
export function isGroupHidden(group: LegendGroup, hidden: ReadonlySet<string>): boolean {
  return group.kinds.every((k) => hidden.has(k));
}

/**
 * Toggle one group.
 *
 * Group semantics rather than per-kind: if the whole group is already hidden the click
 * restores it, otherwise it hides it. Toggling kind-by-kind would make a partially hidden
 * group need two clicks to come back, which reads as a stuck control.
 */
export function toggleGroup(hidden: ReadonlySet<string>, group: LegendGroup): Set<string> {
  const next = new Set(hidden);
  if (isGroupHidden(group, hidden)) for (const k of group.kinds) next.delete(k);
  else for (const k of group.kinds) next.add(k);
  return next;
}

/** True when every filterable kind is hidden and the views have nothing left to draw. */
export function allHidden(hidden: ReadonlySet<string>): boolean {
  return LEGEND_KINDS.every((k) => hidden.has(k));
}