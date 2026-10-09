import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, tempDir, writeClaude, writeCodex, writeDsh } from './helpers.ts';

/**
 * Deterministic read-only proof (acceptance A6).
 *
 * A whole-tree fingerprint of ~/.codex can never be stable while an agent is running,
 * because the agent legitimately appends to its own log. So we prove the property
 * directly: ingest FROZEN fixtures through the real adapters and assert every source
 * byte is unchanged afterwards.
 */

const srcRoot = await tempDir('ro-src');
const dataRoot = await tempDir('ro-data');

async function fingerprintTree(root: string): Promise<string> {
  const parts: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      const st = await fs.stat(p);
      parts.push(p + ':' + st.size + ':' + st.mtimeMs + ':' + st.mode);
    }
  }
  parts.sort();
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

beforeAll(async () => {
  // Codex fixture WITH tool calls (covers call_id pairing + the encrypted-reasoning path)
  await writeCodex(srcRoot, 'rollout-1.jsonl', [
    { type: 'session_meta', timestamp: '2026-08-20T10:00:00.000Z', payload: { session_id: 'cx1', cwd: '/w', cli_version: '0.153.4' } },
    { type: 'event_msg', ordinal: 1, timestamp: '2026-08-20T10:00:01.000Z', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'response_item', ordinal: 2, timestamp: '2026-08-20T10:00:01.100Z', payload: { type: 'message', role: 'user', content: [{ text: 'run ls' }] } },
    { type: 'response_item', ordinal: 3, timestamp: '2026-08-20T10:00:02.000Z', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' } },
    { type: 'response_item', ordinal: 4, timestamp: '2026-08-20T10:00:03.000Z', payload: { type: 'function_call_output', call_id: 'c1', output: 'a.txt' } },
    { type: 'event_msg', ordinal: 5, timestamp: '2026-08-20T10:00:04.000Z', payload: { type: 'task_complete', turn_id: 't1', duration_ms: 3000, time_to_first_token_ms: 400, completed_at: 1788518404 } },
  ]);
  // Claude fixture with plaintext thinking + a tool call
  await writeClaude(srcRoot, 'cl-1.jsonl', [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'cl1', cwd: '/w', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'cl1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'thinking', thinking: 'they said hi', signature: 's' }, { type: 'text', text: 'hello' }], usage: { input_tokens: 5, output_tokens: 2 } } },
    { type: 'system', subtype: 'turn_duration', durationMs: 1200, timestamp: '2026-01-01T00:00:02.000Z' },
  ]);
  // DSH fixture across multiple zstd frames
  await writeDsh(srcRoot, 'ds1', [
    JSON.stringify({ type: 'session', version: 3, id: 'ds1', createdAt: 1788518400000, cwd: '/w' }) + '\n',
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1788518400000, data: { turn: 1 } }) + '\n',
    JSON.stringify({ type: 'tool/call', seq: 1, time: 1788518400100, data: { turn: 1, step: 1, callId: 'k1', name: 'bash', arguments: '{}' } }) + '\n',
    JSON.stringify({ type: 'tool/result', seq: 2, time: 1788518400500, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }], source: { callId: 'k1' } } } }) + '\n',
  ]);
});

afterAll(async () => { await cleanup(srcRoot); await cleanup(dataRoot); });

describe('read-only guarantee (acceptance A6)', () => {
  it('never mutates a single source byte across a full ingest', async () => {
    process.env.TRAJVIEW_CODEX_HOME = srcRoot;
    process.env.TRAJVIEW_CLAUDE_HOME = srcRoot;
    process.env.TRAJVIEW_DSH_HOME = srcRoot;   // the adapter appends 'sessions' itself

    const before = await fingerprintTree(srcRoot);
    const beforeFiles = (await fs.readdir(path.join(srcRoot, 'sessions', '2026', '01', '01'))).sort();
    const beforeBytes = await fs.readFile(path.join(srcRoot, 'sessions', '2026', '01', '01', beforeFiles[0]));

    // Import lazily so the adapters pick up the overridden roots.
    const { ingest } = await import('../src/ingest.ts');
    const report = await ingest({ dataDir: dataRoot });

    expect(report.errors).toEqual([]);
    expect(report.ingested.codex).toBe(1);
    expect(report.ingested['claude-code']).toBe(1);
    expect(report.ingested.dsh).toBe(1);

    const after = await fingerprintTree(srcRoot);
    const afterFiles = (await fs.readdir(path.join(srcRoot, 'sessions', '2026', '01', '01'))).sort();
    const afterBytes = await fs.readFile(path.join(srcRoot, 'sessions', '2026', '01', '01', beforeFiles[0]));

    expect(afterFiles).toEqual(beforeFiles);          // no new files created
    expect(afterBytes.equals(beforeBytes)).toBe(true); // no byte changed
    expect(after).toBe(before);                        // identical tree fingerprint

    // ...while the derived layer and the vault DID get written.
    await expect(fs.stat(path.join(dataRoot, 'traces.sqlite3'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(dataRoot, 'vault', 'codex'))).resolves.toBeTruthy();
  }, 60000);
});
