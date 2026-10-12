import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, tempDir } from './helpers.ts';

/**
 * REGRESSION: `--from-vault` silently erased the entire subagent tree.
 *
 * `parentSessionId` / `agentNickname` / `subagentDepth` live ONLY in a Codex rollout's first
 * line. The vault's `meta.json` never recorded them, and the replay path built every ref
 * from that meta alone — so a single rebuild turned 177 of 414 codex sessions into plain
 * root conversations.
 *
 * The failure was invisible twice over:
 *  - the fields were ABSENT, not wrong, so no parse error and no diagnostics counter fired;
 *  - `--force` exists precisely to overwrite existing rows, so the store's upsert faithfully
 *    persisted the emptiness.
 *
 * Nothing but a count comparison catches this, which is what this file does.
 */


const DATA = await tempDir('vault-sub-data');
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
  // Lay the vault out by hand rather than running a full ingest: the capture layout is just
  // meta.json + the byte copy, and a real ingest here blows the 30s hook budget.
  const bytes = (lines: any[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const captures: Array<[string, any[]]> = [
    [PARENT, [parentMeta, say('root question', 1)]],
    [CHILD, [childMeta, say('subagent task', 1)]],
  ];
  for (const [id, lines] of captures) {
    const dir = path.join(DATA, 'vault', 'codex', id);
    await fs.mkdir(dir, { recursive: true });
    const body = bytes(lines);
    await fs.writeFile(path.join(dir, 'session.jsonl'), body);
    // meta.json deliberately carries NO subagent field — the real one does not either,
    // which is exactly why replay used to lose it.
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({
      source: 'codex', sessionId: id, sourcePath: '/origin/rollout.jsonl',
      sourceRevision: '1:2:' + body.length + ':3:4', byteSize: body.length,
      complete: true, ingestedAt: 1789000000000, strategy: 'full-copy',
    }, null, 2));
  }
});

afterAll(async () => {

  await cleanup(DATA);
  delete process.env.TRAJVIEW_CODEX_HOME;
});

async function replayRefs() {
  const { vaultAdapters } = await import('../src/sources/vault.ts');
  const ad = vaultAdapters(path.join(DATA, 'vault')).find((a) => a.id === 'codex')!;
  const refs: any[] = [];
  for await (const r of ad.discover()) refs.push(r);
  return refs;
}

describe('vault replay preserves codex subagent identity', () => {
  it('re-derives parentSessionId from the capture, not from meta.json', async () => {
    const refs = await replayRefs();
    const child = refs.find((r) => r.sessionId === CHILD);
    expect(child).toBeTruthy();
    expect(child!.parentSessionId).toBe(PARENT);
  });

  it('re-derives agentNickname and subagentDepth the same way', async () => {
    const refs = await replayRefs();
    const child = refs.find((r) => r.sessionId === CHILD)!;
    expect(child.agentNickname).toBe('Huygens');
    expect(child.subagentDepth).toBe(1);
  });

  it('still leaves a root conversation without subagent metadata', async () => {
    const refs = await replayRefs();
    const root = refs.find((r) => r.sessionId === PARENT)!;
    expect(root.parentSessionId).toBeUndefined();
    expect(root.agentNickname).toBeUndefined();
    expect(root.subagentDepth).toBeUndefined();
  });

  it('keeps both sessions distinct — no parent/child id collision', async () => {
    const refs = await replayRefs();
    expect(refs.map((r) => r.sessionId).sort()).toEqual([PARENT, CHILD].sort());
  });

  // The replay ref must point at the CAPTURE, not at the (possibly deleted) origin —
  // otherwise a rebuilt store cites a path that no longer exists.
  it('points at the vault copy while keeping the original revision', async () => {
    const refs = await replayRefs();
    const child = refs.find((r) => r.sessionId === CHILD)!;
    expect(child.path).toContain(path.join('vault', 'codex', CHILD));
    expect(child.revision).toBeTruthy();
  });

  it('normalizes a replayed subagent into a parent-linked session', async () => {
    const refs = await replayRefs();
    const { normalizeCodex } = await import('../src/normalize/codex.ts');
    const { codexAdapter } = await import('../src/sources/codex.ts');
    const child = refs.find((r) => r.sessionId === CHILD)!;
    const s = normalizeCodex(child, await codexAdapter.readAll(child));
    expect(s.parentSessionId).toBe(PARENT);
    expect(s.agentNickname).toBe('Huygens');
    expect(s.subagentDepth).toBe(1);
  });
});