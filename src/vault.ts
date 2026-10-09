/**
 * Vault: the immutable raw archive (PRD §6.3).
 *
 * Copy-on-ingest is the DEFAULT because the owning CLI rotates and deletes its own
 * logs — a trajectory tool that loses data when the source disappears is useless.
 *
 * Write model (PRD §6.3.1):
 *   Model A (default, full-copy) — one atomic full copy, meta.complete = true
 *   Model B (--copy-strategy=incremental-append) — appended per batch, complete stays false
 *
 * Extension is per source: Codex/Claude land as plain `.jsonl` (they are already plain
 * JSONL, so compressing them is pure overhead); DSH keeps its original frame-concatenated
 * `.jsonl.zstd` so one reader serves both the source and the vault.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import type { SourceId, SessionRef } from './types.ts';

export type CopyStrategy = 'full-copy' | 'incremental-append';

export interface VaultMeta {
  source: SourceId;
  sessionId: string;
  sourcePath: string;
  sourceRevision?: string;
  byteSize: number;
  complete: boolean;
  ingestedAt: number;
  strategy: CopyStrategy;
}

export class Vault {
  constructor(private readonly root: string, private readonly strategy: CopyStrategy = 'full-copy') {}

  private dir(source: SourceId, sessionId: string): string {
    return path.join(this.root, source, safeSegment(sessionId));
  }
  metaPath(source: SourceId, sessionId: string): string {
    return path.join(this.dir(source, sessionId), 'meta.json');
  }
  dataPath(source: SourceId, sessionId: string): string {
    return path.join(this.dir(source, sessionId), source === 'dsh' ? 'session.jsonl.zstd' : 'session.jsonl');
  }

  async readMeta(ref: SessionRef): Promise<VaultMeta | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.metaPath(ref.source, ref.sessionId), 'utf8')) as VaultMeta;
    } catch { return undefined; }
  }

  /**
   * Persist the raw bytes. Returns the new metadata.
   * Model A writes a temp file then renames, so a crash never leaves a half vault.
   */
  async put(ref: SessionRef, raw: Buffer): Promise<VaultMeta> {
    const dir = this.dir(ref.source, ref.sessionId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = this.dataPath(ref.source, ref.sessionId);

    if (this.strategy === 'incremental-append' && (await this.readMeta(ref))?.complete === false) {
      await fs.appendFile(target, raw, { mode: 0o600 });
    } else {
      const tmp = target + '.' + randomSuffix() + '.tmp';
      await fs.writeFile(tmp, raw, { mode: 0o600 });
      await fs.rename(tmp, target);
    }

    const meta: VaultMeta = {
      source: ref.source,
      sessionId: ref.sessionId,
      sourcePath: ref.path,
      sourceRevision: ref.revision,
      byteSize: (await fs.stat(target)).size,
      complete: this.strategy === 'full-copy',
      ingestedAt: Date.now(),
      strategy: this.strategy,
    };
    await fs.writeFile(this.metaPath(ref.source, ref.sessionId), JSON.stringify(meta, null, 2), { mode: 0o600 });
    return meta;
  }

  /** Integrity check: vault truncated externally? */
  async isTruncated(ref: SessionRef): Promise<boolean> {
    const meta = await this.readMeta(ref);
    if (!meta || !meta.complete) return false;
    try {
      const st = await fs.stat(this.dataPath(ref.source, ref.sessionId));
      return st.size < meta.byteSize;
    } catch { return true; }
  }
}

/** Content-addressed blob store for large payloads (PRD §6.4). */
export class BlobStore {
  constructor(private readonly root: string) {}
  async put(data: string): Promise<string> {
    const buf = Buffer.from(data, 'utf8');
    const digest = createHash('sha256').update(buf).digest('hex');
    const dir = path.join(this.root, digest.slice(0, 2));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const p = path.join(dir, digest);
    try { await fs.access(p); } catch { await fs.writeFile(p, buf, { mode: 0o600 }); }
    return digest;
  }
  async get(digest: string): Promise<string> {
    return fs.readFile(path.join(this.root, digest.slice(0, 2), digest), 'utf8');
  }
}

export function isProbablyZstd(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0xfd2fb528;
}

export function decompress(buf: Buffer): string {
  if (!isProbablyZstd(buf)) return buf.toString('utf8');
  // single-frame fast path
  try { return zlib.zstdDecompressSync(buf).toString('utf8'); } catch { return ''; }
}

function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180) || 'unknown';
}
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
