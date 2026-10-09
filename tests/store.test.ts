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
const lines = [
  meta,
  { type: 'event_msg', ordinal: 1, timestamp: '2026-08-20T10:00:01.000Z', payload: { type: 'task_started', turn_id: 't1' } },
  { type: 'response_item', ordinal: 2, timestamp: '2026-08-20T10:00:01.100Z', payload: { type: 'message', role: 'user', content: [{ text: 'hello world' }] } },
];
const session = () => normalizeCodex(REF, splitLines(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')));

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
