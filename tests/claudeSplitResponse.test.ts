import { describe, expect, it } from 'vitest';
import { normalizeClaude } from '../src/normalize/claude.ts';
import { splitLines } from '../src/sources/stableRead.ts';
import type { SessionRef } from '../src/types.ts';

/**
 * Claude Code writes ONE API response as TWO adjacent `assistant` JSONL lines:
 * a line with the thinking/text blocks, then a line with the tool_use blocks.
 *
 * Measured on this machine's logs, the pair carries an identical `message.id`, identical
 * `usage`, identical `stop_reason`, and the second line's `parentUuid` is the first line's
 * `uuid` — so it is one model call. Giving each line its own step split a single assistant
 * turn into "助手（无内容）" plus an orphan "助手 Write{…}" row that the ledger's
 * same-step fold could never reunite.
 */

const REF: SessionRef = { source: 'claude-code', sessionId: 'c1', path: '/tmp/c1.jsonl' };
const run = (lines: any[]) =>
  normalizeClaude(REF, splitLines(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')));

const USAGE = {
  input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 0,
  output_tokens: 40, output_tokens_details: { thinking_tokens: 12 },
};

const user = (t: string, ts: string) => ({
  type: 'user', uuid: 'u' + ts, parentUuid: null, sessionId: 'c1', cwd: '/w',
  timestamp: ts, message: { role: 'user', content: t },
});

/** One line of an assistant response. `msgId` groups the lines of a single API response. */
const asst = (blocks: any[], ts: string, msgId: string, parentUuid: string | null, usage: any = USAGE) => ({
  type: 'assistant', uuid: 'a' + ts, parentUuid, sessionId: 'c1', cwd: '/w', timestamp: ts,
  message: { id: msgId, role: 'assistant', model: 'claude-x', stop_reason: 'tool_use', usage, content: blocks },
});

describe('claude: one API response split across assistant lines', () => {
  const T = (n: number) => `2026-01-01T00:00:0${n}.000Z`;

  it('merges a reasoning line and its tool_use line into ONE step and ONE row', () => {
    const s = run([
      user('save it', T(0)),
      asst([{ type: 'thinking', thinking: 'I should write the file' }], T(1), 'msg_A', 'u' + T(0)),
      asst([{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/out/005.md' } }],
        T(2), 'msg_A', 'a' + T(1)),
    ]);

    // One model call -> one step.
    expect(s.steps).toHaveLength(1);

    const msgs = s.records.filter((r) => r.kind === 'message' || r.kind === 'reasoning');
    expect(msgs).toHaveLength(1);
    // Reasoning-only response is labelled 推理, never a contentless "（无内容）" 助手 row.
    expect(msgs[0].kind).toBe('reasoning');
    expect(msgs[0].detailText).toBe('I should write the file');
    // ...and the ROW SUMMARY must still carry that reasoning. Folding the tool in used to
    // overwrite `text` with the "（仅工具调用）" placeholder, leaving the merged row showing
    // nothing but the tool call — exactly what the merge was supposed to stop.
    expect(msgs[0].text).toBe('I should write the file');
    expect(msgs[0].text).not.toBe('（仅工具调用）');

    // The tool sits in the SAME step as the message that issued it, so the ledger can fold it.
    const tool = s.records.find((r) => r.kind === 'tool')!;
    expect(tool.stepIndex).toBe(msgs[0].stepIndex);
    expect(tool.orderIndex).toBeGreaterThan(msgs[0].orderIndex);
    expect(tool.toolName).toBe('Write');
  });

  it('keeps assistant text and the tool call in one row when text comes first', () => {
    const s = run([
      user('go', T(0)),
      asst([{ type: 'text', text: 'Saving that now.' }], T(1), 'msg_B', 'u' + T(0)),
      asst([{ type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: '/out/x.md' } }],
        T(2), 'msg_B', 'a' + T(1)),
    ]);

    expect(s.steps).toHaveLength(1);
    const msgs = s.records.filter((r) => r.kind === 'message');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].detailText).toBe('Saving that now.');
    expect(s.records.find((r) => r.kind === 'tool')!.stepIndex).toBe(msgs[0].stepIndex);
  });

  it('counts the shared usage ONCE, not once per line', () => {
    const s = run([
      user('go', T(0)),
      asst([{ type: 'thinking', thinking: 'think' }], T(1), 'msg_C', 'u' + T(0)),
      asst([{ type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'ls' } }], T(2), 'msg_C', 'a' + T(1)),
    ]);

    const turn = s.turns[0] as any;
    // The turn aggregate is folded onto the turn-end record; read it from there.
    const end: any = s.records.find((r) => r.kind === 'turn-end');
    const usage = end?.usage ?? turn.usage;
    if (usage) {
      // 1000 input on ONE response must not be reported as 2000.
      expect(usage.inputTokens).toBe(1000);
      expect(usage.outputTokens).toBe(40);
    } else {
      // No turn-end record in this fixture: assert via the step instead.
      expect(s.steps[0].usage!.inputTokens).toBe(1000);
    }
  });

  it('emits NO placeholder row for a tool-only response', () => {
    const s = run([
      user('go', T(0)),
      asst([{ type: 'tool_use', id: 'tu4', name: 'Bash', input: { command: 'ls' } }], T(1), 'msg_G', 'u' + T(0)),
    ]);

    // The tool row IS the content. A "（仅工具调用）" message record here would render as a
    // second, empty-looking 助手 row next to the 工具 row.
    expect(s.records.filter((r) => r.kind === 'message')).toHaveLength(0);
    expect(s.records.filter((r) => r.kind === 'reasoning')).toHaveLength(0);
    const tools = s.records.filter((r) => r.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0].toolName).toBe('Bash');
    // No record anywhere still carries the retired placeholder.
    expect(JSON.stringify(s.records)).not.toContain('（仅工具调用）');
  });

  it('keeps the assistant message and its tool as SEPARATE records (one row each)', () => {
    const s = run([
      user('go', T(0)),
      asst([{ type: 'text', text: 'Saving that now.' }], T(1), 'msg_H', 'u' + T(0)),
      asst([{ type: 'tool_use', id: 'tu5', name: 'Write', input: { file_path: '/x.md' } }],
        T(2), 'msg_H', 'a' + T(1)),
    ]);

    // Both in one step (they are one API response) but as distinct records, so the ledger
    // renders a 助手 row and its own 工具 row — matching DSH and Codex.
    const msg = s.records.find((r) => r.kind === 'message')!;
    const tool = s.records.find((r) => r.kind === 'tool')!;
    expect(msg).toBeTruthy();
    expect(tool).toBeTruthy();
    expect(tool.stepIndex).toBe(msg.stepIndex);
    expect(tool.recordId).not.toBe(msg.recordId);
  });

  it('does NOT merge two genuinely different responses', () => {
    const s = run([
      user('go', T(0)),
      asst([{ type: 'text', text: 'first' }], T(1), 'msg_D', 'u' + T(0)),
      user('again', T(2)),
      asst([{ type: 'text', text: 'second' }], T(3), 'msg_E', 'u' + T(2)),
    ]);

    expect(s.steps).toHaveLength(2);
    const bodies = s.records.filter((r) => r.kind === 'message').map((r) => r.detailText);
    expect(bodies).toEqual(['first', 'second']);
  });
  it('appends text from a later line of the same response instead of dropping it', () => {
    const s = run([
      user('go', T(0)),
      asst([{ type: 'thinking', thinking: 'hmm' }], T(1), 'msg_F', 'u' + T(0)),
      asst([{ type: 'text', text: 'here is the answer' }], T(2), 'msg_F', 'a' + T(1)),
    ]);

    expect(s.steps).toHaveLength(1);
    const msgs = s.records.filter((r) => r.kind === 'message' || r.kind === 'reasoning');
    expect(msgs).toHaveLength(1);
    // The response's real output text wins as the summary; it is no longer a bare 推理 row.
    expect(msgs[0].kind).toBe('message');
    expect(msgs[0].detailText).toBe('here is the answer');
    // ...and the reasoning is still reachable from the step.
    expect(s.steps[0].reasoning?.text).toBe('hmm');
  });
});