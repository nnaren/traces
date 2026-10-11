/**
 * Codex CLI rollout adapter — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * plus `~/.codex/archived_sessions/`.
 *
 * Facts established by measurement (trajectory-data-sources.md §1) and by the
 * feasibility report:
 *  - TWO parallel layers: `response_item` (conversation) + `event_msg` (UI/usage/timing).
 *    Both must be consumed; reading only one loses half the information.
 *  - `ordinal` exists ONLY on codex >= 0.147.0 (127/408 sessions measured). Older
 *    sessions must fall back to physical line order (R1).
 *  - `token_usage_record` is a 7th top-level type on codex >= 0.153.4 carrying
 *    `response_id` — response-level usage (R7).
 *  - Tool pairing uses `call_id`, NOT `id`.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SessionRef, SourceCapabilities, TrajectorySourceAdapter, RawLine } from '../types.ts';
import { readStable, splitLines, parseLine } from './stableRead.ts';

export const CODEX_CAPABILITIES: SourceCapabilities = {
  reasoning: 'encrypted',
  usageGranularity: 'ambiguous',
  cacheSemantics: 'ambiguous',
  cost: 'none',
  ttft: 'native',
  tokenTimeline: 'no',
  toolDuration: 'none',
  subagentTree: 'declared-only',
  ordering: 'ordinal',
  unknownEventPolicy: 'skip',
};

async function collectJsonl(dir: string, depth: number, maxDepth: number): Promise<string[]> {
  if (depth > maxDepth) return [];
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out: string[] = [];
  for (const name of names) {
    const p = path.join(dir, name);
    if (name.endsWith('.jsonl')) { out.push(p); continue; }
    const st = await fs.stat(p).catch(() => undefined);
    if (st?.isDirectory()) out.push(...await collectJsonl(p, depth + 1, maxDepth));
  }
  return out;
}

const TOP_TYPES = new Set([
  'session_meta', 'turn_context', 'response_item', 'event_msg', 'world_state',
  'inter_agent_communication_metadata', 'token_usage_record',
]);

/** Roots are overridable so the read-only guarantee can be proven against fixtures.
 *  Resolved lazily on every call — module-load-time capture would freeze the value. */
export const codexHome = (): string => process.env.TRAJVIEW_CODEX_HOME ?? path.join(homedir(), '.codex');

export const codexAdapter: TrajectorySourceAdapter = {
  id: 'codex',
  capabilities: CODEX_CAPABILITIES,

  async *discover(): AsyncIterable<SessionRef> {
    const root = codexHome();
    const bases = [path.join(root, 'sessions'), path.join(root, 'archived_sessions')];
    for (const base of bases) {
      // sessions/YYYY/MM/DD/*.jsonl is FOUR levels deep; archived_sessions is flat.
      // A bounded recursive walk handles both without hardcoding the depth.
      const entries = await collectJsonl(base, 0, 4);
      for (const p of entries.sort()) {
        // Read only the header line for cheap discovery.
        let first: any;
        try {
          const fd = await fs.open(p, 'r');
          try {
            const buf = Buffer.alloc(64 * 1024);
            const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
            // Scan the RAW BYTES for '\n', not the decoded string. UTF-8 multi-byte chars
            // (base_instructions.text is full of them) shift `indexOf` off the byte
            // boundary, and `buf.toString('utf8', 0, nl)` then slices mid-character and
            // truncates the JSON, which the parser reports as "Unterminated string" — and
            // the catch below silently dropped the session. That bug lost a codex
            // session with a large system prompt until it was caught by hand.
            let nl = -1;
            for (let i = 0; i < bytesRead; i++) {
              if (buf[i] === 0x0a) { nl = i; break; }
            }
            first = JSON.parse(buf.toString('utf8', 0, nl > 0 ? nl : bytesRead));
          } finally { await fd.close(); }
        } catch (err) {
          // Don't swallow silently — a malformed header was the original bug and we don't
          // want a regression to disappear into a lower count again.
          console.warn('trajview: codex header unreadable, skipping: ' + p + ' :: ' + (err instanceof Error ? err.message : String(err)));
          continue;
        }
        if (first?.type !== 'session_meta') continue;
        const st = await fs.stat(p).catch(() => undefined);
        // `payload.id` is this rollout's OWN thread id; `payload.session_id` is the ROOT
        // conversation. For a normal session the two are identical (113/113 measured on
        // this machine), but a subagent rollout carries its PARENT in `session_id`
        // (64/64 measured). Keying on `session_id` therefore gave every subagent its
        // parent's identity, so they collided and were dropped as duplicates — 36% of all
        // trajectories were invisible. `id` is present in every rollout, so prefer it.
        const spawn = first.payload?.source?.subagent?.thread_spawn;
        yield {
          source: 'codex',
          sessionId: first.payload?.id ?? first.payload?.session_id ?? path.basename(p),
          parentSessionId: first.payload?.parent_thread_id ?? spawn?.parent_thread_id,
          agentNickname: first.payload?.agent_nickname ?? spawn?.agent_nickname ?? undefined,
          subagentDepth: typeof spawn?.depth === 'number' ? spawn.depth : undefined,
          path: p,
          cwd: first.payload?.cwd,
          cliVersion: first.payload?.cli_version,
          // Filename dates can disagree with payload (timezones/archival); payload wins.
          startedAt: first.payload?.timestamp ? Date.parse(first.payload.timestamp) : undefined,
          byteSize: st?.size,
          revision: st ? [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':') : undefined,
        };
      }
    }
  },

  async readAll(ref: SessionRef): Promise<RawLine[]> {
    const { text } = await readStable(ref.path);
    return splitLines(text);
  },

  isRelevant(raw: RawLine): boolean {
    const o = parseLine(raw);
    if (!o) return raw.parseError !== undefined; // keep bad lines for diagnostics
    return TOP_TYPES.has(o.type);
  },
};
