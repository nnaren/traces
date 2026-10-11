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
