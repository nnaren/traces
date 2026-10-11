/**
 * HTTP API + static host. Plain node:http, no framework.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store.ts';
import type { SourceId } from '../types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const WEB_DIST = path.join(ROOT, 'web', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.map': 'application/json',
};

/**
 * Record kinds that carry a wall-clock position and can therefore enter a timeline lane.
 *   输入 lane — system / user / context / compacted (what the agent was fed)
 *   模型 lane — message / reasoning (the model's own output)
 *   工具 lane — tool / subtool (tool processing)
 *
 * The 模型 lane is RECORD-based, matching DSH (whose model lane is its assistant message
 * spans). Each 助手 / 推理 row gets its own block, so a click in the ledger rings exactly
 * one block. Timing the source only records at step level is carried onto the record by
 * `withStepTiming` below, so DSH keeps its duration bars and TTFT gradient.
 *
 * `turn-end` / `session-end` are boundaries, drawn as turn edges, not spans.
 * `request-header` is a protocol artifact with no user- or tool-visible span.
 */
const TIMELINE_KINDS = new Set([
  'system', 'user', 'context', 'compacted',
  'message', 'reasoning',
  'tool', 'subtool',
]);

export function startServer(opts: { dataDir: string; port: number; host?: string }) {
  return Store.open(opts.dataDir).then((store) => {
    const server = createServer((req, res) => { void handle(req, res, store); });
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      const a = server.address();
      console.log('trajview listening on http://' + (opts.host ?? '127.0.0.1') + ':' + (typeof a === 'object' && a ? a.port : opts.port));
    });
    return server;
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (p === '/api/health') {
      const counts = store.countSessions();
      return json(res, { ok: true, sessions: counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
    }
    if (p === '/api/sessions') {
      const source = url.searchParams.get('source') as SourceId | null;
      const limit = Number(url.searchParams.get('limit') ?? 300);
      return json(res, store.listSessions({ source: source ?? undefined, limit }).map(shapeSession));
    }
    if (p === '/api/search') {
      const q = url.searchParams.get('q') ?? '';
      return json(res, store.search(q, Number(url.searchParams.get('limit') ?? 60)));
    }
    const m = p.match(/^\/api\/sessions\/([\w-]+)\/([^/]+)(\/.*)?$/);
    if (m) {
      const source = m[1] as SourceId;
      const id = decodeURIComponent(m[2]);
      const sub = m[3] ?? '';
      if (sub === '' || sub === '/') {
        const row = store.getSession(source, id);
        if (!row) return json(res, { error: 'not found' }, 404);
        return json(res, { session: shapeSession(row), turns: store.getTurns(source, id), steps: store.getSteps(source, id) });
      }
      if (sub === '/records') {
        const before = url.searchParams.get('before');
        const limit = Number(url.searchParams.get('limit') ?? 200);
        const rows = store.getPage(source, id, before === null ? undefined : Number(before), limit);
        const oldest = rows.length ? Number(rows[0].order_index) : 0;
        return json(res, { records: rows.map(shapeRecord), hasMore: rows.length === limit && oldest > 0, nextBefore: oldest });
      }
      if (sub === '/timeline') {
        const limit = Number(url.searchParams.get('limit') ?? 4000);
        const rows = store.getPage(source, id, undefined, limit);
        // Three-lane overview (DSH ui-trajectory scheme): every record that carries a
        // timestamp can enter a lane. The client assigns lanes by kind, so the server
        // hands over the whole plottable set rather than pre-filtering one kind.
        const steps = withStepAnchors(store.getSteps(source, id), rows);
        // A record carries a position; only a step carries a DURATION. Hand the model
        // output records their step's timing so the 模型 lane keeps real bars (and TTFT)
        // on sources that log step boundaries, without the lane having to be step-based.
        const stepByKey = new Map<string, any>();
        for (const s of steps) stepByKey.set(`${s.turn_index}:${s.step_index}`, s);

        const spans = rows
          .filter((r: any) => r.started_at != null && TIMELINE_KINDS.has(r.kind))
          .map((r: any) => {
            const step = r.kind === 'message' || r.kind === 'reasoning'
              ? stepByKey.get(`${r.turn_index}:${r.step_index}`) : undefined;
            // The step's span belongs to the record that ANCHORS it; other records in the
            // same step keep their own start marker rather than all sharing one duration.
            const owns = step?.anchorOrder != null && step.anchorOrder === r.order_index;
            const hasStepSpan = owns && step.started_at != null && step.ended_at != null
              && step.ended_at > step.started_at;
            return {
              recordId: r.record_id, kind: r.kind, orderIndex: r.order_index,
              turnIndex: r.turn_index, stepIndex: r.step_index,
              toolName: r.tool_name, startedAt: r.started_at, timeSeconds: r.time_seconds,
              isError: r.is_error === 1, summary: r.summary ?? '',
              // Present only when this record owns a completed model call.
              ...(hasStepSpan ? {
                stepStartedAt: step.started_at,
                stepEndedAt: step.ended_at,
                ttftMs: step.ttft_ms ?? null,
                model: step.model ?? null,
              } : {}),
            };
          });
        return json(res, { turns: store.getTurns(source, id), steps, spans });
      }
      const rm = sub.match(/^\/records\/(.+)$/);
      if (rm) {
        const row = store.getRecord(source, id, decodeURIComponent(rm[1]));
        if (!row) return json(res, { error: 'not found' }, 404);
        return json(res, {
          ...shapeRecord(row),
          detail: store.recordDetail(row) ?? null,
          // The tool calls THIS record owns — bounded by the next assistant record, not
          // by the step. Codex alternates AgentMessage / Reasoning blocks and each owns
          // only the tools that follow it.
          siblings: row.turn_index != null && row.step_index != null
            ? store.getOwnedToolCalls(source, id, row)
              .map((s: any) => ({
                recordId: s.record_id, kind: s.kind, toolName: s.tool_name,
                callId: s.call_id, isError: s.is_error === 1, summary: s.summary,
                timeSeconds: s.time_seconds, startedAt: s.started_at,
              }))
            : [],
        });
      }
    }
    return serveStatic(p, res);
  } catch (err) {
    return json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/**
 * Attach each step's authoritative position to the step row.
 *
 * A step is not a ledger row, but the 模型 lane must line up with the 助手 row that
 * produced it. That row is a `message`, which is deliberately absent from `spans` (the
 * step itself draws that lane), so the anchor cannot be derived client-side from the
 * span list. We resolve it here from the full record set and fall back to the step's
 * earliest record so a step with no assistant output still lands in a sensible place.
 */
function withStepAnchors(steps: any[], rows: any[]): any[] {
  const anchor = new Map<string, number>();
  for (const r of rows) {
    if (r.turn_index == null || r.step_index == null) continue;
    const k = `${r.turn_index}:${r.step_index}`;
    const cur = anchor.get(k);
    if (cur === undefined || r.order_index < cur) anchor.set(k, r.order_index);
  }
  // Prefer the assistant record itself; only fall back to the earliest record otherwise.
  const msgAnchor = new Map<string, number>();
  for (const r of rows) {
    if ((r.kind !== 'message' && r.kind !== 'reasoning') || r.turn_index == null || r.step_index == null) continue;
    const k = `${r.turn_index}:${r.step_index}`;
    const cur = msgAnchor.get(k);
    if (cur === undefined || r.order_index < cur) msgAnchor.set(k, r.order_index);
  }
  return steps.map((s) => ({
    ...s,
    anchorOrder: msgAnchor.get(`${s.turn_index}:${s.step_index}`)
      ?? anchor.get(`${s.turn_index}:${s.step_index}`),
  }));
}

function shapeSession(r: any) {
  return {
    source: r.source, sessionId: r.session_id, cwd: r.cwd, gitBranch: r.git_branch,
    cliVersion: r.cli_version, startedAt: r.started_at, endedAt: r.ended_at,
    capabilities: safeParse(r.capabilities_json, {}), diagnostics: safeParse(r.diagnostics_json, {}),
    recordCount: r.record_count, turnCount: r.turn_count, stepCount: r.step_count,
  };
}
function shapeRecord(r: any) {
  return {
    recordId: r.record_id, kind: r.kind, orderIndex: r.order_index,
    turnIndex: r.turn_index, stepIndex: r.step_index, sourceSeq: r.source_seq,
    startedAt: r.started_at, timeSeconds: r.time_seconds,
    toolName: r.tool_name, callId: r.call_id, isError: r.is_error === 1,
    // NormToolCall, kept whole so the inspector can show 参数 and 结果 separately
    // instead of the concatenated detail_text, and can expose sub-tool nesting.
    tool: safeParse(r.tool_json, undefined),
    usage: safeParse(r.usage_json, null), flags: safeParse(r.flags_json, []),
    summary: r.summary, hasDetailBlob: !!r.detail_blob,
  };
}
function safeParse(s: unknown, fallback: any) {
  if (typeof s !== 'string') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
async function serveStatic(p: string, res: ServerResponse) {
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.join(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    try {
      const html = await fs.readFile(path.join(WEB_DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('web/dist not built. Run: npm run build:web');
    }
  }
}
