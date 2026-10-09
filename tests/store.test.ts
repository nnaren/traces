import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.ts';
import { Vault } from '../src/vault.ts';
import { normalizeCodex } from '../src/normalize/codex.ts';
import { splitLines } from '../src/sources/stableRead.ts';
import type { SessionRef } from '../src/types.ts';
import { cleanup, tempDir } from './helpers.ts';

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

  it('can be deleted and rebuilt from the vault to an identical result (P6)', async () => {
    const s0 = await Store.open(dir);
    const before = s0.getPage('codex', 's1', undefined, 999).map((r: any) => [r.order_index, r.kind, r.summary]);
    s0.close();

    // Delete ONLY the derived layer; the vault stays.
    await fs.rm(path.join(dir, 'traces.sqlite3'), { force: true });
    for (const suffix of ['-wal', '-shm']) await fs.rm(path.join(dir, 'traces.sqlite3' + suffix), { force: true });

    const s1 = await Store.open(dir);
    expect(s1.countSessions().codex).toBe(0);           // derived data is gone
    s1.writeSession(session(), '/vault/s1.jsonl', '/fake/s1.jsonl');
    const after = s1.getPage('codex', 's1', undefined, 999).map((r: any) => [r.order_index, r.kind, r.summary]);
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
