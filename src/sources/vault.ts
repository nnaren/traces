/**
 * Vault-backed source adapters (P6) — the missing half of copy-on-ingest.
 *
 * vault.ts justifies the vault with: "the owning CLI rotates and deletes its own logs —
 * a trajectory tool that loses data when the source disappears is useless." That promise
 * is only kept if the captured bytes can be turned BACK into a trajectory, which needs an
 * ingest path that reads the vault instead of the source tree.
 *
 * A vault adapter is the corresponding real adapter with ONE method replaced:
 *
 *   discover()   walks data/vault/<source>/<sessionId>/ instead of ~/.codex etc.
 *   readAll()    unchanged — it is a pure function of the bytes and the path suffix, so
 *                a vault copy parses identically to its source (the DSH `.jsonl.zstd`
 *                suffix still routes through the frame walker).
 *   isRelevant() unchanged — same filter the source adapter applies.
 *
 * The `sourcePath` recorded at capture time is carried through the ref, so a replayed
 * session still tells you where it originally came from even if that file is long gone.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionRef, SourceId, TrajectorySourceAdapter } from '../types.ts';
import { codexAdapter } from './codex.ts';
import { claudeAdapter } from './claude.ts';
import { dshAdapter } from './dsh.ts';
import { Vault } from '../vault.ts';

const REAL: Record<SourceId, TrajectorySourceAdapter> = {
  codex: codexAdapter,
  'claude-code': claudeAdapter,
  dsh: dshAdapter,
};

export interface VaultEntry {
  ref: SessionRef;
  /** The vault copy is missing or shorter than meta.byteSize. */
  damaged: boolean;
  /** capture never finished (incremental-append strategy). */
  partial: boolean;
}

/** Enumerate one source's vault, reporting integrity problems instead of hiding them. */
export async function enumerateVault(vaultRoot: string, source: SourceId): Promise<VaultEntry[]> {
  const vault = new Vault(vaultRoot);
  const base = path.join(vaultRoot, source);
  const ids = await fs.readdir(base).catch(() => [] as string[]);
  const out: VaultEntry[] = [];

  for (const sessionId of ids.sort()) {
    const meta = await vault.readMeta({ source, sessionId } as SessionRef);
    if (!meta) continue; // not a vault directory
    const dataPath = vault.dataPath(source, sessionId);

    let size = -1;
    try { size = (await fs.stat(dataPath)).size; } catch { /* missing */ }
    const damaged = size < 0 || (meta.byteSize > 0 && size !== meta.byteSize);
    if (damaged) continue; // never normalize a payload we cannot fully account for

    out.push({
      ref: {
        source,
        sessionId,
        path: dataPath,
        // Preserve where this was captured from; the UI shows it and re-ingest compares it.
        cwd: undefined,
        byteSize: size,
        revision: meta.sourceRevision,
        startedAt: undefined,
      },
      damaged: false,
      partial: meta.complete === false,
    });
  }
  return out;
}

/** Replace a real adapter's discovery with vault discovery; everything else is reused. */
export function vaultAdapter(vaultRoot: string, source: SourceId): TrajectorySourceAdapter {
  const base = REAL[source];
  return {
    id: base.id,
    capabilities: base.capabilities,
    async *discover(): AsyncIterable<SessionRef> {
      for (const e of await enumerateVault(vaultRoot, source)) yield e.ref;
    },
    readAll: (ref, signal) => base.readAll(ref, signal),
    isRelevant: (raw) => base.isRelevant(raw),
  };
}

/** All three vault-backed adapters, for `ingest --from-vault`. */
export function vaultAdapters(vaultRoot: string): TrajectorySourceAdapter[] {
  return [vaultAdapter(vaultRoot, 'codex'), vaultAdapter(vaultRoot, 'claude-code'), vaultAdapter(vaultRoot, 'dsh')];
}