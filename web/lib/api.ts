export type SourceId = 'codex' | 'claude-code' | 'dsh';

export interface Capabilities {
  reasoning: 'plaintext' | 'encrypted' | 'absent';
  usageGranularity: string;
  cacheSemantics: string;
  cost: string; ttft: string; tokenTimeline: string;
  toolDuration: string; subagentTree: string;
  ordering: string; unknownEventPolicy: string;
}

export interface SessionRow {
  source: SourceId; sessionId: string; cwd?: string; gitBranch?: string; cliVersion?: string;
  /** Codex subagents: the spawning conversation, its spawn nickname, and the spawn depth. */
  /** First real user message — the card's one-line subject. */
  title?: string | null;
  parentSessionId?: string | null; agentNickname?: string | null; subagentDepth?: number | null;
  startedAt?: number; endedAt?: number;
  capabilities: Capabilities;
  diagnostics: Record<string, any>;
  recordCount: number; turnCount: number; stepCount: number;
}

export interface ToolCall {
  callId: string; name: string; inputRaw?: string; outputText?: string; isError?: boolean;
  startedAt?: number; endedAt?: number; durationMs?: number | null;
  parentCallId?: string; depth?: number; unresolved?: boolean;
}

export interface RecordRow {
  recordId: string; kind: string; orderIndex: number;
  turnIndex?: number; stepIndex?: number; sourceSeq?: string;
  startedAt?: number; timeSeconds: number | null;
  toolName?: string; callId?: string; isError: boolean;
  tool?: ToolCall;
  usage: any; flags: string[]; summary: string; detail?: string | null;
  hasDetailBlob?: boolean;
}

export interface TurnRow {
  turn_index: number; source_turn_id?: string; boundary_confidence: string;
  started_at?: number; ended_at?: number; duration_ms?: number | null;
  ttft_ms?: number | null; end_reason?: string;
}
export interface StepRow {
  step_index: number; turn_index: number; boundary_confidence: string;
  /** The step number as written by the source; restarts inside every turn for DSH. */
  source_step_id?: string;
  started_at?: number; ended_at?: number; ttft_ms?: number | null; decode_ms?: number | null;
  model?: string; usage_json?: string; reasoning_json?: string;
  /** Authoritative ledger position of the assistant row this step produced. */
  anchorOrder?: number;
}

/** One record projected onto a timeline lane (DSH ui-trajectory three-lane scheme). */
export interface TimelineSpan {
  recordId: string; kind: string; orderIndex: number; turnIndex?: number; stepIndex?: number;
  toolName?: string; startedAt?: number; timeSeconds: number | null;
  isError: boolean; summary: string;
  /**
   * Present only on the model-output record that OWNS a completed model call: the step's
   * window, TTFT and model. A source that logs timing per step (DSH) has no per-record
   * duration, so the server lends the owning record its step's span — and only that one,
   * so sibling records in the same step still render as start markers.
   */
  stepStartedAt?: number;
  stepEndedAt?: number;
  ttftMs?: number | null;
  model?: string | null;
}

/** A tool call issued inside the same step as the inspected record. */
export interface SiblingTool {
  recordId: string; kind: string; toolName?: string; callId?: string;
  isError: boolean; summary: string; timeSeconds: number | null; startedAt?: number;
}

const base = '';
async function get<T>(url: string): Promise<T> {
  const r = await fetch(base + url);
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json() as Promise<T>;
}
async function post<T>(url: string): Promise<T> {
  const r = await fetch(base + url, { method: 'POST' });
  // The server uses 409 to signal "another ingest is already running". That is NOT an
  // error from the caller's perspective — the caller will just start polling the same
  // job via ingestStatus(). Surface the body either way so the caller can decide.
  const body = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) {
    throw new Error(url + ' -> ' + r.status + ' ' + JSON.stringify(body));
  }
  return body as T;
}

export interface IngestJob {
  startedAt: number; finishedAt?: number; exitCode?: number | null;
  stdout: string; stderr: string; error?: string; pid?: number;
}

export const api = {
  health: () => get<{ ok: boolean; sessions: Record<string, number>; total: number }>('/api/health'),
  /** Returns the running job, the last finished job, or `{ idle: true }`. */
  ingestStatus: () => get<({ idle: true } | (IngestJob & { idle?: false }))>('/api/ingest'),
  /**
   * Kicks off an ingest. The server returns 200 with the new job on success, or 409 with
   * the already-running job if one is in flight — callers should treat either as "an
   * ingest is happening, start polling".
   */
  ingest: () => post<{ started?: true; busy?: true; job: IngestJob }>('/api/ingest'),
  sessions: (source?: SourceId) =>
    get<SessionRow[]>('/api/sessions?limit=400' + (source ? '&source=' + source : '')),
  session: (source: SourceId, id: string) =>
    get<{ session: SessionRow; turns: TurnRow[]; steps: StepRow[] }>(
      `/api/sessions/${source}/${encodeURIComponent(id)}`),
  records: (source: SourceId, id: string, before?: number, limit = 200) =>
    get<{ records: RecordRow[]; hasMore: boolean; nextBefore: number | null; nextAfter: number | null }>(
      `/api/sessions/${source}/${encodeURIComponent(id)}/records?limit=${limit}` +
      (before === undefined ? '' : '&before=' + before)),
  /** Head-first page: `after` undefined starts at the session's OLDEST record. */
  recordsAfter: (source: SourceId, id: string, after?: number, limit = 200) =>
    get<{ records: RecordRow[]; hasMore: boolean; nextBefore: number | null; nextAfter: number | null }>(
      `/api/sessions/${source}/${encodeURIComponent(id)}/records?dir=fwd&limit=${limit}` +
      (after === undefined ? '' : '&after=' + after)),
  /** Every real user message of a session — the card's hover preview. */
  messages: (source: SourceId, id: string, limit = 200) =>
    get<{ messages: Array<{ recordId: string; orderIndex: number; text: string }> }>(
      `/api/sessions/${source}/${encodeURIComponent(id)}/messages?limit=${limit}`),
  record: (source: SourceId, id: string, rid: string) =>
    get<RecordRow & { siblings: SiblingTool[] }>(
      `/api/sessions/${source}/${encodeURIComponent(id)}/records/${encodeURIComponent(rid)}`),
  timeline: (source: SourceId, id: string) =>
    get<{ turns: TurnRow[]; steps: StepRow[]; spans: TimelineSpan[] }>(
      `/api/sessions/${source}/${encodeURIComponent(id)}/timeline`),
  search: (q: string) => get<any[]>('/api/search?q=' + encodeURIComponent(q)),
};

export const fmtDur = (s: number | null | undefined): string => {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  if (s < 1) return Math.round(s * 1000) + 'ms';
  if (s < 60) return s.toFixed(2) + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + Math.round(s % 60) + 's';
};
export const fmtTime = (ms?: number): string => (ms ? new Date(ms).toLocaleString() : '—');

/**
 * Split a tool row's summary into name and arguments, the way DSH renders them:
 *
 *   ours   bash({"command":"du -sh …"})
 *   DSH    bash {"command":"du -sh …"}
 *
 * The parentheses are dropped and the object is always brace-wrapped, because that is
 * what the arguments actually are — passing them as `({…})` reads like a call expression.
 * Non-JSON payloads are wrapped too rather than left bare, so the colour break between
 * name and arguments stays in one place.
 */
export function splitToolLabel(summary: string, toolName?: string): { name: string; args: string } {
  const s = (summary ?? '').trim();
  const open = s.indexOf('(');
  if (open <= 0) return { name: toolName ?? s, args: '' };
  const name = s.slice(0, open);
  const inner = s.slice(open + 1, s.endsWith(')') ? s.length - 1 : undefined).trim();
  if (!inner) return { name, args: '' };
  return { name, args: inner.startsWith('{') && inner.endsWith('}') ? inner : `{${inner}}` };
}
