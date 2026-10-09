/**
 * Ingest-level invariants that the normalizer tests cannot see, because they only
 * appear once two discoveries of the SAME session collide.
 *
 * Codex writes each session to `sessions/` and again to `archived_sessions/`, so
 * discover() yields one sessionId twice with different content. The derived store must
 * keep the richer copy — and, just as importantly, the VAULT must never receive the copy
 * that was rejected.
 *
 * The vault is the immutable raw archive: its whole reason to exist is that the owning
 * CLI rotates and deletes its own logs, so this is the last copy of the bytes. Clobbering
 * it with an inferior duplicate would silently destroy the richest trajectory the tool
 * ever saw, while the store kept looking correct.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ingest } from '../src/ingest.ts';
import { Store } from '../src/store.ts';
import { Vault } from '../src/vault.ts';
import { splitLines } from '../src/sources/stableRead.ts';
import type { RawLine, SessionRef, TrajectorySourceAdapter } from '../src/types.ts';
import { cleanup, tempDir } from './helpers.ts';

const dir = await tempDir('ingest');
afterEach(() => cleanup(dir));

const CAPS = {
  reasoning: 'plaintext', usageGranularity: 'per-record', cacheSemantics: 'separate',
  cost: 'none', ttft: 'none', tokenTimeline: 'no', toolDuration: 'derivable',
  subagentTree: 'none', ordering: 'physical-line-order', unknownEventPolicy: 'refuse',
} as const;

/** A file-shaped source on disk so the vault has real bytes to copy. */
async function sourceFile(body: string, name: string): Promise<string> {
  const p = path.join(dir, 'src', name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body);
  return p;
}

function fakeAdapter(refs: SessionRef[]): TrajectorySourceAdapter {
  return {
    id: 'codex',
    capabilities: CAPS as any,
    async *discover() { for (const r of refs) yield r; },
    async readAll(ref) {
      const raw = await fs.readFile(ref.path, 'utf8');
      return splitLines(Buffer.from(raw, 'utf8'));
    },
    isRelevant: () => true,
  };
}

const richBody = [
  JSON.stringify({ type: 'session_meta', payload: { session_id: 'dup', cwd: '/w' } }),
  ...Array.from({ length: 8 }, (_, i) => JSON.stringify({
    type: 'response_item', ordinal: i + 1,
    payload: { type: 'message', role: 'user', content: [{ text: 'msg' + i }] },
  })),
].join('\n') + '\n';

const poorBody = [
  JSON.stringify({ type: 'session_meta', payload: { session_id: 'dup', cwd: '/w' } }),
  JSON.stringify({ type: 'response_item', ordinal: 1, payload: { type: 'message', role: 'user', content: [{ text: 'msg0' }] } }),
].join('\n') + '\n';

describe('duplicate discovery', () => {
  it('keeps the richer copy in the store AND in the vault', async () => {
    const rich = await sourceFile(richBody, 'rich.jsonl');
    const poor = await sourceFile(poorBody, 'poor.jsonl');
    // Same sessionId, discovered twice — richer first, then the inferior duplicate.
    const refs: SessionRef[] = [
      { source: 'codex', sessionId: 'dup', path: rich, revision: 'rev-rich' },
      { source: 'codex', sessionId: 'dup', path: poor, revision: 'rev-poor' },
    ];

    const report = await ingest({ dataDir: dir, adapters: [fakeAdapter(refs)] });
    expect(report.errors).toEqual([]);
    expect(report.superseded.codex).toBe(1);

    // The derived store keeps the rich session.
    const s = await Store.open(dir);
    expect(Number(s.getSession('codex', 'dup')!.record_count)).toBeGreaterThan(2);
    s.close();

    // THE REGRESSION: the vault must still hold the rich bytes, not the rejected ones.
    const v = new Vault(path.join(dir, 'vault'));
    const vaultText = await fs.readFile(v.dataPath('codex', 'dup'), 'utf8');
    expect(vaultText).toBe(richBody);
    expect(vaultText).toContain('msg7');
  });

  it('does not clobber the vault when the rejected duplicate is seen FIRST', async () => {
    const rich = await sourceFile(richBody, 'rich2.jsonl');
    const poor = await sourceFile(poorBody, 'poor2.jsonl');
    // Order flipped: the inferior copy arrives first and is legitimately ingested,
    // then the richer one must replace BOTH the store row and the vault bytes.
    const refs: SessionRef[] = [
      { source: 'codex', sessionId: 'dup2', path: poor, revision: 'r1' },
      { source: 'codex', sessionId: 'dup2', path: rich, revision: 'r2' },
    ];
    const report = await ingest({ dataDir: dir, adapters: [fakeAdapter(refs)] });
    expect(report.errors).toEqual([]);
    expect(report.superseded.codex ?? 0).toBe(0);

    const v = new Vault(path.join(dir, 'vault'));
    const vaultText = await fs.readFile(v.dataPath('codex', 'dup2'), 'utf8');
    expect(vaultText).toBe(richBody);
  });

  it('lets --force replace a stored session that a parser fix shrank', async () => {
    const rich = await sourceFile(richBody, 'rich3.jsonl');
    const ref: SessionRef = { source: 'codex', sessionId: 'forced', path: rich, revision: 'r1' };
    const adapters = [fakeAdapter([ref])];

    await ingest({ dataDir: dir, adapters });
    const before = (await Store.open(dir)).getSession('codex', 'forced')!.record_count as number;

    // A later run sees fewer records for the same revision. Without --force the richer
    // stored row wins (supersede). With --force the user is explicitly saying the stored
    // derived data is stale and must be replaced.
    const shrunk: SessionRef = { ...ref, revision: 'r2' };
    const report = await ingest({ dataDir: dir, adapters: [fakeAdapter([shrunk])], force: true });
    expect(report.errors).toEqual([]);
    const after = (await Store.open(dir)).getSession('codex', 'forced')!.record_count as number;
    expect(after).toBe(before);
  });

  // REGRESSION: --force once bypassed the dedup guard entirely, which let the LAST duplicate
  // seen win — so `ingest --force` silently replaced rich sessions with their poorer
  // archived copies. --force must re-parse across runs without disabling same-run dedup.
  it('--force re-parses without letting a poorer duplicate win', async () => {
    const rich = await sourceFile(richBody, 'frich.jsonl');
    const poor = await sourceFile(poorBody, 'fpoor.jsonl');
    const mk = (order: 'rich-first' | 'poor-first'): SessionRef[] => {
      const a: SessionRef = { source: 'codex', sessionId: 'forced-dup', path: rich, revision: 'rr' };
      const b: SessionRef = { source: 'codex', sessionId: 'forced-dup', path: poor, revision: 'rp' };
      return order === 'rich-first' ? [a, b] : [b, a];
    };

    for (const order of ['rich-first', 'poor-first'] as const) {
      await fs.rm(path.join(dir, 'traces.sqlite3'), { force: true });
      for (const suffix of ['-wal', '-shm']) {
        await fs.rm(path.join(dir, 'traces.sqlite3' + suffix), { force: true });
      }
      await fs.rm(path.join(dir, 'blobs'), { recursive: true, force: true });
      await fs.rm(path.join(dir, 'vault'), { recursive: true, force: true });

      const report = await ingest({ dataDir: dir, adapters: [fakeAdapter(mk(order))], force: true });
      expect(report.errors, order).toEqual([]);

      const s = await Store.open(dir);
      const stored = Number(s.getSession('codex', 'forced-dup')!.record_count);
      s.close();
      // 8 messages (session_meta is session-level, not a record), regardless of order.
      expect(stored, order + ': the poorer duplicate won').toBe(8);

      const v = new Vault(path.join(dir, 'vault'));
      expect(await fs.readFile(v.dataPath('codex', 'forced-dup'), 'utf8'), order).toBe(richBody);
    }
  });

  it('leaves the source tree untouched', async () => {
    const rich = await sourceFile(richBody, 'ro.jsonl');
    const before = await fs.readFile(rich);
    const refs: SessionRef[] = [{ source: 'codex', sessionId: 'ro', path: rich, revision: 'r1' }];
    await ingest({ dataDir: dir, adapters: [fakeAdapter(refs)] });
    expect(await fs.readFile(rich)).toEqual(before);
  });
});