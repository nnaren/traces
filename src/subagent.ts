/**
 * Which tool calls are really about a SUBAGENT conversation, per source.
 *
 * The three sources name the same action three different ways, and they do not even agree on
 * how many actions there are — so a single shared "is this a subagent call?" list would be
 * wrong for at least one of them. Measured on this machine (counts from the ingested store):
 *
 * | 源 | 派生 | 管理 | 其它形态 |
 * |---|---|---|---|
 * | **Claude Code** | `Agent` (30) | — | 只有「派生」一种调用；`Agent` 的**返回值是子代理的最终报告正文**，没有任何 id |
 * | **DSH** | `subagent` (10)、`task` (1) | `send_message` (1)、`list_agents` (1) | 参数是 `description` + `prompt` |
 * | **Codex** | `spawn_agent` (208) | `wait_agent` (1675)、`send_message` (507)、`list_agents` (98)、`close_agent` (40)、`interrupt_agent` (17)、`followup_task` (69) | 名字可带**重复前缀** `multi_agent_v1__multi_agent_v1__wait_agent`；并且子代理的结果以 `<subagent_notification>` **上下文**记录回注主会话（72） |
 *
 * Three consequences the callers depend on:
 *
 *  - Codex's `wait_agent` outnumbers everything else 8:1. It is still a subagent call, and
 *    marking it is the honest reading — but it means the 子代理 colour dominates some Codex
 *    ledgers. That is a property of the source, not something to hide by lying about the kind.
 *  - Claude has NO management tools: one `Agent` call spawns, and the transcript of the child
 *    lives in a separate session. Codex/DSH spawn AND steer the same child over many calls.
 *  - `multi_agent_v1__write_stdin` is NOT a subagent call (it writes to a process' stdin),
 *    and it shares the namespaced prefix with the real ones — so membership is tested after
 *    stripping prefixes, never by substring.
 */
import type { SourceId } from './types.ts';

/** Tool names that spawn or steer a subagent, per source. */
export const SUBAGENT_TOOLS: Record<SourceId, ReadonlySet<string>> = {
  'claude-code': new Set([
    'Agent',
    // Older Claude Code named the same tool `Task` (pre-2.0 transcripts). Not present on
    // this machine, recognised so an older capture is not silently left unlabelled.
    'Task',
  ]),
  dsh: new Set([
    'subagent',
    // DSH's earlier name for the same tool; the payload is `prompt`, not `description`.
    'task',
    'send_message',
    'list_agents',
    'interrupt_agent',
    'send_input',
  ]),
  codex: new Set([
    'spawn_agent',
    'wait_agent',
    'close_agent',
    'send_message',
    'list_agents',
    'interrupt_agent',
    'followup_task',
    'resume_agent',
  ]),
};

/**
 * Codex namespaces its multi-agent tools by prefix, and the prefix REPEATS
 * (`multi_agent_v1__multi_agent_v1__wait_agent` is measured on this machine).
 *
 * Stripped before matching so a namespaced tool is classified by what it does, and so
 * `multi_agent_v1__write_stdin` — which shares the prefix but has nothing to do with
 * subagents — falls through to an ordinary tool.
 */
export function baseToolName(name: string): string {
  let n = name;
  while (n.startsWith('multi_agent_v1__')) n = n.slice('multi_agent_v1__'.length);
  return n;
}

/** Whether this call manages a subagent conversation, in the source that logged it. */
export function isSubagentTool(source: SourceId, name: string | undefined | null): boolean {
  if (!name) return false;
  return SUBAGENT_TOOLS[source].has(baseToolName(name));
}

/**
 * Codex injects a finished subagent's report back into the PARENT conversation as a user
 * message wrapped in `<subagent_notification>` (72 measured). Claude and DSH do not — their
 * `Agent`/`subagent` call returns the report inline, so there is no separate record to mark.
 *
 * Marking it keeps the parent's ledger readable: without it, a turn that was decided by a
 * subagent looks like an unexplained block of 上下文.
 */
export function isSubagentNotification(text: string | undefined | null): boolean {
  return typeof text === 'string' && text.trimStart().startsWith('<subagent_notification>');
}

/**
 * What the subagent call actually DID, which the three sources spell differently.
 *
 * Used for the ledger's tooltip only — never for colouring or filtering, where lumping
 * spawn together with wait would hide the fact that they are different actions.
 */
export type SubagentAction = 'spawn' | 'wait' | 'message' | 'list' | 'close' | 'interrupt' | 'unknown';

export function subagentAction(source: SourceId, name: string | undefined | null): SubagentAction {
  const n = baseToolName(name ?? '');
  if (n === 'Agent' || n === 'Task' || n === 'subagent' || n === 'task' || n === 'spawn_agent') return 'spawn';
  if (n === 'wait_agent') return 'wait';
  if (n === 'send_message' || n === 'send_input') return 'message';
  if (n === 'list_agents') return 'list';
  if (n === 'close_agent') return 'close';
  if (n === 'interrupt_agent') return 'interrupt';
  void source;
  return 'unknown';
}

export const SUBAGENT_ACTION_LABEL: Record<SubagentAction, string> = {
  spawn: '派生', wait: '等待', message: '发消息', list: '查看列表',
  close: '关闭', interrupt: '打断', unknown: '子代理',
};