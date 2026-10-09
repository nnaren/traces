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
  startedAt?: number; endedAt?: number;
  capabilities: Capabilities;
  diagnostics: Record<string, any>;
  recordCount: number; turnCount: number; stepCount: number;
}

export interface RecordRow {
  recordId: string; kind: string; orderIndex: number;
  turnIndex?: number; stepIndex?: number; sourceSeq?: string;
  startedAt?: number; timeSeconds: number | null;
  toolName?: string; callId?: string; isError: boolean;
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
  started_at?: number; ended_at?: number; ttft_ms?: number | null; decode_ms?: number | null;
  model?: string; usage_json?: string; reasoning_json?: string;
}

const base = '';
async function get<T>(url: string): Promise<T> {
  const r = await fetch(base + url);
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json() as Promise<T>;
}

export const api = {
  health: () => get<{ ok: boolean; sessions: Record<string, number>; total: number }>('/api/health'),
  sessions: (source?: SourceId) =>
    get<SessionRow[]>('/api/sessions?limit=400' + (source ? '&source=' + source : '')),
  session: (source: SourceId, id: string) =>
    get<{ session: SessionRow; turns: TurnRow[]; steps: StepRow[] }>(
      `/api/sessions/${source}/${encodeURIComponent(id)}`),
  records: (source: SourceId, id: string, before?: number, limit = 200) =>
    get<{ records: RecordRow[]; hasMore: boolean; nextBefore: number }>(
      `/api/sessions/${source}/${encodeURIComponent(id)}/records?limit=${limit}` +
      (before === undefined ? '' : '&before=' + before)),
  record: (source: SourceId, id: string, rid: string) =>
    get<RecordRow>(`/api/sessions/${source}/${encodeURIComponent(id)}/records/${encodeURIComponent(rid)}`),
  timeline: (source: SourceId, id: string) =>
    get<{ turns: TurnRow[]; steps: StepRow[]; spans: any[] }>(
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
