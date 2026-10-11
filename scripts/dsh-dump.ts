/**
 * Dump a DSH session log to plain JSONL.
 *
 * The physical file is a CONCATENATION OF INDEPENDENT ZSTD FRAMES, so a standard
 * decompressor only recovers the first frame. This reuses the adapter's frame walker
 * (`decodeZstdConcatenation`) so the dump matches what trajview ingested.
 *
 *   npm run dump:dsh -- <file|sessionId>          # write <file>.jsonl next to it
 *   npm run dump:dsh -- <file|sessionId> --stdout # stream to stdout
 *   npm run dump:dsh -- --list                    # list sessions under ~/.dsh
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { decodeZstdConcatenation } from '../src/sources/dsh.ts';

const DSH_HOME = process.env.TRAJVIEW_DSH_HOME ?? path.join(homedir(), '.dsh');

async function listSessions(): Promise<void> {
  const base = path.join(DSH_HOME, 'sessions');
  const projects = await fs.readdir(base).catch(() => []);
  let total = 0;
  for (const project of projects.sort()) {
    const pdir = path.join(base, project);
    const sessions = await fs.readdir(pdir).catch(() => []);
    for (const id of sessions.sort()) {
      const sdir = path.join(pdir, id);
      const files = await fs.readdir(sdir).catch(() => []);
      for (const f of files) {
        if (!f.endsWith('.jsonl.zstd') && !f.endsWith('.jsonl')) continue;
        const full = path.join(sdir, f);
        const st = await fs.stat(full);
        total++;
        console.log(`${String(st.size).padStart(10)}  ${new Date(st.mtimeMs).toISOString().slice(0, 19)}  ${full}`);
      }
    }
  }
  console.error(`\n共 ${total} 个会话文件（根目录 ${DSH_HOME}）`);
}

/** Accept either a direct file path, a bare session id, or a session id + project slug. */
async function resolve(target: string): Promise<string> {
  const direct = path.resolve(target);
  const st = await fs.stat(direct).catch(() => null);
  if (st?.isFile()) return direct;

  const base = path.join(DSH_HOME, 'sessions');
  const projects = await fs.readdir(base).catch(() => []);
  const hits: string[] = [];
  for (const project of projects) {
    const sdir = path.join(base, project, target);
    const files = await fs.readdir(sdir).catch(() => []);
    for (const f of files) {
      if (f.endsWith('.jsonl.zstd') || f.endsWith('.jsonl')) hits.push(path.join(sdir, f));
    }
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    console.error(`会话 id「${target}」在 ${hits.length} 个项目下有同名文件，请直接给完整路径：`);
    hits.forEach((h) => console.error('  ' + h));
    process.exit(1);
  }
  throw new Error(`找不到会话：${target}（可用 --list 查看全部）`);
}

const args = process.argv.slice(2);
if (args.includes('--list') || args.length === 0) {
  await listSessions();
} else {
  const toStdout = args.includes('--stdout');
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) throw new Error('缺少目标文件或 sessionId');

  const file = await resolve(target);
  const buf = await fs.readFile(file);
  const { text, frameCount, truncated } = decodeZstdConcatenation(buf);
  const lines = text.split('\n');
  // A torn trailing frame can leave a half-written final line; never emit it.
  if (lines.length && !lines[lines.length - 1]) lines.pop();
  const clean = lines.filter((l) => l.trim() !== '');
  const bad = clean.filter((l) => { try { JSON.parse(l); return false; } catch { return true; } });

  console.error(`帧数 ${frameCount}${truncated ? '（末尾有半帧，已只取已提交部分）' : ''}`);
  console.error(`行数 ${clean.length}，其中 ${bad.length} 行非合法 JSON`);

  const body = clean.join('\n') + '\n';
  if (toStdout) process.stdout.write(body);
  else {
    // NEVER write next to the source: ~/.dsh is read-only for this project.
    // Output always lands in ./dump/ under the working directory.
    const outDir = path.join(process.cwd(), 'dump');
    await fs.mkdir(outDir, { recursive: true });
    const out = path.join(outDir, path.basename(file).replace(/\.zstd$/, '') + '.jsonl');
    await fs.writeFile(out, body);
    console.error(`已写入 ${out}（${(Buffer.byteLength(body) / 1024).toFixed(1)} KB）`);
  }
}