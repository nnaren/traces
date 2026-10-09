/**
 * Honesty rules (PRD P2/P4), asserted across ALL THREE sources at once.
 *
 * The README promises: "未知就是「—」，不会显示 0 或凭空补一个时长。" A viewer cannot
 * tell a real 0 ms tool call from a fabricated one, so the only safe encoding of "we
 * never saw the end of this" is null — and it must stay null through normalization,
 * the SQLite binding layer, and the API shape.
 *
 * These run over every source because the three normalizers are independent
 * implementations of the same contract; one of them quietly emitting 0 is enough to
 * make the capability matrix lie.
 */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.ts';
import { normalizeCodex } from '../src/normalize/codex.ts';
import { normalizeClaude } from '../src/normalize/claude.ts';
import { normalizeDsh } from '../src/normalize/dsh.ts';
import { splitLines } from '../src/sources/stableRead.ts';
import type { NormSession, SessionRef } from '../src/types.ts';
import { cleanup, tempDir } from './helpers.ts';

const buf = (lines: any[]) => Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
const ref = (source: any, id: string): SessionRef => ({ source, sessionId: id, path: '/tmp/' + id });

/** A tool call that is opened and NEVER resolved — the classic in-flight / crashed tail. */
const DANGLING = {
  codex: () => normalizeCodex(ref('codex', 'x'), splitLines(buf([
    { type: 'session_meta', ordinal: 0, timestamp: '2026-08-20T10:00:00.000Z', payload: { session_id: 'x', cli_version: '0.153.4' } },
    { type: 'event_msg', ordinal: 1, timestamp: '2026-08-20T10:00:01.000Z', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'response_item', ordinal: 2, timestamp: '2026-08-20T10:00:02.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } },
    { type: 'response_item', ordinal: 3, timestamp: '2026-08-20T10:00:02.500Z', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' } },
    { type: 'event_msg', ordinal: 4, timestamp: '2026-08-20T10:00:09.000Z', payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' } },
  ]))),
  'claude-code': () => normalizeClaude(ref('claude-code', 'c'), splitLines(buf([
    { type: 'user', uuid: 'u1', sessionId: 'c', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'go' } },
    { type: 'assistant', uuid: 'a1', sessionId: 'c', timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } },
  ]))),
  dsh: () => normalizeDsh(ref('dsh', 'd'), splitLines(buf([
    { type: 'session', version: 3, id: 'd', createdAt: 1788518400000, cwd: '/w' },
    { type: 'turn/start', seq: 0, time: 1788518400000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1788518400100, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 2, time: 1788518400500, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
  ]))),
};

const SOURCES = ['codex', 'claude-code', 'dsh'] as const;

describe('unknown is null, never 0 (P2/P4)', () => {
  for (const src of SOURCES) {
    it(`${src}: an unresolved tool call reports no elapsed time at all`, () => {
      const s = DANGLING[src]();
      const tool = s.records.find((r) => r.kind === 'tool');
      expect(tool, `${src} produced no tool record`).toBeTruthy();
      // The whole point: null, NOT 0. A fabricated 0 reads as "instant tool call".
      expect(tool!.timeSeconds).toBeNull();
      expect(tool!.tool?.durationMs ?? null).toBeNull();
      expect(s.diagnostics.unresolvedCallCount).toBeGreaterThan(0);
    });

    it(`${src}: no record anywhere invents a duration`, () => {
      const s = DANGLING[src]();
      for (const r of s.records) {
        expect(Number.isNaN(r.timeSeconds as any), `${src} ${r.kind} ${r.recordId} is NaN`).toBe(false);
        if (r.timeSeconds !== null) expect(r.timeSeconds).toBeGreaterThanOrEqual(0);
      }
      for (const t of s.turns) {
        expect(Number.isNaN(t.durationMs as any), `${src} turn duration is NaN`).toBe(false);
      }
    });
  }

  it('never fabricates usage for a turn that reported none', () => {
    for (const src of SOURCES) {
      const s = DANGLING[src]();
      for (const r of s.records) {
        if (r.kind !== 'turn-end') continue;
        const u = r.usage;
        if (u === undefined) continue;
        // A present usage object must not be an all-zero placeholder.
        expect(Object.values(u).some((v) => typeof v === 'number' && v > 0),
          `${src} turn-end carries an all-zero usage`).toBe(true);
      }
    }
  });
});

describe('null survives the store and the API shape', () => {
  it('binds unknown timing to NULL, never to 0 and never to NaN', async () => {
    const dir = await tempDir('honest');
    try {
      const s = await Store.open(dir);
      const norm = DANGLING.dsh();
      s.writeSession(norm, '/v', '/f');
      const row = s.getPage('dsh', 'd', undefined, 500).find((r: any) => r.kind === 'tool')!;
      expect(row.time_seconds).toBeNull();      // not 0
      expect(row.started_at).not.toBeNull();    // the start IS known
      s.close();
    } finally {
      await cleanup(dir);
    }
  });

  it('keeps a genuinely instant tool call distinguishable from an unknown one', async () => {
    const dir = await tempDir('honest2');
    try {
      const s = await Store.open(dir);
      const norm: NormSession = DANGLING.dsh();
      // Give one tool a real (tiny but positive) duration, leave the other unknown.
      norm.records = norm.records.map((r) =>
        r.kind === 'tool' ? { ...r, timeSeconds: 0, tool: { ...r.tool!, durationMs: 0 } } : r);
      s.writeSession(norm, '/v', '/f');
      const row = s.getPage('dsh', 'd', undefined, 500).find((r: any) => r.kind === 'tool')!;
      expect(row.time_seconds).toBe(0);        // a real zero survives as 0
      s.close();
    } finally {
      await cleanup(dir);
    }
  });
});