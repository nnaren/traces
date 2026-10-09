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
const SCHEMA_VERSION = 2;
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
          started_at, ended_at, first_seen_at, last_ingested_at, capabilities_json, diagnostics_json,
          record_count, turn_count, step_count)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source, session_id) DO UPDATE SET
          vault_path=excluded.vault_path, source_path=excluded.source_path, cwd=excluded.cwd,
          git_branch=excluded.git_branch, cli_version=excluded.cli_version, started_at=excluded.started_at,
          ended_at=excluded.ended_at, last_ingested_at=excluded.last_ingested_at,
          capabilities_json=excluded.capabilities_json, diagnostics_json=excluded.diagnostics_json,
          record_count=excluded.record_count, turn_count=excluded.turn_count, step_count=excluded.step_count
      `).run(s.source, s.sessionId, vaultPath, sourcePath, s.cwd ?? null, s.gitBranch ?? null, s.cliVersion ?? null,
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
        boundary_confidence,started_at,ended_at,ttft_ms,decode_ms,model,usage_json,reasoning_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const st of s.steps) insStep.run(...nums([
        s.source, s.sessionId, st.stepIndex, st.turnIndex, st.boundaryConfidence,
        st.startedAt, st.endedAt, st.ttftMs, st.decodeMs, st.model ?? null,
        st.usage ? JSON.stringify(st.usage) : null, st.reasoning ? JSON.stringify(st.reasoning) : null,
      ]));

      const insRec = this.db.prepare(`INSERT INTO records (source,session_id,record_id,order_index,kind,
        turn_index,step_index,source_seq,started_at,time_seconds,tool_name,call_id,is_error,
        usage_json,flags_json,summary,detail_text,detail_blob)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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

  /** Tail-first page of records, message-aligned like DSH's paginate(). */
  getPage(source: SourceId, sessionId: string, beforeOrder: number | undefined, limit: number): any[] {
    const lim = Math.min(Math.max(limit, 1), 1000);
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
