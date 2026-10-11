import type { RecordRow } from './api';

/**
 * Session ids a tool call refers to as subagents.
 *
 * Codex drives subagents through ordinary tool calls, and the child conversation's id is
 * right there in the payload:
 *
 *   spawn_agent  → result `{"agent_id":"01a09624-…","nickname":"Huygens"}`
 *   wait_agent   → input  `{"targets":["01a09624-…"],"timeout_ms":360000}`
 *
 * A subagent rollout is a session of its own (the adapter keys it by `payload.id`), so that
 * id is directly openable — which is the whole point of surfacing it.
 *
 * Both the input and the output are scanned, because which one carries the id depends on
 * the tool: the spawner learns the id from the RESULT, while the waiter is handed it in its
 * ARGUMENTS. Values are collected from nested structures rather than a fixed shape, so a
 * Codex version that renames a wrapper object still works.
 */
export interface SubagentRef {
  id: string;
  /** Codex's spawn-assigned name for the child, when the payload carried one. */
  nickname?: string;
}

export function subagentRefs(rec: RecordRow): SubagentRef[] {
  const found = new Map<string, SubagentRef>();
  collect(rec.tool?.outputText, found);
  collect(rec.tool?.inputRaw, found);
  return [...found.values()];
}

/** Keys whose string value is a subagent thread id. */
const ID_KEYS = new Set(['agent_id', 'agentId', 'thread_id', 'threadId', 'receiver_thread_id']);
/** Keys whose array value is a list of subagent thread ids. */
const ID_LIST_KEYS = new Set(['targets', 'receiver_thread_ids', 'receiverThreadIds', 'agents']);

function collect(text: string | null | undefined, out: Map<string, SubagentRef>): void {
  if (!text) return;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return; }   // not JSON: nothing to find
  walk(parsed, out, 0);
}

function walk(v: unknown, out: Map<string, SubagentRef>, depth: number): void {
  if (depth > 8 || v == null) return;
  if (Array.isArray(v)) {
    // An array of plain ids is itself a target list.
    for (const item of v) walk(item, out, depth + 1);
    return;
  }
  if (typeof v !== 'object') return;

  // `spawn_agent` returns the id and the nickname together — take both in one pass.
  const obj = v as Record<string, unknown>;
  let nickname: string | undefined;
  for (const [k, val] of Object.entries(obj)) {
    if (k === 'nickname' && typeof val === 'string') nickname = val;
  }
  for (const [k, val] of Object.entries(obj)) {
    if (typeof val === 'string' && ID_KEYS.has(k)) { addId(val, out, nickname); continue; }
    if (Array.isArray(val) && ID_LIST_KEYS.has(k)) {
      for (const item of val) {
        if (typeof item === 'string') addId(item, out, undefined);
        else walk(item, out, depth + 1);
      }
      continue;
    }
    if (typeof val === 'object') walk(val, out, depth + 1);
  }
}

/**
 * Thread ids as Codex writes them: `01a09624-2596-73e3-bee8-d7258d9f2880`.
 *
 * Two shapes are accepted — the dashed 8-4-4-4-12 form Codex actually emits, and a bare
 * 26-char Crockford base32 ULID — because the id is also seen undashed in some payloads.
 * Requiring an id-like shape keeps `"agent_id": "architect"` from a schema block, or a
 * `"targets"` field used for something else entirely, from rendering a dead link.
 */
const THREAD_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-hjkmnp-tv-z]{26})$/i;

function addId(v: string, out: Map<string, SubagentRef>, nickname: string | undefined): void {
  const s = v.trim();
  if (!THREAD_ID.test(s)) return;
  const key = s.toLowerCase();
  const prev = out.get(key);
  if (prev) { if (!prev.nickname && nickname) prev.nickname = nickname; return; }
  out.set(key, { id: s, nickname });
}
