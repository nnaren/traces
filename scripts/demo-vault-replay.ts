/**
 * Diagnostic (not part of the suite): does the vault actually let you recover a
 * trajectory after the owning CLI deletes its own log?
 *
 * vault.ts justifies copy-on-ingest with: "the owning CLI rotates and deletes its own
 * logs — a trajectory tool that loses data when the source disappears is useless."
 *
 * This walks the exact sequence that justification promises:
 *   ingest -> delete the derived layer -> the source disappears -> ingest again
 *
 * If the last step recovers nothing, the vault preserved bytes nobody can read back,
 * and store.ts:3's "re-running ingest reproduces it byte-for-byte from the vault" is
 * describing a path that does not exist.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ingest } from '../src/ingest.ts';
import { vaultAdapters } from '../src/sources/vault.ts';
import { normalizeCodex } from '../src/normalize/codex.ts';
import { splitLines } from '../src/sources/stableRead.ts';
import { Store } from '../src/store.ts';
import type { SessionRef, TrajectorySourceAdapter } from '../src/types.ts';

const CAPS = {
  reasoning: 'encrypted', usageGranularity: 'ambiguous', cacheSemantics: 'ambiguous',
  cost: 'none', ttft: 'native', tokenTimeline: 'no', toolDuration: 'none',
  subagentTree: 'declared-only', ordering: 'ordinal', unknownEventPolicy: 'skip',
} as const;

function adapterFor(paths: string[]): TrajectorySourceAdapter {
  return {
    id: 'codex',
    capabilities: CAPS as any,
    async *discover() {
      for (const p of paths) {
        if (!(await exists(p))) continue;
        const raw = await fs.readFile(p, 'utf8');
        const first = JSON.parse(raw.slice(0, raw.indexOf('\n')));
        yield {
          source: 'codex', sessionId: first.payload.session_id, path: p,
          cwd: first.payload.cwd, revision: 'r' + (await fs.stat(p)).size,
        } as SessionRef;
      }
    },
    async readAll(ref) {
      return splitLines(Buffer.from(await fs.readFile(ref.path, 'utf8'), 'utf8'));
    },
    isRelevant: () => true,
  };
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

async function count(dataDir: string): Promise<number> {
  const s = await Store.open(dataDir);
  const n = s.countSessions().codex;
  s.close();
  return n;
}

async function main() {
  const root = path.resolve('.tmp-vault-replay');
  const srcDir = path.join(root, 'codex-home');
  const dataDir = path.join(root, 'data');
  const srcFile = path.join(srcDir, 'rollout-1.jsonl');
  await fs.mkdir(srcDir, { recursive: true });

  const body = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'vanishing', cwd: '/w' } }),
    ...Array.from({ length: 5 }, (_, i) => JSON.stringify({
      type: 'response_item', ordinal: i + 1,
      payload: { type: 'message', role: 'user', content: [{ text: 'line ' + i }] },
    })),
  ].join('\n') + '\n';
  await fs.writeFile(srcFile, body);

  console.log('1) 首次 ingest（源存在）');
  await ingest({ dataDir, adapters: [adapterFor([srcFile])] });
  console.log('   store 中的 codex 会话数:', await count(dataDir));

  const vaultBytes = await fs.readFile(path.join(dataDir, 'vault', 'codex', 'vanishing', 'session.jsonl'), 'utf8');
  console.log('   vault 中保存的字节数:  ', vaultBytes.length, '(源文件完整保留 ✓)');

  console.log('\n2) 删除派生层（traces.sqlite3 + blobs）');
  for (const f of ['traces.sqlite3', 'traces.sqlite3-wal', 'traces.sqlite3-shm']) {
    await fs.rm(path.join(dataDir, f), { force: true });
  }
  await fs.rm(path.join(dataDir, 'blobs'), { recursive: true, force: true });
  console.log('   store 中的 codex 会话数:', await count(dataDir));

  console.log('\n3) 源 CLI 轮转并删除自己的日志（vault.ts 声称这正是它存在的理由）');
  await fs.rm(srcFile, { force: true });
  console.log('   源文件已删除，vault 仍持有', vaultBytes.length, '字节');

  console.log('\n4) 再次 ingest —— 能否从 vault 恢复？');
  const report = await ingest({
    dataDir,
    adapters: vaultAdapters(path.join(dataDir, 'vault')),
    noVault: true,
  });
  const recovered = await count(dataDir);
  console.log('   discovered:', report.discovered.codex ?? 0, ' ingested:', report.ingested.codex ?? 0);
  console.log('   store 中的 codex 会话数:', recovered);

  console.log('\n结论:', recovered > 0
    ? '✓ 派生层可从 vault 恢复 —— 源消失后轨迹仍然在'
    : '✗ vault 中的原始字节无法回放进 store —— 轨迹丢失，尽管字节还在磁盘上');

  await fs.rm(root, { recursive: true, force: true });
  if (recovered === 0) process.exitCode = 1;
}

main();