import { describe, expect, it } from 'vitest';
import { buildRows, TOOL_ONLY } from '../web/components/Ledger.tsx';
import type { RecordRow } from '../web/lib/api.ts';

/**
 * Ledger row construction for Claude Code.
 *
 * Claude emits an assistant message AND every tool_use block from one JSONL line, but as
 * separate records sharing a step. Rendered 1:1 that reads as "助手 / 工具" per step, and
 * two adjacent tool-only steps read as a run of bare "（仅工具调用）" 助手 rows — the
 * complaint this fold fixes.
 */

let n = 0;
function rec(p: Partial<RecordRow> & { kind: string; orderIndex: number }): RecordRow {
  return {
    recordId: p.recordId ?? 'r' + n++,
    timeSeconds: null, isError: false, usage: null, flags: [],
    summary: '', ...p,
  } as RecordRow;
}

const turns = [{ turn_index: 0, boundary_confidence: 'derived' }] as any[];
const steps = [
  { step_index: 0, turn_index: 0, boundary_confidence: 'derived' },
  { step_index: 1, turn_index: 0, boundary_confidence: 'derived' },
] as any[];

/** Records arrive DESCENDING by order_index, matching the API page order. */
const desc = (rs: RecordRow[]) => [...rs].sort((a, b) => b.orderIndex - a.orderIndex);

describe('ledger: folding Claude tool records into their message', () => {
  it('folds a tool-only message and its tool into ONE row', () => {
    const records = desc([
      rec({ kind: 'user', orderIndex: 0, summary: 'go' }),
      rec({ kind: 'message', orderIndex: 1, stepIndex: 1, turnIndex: 0, summary: TOOL_ONLY }),
      rec({ kind: 'tool', orderIndex: 1.001, stepIndex: 1, turnIndex: 0, summary: 'Bash({"command":"ls"})' }),
    ]);
    const rows = buildRows(records, turns, steps, true).filter((r) => r.kind === 'record');

    // user + folded message = 2 rows; the tool has none of its own.
    expect(rows).toHaveLength(2);
    const msg = rows.find((r) => r.record!.kind === 'message')!;
    expect(msg.attachedTools).toHaveLength(1);
    expect(msg.attachedTools![0].summary).toBe('Bash({"command":"ls"})');
    // Single-line row: the tool is promoted onto the summary line, so no chip line.
    expect(msg.height).toBe(26);
  });

  it('marks the folded row as a tool carrier so the row is taller when chips remain', () => {
    const records = desc([
      rec({ kind: 'message', orderIndex: 1, stepIndex: 1, turnIndex: 0,
        summary: '好的，我来读这几个文件' }),
      rec({ kind: 'tool', orderIndex: 1.001, stepIndex: 1, turnIndex: 0, summary: 'Read({"path":"/a"})' }),
      rec({ kind: 'tool', orderIndex: 1.002, stepIndex: 1, turnIndex: 0, summary: 'Read({"path":"/b"})' }),
    ]);
    const rows = buildRows(records, turns, steps, true).filter((r) => r.kind === 'record');
    expect(rows).toHaveLength(1);
    expect(rows[0].attachedTools).toHaveLength(2);
    // Text + tools: text stays on line 1, the two chips need the extra 22px line.
    expect(rows[0].height).toBe(26 + 22);
  });

  it('leaves records alone when mergeTools is off (Codex / DSH)', () => {
    const records = desc([
      rec({ kind: 'message', orderIndex: 1, stepIndex: 1, turnIndex: 0, summary: TOOL_ONLY }),
      rec({ kind: 'tool', orderIndex: 1.001, stepIndex: 1, turnIndex: 0, summary: 'bash({"cmd":"ls"})' }),
    ]);
    const rows = buildRows(records, turns, steps, false).filter((r) => r.kind === 'record');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.attachedTools === undefined)).toBe(true);
    expect(rows.every((r) => r.height === 26)).toBe(true);
  });

  it('only folds tools that follow a message in the SAME step', () => {
    const records = desc([
      // step 0 has a tool but no message -> nothing owns it, so it keeps its own row.
      rec({ kind: 'tool', orderIndex: 0.001, stepIndex: 0, turnIndex: 0, summary: 'Orphan({"a":1})' }),
      // step 1 has the message + its tool.
      rec({ kind: 'message', orderIndex: 1, stepIndex: 1, turnIndex: 0, summary: TOOL_ONLY }),
      rec({ kind: 'tool', orderIndex: 1.001, stepIndex: 1, turnIndex: 0, summary: 'Bash({"command":"ls"})' }),
    ]);
    const rows = buildRows(records, turns, steps, true).filter((r) => r.kind === 'record');
    const kinds = rows.map((r) => r.record!.kind).sort();
    expect(kinds).toEqual(['message', 'tool']);
    const orphan = rows.find((r) => r.record!.kind === 'tool')!;
    expect(orphan.record!.stepIndex).toBe(0);
    expect(rows.find((r) => r.record!.kind === 'message')!.attachedTools).toHaveLength(1);
  });

  it('does not let a tool jump the step boundary to a later message', () => {
    const records = desc([
      rec({ kind: 'message', orderIndex: 5, stepIndex: 1, turnIndex: 0, summary: TOOL_ONLY }),
      // Belongs to step 0, which has no message: must not be adopted by step 1's message.
      rec({ kind: 'tool', orderIndex: 4, stepIndex: 0, turnIndex: 0, summary: 'Bash({"command":"old"})' }),
    ]);
    const rows = buildRows(records, turns, steps, true).filter((r) => r.kind === 'record');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.record!.kind === 'message')!.attachedTools).toBeUndefined();
  });
});
