import { describe, expect, it } from 'vitest';
import { subagentRefs } from '../web/lib/subagent.ts';
import type { RecordRow } from '../web/lib/api.ts';

/**
 * Codex drives subagents through ordinary tool calls and puts the child's thread id in the
 * payload — `spawn_agent` in its RESULT, `wait_agent` in its ARGUMENTS. Those ids are the
 * child's session, so the inspector turns them into jump links.
 *
 * The id shape is the part worth pinning down: Codex writes
 * `01a09624-2596-73e3-bee8-d7258d9f2880` (dashed, 36 chars), NOT a bare 26-char ULID. An
 * earlier ULID-only check silently matched nothing and the links never appeared.
 */

const CHILD = '01a09624-2596-73e3-bee8-d7258d9f2880';
const CHILD2 = '01a09629-573d-7b82-b5b3-a173ca8c6df7';

function rec(input?: string, output?: string): RecordRow {
  return {
    recordId: 'r', kind: 'tool', orderIndex: 1, timeSeconds: null, isError: false,
    usage: null, flags: [], summary: '',
    tool: { callId: 'c', name: 'spawn_agent', inputRaw: input, outputText: output },
  } as unknown as RecordRow;
}

describe('subagent refs in a tool call', () => {
  it('reads agent_id and nickname from a spawn_agent result', () => {
    const refs = subagentRefs(rec(undefined, `{"agent_id":"${CHILD}","nickname":"Huygens"}`));
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe(CHILD);
    expect(refs[0].nickname).toBe('Huygens');
  });

  it('reads every target from a wait_agent argument list', () => {
    const refs = subagentRefs(rec(`{"targets":["${CHILD}","${CHILD2}"],"timeout_ms":360000}`));
    expect(refs.map((r) => r.id).sort()).toEqual([CHILD, CHILD2].sort());
  });

  it('accepts a bare 26-char ULID too', () => {
    const ulid = '01a09624259673e3bee8d7258d';
    expect(subagentRefs(rec(undefined, `{"agent_id":"${ulid}"}`))[0].id).toBe(ulid);
  });

  it('ignores id-like keys whose value is not a thread id', () => {
    // A schema block or an unrelated payload must not produce a dead link.
    expect(subagentRefs(rec(undefined, '{"agent_id":"architect"}'))).toHaveLength(0);
    expect(subagentRefs(rec(undefined, '{"agent_id":""}'))).toHaveLength(0);
    expect(subagentRefs(rec(undefined, '{"agent_id":42}'))).toHaveLength(0);
  });

  it('returns nothing for output that is not JSON', () => {
    expect(subagentRefs(rec(undefined, 'plain text result'))).toHaveLength(0);
    expect(subagentRefs(rec())).toHaveLength(0);
  });

  it('dedupes an id seen in both input and output, keeping the nickname', () => {
    const refs = subagentRefs(rec(`{"targets":["${CHILD}"]}`, `{"agent_id":"${CHILD}","nickname":"Aristotle"}`));
    expect(refs).toHaveLength(1);
    expect(refs[0].nickname).toBe('Aristotle');
  });

  it('finds an id nested inside a wrapper object', () => {
    const refs = subagentRefs(rec(undefined, `{"result":{"spawned":{"agent_id":"${CHILD}"}}}`));
    expect(refs).toHaveLength(1);
  });
});

/**
 * Claude Code cannot be resolved from the payload at all: an `Agent` call's RESULT is the
 * subagent's final prose — 2764 chars of report, not one id (measured on the 996c7dee
 * session) — and its arguments carry the prompt. The link lives in the spawn's sidecar,
 * which the ingest stores as the child's `spawn_call_id`, and the record detail endpoint
 * resolves it back into `record.subagents`.
 */
describe('claude code subagent refs, resolved by the server', () => {
  const CHILD_ID = '996c7dee-4e92-4730-b5a3-f2c4131239a4--sub-ac5961e309227d752';
  const CALL = 'chatcmpl-tool-93249bc52a95581f';

  function agentRec(callId = CALL): RecordRow {
    return {
      recordId: 'r', kind: 'tool', orderIndex: 1, timeSeconds: null, isError: false, callId,
      usage: null, flags: [], summary: 'Agent(...)',
      tool: {
        callId, name: 'Agent',
        inputRaw: '{"description":"执行评审任务 ReviewTask-1","subagent_type":"general-purpose","prompt":"go"}',
        outputText: '[{"type":"text","text":"评审完成。结果已写入 review_result_1.json（无确认缺陷）。"}]',
      },
    } as unknown as RecordRow;
  }

  it('links the children the server resolved for this call', () => {
    const rec = { ...agentRec(), subagents: [{ sessionId: CHILD_ID, spawnCallId: CALL, agentNickname: 'ReviewTask-1' }] };
    const refs = subagentRefs(rec);
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe(CHILD_ID);
    expect(refs[0].nickname).toBe('ReviewTask-1');
  });

  it('ignores children the server attached to a DIFFERENT call', () => {
    const rec = { ...agentRec(), subagents: [{ sessionId: CHILD_ID, spawnCallId: 'chatcmpl-tool-other' }] };
    expect(subagentRefs(rec)).toHaveLength(0);
  });

  it('returns nothing for an `Agent` call with no child ingested yet', () => {
    expect(subagentRefs({ ...agentRec(), subagents: [] })).toHaveLength(0);
    expect(subagentRefs(agentRec())).toHaveLength(0);
  });

  it('merges a server-resolved child with a payload-derived one instead of dropping either', () => {
    const rec = {
      ...agentRec(),
      tool: { callId: CALL, name: 'wait_agent', inputRaw: '{"targets":["01a09624-2596-73e3-bee8-d7258d9f2880"]}' },
      subagents: [{ sessionId: CHILD_ID, spawnCallId: CALL, agentNickname: 'ReviewTask-1' }],
    } as unknown as RecordRow;
    const refs = subagentRefs(rec);
    expect(refs.map((r) => r.id).sort()).toEqual([CHILD_ID, '01a09624-2596-73e3-bee8-d7258d9f2880'].sort());
  });
});
