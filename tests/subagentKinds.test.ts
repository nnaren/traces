import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_TOOLS, baseToolName, isSubagentNotification, isSubagentTool, subagentAction,
} from '../src/subagent.ts';

/**
 * The three sources name delegation differently and offer different amounts of it, so this
 * list is per source by construction. Two failure modes matter and neither throws:
 *
 *  - a real subagent call filed as `tool` (invisible delegation), or
 *  - an ordinary tool filed as `subagent` (the ledger claims the agent delegated work it
 *    actually did itself — the more damaging of the two, because it invents a fact).
 *
 * Counts come from the ingested store on this machine, so the fixtures below are measured
 * names, not guesses.
 */
describe('per-source subagent tool classification', () => {
  it('knows claude code spawns with Agent and has no management tools at all', () => {
    expect(isSubagentTool('claude-code', 'Agent')).toBe(true);
    expect(isSubagentTool('claude-code', 'Task')).toBe(true);       // older name, same tool
    expect(SUBAGENT_TOOLS['claude-code'].has('wait_agent')).toBe(false);
    expect(isSubagentTool('claude-code', 'Bash')).toBe(false);
    expect(isSubagentTool('claude-code', 'Read')).toBe(false);
    expect(isSubagentTool('claude-code', 'Write')).toBe(false);
  });

  it('knows dsh spawns with subagent (and the older task)', () => {
    expect(isSubagentTool('dsh', 'subagent')).toBe(true);
    expect(isSubagentTool('dsh', 'task')).toBe(true);
    expect(isSubagentTool('dsh', 'send_message')).toBe(true);
    expect(isSubagentTool('dsh', 'list_agents')).toBe(true);
    expect(isSubagentTool('dsh', 'interrupt_agent')).toBe(true);
    expect(isSubagentTool('dsh', 'bash')).toBe(false);
    expect(isSubagentTool('dsh', 'read')).toBe(false);
    expect(isSubagentTool('dsh', 'todo_write')).toBe(false);
    expect(isSubagentTool('dsh', 'web_search')).toBe(false);
  });

  /**
   * Codex drives subagents through a whole tool FAMILY, and `wait_agent` alone is 1675 of the
   * 2552 such calls measured — it is still delegation, so it must be classified as such.
   */
  it('knows codex drives subagents through a family of tools', () => {
    for (const t of ['spawn_agent', 'wait_agent', 'close_agent', 'send_message',
                     'list_agents', 'interrupt_agent', 'followup_task']) {
      expect(isSubagentTool('codex', t), t).toBe(true);
    }
    expect(isSubagentTool('codex', 'exec_command')).toBe(false);
    expect(isSubagentTool('codex', 'apply_patch')).toBe(false);
  });

  /**
   * Codex namespaces its multi-agent tools and the prefix REPEATS
   * (`multi_agent_v1__multi_agent_v1__wait_agent` is measured). Classification must survive
   * that — and, critically, `write_stdin` shares the prefix while having nothing to do with
   * subagents, so a substring test would invent a delegation here.
   */
  it('strips repeated multi_agent_v1__ prefixes, and only those', () => {
    expect(baseToolName('multi_agent_v1__spawn_agent')).toBe('spawn_agent');
    expect(baseToolName('multi_agent_v1__multi_agent_v1__wait_agent')).toBe('wait_agent');
    expect(isSubagentTool('codex', 'multi_agent_v1__spawn_agent')).toBe(true);
    expect(isSubagentTool('codex', 'multi_agent_v1__multi_agent_v1__wait_agent')).toBe(true);
    expect(isSubagentTool('codex', 'multi_agent_v1__multi_agent_v1__spawn_agent')).toBe(true);
    // Same namespace, ordinary tool — must stay ordinary.
    expect(isSubagentTool('codex', 'multi_agent_v1__write_stdin')).toBe(false);
  });

  it('never treats a missing name as a subagent call', () => {
    for (const n of [undefined, null, '']) {
      expect(isSubagentTool('codex', n)).toBe(false);
      expect(isSubagentTool('dsh', n)).toBe(false);
      expect(isSubagentTool('claude-code', n)).toBe(false);
    }
  });

  it('is a per-source decision, not a shared one', () => {
    // The same tool name means different things to different harnesses: `send_message` steers
    // a subagent in all three, but `Agent` is only ever claude's, and codex never uses it.
    expect(isSubagentTool('codex', 'Agent')).toBe(false);
    expect(isSubagentTool('dsh', 'Agent')).toBe(false);
    expect(isSubagentTool('claude-code', 'subagent')).toBe(false);
  });
});

describe('codex subagent notification', () => {
  /**
   * Only codex hands a finished child's report back as its own injected record — claude and
   * DSH return that report inside the spawn call's result, so they produce no such record and
   * need no equivalent rule.
   */
  it('recognises the wrapper codex injects into the parent conversation', () => {
    expect(isSubagentNotification('<subagent_notification>')).toBe(true);
    expect(isSubagentNotification('  <subagent_notification>\nagent finished')).toBe(true);
  });

  it('does not claim ordinary injected context', () => {
    expect(isSubagentNotification('Current runtime context. This snapshot supersedes...')).toBe(false);
    expect(isSubagentNotification('<system-reminder>')).toBe(false);
    expect(isSubagentNotification('<task-notification>')).toBe(false);
    expect(isSubagentNotification(undefined)).toBe(false);
    expect(isSubagentNotification(null)).toBe(false);
  });
});

describe('subagent action, for the record tooltip', () => {
  it('distinguishes the actions even though they share one colour', () => {
    expect(subagentAction('claude-code', 'Agent')).toBe('spawn');
    expect(subagentAction('dsh', 'subagent')).toBe('spawn');
    expect(subagentAction('codex', 'spawn_agent')).toBe('spawn');
    expect(subagentAction('codex', 'wait_agent')).toBe('wait');
    expect(subagentAction('codex', 'send_message')).toBe('message');
    expect(subagentAction('codex', 'close_agent')).toBe('close');
    expect(subagentAction('codex', 'interrupt_agent')).toBe('interrupt');
    expect(subagentAction('codex', 'list_agents')).toBe('list');
    expect(subagentAction('codex', undefined)).toBe('unknown');
  });

  it('resolves a namespaced codex tool to the same action', () => {
    expect(subagentAction('codex', 'multi_agent_v1__multi_agent_v1__wait_agent')).toBe('wait');
  });
});