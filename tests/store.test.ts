import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.ts';
import { Vault } from '../src/vault.ts';
import { ingest } from '../src/ingest.ts';
import { vaultAdapters } from '../src/sources/vault.ts';
import { normalizeCodex } from '../src/normalize/codex.ts';
import { splitLines } from '../src/sources/stableRead.ts';
import type { SessionRef, TrajectorySourceAdapter } from '../src/types.ts';
import { cleanup, tempDir } from './helpers.ts';

/** A real adapter over an explicit file list, so ingest() can be driven from fixtures. */
function fixtureAdapter(refs: SessionRef[]): TrajectorySourceAdapter {
  return {
    id: 'codex',
    capabilities: normalizeCodex(refs[0] ?? ({ source: 'codex', sessionId: 'x', path: '/x' } as SessionRef), []).capabilities,
    async *discover() {
      for (const r of refs) {
        try { await fs.access(r.path); } catch { continue; }   // a deleted source is gone
        yield r;
      }
    },
    async readAll(ref) {
      return splitLines(Buffer.from(await fs.readFile(ref.path, 'utf8'), 'utf8'));
    },
    isRelevant: () => true,
  };
}

const dir = await tempDir('store');
afterAll(() => cleanup(dir));

const REF: SessionRef = { source: 'codex', sessionId: 's1', path: '/fake/s1.jsonl', revision: 'r1' };
const meta = { type: 'session_meta', ordinal: 0, timestamp: '2026-08-20T10:00:00.000Z', payload: { session_id: 's1', cwd: '/w', cli_version: '0.153.4' } };
const userItem = { type: 'response_item', ordinal: 2, timestamp: '2026-08-20T10:00:01.100Z', payload: { type: 'message', role: 'user', content: [{ text: 'hello world' }] } };
// Codex writes a `UserMessage` echo for real human input, and the normalizer keys the
// human/context distinction on it. Without this echo the message above is classified as
// injected 上下文, which is exactly the distinction the session title depends on.
const userEcho = { type: 'event_msg', ordinal: 2.5, timestamp: '2026-08-20T10:00:01.100Z', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'um_1', client_id: 'c', content: [{ type: 'text', text: 'hello world' }] } } };
const lines = [
  meta,
  { type: 'event_msg', ordinal: 1, timestamp: '2026-08-20T10:00:01.000Z', payload: { type: 'task_started', turn_id: 't1' } },
  userItem,
  userEcho,
];
const session = () => normalizeCodex(REF, splitLines(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')));

/**
 * A session with a known record count, so head-vs-tail paging is unambiguous. The 4-line
 * fixture above normalizes to too few records for "oldest" and "newest" to differ.
 */
const bigRef: SessionRef = { source: 'codex', sessionId: 'big', path: '/fake/big.jsonl', revision: 'r1' };
function bigSession(n = 12) {
  const ls: any[] = [
    { type: 'session_meta', ordinal: 0, timestamp: '2026-08-20T10:00:00.000Z', payload: { session_id: 'big', id: 'big', cwd: '/w', cli_version: '0.153.4' } },
    { type: 'event_msg', ordinal: 1, timestamp: '2026-08-20T10:00:01.000Z', payload: { type: 'task_started', turn_id: 'tb' } },
  ];
  for (let i = 0; i < n; i++) {
    ls.push({ type: 'response_item', ordinal: 2 + i, timestamp: '2026-08-20T10:00:02.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply ' + i }] } });
  }
  ls.push({ type: 'event_msg', ordinal: 99, timestamp: '2026-08-20T10:00:09.000Z', payload: { type: 'task_complete', turn_id: 'tb', duration_ms: 100 } });
  return normalizeCodex(bigRef, splitLines(Buffer.from(ls.map((l) => JSON.stringify(l)).join('\n') + '\n')));
}

describe('derived store', () => {
  it('opens, writes and reads back a session', async () => {
    const s = await Store.open(dir);
    s.writeSession(session(), '/vault/s1.jsonl', '/fake/s1.jsonl');
    const counts = s.countSessions();
    expect(counts.codex).toBe(1);
    const page = s.getPage('codex', 's1', undefined, 50);
    expect(page.length).toBeGreaterThan(0);
    expect(page.every((r: any) => r.kind !== undefined)).toBe(true);
    s.close();
  });

  it('pages tail-first and reports the next cursor', async () => {
    const s = await Store.open(dir);
    const first = s.getPage('codex', 's1', undefined, 1);
    expect(first).toHaveLength(1);
    s.close();
  });

  /**
   * Head-first paging: the ledger opens at the session's FIRST records, so the cursorless
   * page must be the OLDEST slice — the mirror image of the tail-first default, which
   * returns the newest. Getting this backwards silently shows the middle of a trajectory as
   * if it were the beginning.
   */
  it('pages head-first from the oldest record when direction is fwd', async () => {
    const s = await Store.open(dir);
    s.writeSession(bigSession(), '/vault/big.jsonl', '/fake/big.jsonl');
    const fwd = s.getPage('codex', 'big', undefined, 1, 'fwd');
    const back = s.getPage('codex', 'big', undefined, 1, 'back');
    expect(fwd).toHaveLength(1);
    expect(Number(fwd[0].order_index)).toBeLessThan(Number(back[0].order_index));
    s.close();
  });

  it('walks the whole session forward, in order, without gaps or repeats', async () => {
    const s = await Store.open(dir);
    s.writeSession(bigSession(), '/vault/big.jsonl', '/fake/big.jsonl');
    const all = s.getPage('codex', 'big', undefined, 999, 'fwd');
    const idx = all.map((r: any) => Number(r.order_index));
    expect(idx.length).toBeGreaterThan(5);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(new Set(idx).size).toBe(idx.length);

    let cursor: number | undefined;
    const walked: number[] = [];
    for (let i = 0; i < 999; i++) {
      const page = s.getPage('codex', 'big', cursor, 1, 'fwd');
      if (!page.length) break;
      walked.push(Number(page[0].order_index));
      cursor = Number(page[0].order_index);
    }
    expect(walked).toEqual(idx);
    s.close();
  });

  /**
   * The card title must come from a REAL user turn. A session's first record is almost always
   * a system prompt or an injected `<environment_context>` block, and titling from one of
   * those would give every card the same subject.
   */
  it('titles a session from its first REAL user message, not its system prompt', async () => {
    const s = await Store.open(dir);
    const titles = s.sessionTitles('codex', ['s1']);
    expect(titles.get('s1')).toBe('hello world');
    s.close();
  });

  it('returns every user message of a session, oldest first', async () => {
    const s = await Store.open(dir);
    const msgs = s.userMessages('codex', 's1');
    expect(msgs.map((m) => m.text)).toContain('hello world');
    const idx = msgs.map((m) => m.orderIndex);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    s.close();
  });

  it('has no title for a session that never saw a human turn', async () => {
    const s = await Store.open(dir);
    expect(s.sessionTitles('codex', ['no-such-session']).size).toBe(0);
    expect(s.userMessages('codex', 'no-such-session')).toEqual([]);
    s.close();
  });

  it('is idempotent: re-writing the same session does not duplicate rows', async () => {
    const s = await Store.open(dir);
    const before = s.getPage('codex', 's1', undefined, 999).length;
    s.writeSession(session(), '/vault/s1.jsonl', '/fake/s1.jsonl');
    const after = s.getPage('codex', 's1', undefined, 999).length;
    expect(after).toBe(before);
    s.close();
  });

  // P6 — this used to re-normalize a fixture and call that "from the vault". It now
  // deletes the source file outright and replays through the real vault adapters, which is
  // the only version of this claim worth asserting.
  it('rebuilds the derived layer from the vault alone after the source is gone (P6)', async () => {
    const pdir = path.join(dir, 'p6');
    const src = path.join(pdir, 'rollout-p6.jsonl');
    const lineBody = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    await fs.mkdir(pdir, { recursive: true });
    await fs.writeFile(src, lineBody);

    const adapters = [fixtureAdapter([{ source: 'codex', sessionId: 'p6', path: src, revision: 'r1' }])];
    const first = await ingest({ dataDir: pdir, adapters });
    expect(first.errors).toEqual([]);
    expect(first.ingested.codex).toBe(1);

    const s0 = await Store.open(pdir);
    const before = s0.getPage('codex', 'p6', undefined, 999)
      .map((r: any) => [r.order_index, r.kind, r.summary, r.started_at, r.detail_text]);
    s0.close();
    expect(before.length).toBeGreaterThan(0);

    // The owning CLI rotates its own logs away.
    await fs.rm(src, { force: true });

    // Delete ONLY the derived layer. The vault survives — that is the whole point of it.
    for (const suffix of ['', '-wal', '-shm']) {
      await fs.rm(path.join(pdir, 'traces.sqlite3' + suffix), { force: true });
    }
    await fs.rm(path.join(pdir, 'blobs'), { recursive: true, force: true });

    // Rebuild from the vault, with no source tree left to read.
    const replay = await ingest({
      dataDir: pdir,
      adapters: vaultAdapters(path.join(pdir, 'vault')),
      noVault: true,
    });
    expect(replay.errors).toEqual([]);
    expect(replay.ingested.codex).toBe(1);

    const s1 = await Store.open(pdir);
    const after = s1.getPage('codex', 'p6', undefined, 999)
      .map((r: any) => [r.order_index, r.kind, r.summary, r.started_at, r.detail_text]);
    s1.close();
    expect(after).toEqual(before);
  });

  it('refuses to adopt a non-empty foreign database in the data dir', async () => {
    const fdir = path.join(dir, 'foreign');
    await fs.mkdir(fdir, { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(fdir, 'traces.sqlite3'));
    db.exec('CREATE TABLE x(a)');
    db.close();
    await expect(Store.open(fdir)).rejects.toThrow(/foreign database|non-empty/);
  });

  it('refuses to downgrade a newer schema instead of wiping it', async () => {
    const ndir = path.join(dir, 'newer');
    await fs.mkdir(ndir, { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(ndir, 'traces.sqlite3'));
    db.exec('PRAGMA application_id = ' + 0x5452414a);
    db.exec('PRAGMA user_version = 99');
    db.exec('CREATE TABLE precious(x)');
    db.close();
    await expect(Store.open(ndir)).rejects.toThrow(/newer than this build/);
    // the newer database must be left untouched
    const check = new DatabaseSync(path.join(ndir, 'traces.sqlite3'));
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name='precious'").get()).toBeTruthy();
    check.close();
  });

  it('round-trips a full-text search and returns no highlight sentinels', async () => {
    const s = await Store.open(dir);
    const hits = s.search('hello');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].record_id).toBeTruthy();
    expect(hits[0].score).toBeLessThanOrEqual(0);          // bm25: lower is better
    expect(String(hits[0].snip)).toContain('hello');
    const text = JSON.stringify(hits[0]);
    // We pass U+FFF0/U+FFF1 to snippet(); DSH uses U+FDD0/U+FDD1. Strip both.
    for (const marker of ['\uFDD0', '\uFDD1', '\uFFF0', '\uFFF1']) {
      expect(text).not.toContain(marker);
    }
    s.close();
  });

  it('survives a malformed FTS query instead of throwing', async () => {
    const s = await Store.open(dir);
    expect(s.search('unbalanced "quote')).toEqual([]);
    s.close();
  });
});

describe('vault (copy-on-ingest raw archive)', () => {
  it('writes atomically and marks itself complete (Model A)', async () => {
    const v = new Vault(path.join(dir, 'vault-test'), 'full-copy');
    const meta = await v.put(REF, Buffer.from('{"a":1}\n'));
    expect(meta.complete).toBe(true);
    expect(meta.byteSize).toBeGreaterThan(0);
    const read = await v.readMeta(REF);
    expect(read!.complete).toBe(true);
  });

  it('detects a truncated vault', async () => {
    const v = new Vault(path.join(dir, 'vault-trunc'), 'full-copy');
    await v.put({ ...REF, sessionId: 'trunc' }, Buffer.from('{"a":1}\n'));
    expect(await v.isTruncated({ ...REF, sessionId: 'trunc' })).toBe(false);
    await fs.truncate(v.dataPath('codex', 'trunc'), 3);
    expect(await v.isTruncated({ ...REF, sessionId: 'trunc' })).toBe(true);
  });
});

/**
 * The reverse half of the subagent link: from a child, find the parent's ROW.
 *
 * Both sources have to work, because they record the link differently — Claude stores the
 * spawning call's id on the child, so the lookup is an indexed equality; Codex stores
 * nothing, and the child's id only appears inside the parent's spawn result, so it has to be
 * searched for. Getting this wrong does not throw: it returns null, and the UI silently
 * reopens the parent at the top instead of on the call that explains the child's existence.
 */
describe('spawning record lookup (child → parent row)', () => {
  const CLAUDE_PARENT = 'ccccccc-1111-7000-8000-000000000001';
  const CLAUDE_CHILD = CLAUDE_PARENT + '--sub-ac5961e309227d752';
  const CLAUDE_CALL = 'chatcmpl-tool-93249bc52a95581f';
  const CODEX_PARENT = 'ddddddd-2222-7000-8000-000000000002';
  const CODEX_CHILD = '01a09624-2596-73e3-bee8-d7258d9f2880';

  const session = (o: Partial<any> & { sessionId: string; source: 'codex' | 'claude-code' }) => ({
    capabilities: normalizeCodex({ source: 'codex', sessionId: o.sessionId, path: '/x' } as SessionRef, []).capabilities,
    diagnostics: { badLineCount: 0 }, turns: [], steps: [], records: [], ...o,
  } as any);

  it('finds the parent call by id (claude), and lists the child for the same id', async () => {
    const s = await Store.open(dir);
    s.writeSession(session({
      source: 'claude-code', sessionId: CLAUDE_PARENT,
      records: [{
        recordId: 'tool' + CLAUDE_CALL + '::1', kind: 'tool', orderIndex: 92.001, turnIndex: 0, stepIndex: 4,
        text: 'Agent({...})', timeSeconds: null, toolName: 'Agent', callId: CLAUDE_CALL, flags: [],
        tool: { callId: CLAUDE_CALL, name: 'Agent' },
      }],
    }), '/v/p', '/s/p');
    s.writeSession(session({
      source: 'claude-code', sessionId: CLAUDE_CHILD,
      parentSessionId: CLAUDE_PARENT, agentNickname: 'ReviewTask-1', subagentDepth: 1, spawnCallId: CLAUDE_CALL,
    }), '/v/c', '/s/c');

    expect(s.findRecordByCallId('claude-code', CLAUDE_PARENT, CLAUDE_CALL)?.record_id)
      .toBe('tool' + CLAUDE_CALL + '::1');
    expect(s.childSessionsByCallId('claude-code', CLAUDE_CALL))
      .toEqual([{ sessionId: CLAUDE_CHILD, agentNickname: 'ReviewTask-1' }]);
    s.close();
  });

  it('finds the spawning call by the child id inside the payload (codex)', async () => {
    const s = await Store.open(dir);
    s.writeSession(session({
      source: 'codex', sessionId: CODEX_PARENT,
      records: [{
        recordId: 'spawn-1', kind: 'tool', orderIndex: 10.001, turnIndex: 0, stepIndex: 2,
        text: 'spawn_agent({...})', timeSeconds: null, toolName: 'spawn_agent', callId: 'call_a', flags: [],
        tool: { callId: 'call_a', name: 'spawn_agent', outputText: JSON.stringify({ agent_id: CODEX_CHILD, nickname: 'Huygens' }) },
      }],
    }), '/v/p2', '/s/p2');
    s.writeSession(session({
      source: 'codex', sessionId: CODEX_CHILD, parentSessionId: CODEX_PARENT, agentNickname: 'Huygens',
    }), '/v/c2', '/s/c2');

    expect(s.findSpawnRecordByChildId('codex', CODEX_PARENT, CODEX_CHILD)).toBe('spawn-1');
    // An id that merely APPEARS in some payload text is not a link.
    expect(s.findSpawnRecordByChildId('codex', CODEX_PARENT, 'no-such-thread')).toBeUndefined();
    s.close();
  });
});
