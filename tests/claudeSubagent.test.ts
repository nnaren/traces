import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, tempDir, writeClaude, writeClaudeSubagent } from './helpers.ts';

/**
 * REGRESSION: Claude Code subagent trajectories were invisible.
 *
 * A subagent transcript is NOT beside the session file — it is
 * `projects/<slug>/<session>/subagents/agent-<agentId>.jsonl`, TWO levels below the project
 * directory. Discovery walked one level and matched `*.jsonl`, so the session's own
 * directory was skipped by name and the four subagents of session 996c7dee (1597 lines,
 * 3.0 MB) were never read.
 *
 * Three properties are asserted here, each of which was independently fatal:
 *  - the transcripts are DISCOVERED (the directory is walked);
 *  - they do not COLLIDE (every record in a subagent repeats the PARENT's `sessionId`, so
 *    keying on it would overwrite one subagent with another);
 *  - they are LINKED (`subagents/*.meta.json` → `toolUseId` is the parent's `tool_use.id`,
 *    and it is the only such key — the `Agent` result is prose with no id in it).
 */

const SRC = await tempDir('claude-sub-src');
const DATA = await tempDir('claude-sub-data');

const PARENT = '996c7dee-4e92-4730-b5a3-f2c4131239a4';
const CHILD = 'ac5961e309227d752';
const CALL = 'chatcmpl-tool-93249bc52a95581f';

/** One assistant response carrying a tool call, as a subagent transcript records it. */
const assistant = (id: string, text: string, toolId?: string) => ({
  type: 'assistant', uuid: id, parentUuid: null, isSidechain: true,
  sessionId: PARENT, agentId: CHILD,
  timestamp: '2026-10-14T04:44:17.000Z',
  message: {
    role: 'assistant', model: 'claude-sonnet-4',
    content: [{ type: 'text', text }, ...(toolId ? [{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: '/w/a.c' } }] : [])],
    usage: { input_tokens: 100, output_tokens: 20 },
  },
});

beforeAll(async () => {
  // Root conversation: one user turn, one `Agent` spawn, one result.
  await writeClaude(SRC, `${PARENT}.jsonl`, [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: PARENT, timestamp: '2026-10-14T04:44:00.000Z',
      message: { role: 'user', content: 'run three reviews' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: PARENT, timestamp: '2026-10-14T04:44:10.000Z',
      message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'tool_use', id: CALL, name: 'Agent',
        input: { description: '执行评审任务 ReviewTask-1', subagent_type: 'general-purpose', model: 'sonnet', run_in_background: false, prompt: 'go' } }],
        usage: { input_tokens: 10, output_tokens: 5 } } },
  ]);
  await writeClaudeSubagent(SRC, PARENT, CHILD,
    { agentType: 'general-purpose', description: '执行评审任务 ReviewTask-1', toolUseId: CALL, spawnDepth: 1, model: 'sonnet' },
    [
      // The spawn prompt. NOTE the sessionId: it is the PARENT's, in every record.
      { type: 'user', uuid: 's1', parentUuid: null, isSidechain: true, sessionId: PARENT, agentId: CHILD,
        timestamp: '2026-10-14T04:44:16.480Z', cwd: '/w', version: '2.1.270', gitBranch: 'HEAD',
        message: { role: 'user', content: '你是 ReviewTask-1' } },
      assistant('s2', '读文件', 'toolu-1'),
      { type: 'user', uuid: 's3', parentUuid: 's2', isSidechain: true, sessionId: PARENT, agentId: CHILD,
        timestamp: '2026-10-14T04:44:18.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'ok' }] } },
      assistant('s4', '评审完成，结果已写入 review_result_1.json'),
    ]);
  // A second child of the SAME parent: the collision case.
  await writeClaudeSubagent(SRC, PARENT, 'a1ac3e2c92d1f798b',
    { agentType: 'general-purpose', description: '执行评审任务 ReviewTask-2', toolUseId: 'chatcmpl-tool-ac545a67eeabd10d', spawnDepth: 1 },
    [
      { type: 'user', uuid: 't1', parentUuid: null, isSidechain: true, sessionId: PARENT, agentId: 'a1ac3e2c92d1f798b',
        timestamp: '2026-10-14T04:44:16.627Z', cwd: '/w', version: '2.1.270',
        message: { role: 'user', content: '你是 ReviewTask-2' } },
      assistant('t2', 'ok', undefined),
    ]);
});

afterAll(async () => {
  delete process.env.TRAJVIEW_CLAUDE_HOME;
  await cleanup(SRC);
  await cleanup(DATA);
});

async function discoverRefs(): Promise<any[]> {
  process.env.TRAJVIEW_CLAUDE_HOME = SRC;
  const { claudeAdapter } = await import('../src/sources/claude.ts');
  const out: any[] = [];
  for await (const r of claudeAdapter.discover()) out.push(r);
  return out;
}

describe('claude code subagent discovery', () => {
  it('finds the transcripts under <session>/subagents/, not just beside the session', async () => {
    const refs = await discoverRefs();
    expect(refs).toHaveLength(3);                       // 1 root + 2 subagents
    expect(refs.map((r) => r.sessionId).sort()).toContain(`${PARENT}--sub-${CHILD}`);
  });

  it('keys each subagent on its OWN agentId — never on the parent id its records carry', async () => {
    const refs = await discoverRefs();
    const children = refs.filter((r) => r.parentSessionId);
    expect(children).toHaveLength(2);
    expect(new Set(children.map((r) => r.sessionId)).size).toBe(2);
    // The parent id appears on EVERY record inside a subagent, so it can never be the key.
    for (const c of children) expect(c.sessionId).not.toBe(c.parentSessionId);
  });

  it('links every child to the conversation that spawned it', async () => {
    const refs = await discoverRefs();
    for (const c of refs.filter((r) => r.parentSessionId)) expect(c.parentSessionId).toBe(PARENT);
  });

  it('reads the spawn descriptor: label, depth, and the spawning tool call id', async () => {
    const refs = await discoverRefs();
    const child = refs.find((r) => r.sessionId === `${PARENT}--sub-${CHILD}`)!;
    expect(child.agentNickname).toBe('执行评审任务 ReviewTask-1');
    expect(child.subagentDepth).toBe(1);
    // The one key the UI can jump on: the parent's `tool_use.id` for the `Agent` call.
    expect(child.spawnCallId).toBe(CALL);
  });

  it('leaves the root conversation without subagent identity', async () => {
    const root = (await discoverRefs()).find((r) => r.sessionId === PARENT)!;
    expect(root.parentSessionId).toBeUndefined();
    expect(root.spawnCallId).toBeUndefined();
    expect(root.subagentDepth).toBeUndefined();
  });

  it('points at the transcript, and carries the subagent header identity', async () => {
    const child = (await discoverRefs()).find((r) => r.sessionId === `${PARENT}--sub-${CHILD}`)!;
    expect(child.path).toContain(path.join(PARENT, 'subagents', `agent-${CHILD}.jsonl`));
    expect(child.cliVersion).toBe('2.1.270');
    expect(child.cwd).toBe('/w');
    expect(child.revision).toBeTruthy();
  });
});

describe('claude code subagent normalization', () => {
  it('normalizes into its own parent-linked session', async () => {
    const child = (await discoverRefs()).find((r) => r.sessionId === `${PARENT}--sub-${CHILD}`)!;
    const { claudeAdapter } = await import('../src/sources/claude.ts');
    const { normalizeClaude } = await import('../src/normalize/claude.ts');
    const lines = await claudeAdapter.readAll(child);
    const s = normalizeClaude(child, lines.filter((l) => claudeAdapter.isRelevant(l)));
    expect(s.sessionId).toBe(`${PARENT}--sub-${CHILD}`);
    expect(s.parentSessionId).toBe(PARENT);
    expect(s.agentNickname).toBe('执行评审任务 ReviewTask-1');
    expect(s.subagentDepth).toBe(1);
    expect(s.spawnCallId).toBe(CALL);
  });

  it('does not call a completed subagent interrupted (it has no turn_duration at all)', async () => {
    const child = (await discoverRefs()).find((r) => r.sessionId === `${PARENT}--sub-${CHILD}`)!;
    const { claudeAdapter } = await import('../src/sources/claude.ts');
    const { normalizeClaude } = await import('../src/normalize/claude.ts');
    const lines = await claudeAdapter.readAll(child);
    const s = normalizeClaude(child, lines.filter((l) => claudeAdapter.isRelevant(l)));
    expect(s.records.some((r) => r.text.includes('interrupted'))).toBe(false);
    expect(s.turns[s.turns.length - 1].endReason).toBe('completed');
  });

  it('keeps the subagent tool call paired with its result', async () => {
    const child = (await discoverRefs()).find((r) => r.sessionId === `${PARENT}--sub-${CHILD}`)!;
    const { claudeAdapter } = await import('../src/sources/claude.ts');
    const { normalizeClaude } = await import('../src/normalize/claude.ts');
    const lines = await claudeAdapter.readAll(child);
    const s = normalizeClaude(child, lines.filter((l) => claudeAdapter.isRelevant(l)));
    const call = s.records.find((r) => r.toolName === 'Read')!;
    expect(call.tool?.outputText).toBe('ok');
    expect(call.tool?.durationMs).toBeGreaterThan(0);
    expect(s.diagnostics.unresolvedCallCount).toBe(0);
  });
});

describe('claude code subagent vault round-trip', () => {
  it('rebuilds the whole link from the capture alone, with the source tree unreadable', async () => {
    const child = (await discoverRefs()).find((r) => r.sessionId === `${PARENT}--sub-${CHILD}`)!;
    const { Vault } = await import('../src/vault.ts');
    const raw = await fs.readFile(child.path);
    const vault = new Vault(path.join(DATA, 'vault'));
    await vault.put(child, raw);

    // The source file is gone — exactly the situation the vault exists for.
    await fs.rm(child.path);
    await fs.rm(child.path.replace(/\.jsonl$/, '.meta.json'));

    const { enumerateVault } = await import('../src/sources/vault.ts');
    const entries = await enumerateVault(path.join(DATA, 'vault'), 'claude-code');
    const replayed = entries.find((e) => e.ref.sessionId === `${PARENT}--sub-${CHILD}`)!;
    expect(replayed).toBeTruthy();
    expect(replayed.ref.parentSessionId).toBe(PARENT);
    expect(replayed.ref.subagentDepth).toBe(1);
    expect(replayed.ref.agentNickname).toBe('执行评审任务 ReviewTask-1');
    // Not re-derivable from the capture's own path: the parent's `Agent` record is not
    // part of this capture, so meta.json is the only place this can live.
    expect(replayed.ref.spawnCallId).toBe(CALL);
    expect(replayed.ref.path).toContain(path.join('vault', 'claude-code'));
  });
});

describe('claude code legacy flat subagent layout', () => {
  it('still recognises agent-<id>.jsonl sitting beside the session files', async () => {
    const src = await tempDir('claude-sub-flat');
    try {
      await writeClaude(src, `${PARENT}.jsonl`, [
        { type: 'user', uuid: 'f1', parentUuid: null, sessionId: PARENT, timestamp: '2026-10-14T04:44:00.000Z', message: { role: 'user', content: 'hi' } },
      ]);
      // No `<session>/` directory at all — the documented older layout.
      await fs.writeFile(
        path.join(src, 'projects', '-tmp-proj', 'agent-flat00000000001.jsonl'),
        JSON.stringify({ type: 'user', uuid: 'g1', parentUuid: null, isSidechain: true, sessionId: PARENT, agentId: 'flat00000000001', timestamp: '2026-10-14T04:44:20.000Z', message: { role: 'user', content: 'sub' } }) + '\n',
      );
      process.env.TRAJVIEW_CLAUDE_HOME = src;
      const { claudeAdapter } = await import('../src/sources/claude.ts');
      const out: any[] = [];
      for await (const r of claudeAdapter.discover()) out.push(r);
      const flat = out.find((r) => r.sessionId.endsWith('flat00000000001'));
      expect(flat).toBeTruthy();
      // With no directory to read the parent from, the transcript's own sessionId IS the
      // parent (measured) — so the link survives the older layout too.
      expect(flat!.parentSessionId).toBe(PARENT);
    } finally {
      await cleanup(src);
    }
  });
});