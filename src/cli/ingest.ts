#!/usr/bin/env node
/** CLI: `npm run ingest -- [options]` */
import { promises as fs } from 'node:fs';
import { ingest } from '../ingest.ts';
import type { SourceId } from '../types.ts';

interface Opts { dataDir: string; sources: SourceId[]; limit?: number; noVault: boolean; force: boolean; strategy: 'full-copy' | 'incremental-append'; }

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    dataDir: './data', sources: ['codex', 'claude-code', 'dsh'],
    noVault: false, force: false, strategy: 'full-copy',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') o.dataDir = argv[++i];
    else if (a === '--sources') o.sources = argv[++i].split(',') as SourceId[];
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--no-vault') o.noVault = true;
    else if (a === '--force') o.force = true;
    else if (a === '--copy-strategy') o.strategy = argv[++i] as Opts['strategy'];
    else if (a === '--help' || a === '-h') {
      console.log('usage: npm run ingest -- [--data-dir DIR] [--sources codex,claude-code,dsh] [--limit N] [--no-vault] [--force] [--copy-strategy full-copy|incremental-append]');
      process.exit(0);
    }
  }
  return o;
}

/** Fingerprint the source roots so read-only can be asserted (acceptance A6). */
async function fingerprint(roots: string[]): Promise<string> {
  const parts: string[] = [];
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: any[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = dir + '/' + e.name;
        if (e.isDirectory()) { stack.push(p); continue; }
        try {
          const st = await fs.stat(p);
          parts.push(p + ':' + st.size + ':' + st.mtimeMs);
        } catch { /* ignore */ }
      }
    }
  }
  parts.sort();
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

const opts = parseArgs(process.argv.slice(2));
const home = process.env.HOME ?? '';
console.log('trajview ingest');
console.log('  data-dir: ' + opts.dataDir);
console.log('  sources : ' + opts.sources.join(', '));

const roots = [home + '/.codex', home + '/.claude', home + '/.dsh'];
console.log('fingerprinting sources (read-only assertion)...');
const before = await fingerprint(roots);

const report = await ingest({
  dataDir: opts.dataDir,
  sources: opts.sources,
  limitPerSource: opts.limit,
  noVault: opts.noVault,
  copyStrategy: opts.strategy,
  force: opts.force,
  onProgress: (m) => console.log(m),
});

const after = await fingerprint(roots);
console.log('\nresult:');
console.log('  elapsed        : ' + report.elapsedMs + 'ms');
console.log('  records/source : ' + JSON.stringify(report.records));
console.log('  dsh refusals   : ' + report.refusals.length + (report.refusals.length ? ' (unknown non-ignorable event types)' : ''));
console.log('  errors         : ' + report.errors.length);
for (const e of report.errors.slice(0, 10)) console.log('    - ' + e.source + '/' + e.sessionId + ': ' + e.message);

// A live Codex/Claude session appends to its own log WHILE we read it, so a whole-tree
// fingerprint always moves. That makes this signal informational only. The deterministic
// read-only proof is tests/readonly.test.ts, which ingests frozen fixtures and compares
// their bytes before/after.
console.log('\nsource-tree fingerprint: ' + (before === after ? 'unchanged' : 'changed'));
console.log('  (informational: a live agent appends to its own log during this run)');
console.log('  deterministic read-only proof: npm test -- readonly');
