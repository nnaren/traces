import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, tempDir, writeCodex } from './helpers.ts';

/**
 * Codex subagent rollouts were invisible.
 *
 * Every rollout writes `session_meta.payload.session_id` as the ROOT conversation — a
 * subagent's own identity is in `payload.id`. The adapter keyed on `session_id`, so all 64
 * subagent rollouts on this machine were assigned their parent's id, collided with it and
 * were discarded by the duplicate rule (ingest reported `superseded=60`). 36% of all
 * trajectories never reached the viewer.
 *
 * The adapter root is overridden via TRAJVIEW_CODEX_HOME so the real ~/.codex is untouched.
 */

const ROOT = await tempDir('codex-sub');
const PARENT = 'aaaaaaaa-1111-7000-8000-000000000001';
const CHILD = 'bbbbbbbb-2222-7000-8000-000000000002';

const parentMeta = {
  type: 'session_meta',
  payload: {
    session_id: PARENT, id: PARENT, timestamp: '2026-09-12T14:44:24.000Z',
    cwd: '/w', cli_version: '0.150.0', thread_source: 'user',
  },
};
const childMeta = {
  type: 'session_meta',
  payload: {
    // The trap: session_id is the PARENT, id is the subagent's own thread.
    session_id: PARENT, id: CHILD, parent_thread_id: PARENT,
    timestamp: '2026-09-12T15:02:26.000Z', cwd: '/w', cli_version: '0.150.0',
    thread_source: 'subagent', agent_nickname: 'Huygens',
    source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_nickname: 'Huygens' } } },
  },
};
const say = (text: string, ordinal: number) => ({
  type: 'response_item', ordinal, timestamp: '2026-09-12T15:02:27.000Z',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

beforeAll(async () => {
  await writeCodex(ROOT, 'rollout-parent.jsonl', [parentMeta, say('root question', 1)]);
  await writeCodex(ROOT, 'rollout-child.jsonl', [childMeta, say('subagent task', 1)]);
});

afterAll(async () => {
  await cleanup(ROOT);
  delete process.env.TRAJVIEW_CODEX_HOME;
});

async function discoverAll() {
  process.env.TRAJVIEW_CODEX_HOME = ROOT;
  // Import lazily so the adapter resolves the overridden root.
  const { codexAdapter } = await import('../src/sources/codex.ts');
  const refs: any[] = [];
  for await (const r of codexAdapter.discover()) refs.push(r);
  return refs;
}

describe('codex subagent discovery', () => {
  it('keys a subagent rollout by its OWN thread id, not its parent session_id', async () => {
    const refs = await discoverAll();
    const ids = refs.map((r) => r.sessionId).sort();
    // Two DISTINCT sessions. Before the fix both came back as PARENT and one was dropped.
    expect(ids).toEqual([PARENT, CHILD].sort());
  });

  it('carries the parent link, nickname and depth', async () => {
    const refs = await discoverAll();
    const child = refs.find((r) => r.sessionId === CHILD)!;
    expect(child.parentSessionId).toBe(PARENT);
    expect(child.agentNickname).toBe('Huygens');
    expect(child.subagentDepth).toBe(1);
  });

  it('leaves a root conversation without subagent metadata', async () => {
    const refs = await discoverAll();
    const root = refs.find((r) => r.sessionId === PARENT)!;
    expect(root.parentSessionId).toBeUndefined();
    expect(root.agentNickname).toBeUndefined();
  });

  it('normalizes the subagent session under its own id too', async () => {
    process.env.TRAJVIEW_CODEX_HOME = ROOT;
    const { codexAdapter } = await import('../src/sources/codex.ts');
    const { normalizeCodex } = await import('../src/normalize/codex.ts');
    const refs: any[] = [];
    for await (const r of codexAdapter.discover()) refs.push(r);
    const child = refs.find((r) => r.sessionId === CHILD)!;
    const s = normalizeCodex(child, await codexAdapter.readAll(child));
    expect(s.sessionId).toBe(CHILD);
    expect(s.parentSessionId).toBe(PARENT);
    expect(s.agentNickname).toBe('Huygens');
    // ...and it actually has content, rather than being an empty shell.
    expect(s.records.length).toBeGreaterThan(0);
  });
});