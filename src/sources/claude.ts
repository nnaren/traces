/**
 * Claude Code adapter — `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`
 * plus `agent-<uuid>.jsonl` for subagents.
 *
 * Measured facts (trajectory-data-sources.md §2):
 *  - NO `ordinal` and NO `seq`: authoritative order is PHYSICAL LINE ORDER.
 *    Sorting by timestamp is wrong (same-ms records, clock skew).
 *  - `thinking` is PLAINTEXT (the one thing Codex cannot show).
 *  - `usage` is PER-ASSISTANT-RECORD, not per turn — must be summed and labelled.
 *  - `cost-state` is a PERIODIC SNAPSHOT, not a delta: take the last one only.
 *  - turn boundary = `system:turn_duration` + the `isMeta=false` user string (dual criteria).
 *  - bulky UI/snapshot records are filtered by default.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SessionRef, SourceCapabilities, TrajectorySourceAdapter, RawLine } from '../types.ts';
import { readStable, splitLines, parseLine } from './stableRead.ts';
import { projectSlugFromPath, resolveProjectSlugCached } from './claudeSlug.ts';

/**
 * The project directory for a Claude session, recovered from the `projects/<slug>/` folder.
 *
 * This is the ONLY reliable source on this machine: the session's first line carries no
 * `cwd` (all 69 measured files), so the adapter's old `first.cwd` was always `undefined` —
 * which is why every Claude card was missing its path. The slug is resolved against the
 * filesystem rather than decoded; see claudeSlug.ts for why decoding alone is wrong.
 */
function cwdFromSourcePath(p: string): string | undefined {
  const slug = projectSlugFromPath(p);
  return slug ? resolveProjectSlugCached(slug) : undefined;
}

/** Shared ref construction, so discovery and vault replay cannot drift apart. */
function buildClaudeRef(p: string, sessionId: string, first: any, st?: { size: number; dev: number; ino: number; mtimeMs: number; ctimeMs: number }): SessionRef {
  return {
    source: 'claude-code',
    sessionId,
    path: p,
    // Prefer the project directory from the slug. `first.cwd` is kept as a fallback for
    // captures taken from a layout that does carry it, but it is absent in every file here.
    cwd: cwdFromSourcePath(p) ?? first?.cwd,
    gitBranch: first?.gitBranch,
    cliVersion: first?.version,
    startedAt: first?.timestamp ? Date.parse(first.timestamp) : undefined,
    byteSize: st?.size,
    revision: st ? [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':') : undefined,
  };
}

export const CLAUDE_CAPABILITIES: SourceCapabilities = {
  reasoning: 'plaintext',
  usageGranularity: 'per-record',
  cacheSemantics: 'separate',
  cost: 'native',
  ttft: 'none',
  tokenTimeline: 'no',
  toolDuration: 'derivable',
  subagentTree: 'inferred',
  ordering: 'physical-line-order',
  unknownEventPolicy: 'skip',
};

/** Records that carry no trajectory information and are huge (risk #5). */
const FILTERED = new Set([
  'attachment', 'file-history-snapshot', 'file-history-delta',
  'last-prompt', 'mode', 'permission-mode', 'atis-latch',
  'queue-operation', 'ai-title',
]);

export const claudeHome = (): string => process.env.TRAJVIEW_CLAUDE_HOME ?? path.join(homedir(), '.claude');

export const claudeAdapter: TrajectorySourceAdapter = {
  id: 'claude-code',
  capabilities: CLAUDE_CAPABILITIES,

  async *discover(): AsyncIterable<SessionRef> {
    const base = path.join(claudeHome(), 'projects');
    const projects = await fs.readdir(base).catch(() => []);
    for (const proj of projects) {
      const dir = path.join(base, proj);
      const files = await fs.readdir(dir).catch(() => []);
      for (const f of files.sort()) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(dir, f);
        let first: any;
        try {
          const fd = await fs.open(p, 'r');
          try {
            const buf = Buffer.alloc(64 * 1024);
            const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
            // Same UTF-8 boundary bug as codex.ts — see the note there. Any header whose
            // first line has multi-byte chars was being sliced mid-character and the
            // session was silently dropped from the ledger.
            let nl = -1;
            for (let i = 0; i < bytesRead; i++) {
              if (buf[i] === 0x0a) { nl = i; break; }
            }
            first = JSON.parse(buf.toString('utf8', 0, nl > 0 ? nl : bytesRead));
          } finally { await fd.close(); }
        } catch (err) {
          console.warn('trajview: claude header unreadable, skipping: ' + p + ' :: ' + (err instanceof Error ? err.message : String(err)));
          continue;
        }
        if (!first || typeof first !== 'object') continue;
        const st = await fs.stat(p).catch(() => undefined);
        yield buildClaudeRef(p, first.sessionId ?? f.replace(/\.jsonl$/, ''), first, st);
      }
    }
  },

  readRef: async (p: string, sourcePath?: string) => {
    let first: any;
    try {
      const fd = await fs.open(p, 'r');
      try {
        const buf = Buffer.alloc(64 * 1024);
        const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
        let nl = -1;
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === 0x0a) { nl = i; break; }
        }
        first = JSON.parse(buf.toString('utf8', 0, nl > 0 ? nl : bytesRead));
      } finally { await fd.close(); }
    } catch { return undefined; }
    if (!first || typeof first !== 'object') return undefined;
    const st = await fs.stat(p).catch(() => undefined);
    const ref = buildClaudeRef(p, first.sessionId ?? path.basename(p, '.jsonl'), first, st);
    // A vault capture re-hosts the file under data/vault/claude-code/<id>/, so its OWN path
    // no longer carries the project slug. The ORIGINAL path (in meta.json) still does, and
    // that is the only place the project directory can be recovered from on replay.
    if (sourcePath) ref.cwd = cwdFromSourcePath(sourcePath) ?? ref.cwd;
    return ref;
  },

  async readAll(ref: SessionRef): Promise<RawLine[]> {
    const { text } = await readStable(ref.path);
    return splitLines(text);
  },

  isRelevant(raw: RawLine): boolean {
    const o = parseLine(raw);
    if (!o) return raw.parseError !== undefined;
    return o.type !== undefined && !FILTERED.has(o.type);
  },
};
