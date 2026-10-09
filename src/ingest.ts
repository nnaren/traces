/**
 * Ingest pipeline: discover -> stable read -> vault (copy-on-ingest) -> normalize -> store.
 *
 * Sources are opened READ-ONLY and never written. Enforced by construction: every
 * filesystem call in this path targets either the vault/data dir or a read-mode fd.
 */
import { promises as fs } from 'node:fs';
import { normalizeCodex } from './normalize/codex.ts';
import { normalizeClaude } from './normalize/claude.ts';
import { normalizeDsh, type DshRefusal } from './normalize/dsh.ts';
import { codexAdapter } from './sources/codex.ts';
import { claudeAdapter } from './sources/claude.ts';
import { dshAdapter } from './sources/dsh.ts';
import { Vault, type CopyStrategy } from './vault.ts';
import { Store } from './store.ts';
import type { NormSession, SessionRef, SourceId, TrajectorySourceAdapter } from './types.ts';

export const ADAPTERS: TrajectorySourceAdapter[] = [codexAdapter, claudeAdapter, dshAdapter];

export interface IngestOptions {
  dataDir: string;
  sources?: SourceId[];
  limitPerSource?: number;
  copyStrategy?: CopyStrategy;
  noVault?: boolean;
  /** Re-normalize even when the source has not changed (e.g. normalizer was fixed). */
  force?: boolean;
  /** Adapter override; defaults to the three real sources. Injected by tests. */
  adapters?: TrajectorySourceAdapter[];
  onProgress?: (msg: string) => void;
}

export interface IngestReport {
  discovered: Record<string, number>;
  ingested: Record<string, number>;
  skippedUnchanged: Record<string, number>;
  /** Duplicate discoveries discarded because an existing copy had more records. */
  superseded: Record<string, number>;
  records: Record<string, number>;
  refusals: DshRefusal[];
  errors: Array<{ source: string; sessionId: string; message: string }>;
  elapsedMs: number;
}

function normalizeFor(adapter: TrajectorySourceAdapter, ref: SessionRef, lines: any[], refusals: DshRefusal[]) {
  if (adapter.id === 'codex') return normalizeCodex(ref, lines);
  if (adapter.id === 'claude-code') return normalizeClaude(ref, lines);
  return normalizeDsh(ref, lines, refusals);
}

export async function ingest(opts: IngestOptions): Promise<IngestReport> {
  const t0 = Date.now();
  const wanted = new Set<SourceId>(opts.sources ?? (['codex', 'claude-code', 'dsh'] as SourceId[]));
  const log = opts.onProgress ?? (() => {});
  const report: IngestReport = {
    discovered: {}, ingested: {}, skippedUnchanged: {}, records: {}, superseded: {},
    refusals: [], errors: [], elapsedMs: 0,
  };

  const store = await Store.open(opts.dataDir);
  const vault = new Vault(opts.dataDir + '/vault', opts.copyStrategy ?? 'full-copy');

  try {
    for (const adapter of (opts.adapters ?? ADAPTERS)) {
      if (!wanted.has(adapter.id)) continue;
      report.discovered[adapter.id] = 0;
      report.ingested[adapter.id] = 0;
      report.skippedUnchanged[adapter.id] = 0;
      report.records[adapter.id] = 0;
      report.superseded[adapter.id] = 0;

      let n = 0;
      // sessionIds already accepted during THIS run. Only these are duplicate discoveries
      // competing with each other; a row left behind by an earlier run is not a duplicate,
      // it is the previous parse, which a re-ingest is meant to replace.
      const accepted = new Set<string>();
      for await (const ref of adapter.discover()) {
        report.discovered[adapter.id]++;
        if (opts.limitPerSource && n >= opts.limitPerSource) break;
        n++;
        try {
          const existing = await vault.readMeta(ref);
          const truncated = existing ? await vault.isTruncated(ref) : false;
          // Skip when the source has not changed since the last vault write.
          if (!opts.force && existing && existing.complete && !truncated && existing.sourceRevision === ref.revision) {
            report.skippedUnchanged[adapter.id]++;
            if (store.getSession(ref.source, ref.sessionId)) continue;
            // fall through if the derived row is missing
          }

          const lines = await adapter.readAll(ref);
          const relevant = lines.filter((l) => adapter.isRelevant(l));

          const session: NormSession = normalizeFor(adapter, ref, relevant, report.refusals);

          // The same session can be discovered twice (Codex: sessions/ vs archived_sessions/).
          // Keep whichever copy actually holds more trajectory rather than letting the
          // last one seen overwrite a richer file.
          //
          // Scope matters here, and getting it wrong is silent:
          //  - Two discoveries of one sessionId WITHIN this run are duplicates: the richer
          //    copy must win, or the last-seen (possibly archived, possibly truncated) copy
          //    overwrites the trajectory.
          //  - A row from a PREVIOUS run is not a duplicate. --force exists precisely to
          //    replace it, even when a parser fix legitimately shrinks the session.
          //
          // This decision MUST happen before the vault write: the vault is the immutable
          // raw archive — it exists because the owning CLI rotates and deletes its own
          // logs — so a copy we are about to reject must never land in it.
          const prior = store.getSession(ref.source, ref.sessionId);
          if (accepted.has(ref.sessionId) && prior && Number(prior.record_count) > session.records.length) {
            report.superseded[adapter.id] = (report.superseded[adapter.id] ?? 0) + 1;
            continue;
          }

          let vaultPath = ref.path;
          if (!opts.noVault) {
            const raw = await fs.readFile(ref.path);
            const meta = await vault.put(ref, raw);
            vaultPath = vault.dataPath(ref.source, ref.sessionId);
            void meta;
          }

          store.writeSession(session, vaultPath, ref.path);
          accepted.add(ref.sessionId);
          report.ingested[adapter.id]++;
          report.records[adapter.id] += session.records.length;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          report.errors.push({ source: adapter.id, sessionId: ref.sessionId, message });
          log('  ! ' + adapter.id + '/' + ref.sessionId + ': ' + message);
        }
      }
      log('[' + adapter.id + '] discovered=' + report.discovered[adapter.id] +
          ' ingested=' + report.ingested[adapter.id] +
          ' unchanged=' + report.skippedUnchanged[adapter.id] +
          ' records=' + report.records[adapter.id] +
          (report.superseded[adapter.id] ? ' superseded=' + report.superseded[adapter.id] : ''));
    }
  } finally {
    store.close();
  }
  report.elapsedMs = Date.now() - t0;
  return report;
}
