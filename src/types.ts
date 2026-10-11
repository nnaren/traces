/**
 * Normalized trajectory model — the contract between source adapters and the store/UI.
 *
 * Derived from `.omx/plans/prd-trajectory-observer-tool.md` §6 with the R1–R7 revisions
 * from `.omx/plans/feasibility-codex-deepseek-trajectory-observability.md`:
 *   R1  ordering is a per-session EFFECTIVE value; SourceCapabilities is only an upper bound
 *   R3  model identity lives on NormStep; NormRecord inherits it (no new record field)
 *   R4  reasoning availability is per-step, not per-session
 *   R7  usage granularity gains 'per-response' (token_usage_record)
 *
 * Honesty rules (P2/P4): unknown is `null`, never 0 and never "now".
 * `timeSeconds` is `number | null`; we never invent elapsed time for in-flight records.
 */

export type SourceId = 'codex' | 'claude-code' | 'dsh';

export type Ordering = 'ordinal' | 'physical-line-order' | 'seq';

/** Source-declared UPPER BOUND. The effective value is `NormSession.capabilities`. */
export interface SourceCapabilities {
  reasoning: 'plaintext' | 'encrypted' | 'absent';
  usageGranularity: 'per-record' | 'per-turn' | 'per-response' | 'cumulative' | 'ambiguous' | 'none';
  cacheSemantics: 'separate' | 'subset-of-input' | 'ambiguous' | 'none';
  cost: 'native' | 'estimated' | 'none';
  ttft: 'native' | 'derivable' | 'none';
  tokenTimeline: 'yes' | 'no';
  toolDuration: 'native' | 'derivable' | 'none';
  subagentTree: 'structural' | 'inferred' | 'declared-only' | 'none';
  ordering: Ordering;
  unknownEventPolicy: 'refuse' | 'skip';
}

export interface RawLine {
  lineNo: number;
  text: string;
  byteStart: number;
  byteEnd: number;
  parseError?: string;
}

export interface SessionRef {
  source: SourceId;
  sessionId: string;
  /** Absolute path of the source file. Never written to. */
  path: string;
  cwd?: string;
  gitBranch?: string;
  cliVersion?: string;
  startedAt?: number;
  byteSize?: number;
  /** [dev,ino,size,mtimeMs,ctimeMs] of the source at discovery time. */
  revision?: string;
}

export interface TrajectorySourceAdapter {
  readonly id: SourceId;
  readonly capabilities: SourceCapabilities;
  /** Enumerate candidate sessions without reading their content. */
  discover(): AsyncIterable<SessionRef>;
  /** Read the whole file as raw lines. Stable read; tolerates concurrent appends. */
  readAll(ref: SessionRef, signal?: AbortSignal): Promise<RawLine[]>;
  /** Source-specific default filtering (e.g. Claude's bulky snapshot records). */
  isRelevant(raw: RawLine): boolean;
}

export type NormRecordKind =
  | 'system' | 'user' | 'context' | 'compacted' | 'message' | 'reasoning'
  | 'tool' | 'subtool' | 'request-header' | 'turn-end' | 'session-end';

export type RecordFlag =
  | 'unresolved-call' | 'unresolved-output' | 'partial' | 'running' | 'shadowed'
  | 'reasoning-encrypted' | 'usage-missing' | 'ttft-missing';

export interface NormUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  costKind?: 'native' | 'estimated';
  scope: 'record' | 'step' | 'turn' | 'session' | 'per-response';
  cacheSemantics: SourceCapabilities['cacheSemantics'];
  crossSourceComparable: boolean;
}

export interface NormToolCall {
  callId: string;
  name: string;
  inputRaw?: string;
  outputText?: string;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number | null;
  parentCallId?: string;
  depth?: number;
  unresolved?: boolean;
}

export interface NormStep {
  stepIndex: number;
  turnIndex: number;
  /**
   * The step number AS WRITTEN BY THE SOURCE. DSH logs `step/start {turn, step}` with
   * the step counter RESTARTING inside every turn (turn 1 → step 1..7, turn 2 → 1..3),
   * whereas `stepIndex` is a flat per-session counter used for ordering. Sources that
   * declare no numbering (Claude Code, Codex) leave this undefined and the UI shows the
   * derived index instead of inventing a number.
   */
  sourceStepId?: string;
  boundaryConfidence: 'explicit' | 'derived';
  startedAt?: number;
  endedAt?: number;
  ttftMs?: number | null;
  decodeMs?: number | null;
  /** R3: effective model for this step. Records inherit from their step. */
  model?: string;
  usage?: NormUsage;
  /** R4: per-step reasoning availability. */
  reasoning?: { availability: 'plaintext' | 'encrypted' | 'absent'; text?: string; bytes?: number };
}

export interface NormTurn {
  turnIndex: number;
  sourceTurnId?: string;
  boundaryConfidence: 'explicit' | 'derived';
  startedAt?: number;
  endedAt?: number;
  durationMs?: number | null;
  ttftMs?: number | null;
  endReason?: string;
}

export interface NormRecord {
  recordId: string;
  kind: NormRecordKind;
  /** Authoritative order within the session. UI sorts ONLY by this. */
  orderIndex: number;
  turnIndex?: number;
  stepIndex?: number;
  sourceSeq?: number | string;
  opensTurn?: boolean;
  text: string;
  detailText?: string;
  toolName?: string;
  callId?: string;
  isError?: boolean;
  errorName?: string;
  /** Unknown stays null. The UI renders "—". */
  timeSeconds: number | null;
  startedAt?: number;
  usage?: NormUsage;
  tool?: NormToolCall;
  flags: RecordFlag[];
}

export interface Diagnostic {
  badLineCount: number;
  unknownTypeCount: number;
  unresolvedCallCount: number;
  shadowedCount: number;
  reopened: boolean;
  ttftMissingCount: number;
  usageMissingCount: number;
  parseErrors: Array<{ lineNo: number; message: string; snippet: string }>;
}

export interface NormSession {
  source: SourceId;
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  cliVersion?: string;
  /** R1: EFFECTIVE ordering for this session, resolved at ingest. */
  capabilities: SourceCapabilities;
  startedAt?: number;
  endedAt?: number;
  turns: NormTurn[];
  steps: NormStep[];
  records: NormRecord[];
  diagnostics: Diagnostic;
}

/** 2x2 safety cap (mirrors DSH ui-trajectory MAX_DEPTH). */
export const MAX_SUBTOOL_DEPTH = 256;
