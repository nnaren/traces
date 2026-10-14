/**
 * Claude Code adapter — `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`
 * plus the session's own subagent transcripts.
 *
 * Measured facts (trajectory-data-sources.md §2, re-measured on this machine):
 *  - NO `ordinal` and NO `seq`: authoritative order is PHYSICAL LINE ORDER.
 *    Sorting by timestamp is wrong (same-ms records, clock skew).
 *  - `thinking` is PLAINTEXT (the one thing Codex cannot show).
 *  - `usage` is PER-ASSISTANT-RECORD, not per turn — must be summed and labelled.
 *  - `cost-state` is a PERIODIC SNAPSHOT, not a delta: take the last one only.
 *  - turn boundary = `system:turn_duration` + the `isMeta=false` user string (dual criteria).
 *  - bulky UI/snapshot records are filtered by default.
 *
 * SUBAGENTS (the reason this adapter has a second discovery path):
 *
 *   projects/<slug>/<session>.jsonl                              the root conversation
 *   projects/<slug>/<session>/subagents/agent-<agentId>.jsonl     ONE spawned subagent
 *   projects/<slug>/<session>/subagents/agent-<agentId>.meta.json its spawn descriptor
 *
 * Three facts about those files drive the whole design here, all measured on the
 * 996c7dee session (4 subagents, 1597 lines):
 *
 *  1. They are TWO levels below the project directory, not beside the session file. The
 *     older layout (`projects/<slug>/agent-<uuid>.jsonl`, the one the format doc describes)
 *     is still recognised, but this machine writes none: 3 sessions carry `subagents/`,
 *     0 carry a flat file. A non-recursive walk simply never sees them.
 *  2. Every record inside a subagent transcript repeats the PARENT's `sessionId`. Keying a
 *     subagent on `first.sessionId` therefore collapses all of them onto the parent and
 *     they collide in `sessions`' primary key — silently, because the loser's rows just
 *     overwrite the winner's. The child's own identity is its `agentId`, which is also
 *     the filename stem, so the session id is DERIVED from both.
 *  3. The parent-child link is `subagents/agent-<id>.meta.json` → `toolUseId`, which is the
 *     parent's `tool_use.id` for the `Agent` call. Claude's `Agent` RESULT carries no id
 *     (it is the subagent's final prose), so this sidecar is the ONLY key to a jump link —
 *     hence SessionRef.spawnCallId.
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
  // The parent/child link is WRITTEN BY CLAUDE ITSELF in `subagents/*.meta.json`
  // (`toolUseId` + `spawnDepth`), not reconstructed from message flow — so it is
  // structural, exactly like Codex's `session_meta.source.subagent.thread_spawn`.
  subagentTree: 'structural',
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

/** Filename stem Claude gives a subagent transcript: `agent-<agentId>.jsonl`. */
const AGENT_FILE = /^agent-(.+)\.jsonl$/;

/**
 * A subagent transcript's own session id.
 *
 * It CANNOT be `first.sessionId`: every record in the file repeats the PARENT's id (4/4
 * measured), so three subagents of one session would claim one primary key and overwrite
 * each other in `sessions`. The child is identified by `agentId` — which is both its
 * `agentId` field and the filename stem — and the parent prefix keeps the id unique across
 * projects and lets the tree group by a plain string comparison, like Codex's ULIDs do.
 */
export function claudeSubagentSessionId(parentSessionId: string, agentId: string): string {
  return `${parentSessionId}--sub-${agentId}`;
}

/** The spawn descriptor Claude writes beside every subagent transcript. */
export interface ClaudeSubagentMeta {
  agentType?: string;
  description?: string;
  /** The parent's `tool_use.id` for the `Agent` call — the ONLY parent↔child key. */
  toolUseId?: string;
  spawnDepth?: number;
  model?: string;
}

interface SubagentLayout {
  agentId: string;
  /**
   * The parent taken from the DIRECTORY the transcript lives in
   * (`projects/<slug>/<session>/subagents/`). Present for the nested layout; absent for the
   * flat one, where the file's own `sessionId` field is the only available key.
   */
  parentFromPath?: string;
  metaPath: string;
}

/**
 * Recognise a path as a subagent transcript, in either layout this machine has shown:
 *
 *   projects/<slug>/<session>/subagents/agent-<id>.jsonl   nested (what 2.1.270 writes)
 *   projects/<slug>/agent-<id>.jsonl                       flat   (older, documented)
 *
 * Path shape — not the record contents — is the discriminator, because a root conversation
 * is also `<session>.jsonl` and the two must never be confused.
 */
function subagentLayout(p: string): SubagentLayout | undefined {
  const m = AGENT_FILE.exec(path.basename(p));
  if (!m) return undefined;
  const dir = path.dirname(p);   // .../<session>/subagents   or   .../<slug>
  const nested = path.basename(dir) === 'subagents' ? dir : undefined;
  return {
    agentId: m[1],
    parentFromPath: nested ? path.basename(path.dirname(nested)) : undefined,
    metaPath: p.replace(/\.jsonl$/, '.meta.json'),
  };
}

async function readSubagentMeta(metaPath: string): Promise<ClaudeSubagentMeta | undefined> {
  try {
    const o = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    return o && typeof o === 'object' ? (o as ClaudeSubagentMeta) : undefined;
  } catch { return undefined; }
}

/**
 * Build the ref for ONE subagent transcript.
 *
 * `parent` supplies what the child's own header may not carry (the project slug → cwd on
 * older captures); `layout` supplies the identity the path encodes. `first.sessionId` is
 * read ONLY for the flat layout, where it is the parent's id by construction — using it as
 * this transcript's own id is the collision described above.
 */
async function buildSubagentRef(
  p: string, layout: SubagentLayout, first: any, parent?: SessionRef,
): Promise<SessionRef> {
  const meta = await readSubagentMeta(layout.metaPath);
  const parentSessionId = layout.parentFromPath ?? first?.sessionId ?? parent?.sessionId;
  const st = await fs.stat(p).catch(() => undefined);
  return {
    source: 'claude-code',
    sessionId: parentSessionId
      ? claudeSubagentSessionId(parentSessionId, layout.agentId)
      : claudeSubagentSessionId('unknown', layout.agentId),
    parentSessionId,
    // Claude has no nickname: the spawn's `description` ("执行评审任务 ReviewTask-1") is the
    // human label the user typed, and falls back to the agent preset it ran under.
    agentNickname: meta?.description ?? meta?.agentType,
    subagentDepth: typeof meta?.spawnDepth === 'number' ? meta.spawnDepth : undefined,
    spawnCallId: meta?.toolUseId,
    path: p,
    // A subagent header DOES carry `cwd`/`version`/`gitBranch` on this machine, and it is
    // more precise than the slug lookup (which truncates at a 40-char path prefix).
    cwd: first?.cwd ?? parent?.cwd ?? cwdFromSourcePath(p),
    gitBranch: first?.gitBranch ?? parent?.gitBranch,
    cliVersion: first?.version ?? parent?.cliVersion,
    startedAt: first?.timestamp ? Date.parse(first.timestamp) : parent?.startedAt,
    byteSize: st?.size,
    revision: st ? [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':') : undefined,
  };
}

/** One subagent transcript, header first. Returns undefined when the file is unreadable. */
async function readSubagentRef(p: string, parent?: SessionRef): Promise<SessionRef | undefined> {
  const layout = subagentLayout(p);
  if (!layout) return undefined;
  const first = await readHeaderLine(p);
  if (!first || typeof first !== 'object') return undefined;
  return buildSubagentRef(p, layout, first, parent);
}

/**
 * Read a session's first line, sliced at a real UTF-8 newline.
 *
 * The same boundary bug as codex.ts lives here: a header whose first line contains
 * multi-byte characters was being sliced mid-character, `JSON.parse` threw, and the whole
 * session was skipped with only a warning. Claude's prompts are routinely Chinese.
 */
async function readHeaderLine(p: string): Promise<any> {
  try {
    const fd = await fs.open(p, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      let nl = -1;
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0x0a) { nl = i; break; }
      }
      return JSON.parse(buf.toString('utf8', 0, nl > 0 ? nl : bytesRead));
    } finally { await fd.close(); }
  } catch (err) {
    console.warn('trajview: claude header unreadable, skipping: ' + p + ' :: ' + (err instanceof Error ? err.message : String(err)));
    return undefined;
  }
}

/** `agent-*.jsonl` transcripts of one session directory, newest layout first. */
async function listSubagentFiles(sessionDir: string): Promise<string[]> {
  const nested = path.join(sessionDir, 'subagents');
  const files = (await fs.readdir(nested).catch(() => [] as string[]))
    .filter((f) => AGENT_FILE.test(f))
    .sort();
  return files.map((f) => path.join(nested, f));
}

export const claudeAdapter: TrajectorySourceAdapter = {
  id: 'claude-code',
  capabilities: CLAUDE_CAPABILITIES,

  async *discover(): AsyncIterable<SessionRef> {
    const base = path.join(claudeHome(), 'projects');
    const projects = await fs.readdir(base).catch(() => []);
    for (const proj of projects) {
      const dir = path.join(base, proj);
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => e.name).sort();
      // `agent-*.jsonl` beside the session files is the OLD flat subagent layout. This
      // machine writes none of them (3 sessions carry `subagents/`, 0 carry a flat file),
      // but recognising it costs nothing and the format doc still describes it.
      const flatSubagents = files.filter((f) => AGENT_FILE.test(f));
      const sessionFiles = files.filter((f) => !AGENT_FILE.test(f));

      for (const f of sessionFiles) {
        const p = path.join(dir, f);
        const first = await readHeaderLine(p);
        if (!first || typeof first !== 'object') continue;
        const st = await fs.stat(p).catch(() => undefined);
        const sessionId = first.sessionId ?? f.replace(/\.jsonl$/, '');
        const ref = buildClaudeRef(p, sessionId, first, st);
        yield ref;

        // The subagent transcripts live in `<session>/subagents/`, two levels below the
        // project directory — the walk above never descends, which is exactly why four
        // subagents of this machine's 996c7dee session were invisible.
        for (const sp of await listSubagentFiles(path.join(dir, f.replace(/\.jsonl$/, '')))) {
          const child = await readSubagentRef(sp, ref);
          if (child) yield child;
        }
      }

      // A session directory whose `<session>.jsonl` is gone (Claude Code deletes its own
      // logs) still holds its subagents. Yielding them as orphans keeps the trajectories:
      // `buildSessionTree` leaves a parentless session at the top level rather than hiding
      // it, and `parentSessionId` still names the conversation they belong to.
      for (const e of entries.filter((x) => x.isDirectory() && x.name !== 'memory')) {
        if (sessionFiles.includes(e.name + '.jsonl')) continue;
        for (const sp of await listSubagentFiles(path.join(dir, e.name))) {
          const child = await readSubagentRef(sp, { source: 'claude-code', sessionId: e.name, path: '' });
          if (child) yield child;
        }
      }

      for (const f of flatSubagents) {
        const child = await readSubagentRef(path.join(dir, f));
        if (child) yield child;
      }
    }
  },

  readRef: async (p: string, sourcePath?: string) => {
    // A subagent capture must be recognised from its ORIGINAL path: inside the vault the
    // file is re-hosted as `<id>/session.jsonl`, where the filename says nothing. Deriving
    // the layout here (rather than in the replay path) keeps one implementation of it.
    const origin = sourcePath ?? p;
    const originLayout = subagentLayout(origin);
    if (originLayout) {
      const child = await readSubagentRef(p, { source: 'claude-code', sessionId: originLayout.parentFromPath ?? '', path: origin });
      // Same reason as the root branch below: the vault copy's own path carries no project
      // slug, so a capture whose header lacks `cwd` recovers it from the ORIGINAL path.
      if (child) child.cwd = cwdFromSourcePath(origin) ?? child.cwd;
      return child;
    }
    const first = await readHeaderLine(p);
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
