import { describe, expect, it } from 'vitest';
import { normalizeCodex } from '../src/normalize/codex.ts';
import { splitLines } from '../src/sources/stableRead.ts';
import type { SessionRef } from '../src/types.ts';

/**
 * Codex labels injected content with `role: "user"` too.
 *
 * `<environment_context>`, `<skill>`, `<subagent_notification>` … all arrive as
 * `response_item` messages with `role: "user"`, so mapping every role=user message to
 * 用户 dressed 48% of them up as human questions (measured across this machine's
 * rollouts: 363 of 749). The first row of a session read 用户 `<environment_context>`
 * instead of the question the human actually asked.
 *
 * Codex does mark the real ones: every human message is echoed one ordinal later as
 * `event_msg` → `item_completed` → `item.type === "UserMessage"` carrying the identical
 * text. Injected messages have no such echo. That echo is the classifier.
 */

const REF: SessionRef = { source: 'codex', sessionId: 's1', path: '/tmp/s1.jsonl' };
const buf = (lines: any[]) =>
  Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
const run = (lines: any[]) => normalizeCodex(REF, splitLines(buf(lines)));

const meta = {
  type: 'session_meta', ordinal: 0, timestamp: '2026-09-12T14:44:24.000Z',
  payload: { session_id: 's1', cwd: '/w', cli_version: '0.150.0' },
};
const started = { type: 'event_msg', ordinal: 1, timestamp: '2026-09-12T14:44:25.000Z', payload: { type: 'task_started', turn_id: 't1' } };

/** A role=user message. `kind` in the source is always "user" — that is the point. */
const userMsg = (text: string, ordinal: number) => ({
  type: 'response_item', ordinal, timestamp: '2026-09-12T14:44:26.000Z',
  payload: { type: 'message', id: 'msg_' + ordinal, role: 'user', content: [{ type: 'input_text', text }] },
});

/** Codex's echo for a REAL human message, one ordinal after it. */
const echo = (text: string, ordinal: number) => ({
  type: 'event_msg', ordinal, timestamp: '2026-09-12T14:44:26.500Z',
  payload: {
    type: 'item_completed',
    item: { type: 'UserMessage', id: 'um_' + ordinal, client_id: 'c' + ordinal, content: [{ type: 'text', text }] },
  },
});

describe('codex: human input vs injected context', () => {
  it('labels a message Codex echoed as UserMessage as 用户', () => {
    const s = run([meta, started, userMsg('怎么运行', 6), echo('怎么运行', 7)]);
    const r = s.records.find((x) => x.kind === 'user');
    expect(r).toBeTruthy();
    expect(r!.detailText).toBe('怎么运行');
    expect(r!.opensTurn).toBe(true);
  });

  it('labels an injected role=user message as 上下文, not 用户', () => {
    const s = run([
      meta, started,
      userMsg('<environment_context>\n  <cwd>/w</cwd>\n</environment_context>', 3),
      userMsg('<skill>\n<name>oh-my-codex:deep-interview</name>\n</skill>', 8),
    ]);
    expect(s.records.filter((x) => x.kind === 'user')).toHaveLength(0);
    const ctx = s.records.filter((x) => x.kind === 'context');
    expect(ctx).toHaveLength(2);
    // Injected input must never fabricate a turn of its own.
    expect(ctx.every((x) => x.opensTurn !== true)).toBe(true);
  });

  it('keeps a real question as 用户 when it sits between injected blocks', () => {
    const s = run([
      meta, started,
      userMsg('<environment_context>\n  <cwd>/w</cwd>\n</environment_context>', 3),
      userMsg('# Deep-Interview Transcript', 6), echo('# Deep-Interview Transcript', 7),
      userMsg('<skill>\n<name>x</name>\n</skill>', 8),
    ]);

    const users = s.records.filter((x) => x.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].detailText).toBe('# Deep-Interview Transcript');
    expect(s.records.filter((x) => x.kind === 'context')).toHaveLength(2);
    // The real question is the FIRST 用户 row of the session — the reported symptom.
    const firstUser = s.records.filter((x) => x.kind === 'user' || x.kind === 'context')
      .sort((a, b) => a.orderIndex - b.orderIndex)[0];
    expect(firstUser.kind).toBe('context');            // injected env block comes first…
    const firstRealUser = s.records.filter((x) => x.kind === 'user')
      .sort((a, b) => a.orderIndex - b.orderIndex)[0];
    expect(firstRealUser.detailText).toBe('# Deep-Interview Transcript');
  });

  it('does not misclassify when an echo text differs from the message text', () => {
    // The echo must match on CONTENT, not merely exist at the next ordinal.
    const s = run([
      meta, started,
      userMsg('<subagent_notification>{"a":1}</subagent_notification>', 10),
      echo('something else entirely', 11),
    ]);
    expect(s.records.filter((x) => x.kind === 'user')).toHaveLength(0);
    expect(s.records.filter((x) => x.kind === 'context')).toHaveLength(1);
  });

  it('still counts every message — nothing is dropped by the reclassification', () => {
    const s = run([
      meta, started,
      userMsg('a', 3),
      userMsg('<skill>b</skill>', 4),
      userMsg('c', 5), echo('c', 6),
    ]);
    const userish = s.records.filter((x) => x.kind === 'user' || x.kind === 'context');
    expect(userish).toHaveLength(3);
    expect(userish.filter((x) => x.kind === 'user')).toHaveLength(1);
    expect(userish.filter((x) => x.kind === 'context')).toHaveLength(2);
  });
});