/**
 * Derived store (PRD §6.4). Everything here is DISPOSABLE: `rm traces.sqlite3 blobs/` plus
 * `npm run ingest -- --from-vault` reproduces it from the vault alone — byte-identical
 * rows, blobs and FTS index — WITHOUT reading the source tree, so it still works after
 * the owning CLI has rotated its own logs away (P6).
 *
 * Thin common spine + per-source detail tables, so a source adding a field never
 * migrates the spine. Uses node:sqlite (zero native dependency).
 */
import { DatabaseSync } from 'node:sqlite';
import { promises as fs, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

import path from 'node:path';
import type { NormRecord, NormSession, NormStep, NormTurn, SourceId } from './types.ts';

const APPLICATION_ID = 0x5452414a; // 'TRAJ'
const SCHEMA_VERSION = 3;
const BLOB_THRESHOLD = 16 * 1024;
/** Distinct blobs remembered per Store, to skip rewriting an identical payload. */
const BLOB_CACHE_MAX = 4096;

export class Store {
  private db: DatabaseSync;
  private blobRoot: string;
  private blobCache = new Map<string, string>();

  private constructor(private dbPath: string, blobRoot: string) {
    this.blobRoot = blobRoot;
    this.db = new DatabaseSync(dbPath);
  }

  static async open(dataDir: string): Promise<Store> {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(dataDir, 'traces.sqlite3');
    const s = new Store(dbPath, path.join(dataDir, 'blobs'));
    await fs.mkdir(s.blobRoot, { recursive: true, mode: 0o700 });
    s.init();
    return s;
  }

  private init() {
    const appId = this.db.prepare('PRAGMA application_id').get() as any;
    const userVersion = this.db.prepare('PRAGMA user_version').get() as any;
    const current = Number(userVersion?.user_version ?? 0);
    const currentApp = Number(appId?.application_id ?? 0);

    if (currentApp !== 0 && currentApp !== APPLICATION_ID) {
      throw new Error(
        'refusing to open foreign database: application_id=' + currentApp +
        ' (expected ' + APPLICATION_ID + '). Delete it or point --data-dir elsewhere.',
      );
    }
    if (currentApp === 0) {
      // Adopt a genuinely empty database, but never one that already holds foreign tables.
      const tables = this.db.prepare(
        "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      ).get() as any;
      if (Number(tables?.n ?? 0) > 0) {
        throw new Error(
          'refusing to adopt a non-empty database without application_id (found ' +
          tables.n + ' tables). Delete it or point --data-dir elsewhere.',
        );
      }
    }
    if (currentApp === APPLICATION_ID && current !== SCHEMA_VERSION) {
      if (current > SCHEMA_VERSION) {
        throw new Error('database schema v' + current + ' is newer than this build (v' + SCHEMA_VERSION + '); refusing to downgrade');
      }
      this.reset();
    }
    this.migrate();
    this.db.exec('PRAGMA application_id = ' + APPLICATION_ID);
    this.db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    this.db.exec('PRAGMA journal_mode = WAL');
  }

  private reset() {
    const tables = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
    ).all() as any[];
    for (const t of tables) this.db.exec('DROP TABLE IF EXISTS "' + t.name + '"');
  }

  /**
   * DEVIATION FROM PRD §6.4 — documented rather than silently shipped.
   *
   * The PRD prescribed a thin common spine PLUS `record_detail_codex / _claude / _dsh`
   * tables and a separate `usage_events` table. This implementation keeps the spine but
   * stores per-source payloads as TEXT on the spine row (`detail_text`, or a blob ref
   * when large) instead of per-source detail tables.
   *
   * Why: the migration-avoidance goal is still met — a new source's raw payload is just
   * opaque TEXT, so nothing in the spine changes when a source evolves — and the
   * three-table split bought nothing while every per-source query would need an extra
   * join. `usage_events` was dropped for the same reason: `records.usage_json` is
   * already queryable per record and per turn.
   *
   * Revisit if per-source payload columns ever need real SQL predicates.
   */
  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        source TEXT NOT NULL, session_id TEXT NOT NULL,
        vault_path TEXT, source_path TEXT, cwd TEXT, git_branch TEXT, cli_version TEXT,
        -- Codex subagents: the spawning conversation, its nickname and the spawn depth.
        -- Claude subagents additionally record the spawning Agent call's id, which is the
        -- ONLY parent-child key the UI can use (Claude's tool result carries no child id).
        parent_session_id TEXT, agent_nickname TEXT, subagent_depth INTEGER, spawn_call_id TEXT,
        started_at INTEGER, ended_at INTEGER, first_seen_at INTEGER NOT NULL, last_ingested_at INTEGER NOT NULL,
        capabilities_json TEXT NOT NULL, diagnostics_json TEXT NOT NULL DEFAULT '{}',
        record_count INTEGER DEFAULT 0, turn_count INTEGER DEFAULT 0, step_count INTEGER DEFAULT 0,
        PRIMARY KEY (source, session_id)
      );
      CREATE TABLE IF NOT EXISTS turns (
        source TEXT, session_id TEXT, turn_index INTEGER,
        source_turn_id TEXT, boundary_confidence TEXT,
        started_at INTEGER, ended_at INTEGER, duration_ms INTEGER, ttft_ms INTEGER, end_reason TEXT,
        PRIMARY KEY (source, session_id, turn_index)
      );
      CREATE TABLE IF NOT EXISTS steps (
        source TEXT, session_id TEXT, step_index INTEGER, turn_index INTEGER,
        source_step_id TEXT,
        boundary_confidence TEXT, started_at INTEGER, ended_at INTEGER,
        ttft_ms INTEGER, decode_ms INTEGER, model TEXT, usage_json TEXT, reasoning_json TEXT,
        PRIMARY KEY (source, session_id, step_index)
      );
      CREATE TABLE IF NOT EXISTS records (
        source TEXT, session_id TEXT, record_id TEXT,
        order_index INTEGER NOT NULL, kind TEXT NOT NULL,
        turn_index INTEGER, step_index INTEGER, source_seq TEXT,
        started_at INTEGER, time_seconds REAL,
        tool_name TEXT, call_id TEXT, is_error INTEGER,
        tool_json TEXT,
        hook_json TEXT,
        usage_json TEXT, flags_json TEXT,
        summary TEXT, detail_text TEXT, detail_blob TEXT,
        PRIMARY KEY (source, session_id, record_id)
      );
      CREATE INDEX IF NOT EXISTS records_by_order ON records(source, session_id, order_index);
      CREATE INDEX IF NOT EXISTS records_by_turn  ON records(source, session_id, turn_index);
      CREATE INDEX IF NOT EXISTS records_by_tool  ON records(source, session_id, tool_name);
      CREATE INDEX IF NOT EXISTS sessions_by_time ON sessions(source, last_ingested_at DESC);
      -- A regular (non-contentless) fts5 table, deliberately.
      -- content='' was tried first to avoid a second copy of the text, but SQLite then
      -- (a) returns NULL for every UNINDEXED column, breaking the join back to the records table,
      -- and (b) rejects DELETE, which the re-ingest path needs to replace a session.
      -- Correctness beats the space saving at this corpus size.
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
        text, session_id UNINDEXED, source UNINDEXED, record_id UNINDEXED,
        tokenize='unicode61'
      );
    `);

    // CREATE TABLE IF NOT EXISTS never adds a column to an existing table, so derived
    // stores created before a column landed need it appended here. The derived layer is
    // rebuildable from the vault, but a cheap ALTER avoids forcing a full re-ingest.
    const cols = (table: string): string[] =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
    if (!cols('steps').includes('source_step_id')) {
      this.db.exec('ALTER TABLE steps ADD COLUMN source_step_id TEXT');
    }
    if (!cols('records').includes('tool_json')) {
      this.db.exec('ALTER TABLE records ADD COLUMN tool_json TEXT');
    }
    // Hook metadata (event name, handler index, config path, the tool call the injection
    // led to). Kept beside `tool_json` rather than folded into `detail_text`, because the
    // UI links a hook to the tool record it triggered — that link is structure, not prose.
    if (!cols('records').includes('hook_json')) {
      this.db.exec('ALTER TABLE records ADD COLUMN hook_json TEXT');
    }
    // The spawning tool call of a subagent. Same reasoning as the columns above: the link
    // lives in the SOURCE's layout (claude's `subagents/*.meta.json` → `toolUseId`), never
    // in the transcript's own bytes, so it has to be carried explicitly.
    if (!cols('sessions').includes('spawn_call_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN spawn_call_id TEXT');
    }
    // The other half of the parent↔child link: `sessions.spawn_call_id` points AT a record,
    // and this index is how it is found again — every "返回父会话" click has to resolve it.
    // Without it the lookup degrades into a scan of the parent's whole record set.
    this.db.exec('CREATE INDEX IF NOT EXISTS records_by_call ON records(source, session_id, call_id)');
    // The reverse direction of the same link: which child session did this call spawn?
    // Resolved server-side so the inspector's jump link does not depend on the caller's
    // session LIST — that list is capped and time-ordered, so a child that fell outside it
    // would silently have no link at all.
    this.db.exec('CREATE INDEX IF NOT EXISTS sessions_by_spawn_call ON sessions(source, spawn_call_id)');
  }

  /**
   * Content-address a payload under blobs/. Returns null when the blob could NOT be
   * written (read-only data dir, full disk, a directory squatting the content-addressed
   * path) so the caller can keep it inline.
   *
   * A digest we cannot read back is worse than no digest at all: the row would claim a
   * payload exists, recordDetail() would return undefined, and the raw output would be
   * unrecoverable from the derived layer. Degrading to inline costs only some row width.
   */
  private putBlob(text: string): string | null {
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    const cached = this.blobCache.get(digest);
    if (cached !== undefined) return cached;
    const dir = path.join(this.blobRoot, digest.slice(0, 2));
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, digest), text, { mode: 0o600 });
    } catch {
      return null; // deliberately uncached: the next session may get a different data dir
    }
    // Keyed by digest, not by text, so the map does not pin every payload in memory.
    if (this.blobCache.size >= BLOB_CACHE_MAX) this.blobCache.clear();
    this.blobCache.set(digest, digest);
    return digest;
  }

  readBlob(digest: string): string | undefined {
    try { return readFileSync(path.join(this.blobRoot, digest.slice(0, 2), digest), 'utf8'); }
    catch { return undefined; }
  }

  /** Replace a session atomically: delete children then reinsert. */
  writeSession(s: NormSession, vaultPath: string, sourcePath: string): void {
    const now = Date.now();
    const key = [s.source, s.sessionId];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM records WHERE source=? AND session_id=?').run(...key);
      this.db.prepare('DELETE FROM steps WHERE source=? AND session_id=?').run(...key);
      this.db.prepare('DELETE FROM turns WHERE source=? AND session_id=?').run(...key);
      this.db.prepare('DELETE FROM records_fts WHERE session_id=? AND source=?').run(s.sessionId, s.source);
      this.db.prepare(`
        INSERT INTO sessions (source, session_id, vault_path, source_path, cwd, git_branch, cli_version,
          parent_session_id, agent_nickname, subagent_depth, spawn_call_id,
          started_at, ended_at, first_seen_at, last_ingested_at, capabilities_json, diagnostics_json,
          record_count, turn_count, step_count)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source, session_id) DO UPDATE SET
          vault_path=excluded.vault_path, source_path=excluded.source_path, cwd=excluded.cwd,
          git_branch=excluded.git_branch, cli_version=excluded.cli_version,
          parent_session_id=excluded.parent_session_id, agent_nickname=excluded.agent_nickname,
          subagent_depth=excluded.subagent_depth, spawn_call_id=excluded.spawn_call_id,
          started_at=excluded.started_at,
          ended_at=excluded.ended_at, last_ingested_at=excluded.last_ingested_at,
          capabilities_json=excluded.capabilities_json, diagnostics_json=excluded.diagnostics_json,
          record_count=excluded.record_count, turn_count=excluded.turn_count, step_count=excluded.step_count
      `).run(s.source, s.sessionId, vaultPath, sourcePath, s.cwd ?? null, s.gitBranch ?? null, s.cliVersion ?? null,
        s.parentSessionId ?? null, s.agentNickname ?? null, s.subagentDepth ?? null, s.spawnCallId ?? null,
        s.startedAt ?? null, s.endedAt ?? null, now, now, JSON.stringify(s.capabilities),
        JSON.stringify(s.diagnostics), s.records.length, s.turns.length, s.steps.length);

      const insTurn = this.db.prepare(`INSERT INTO turns (source,session_id,turn_index,source_turn_id,
        boundary_confidence,started_at,ended_at,duration_ms,ttft_ms,end_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const t of s.turns) insTurn.run(...nums([
        s.source, s.sessionId, t.turnIndex, t.sourceTurnId ?? null,
        t.boundaryConfidence, t.startedAt, t.endedAt, t.durationMs, t.ttftMs, t.endReason ?? null,
      ]));

      const insStep = this.db.prepare(`INSERT INTO steps (source,session_id,step_index,turn_index,
        source_step_id, boundary_confidence,started_at,ended_at,ttft_ms,decode_ms,model,usage_json,reasoning_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const st of s.steps) insStep.run(...nums([
        s.source, s.sessionId, st.stepIndex, st.turnIndex, st.sourceStepId ?? null, st.boundaryConfidence,
        st.startedAt, st.endedAt, st.ttftMs, st.decodeMs, st.model ?? null,
        st.usage ? JSON.stringify(st.usage) : null, st.reasoning ? JSON.stringify(st.reasoning) : null,
      ]));

      const insRec = this.db.prepare(`INSERT INTO records (source,session_id,record_id,order_index,kind,
        turn_index,step_index,source_seq,started_at,time_seconds,tool_name,call_id,is_error,
        tool_json,hook_json,usage_json,flags_json,summary,detail_text,detail_blob)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insFts = this.db.prepare('INSERT INTO records_fts (text,session_id,source,record_id) VALUES (?,?,?,?)');
      for (const r of s.records) {
        const detail = r.detailText ?? null;
        // Threshold is measured in BYTES (the README states 16 KiB); the blob may still
        // fail to land, in which case putBlob returns null and we keep the payload inline.
        const blob = detail !== null && Buffer.byteLength(detail, 'utf8') > BLOB_THRESHOLD
          ? this.putBlob(detail) : null;
        insRec.run(...nums([
          s.source, s.sessionId, r.recordId, r.orderIndex, r.kind, r.turnIndex, r.stepIndex,
          r.sourceSeq != null ? String(r.sourceSeq) : null, r.startedAt, r.timeSeconds,
          r.toolName ?? null, r.callId ?? null, r.isError ? 1 : 0,
          r.tool ? JSON.stringify(r.tool) : null,
          r.hook ? JSON.stringify(r.hook) : null,
          r.usage ? JSON.stringify(r.usage) : null, JSON.stringify(r.flags), r.text,
          blob ? null : detail, blob,
        ]));
        const searchable = [r.text, r.toolName, r.detailText].filter(Boolean).join('\n').slice(0, 4000);
        if (searchable.trim()) insFts.run(searchable, s.sessionId, s.source, r.recordId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listSessions(opts: { source?: SourceId; limit?: number } = {}): any[] {
    const lim = Math.min(opts.limit ?? 200, 2000);
    if (opts.source) {
      return this.db.prepare('SELECT * FROM sessions WHERE source=? ORDER BY started_at DESC LIMIT ?')
        .all(opts.source, lim);
    }
    return this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(lim);
  }

  countSessions(): Record<string, number> {
    const rows = this.db.prepare('SELECT source, COUNT(*) n FROM sessions GROUP BY source').all() as any[];
    const out: Record<string, number> = { codex: 0, 'claude-code': 0, dsh: 0 };
    for (const r of rows) out[r.source] = r.n;
    return out;
  }

  getSession(source: SourceId, sessionId: string): any | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE source=? AND session_id=?').get(source, sessionId);
  }

  getTurns(source: SourceId, sessionId: string): any[] {
    return this.db.prepare('SELECT * FROM turns WHERE source=? AND session_id=? ORDER BY turn_index')
      .all(source, sessionId);
  }

  getSteps(source: SourceId, sessionId: string): any[] {
    return this.db.prepare('SELECT * FROM steps WHERE source=? AND session_id=? ORDER BY step_index')
      .all(source, sessionId);
  }

  /**
   * One page of records in AUTHORITATIVE order, from either end.
   *
   * `dir: 'back'` (default, cursor = `before`) is tail-first: with no cursor it starts at
   * the newest record, so the ledger opens on the end of the trajectory.
   *
   * `dir: 'fwd'` (cursor = `after`) is head-first: with no cursor it starts at the OLDEST
   * record, so the ledger opens on the session's beginning — the first user message, the
   * system prompt, the context that actually frames everything after it.
   *
   * Both return the page already in ascending `order_index`, so callers never sort.
   */
  getPage(source: SourceId, sessionId: string, beforeOrder: number | undefined, limit: number,
          dir: 'back' | 'fwd' = 'back'): any[] {
    const lim = Math.min(Math.max(limit, 1), 1000);
    if (dir === 'fwd') {
      const sql = beforeOrder === undefined || beforeOrder < 0
        ? 'SELECT * FROM records WHERE source=? AND session_id=? ORDER BY order_index ASC LIMIT ?'
        : 'SELECT * FROM records WHERE source=? AND session_id=? AND order_index > ? ORDER BY order_index ASC LIMIT ?';
      return (beforeOrder === undefined || beforeOrder < 0
        ? this.db.prepare(sql).all(source, sessionId, lim)
        : this.db.prepare(sql).all(source, sessionId, beforeOrder, lim)) as any[];
    }
    const desc = beforeOrder === undefined || beforeOrder < 0;
    const sql = desc
      ? 'SELECT * FROM records WHERE source=? AND session_id=? ORDER BY order_index DESC LIMIT ?'
      : 'SELECT * FROM records WHERE source=? AND session_id=? AND order_index < ? ORDER BY order_index DESC LIMIT ?';
    const rows = (desc
      ? this.db.prepare(sql).all(source, sessionId, lim)
      : this.db.prepare(sql).all(source, sessionId, beforeOrder, lim)) as any[];
    return rows.reverse();
  }

  getRecord(source: SourceId, sessionId: string, recordId: string): any | undefined {
    return this.db.prepare('SELECT * FROM records WHERE source=? AND session_id=? AND record_id=?')
      .get(source, sessionId, recordId);
  }

  /**
   * The record in `sessionId` whose tool call carries `callId`.
   *
   * This is how a subagent finds the row of its PARENT that spawned it, so the trip back
   * can land on that row instead of the top of the parent's ledger. `call_id` is not unique
   * across a session in principle (the same id appearing in input and output halves), so
   * the first row in ledger order wins — the one that issued the call.
   */
  findRecordByCallId(source: SourceId, sessionId: string, callId: string): any | undefined {
    return this.db.prepare(
      'SELECT * FROM records WHERE source=? AND session_id=? AND call_id=? ORDER BY order_index LIMIT 1',
    ).get(source, sessionId, callId);
  }

  /**
   * The subagent sessions spawned by one tool call.
   *
   * One spawn can produce several children (three parallel `Agent` calls are three calls, but
   * a retry or a fan-out can share one), so this returns a list rather than a single row.
   * Claude records the link on the child (`spawn_call_id`); Codex does not, and its id is in
   * the payload instead — the inspector merges both.
   */
  childSessionsByCallId(source: SourceId, callId: string): Array<{ sessionId: string; agentNickname: string | null }> {
    return (this.db.prepare(
      'SELECT session_id, agent_nickname FROM sessions WHERE source=? AND spawn_call_id=? ORDER BY started_at',
    ).all(source, callId) as any[])
      .map((r) => ({ sessionId: r.session_id, agentNickname: r.agent_nickname ?? null }));
  }

  /**
   * The subagents ONE session spawned, in spawn order.
   *
   * The header's "N 个子智能体" menu is built from this rather than from the browser's copy
   * of the session list, for the same reason the inspector's jump links are resolved
   * server-side: `/api/sessions` is capped and time-ordered, so a child can be missing from
   * it while being perfectly present here — "5 个子智能体" that lists 4, or a subagent that
   * exists but cannot be opened, is worse than no menu at all.
   *
   * Ordered by `started_at` because that is the order the parent delegated in, which is the
   * order a reader expects to scan. `session_id` breaks ties so two children with the same
   * millisecond do not swap places between requests.
   */
  childSessions(source: SourceId, parentSessionId: string): any[] {
    return this.db.prepare(
      'SELECT * FROM sessions WHERE source=? AND parent_session_id=? ORDER BY started_at, session_id',
    ).all(source, parentSessionId);
  }

  /**
   * Total tokens per session, over the records that carry usage.
   *
   * `usage_json` is the one place all three sources report usage, with the same
   * `totalTokens` key — but they report it at DIFFERENT granularities, and adding every row
   * up is wrong by exactly a factor of two on the source that reports both:
   *
   *  - **dsh** writes a per-model-call total on every `message` record AND repeats that
   *    turn's running total on the `turn-end` boundary. Measured on the biggest review
   *    subagent in this store: its 225 messages sum to 18,538,539 and the single `turn-end`
   *    adds the same 18,538,539 on top — 37,077,078, exactly double the real cost.
   *  - **codex** and **claude-code** write usage ONLY on the `turn-end` boundary records, so
   *    excluding boundaries to fix dsh would zero both of them out entirely.
   *
   * Both halves are therefore summed separately and the per-call one wins whenever the
   * session reports any; that is what the CASE expressions below are for.
   *
   * The `json_valid` guard is not paranoia about our own writes: a source can carry a usage
   * object we normalised into something unparsable, and one bad row would make
   * `json_extract` throw and take the WHOLE menu down. Measured cost on this machine's store
   * (7 codex children, ~40k records): under 5 ms.
   *
   * A session with no usage rows is ABSENT from the map, not mapped to 0 — "reported nothing"
   * and "reported zero" are different facts, and the menu renders the first as a dash.
   */
  sessionUsageTotals(source: SourceId, sessionIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (sessionIds.length === 0) return out;
    const sql = `
      SELECT session_id,
             SUM(CASE WHEN kind IN ('turn-end', 'session-end') THEN 0
                      ELSE COALESCE(json_extract(usage_json, '$.totalTokens'), 0) END) AS per_call,
             SUM(CASE WHEN kind IN ('turn-end', 'session-end')
                      THEN COALESCE(json_extract(usage_json, '$.totalTokens'), 0) ELSE 0 END) AS per_turn
        FROM records
       WHERE source = ? AND usage_json IS NOT NULL AND json_valid(usage_json)
         AND session_id IN (${sessionIds.map(() => '?').join(',')})
       GROUP BY session_id`;
    for (const r of this.db.prepare(sql).all(source, ...sessionIds) as any[]) {
      // Prefer the per-call sum; fall through to the per-turn one rather than to a zero,
      // which is what a source that reports usage ONLY on its boundaries would otherwise get.
      const sum = Number(r.per_call) > 0 ? Number(r.per_call) : Number(r.per_turn);
      if (sum > 0) out.set(r.session_id, sum);
    }
    return out;
  }

  /**
   * How many subagents each of these sessions spawned in turn (codex nests to depth 4).
   *
   * One grouped query rather than a lookup per row: the menu renders up to 33 children on
   * this machine, and that is 33 round trips if done naively.
   */
  childCounts(source: SourceId, parentIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (parentIds.length === 0) return out;
    const sql = `SELECT parent_session_id, COUNT(*) AS n FROM sessions
                  WHERE source = ? AND parent_session_id IN (${parentIds.map(() => '?').join(',')})
                  GROUP BY parent_session_id`;
    for (const r of this.db.prepare(sql).all(source, ...parentIds) as any[]) {
      out.set(r.parent_session_id, Number(r.n));
    }
    return out;
  }

  /**
   * Attach every DSH subagent to the `subagent` call in its parent that spawned it.
   *
   * DSH is the awkward one of the three, and the asymmetry is the whole reason this exists:
   *
   *  - codex puts the child's thread id in the spawn call's RESULT, so `spawn_agent`'s
   *    payload already names the child session;
   *  - Claude puts it in the spawn's own sidecar (`subagents/agent-<id>.meta.json` →
   *    `toolUseId`), which the ingest reads directly;
   *  - DSH writes NEITHER. The child's header names its parent (`parentSession`), and the
   *    parent's `subagent/catalog` event names the child (`childId`, `label`), but **no
   *    event carries the `callId`** that links the two.
   *
   * So the link is reconstructed from the two keys DSH does write, both of which are exact:
   *   1. `label` === the spawn call's `arguments.description` (measured: 5/5 identical);
   *   2. `childCreatedAt` === the child's header `createdAt`, within a few tens of ms of
   *      the `tool/call` timestamp (measured: 24–38 ms).
   *
   * Both must agree. `label` alone is not enough — a parent may spawn two children with the
   * same description — and time alone is not either; the window is deliberately tight (5s)
   * and, on a tie, the NEAREST call wins.
   *
   * Runs after ingest rather than during it: the child is written before the parent is read,
   * so at write time its `spawn_call_id` cannot yet be known.
   */
  attachDshSpawnCalls(windowMs = 5000): number {
    const children = this.db.prepare(
      "SELECT session_id, parent_session_id, started_at FROM sessions WHERE source='dsh' AND parent_session_id IS NOT NULL AND spawn_call_id IS NULL",
    ).all() as any[];
    if (children.length === 0) return 0;

    // One pass per parent: 5 children share one parent here, so re-reading the parent per
    // child would re-read a 300-line log five times.
    const byParent = new Map<string, any[]>();
    for (const c of children) {
      const list = byParent.get(c.parent_session_id) ?? [];
      list.push(c);
      byParent.set(c.parent_session_id, list);
    }

    const upd = this.db.prepare('UPDATE sessions SET spawn_call_id=?, agent_nickname=? WHERE source=? AND session_id=?');
    let linked = 0;
    for (const [parentId, kids] of byParent) {
      const { calls, catalogs } = this.dshSpawnIndex(parentId);
      if (calls.length === 0) continue;

      for (const kid of kids) {
        const label = catalogs.get(kid.session_id);
        if (!label) continue;          // no catalog row → no honest pairing; better none than guessed
        const call = this.pickSpawnCall(calls, label, kid.started_at, windowMs);
        if (!call) continue;
        upd.run(call.call_id, label, 'dsh', kid.session_id);
        linked++;
      }
    }
    return linked;
  }

  /** The parent's subagent calls and its `childId → label` catalog, in one pass. */
  private dshSpawnIndex(parentId: string): { calls: any[]; catalogs: Map<string, string> } {
    const rows = this.db.prepare(
      "SELECT record_id, kind, call_id, started_at, summary, tool_json, detail_text, detail_blob FROM records WHERE source='dsh' AND session_id=? AND kind='subagent' ORDER BY order_index",
    ).all(parentId) as any[];
    const calls: any[] = [];
    const catalogs = new Map<string, string>();
    for (const r of rows) {
      if (r.call_id) {
        calls.push({
          call_id: r.call_id,
          description: this.dshCallDescription(r),
          started_at: Number(r.started_at),
        });
        continue;
      }
      // A catalog row has no call id; its detail is the raw event, which carries childId.
      const label = this.dshCatalogFields(this.recordDetailText(r));
      if (label) catalogs.set(label.childId, label.label);
    }
    return { calls, catalogs };
  }

  /**
   * `arguments.description` of a DSH `subagent` call — the child's human label.
   *
   * Read from `tool_json.inputRaw`, NOT from `summary`: the summary is the normalizer's
   * one-line truncation at 80 characters, and a review task's prompt blows past that — the
   * JSON is cut mid-string and will not parse (measured: every one of the 5 calls here).
   */
  private dshCallDescription(row: any): string | undefined {
    const tool = safeJson(row.tool_json);
    if (typeof tool?.inputRaw === 'string') {
      try {
        const a = JSON.parse(tool.inputRaw);
        if (typeof a?.description === 'string') return a.description;
      } catch { /* fall through to the summary shape */ }
    }
    // A replayed capture may predate `tool_json`; the summary is all that is left, and it is
    // only usable when the payload was short enough to survive truncation intact.
    const s = String(row.summary ?? '');
    const open = s.indexOf('('), close = s.lastIndexOf(')');
    if (open <= 0 || close <= open) return undefined;
    try {
      const a = JSON.parse(s.slice(open + 1, close));
      return typeof a?.description === 'string' ? a.description : undefined;
    } catch { return undefined; }
  }

  /** A record's full detail text, whether it is inline or in a blob. */
  private recordDetailText(row: any): string | undefined {
    if (row?.detail_text) return row.detail_text;
    if (row?.detail_blob) return this.readBlob(row.detail_blob);
    return undefined;
  }

  private dshCatalogFields(detail: unknown): { childId: string; label: string } | undefined {
    if (typeof detail !== 'string') return undefined;
    try {
      const d = JSON.parse(detail);
      const childId = d?.childId ?? d?.child ?? d?.id;
      if (typeof childId !== 'string') return undefined;
      return { childId, label: typeof d.label === 'string' ? d.label : childId };
    } catch { return undefined; }
  }

  /**
   * The call that produced this child: SAME description, nearest in time.
   *
   * The description is what makes it safe; the timestamp only breaks ties, because the same
   * review task can be re-spawned. Both keys are exact on this machine (5/5 labels
   * identical, 24–38 ms apart), and neither alone would be: a label repeats, and a
   * timestamp without a label would pair a child with an unrelated sibling spawn.
   */
  private pickSpawnCall(calls: any[], label: string, childCreatedAt: number, windowMs: number): any | undefined {
    let best: any | undefined;
    let bestDelta = Infinity;
    for (const c of calls) {
      if (c.description !== label) continue;
      if (!Number.isFinite(c.started_at) || !Number.isFinite(childCreatedAt)) continue;
      const delta = Math.abs(c.started_at - childCreatedAt);
      if (delta <= windowMs && delta < bestDelta) { best = c; bestDelta = delta; }
    }
    return best;
  }

  /**
   * The record in `sessionId` whose payload names `sessionIdOfChild` as a subagent.
   *
   * Codex has no `spawn_call_id`: the child's thread id appears in the spawn call's RESULT
   * (`{"agent_id":"01a09624-…"}`), and only there. Scanning the parent's spawn-ish calls is
   * bounded by how many such calls one conversation makes (208 `spawn_agent` records across
   * all of this machine's codex sessions), so this stays a cheap per-session lookup and it
   * is asked once per "返回父会话" click, not per row.
   */
  findSpawnRecordByChildId(source: SourceId, parentSessionId: string, childSessionId: string): string | undefined {
    const rows = this.db.prepare(
      `SELECT record_id, tool_json FROM records
       WHERE source=? AND session_id=? AND tool_name IN ('spawn_agent','wait_agent','Agent','create_thread')
         AND tool_json IS NOT NULL`,
    ).all(source, parentSessionId) as any[];
    for (const r of rows) {
      const tool = safeJson(r.tool_json);
      if (!tool) continue;
      for (const text of [tool.inputRaw, tool.outputText]) {
        if (typeof text !== 'string' || text.length === 0) continue;
        if (!text.includes(childSessionId)) continue;   // cheap reject before parsing
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { continue; }
        if (mentionsId(parsed, childSessionId)) return r.record_id as string;
      }
    }
    return undefined;
  }

  /**
   * A one-line title per session, taken from its FIRST real user message.
   *
   * `kind='user'` is the normalizer's verdict on human input, which is exactly the distinction
   * that matters here: a session's first record is usually a system prompt or an injected
   * `<environment_context>` block (kind `system`/`context`), and titling a card from one of
   * those would label every session identically.
   *
   * `MIN(order_index)` is correlated per session, so this stays a single scan driven by the
   * existing `records_by_order` index rather than a query per row.
   */
  sessionTitles(source: SourceId, sessionIds: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (sessionIds.length === 0) return out;
    const sql = `
      SELECT session_id, detail_text FROM records r
      WHERE source = ? AND kind = 'user' AND detail_text IS NOT NULL AND detail_text <> ''
        AND order_index = (
          SELECT MIN(r2.order_index) FROM records r2
          WHERE r2.source = r.source AND r2.session_id = r.session_id AND r2.kind = 'user'
            AND r2.detail_text IS NOT NULL AND r2.detail_text <> ''
        )
        AND session_id IN (${sessionIds.map(() => '?').join(',')})`;
    for (const row of this.db.prepare(sql).all(source, ...sessionIds) as any[]) {
      if (!out.has(row.session_id)) out.set(row.session_id, row.detail_text);
    }
    return out;
  }

  /**
   * Every real user message of one session, oldest first — the session's question list.
   * Backs the card tooltip, so it is capped: a session that pastes a file can have hundreds
   * of these and a tooltip does not benefit from all of them.
   *
   * `record_id` is carried so a click can jump straight to that message in the ledger
   * instead of only reading it.
   */
  userMessages(source: SourceId, sessionId: string, limit = 200): Array<{ recordId: string; orderIndex: number; text: string }> {
    const rows = this.db.prepare(
      `SELECT record_id, order_index, detail_text FROM records
       WHERE source=? AND session_id=? AND kind='user'
         AND detail_text IS NOT NULL AND detail_text <> ''
       ORDER BY order_index ASC LIMIT ?`)
      .all(source, sessionId, Math.min(Math.max(limit, 1), 1000)) as any[];
    return rows.map((r) => ({ recordId: r.record_id, orderIndex: r.order_index, text: r.detail_text }));
  }

  /**
   * Tool calls that BELONG to one record: everything after it and before the next
   * assistant record in the same step.
   *
   * This bound matters for Codex, which alternates AgentMessage and Reasoning blocks:
   *   AgentMessage → tool ×N → Reasoning → tool ×N → Reasoning → …
   * Returning the whole step would credit an AgentMessage with the tools that the
   * FOLLOWING Reasoning block issued.
   */
  getStepRecords(source: SourceId, sessionId: string, turnIndex: number, stepIndex: number): any[] {
    return this.db.prepare(
      'SELECT * FROM records WHERE source=? AND session_id=? AND turn_index=? AND step_index=? ORDER BY order_index',
    ).all(source, sessionId, turnIndex, stepIndex) as any[];
  }

  /**
   * The tool window owned by `row`: [row.order_index, next assistant's order_index).
   *
   * The lower bound is INCLUSIVE. A Claude Code assistant line emits the message and
   * every one of its tool_use blocks from a single JSONL row, and the normalizer slots
   * the tools at fractional order_index values immediately above the message's own
   * (`order + 0.001`, `+ 0.002`, …). A strict `>` dropped every one of them, so a
   * tool-call-only assistant message reported "该 step 没有工具调用" in the inspector.
   *
   * The record itself is excluded by `record_id`: when the queried row IS a tool, the
   * inclusive bound would otherwise return it as its own sibling.
   */
  getOwnedToolCalls(source: SourceId, sessionId: string, row: any): any[] {
    const rows = this.getStepRecords(source, sessionId, row.turn_index, row.step_index);
    const next = rows.find((r) => (r.kind === 'message' || r.kind === 'reasoning') && r.order_index > row.order_index);
    const bound = next ? next.order_index : Number.MAX_SAFE_INTEGER;
    return rows.filter((r) =>
      // `subagent` is a CALL like the others (it keeps its arguments, result and duration),
      // so an assistant row must still own it — listing only `tool` would silently drop the
      // delegation out of the inspector's 工具调用 panel the moment it was reclassified.
      (r.kind === 'tool' || r.kind === 'subtool' || r.kind === 'subagent')
      && r.record_id !== row.record_id
      && r.order_index >= row.order_index && r.order_index < bound);
  }

  recordDetail(row: any): string | undefined {
    if (row?.detail_text) return row.detail_text;
    if (row?.detail_blob) return this.readBlob(row.detail_blob);
    return undefined;
  }

  /**
   * Full-text search. `records_fts` stores its own text, so snippet() is available;
   * the private-use sentinels FTS5 uses for highlighting are stripped before display.
   */
  search(query: string, limit = 50): any[] {
    const q = query.replace(/["*]/g, ' ').trim();
    if (!q) return [];
    try {
      return this.db.prepare(`
        SELECT r.source, r.session_id, r.record_id, r.order_index, r.kind,
               r.summary, r.started_at, r.tool_name,
               snippet(records_fts, 0, char(65520), char(65521), '...', 24) AS snip,
               bm25(records_fts) AS score
        FROM records_fts f
        JOIN records r ON r.source=f.source AND r.session_id=f.session_id AND r.record_id=f.record_id
        WHERE records_fts MATCH ?
        ORDER BY score LIMIT ?
      `).all(q, Math.min(limit, 200)).map((row: any) => ({
        ...row,
        // FTS5 wraps matches in private-use sentinels. We pass U+FFF0/U+FFF1
        // explicitly below (SQLite's defaults) and strip BOTH that range and the
        // U+FDD0/U+FDD1 range that DSH uses (session-query-sqlite/src/query.ts), so
        // neither can ever leak into a response regardless of the markers in play.
        snip: typeof row.snip === 'string' ? row.snip.replace(/[\uFDD0\uFDD1\uFFF0\uFFF1]/g, '') : row.snip,
        score: row.score,
      }));
    } catch (err) {
      // A malformed FTS5 expression must never take down the request.
      if (process.env.TRAJVIEW_DEBUG) console.error('search failed:', err);
      return [];
    }
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }
}

function safeJson(s: unknown): any {
  if (typeof s !== 'string') return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

/** Whether `needle` appears as a complete string value anywhere in a parsed payload. */
function mentionsId(v: unknown, needle: string, depth = 0): boolean {
  if (depth > 8 || v == null) return false;
  if (Array.isArray(v)) return v.some((x) => mentionsId(x, needle, depth + 1));
  if (typeof v !== 'object') return false;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    // `id`/`agent_id`/`thread_id`-style KEYS only: a payload can contain the child's id
    // inside a summary or a diff by coincidence, and a link built on that would be fiction.
    if (typeof val === 'string' && val === needle && /(^|_)(id|ids)$/i.test(k)) return true;
    if (val && typeof val === 'object' && mentionsId(val, needle, depth + 1)) return true;
  }
  return false;
}

/**
 * node:sqlite refuses `undefined` and cannot bind NaN. Sources legitimately produce
 * both (a missing timestamp, a 0/0 division). Normalize to NULL so the honest
 * "unknown" survives all the way into SQLite.
 */
type Bindable = string | number | bigint | null;
function nums(vals: any[]): Bindable[] {
  return vals.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string' || typeof v === 'bigint') return v;
    return String(v);
  });
}
