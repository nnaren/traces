import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Write a Codex rollout fixture. Lines are objects or raw strings (for bad lines). */
export async function writeCodex(dir: string, name: string, lines: Array<any | string>): Promise<string> {
  const d = path.join(dir, 'sessions', '2026', '01', '01');
  await fs.mkdir(d, { recursive: true });
  const p = path.join(d, name);
  await fs.writeFile(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
}

export async function writeClaude(dir: string, name: string, lines: Array<any | string>): Promise<string> {
  const d = path.join(dir, 'projects', '-tmp-proj');
  await fs.mkdir(d, { recursive: true });
  const p = path.join(d, name);
  await fs.writeFile(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
}

/**
 * A Claude session's subagent transcript and the spawn sidecar beside it —
 * `projects/<slug>/<session>/subagents/agent-<agentId>.{jsonl,meta.json}`.
 *
 * `meta` is the spawn descriptor Claude writes (`toolUseId` / `description` / `spawnDepth`);
 * the transcript's own first line repeats the PARENT's `sessionId`, exactly as measured.
 */
export async function writeClaudeSubagent(
  dir: string, sessionId: string, agentId: string, meta: Record<string, any>, lines: Array<any | string>,
): Promise<string> {
  const d = path.join(dir, 'projects', '-tmp-proj', sessionId, 'subagents');
  await fs.mkdir(d, { recursive: true });
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  await fs.writeFile(path.join(d, `agent-${agentId}.jsonl`), body);
  await fs.writeFile(path.join(d, `agent-${agentId}.meta.json`), JSON.stringify(meta, null, 2));
  return path.join(d, `agent-${agentId}.jsonl`);
}

/** Minimal concatenated-zstd writer: one independent frame per chunk. */
export async function writeDsh(dir: string, name: string, chunks: string[]): Promise<string> {
  const zlib = await import('node:zlib');
  const d = path.join(dir, 'sessions', '--tmp-proj--', name);
  await fs.mkdir(d, { recursive: true });
  const parts = chunks.map((c) => zlib.zstdCompressSync(Buffer.from(c, 'utf8')));
  await fs.writeFile(path.join(d, 'session.jsonl.zstd'), Buffer.concat(parts));
  return d;
}

export function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(HERE, '..', '.tmp-' + prefix));
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
