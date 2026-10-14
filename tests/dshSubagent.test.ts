import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, tempDir, writeDsh } from './helpers.ts';

/**
 * REGRESSION: DSH subagents were flat root conversations.
 *
 * DSH writes its identity in the `session` header — `parentSession`, `origin:"subagent"`,
 * `delegationDepth` — and the parent→child direction in `subagent/catalog` events
 * (`childId`, `label`). Neither existed in the store, so all 10 subagents on this machine
 * rendered as unrelated sessions.
 *
 * The hard part, and what these tests pin down:
 *
 *  - the header must be read from the LOG, not from the directory name (both `session-<uuid>`
 *    and a bare `<uuid>` exist here, and the header is what `parentSession` refers to);
 *  - DSH writes NO call id linking a child to its spawn, so the pairing is reconstructed from
 *    `label === arguments.description` plus nearest `childCreatedAt` — and BOTH must hold,
 *    because the label alone repeats and the timestamp alone would pair siblings wrongly;
 *  - a child with no catalog row must stay unpaired rather than be guessed at.
 */
const SRC = await tempDir('dsh-sub-src');
const DATA = await tempDir('dsh-sub-data');

const ROOT = 'sess-root-0000-0000-0000-000000000001';
const CHILD_A = 'chil-aaaa-0000-0000-0000-00000000000a';
const CHILD_B = 'chil-bbbb-0000-0000-0000-00000000000b';
const OLD_CHILD = 'chil-cccc-0000-0000-0000-00000000000c';

const T0 = 1791907407000;

/** One zstd frame per call, so each helper call writes a frame the walker can find. */
function ev(seq: number, type: string, data: any, time: number) {
  return JSON.stringify({ type, seq, time, data }) + '\n';
}

beforeAll(async () => {
  // Parent: header, one subagent call per child, and one catalog event per child.
  await writeDsh(SRC, ROOT, [
    JSON.stringify({ type: 'session', version: 4, id: ROOT, createdAt: T0 - 5000, cwd: '/w' }) + '\n',
    ev(0, 'turn/start', { turn: 1 }, T0 - 5000),
    ev(1, 'tool/call', { turn: 1, step: 1, callId: 'call-a', name: 'subagent',
      arguments: JSON.stringify({ description: 'ReviewTask-1 gtpu链路评审', prompt: 'x'.repeat(400) }) }, T0 + 10),
    ev(2, 'tool/result', { turn: 1, step: 1, callId: 'call-a', content: [{ type: 'text', text: 'done' }] }, T0 + 900),
    ev(3, 'subagent/catalog', { version: 0, childId: CHILD_A, childCreatedAt: T0, mode: 'one-shot', label: 'ReviewTask-1 gtpu链路评审' }, T0 + 20),
    ev(4, 'tool/call', { turn: 1, step: 2, callId: 'call-b', name: 'subagent',
      arguments: JSON.stringify({ description: 'review-filter post-processing', prompt: 'y'.repeat(400) }) }, T0 + 1400),
    ev(5, 'tool/result', { turn: 1, step: 2, callId: 'call-b', content: [{ type: 'text', text: 'done' }] }, T0 + 2400),
    ev(6, 'subagent/catalog', { version: 0, childId: CHILD_B, childCreatedAt: T0 + 1400, mode: 'one-shot', label: 'review-filter post-processing' }, T0 + 1420),
    ev(7, 'turn/end', { turn: 1 }, T0 + 3000),
  ]);
  await writeDsh(SRC, CHILD_A, [
    JSON.stringify({ type: 'session', version: 4, id: CHILD_A, createdAt: T0, cwd: '/w',
      parentSession: ROOT, isSeeded: false, origin: 'subagent', delegationDepth: 1, agentPreset: 'standard' }) + '\n',
    ev(0, 'turn/start', { turn: 1 }, T0 + 30),
    ev(1, 'user/message', { content: [{ type: 'text', text: '你是 ReviewTask-1' }] }, T0 + 31),
    ev(2, 'turn/end', { turn: 1 }, T0 + 500),
  ]);
  await writeDsh(SRC, CHILD_B, [
    JSON.stringify({ type: 'session', version: 4, id: CHILD_B, createdAt: T0 + 1400, cwd: '/w',
      parentSession: ROOT, isSeeded: false, origin: 'subagent', delegationDepth: 1, agentPreset: 'standard' }) + '\n',
    ev(0, 'turn/start', { turn: 1 }, T0 + 1430),
    ev(1, 'user/message', { content: [{ type: 'text', text: '你是 review-filter' }] }, T0 + 1431),
    ev(2, 'turn/end', { turn: 1 }, T0 + 1900),
  ]);
  // An OLD-style child: parent known, but the version that never wrote a catalog entry.
  await writeDsh(SRC, OLD_CHILD, [
    JSON.stringify({ type: 'session', version: 4, id: OLD_CHILD, createdAt: T0 + 9000, cwd: '/w',
      parentSession: ROOT, isSeeded: false, origin: 'subagent', delegationDepth: 1, agentPreset: 'standard' }) + '\n',
    ev(0, 'turn/start', { turn: 1 }, T0 + 9010),
    ev(1, 'turn/end', { turn: 1 }, T0 + 9200),
  ]);
});

afterAll(async () => {
  delete process.env.TRAJVIEW_DSH_HOME;
  await cleanup(SRC);
  await cleanup(DATA);
});

async function ingest() {
  process.env.TRAJVIEW_DSH_HOME = path.join(SRC, '..', SRC.split('/').pop()!); // writeDsh nests under sessions/
  const { ingest } = await import('../src/ingest.ts');
  return ingest({ dataDir: DATA, sources: ['dsh'] });
}

async function rows() {
  const { Store } = await import('../src/store.ts');
  const s = await Store.open(DATA);
  const out = (s as any).db.prepare(
    "SELECT session_id, parent_session_id, agent_nickname, subagent_depth, spawn_call_id FROM sessions WHERE source='dsh'",
  ).all() as any[];
  s.close();
  return out;
}

describe('dsh subagent identity from the log header', () => {
  it('keys a child on the header id and records its parent and depth', async () => {
    const report = await ingest();
    expect(report.errors).toEqual([]);
    const byId = new Map((await rows()).map((r) => [r.session_id, r]));
    expect(byId.has(ROOT)).toBe(true);
    const child = byId.get(CHILD_A)!;
    expect(child).toBeTruthy();
    expect(child.parent_session_id).toBe(ROOT);
    expect(child.subagent_depth).toBe(1);
  });

  it('leaves a root conversation without parent metadata', async () => {
    const root = (await rows()).find((r) => r.session_id === ROOT)!;
    expect(root.parent_session_id).toBeNull();
    expect(root.subagent_depth).toBeNull();
  });

  it('keeps every child distinct — the header id, not the directory name', async () => {
    const ids = (await rows()).map((r) => r.session_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(CHILD_A);
    expect(ids).toContain(CHILD_B);
  });
});

describe('dsh parent→child pairing (no call id is ever written by dsh)', () => {
  it('pairs each child with the subagent call that has the same description', async () => {
    const byId = new Map((await rows()).map((r) => [r.session_id, r]));
    expect(byId.get(CHILD_A)!.spawn_call_id).toBe('call-a');
    expect(byId.get(CHILD_B)!.spawn_call_id).toBe('call-b');
    // The label is the child's human name — DSH names no agent, so this comes from the spawn.
    expect(byId.get(CHILD_A)!.agent_nickname).toBe('ReviewTask-1 gtpu链路评审');
  });

  /**
   * The pairing reads `tool_json.inputRaw`, not the one-line summary: a review task's prompt
   * blows past the normalizer's 80-character truncation, so the summary's JSON is cut
   * mid-string and unparsable — and every child silently went unpaired.
   */
  it('still pairs when the call arguments are far longer than the summary', async () => {
    const byId = new Map((await rows()).map((r) => [r.session_id, r]));
    expect(byId.get(CHILD_A)!.spawn_call_id).toBe('call-a');
  });

  /**
   * A child with no catalog row (the 2026-09 logs here) keeps its parent link — that comes
   * from the header and is reliable — but is NOT given a call id. Guessing one from a
   * timestamp would put the user on a call that did not create it.
   */
  it('leaves a child without a catalog entry unpaired rather than guessing', async () => {
    const old = (await rows()).find((r) => r.session_id === OLD_CHILD)!;
    expect(old.parent_session_id).toBe(ROOT);
    expect(old.spawn_call_id).toBeNull();
  });

  it('is idempotent — a second run does not rewrite an existing link', async () => {
    const { Store } = await import('../src/store.ts');
    const s = await Store.open(DATA);
    expect(s.attachDshSpawnCalls()).toBe(0);   // everything already linked
    s.close();
  });
});

describe('dsh vault replay keeps the subagent tree', () => {
  /**
   * `parentSession` lives only in the log's first event. Without a `readRef` the replay path
   * could not ask for it, so `--from-vault` turned every child back into a root conversation —
   * the same silent loss codex suffered once (177 of 414 sessions).
   */
  it('re-derives parent and depth from the captured bytes alone', async () => {
    const { Vault } = await import('../src/vault.ts');
    const { enumerateVault } = await import('../src/sources/vault.ts');
    const refs: any[] = [];
    for await (const r of (await import('../src/sources/dsh.ts')).dshAdapter.discover()) refs.push(r);
    const child = refs.find((r) => r.sessionId === CHILD_A)!;
    const v = new Vault(path.join(DATA, 'vault'));
    await v.put(child, await fs.readFile(child.path));

    const entries = await enumerateVault(path.join(DATA, 'vault'), 'dsh');
    const replayed = entries.find((e) => e.ref.sessionId === CHILD_A)!;
    expect(replayed).toBeTruthy();
    expect(replayed.ref.parentSessionId).toBe(ROOT);
    expect(replayed.ref.subagentDepth).toBe(1);
    expect(replayed.ref.path).toContain(path.join('vault', 'dsh', CHILD_A));
  });
});