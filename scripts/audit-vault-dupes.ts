/**
 * One-off audit (not part of the suite): for every Codex sessionId that discover()
 * yields more than once, assert TWO things about the ingest pipeline:
 *
 *   1. the store kept the copy with the most RECORDS (the selection criterion), and
 *   2. the vault holds that very same copy — a rejected duplicate must never land in
 *      the immutable raw archive.
 *
 * Note the vault is NOT required to hold the largest file by BYTES: isRelevant() filters
 * raw lines, so a bigger file can legitimately yield fewer trajectory records. What must
 * hold is that the vault and the store agree, and that the store took the richest copy.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { codexAdapter } from '../src/sources/codex.ts';
import { normalizeCodex } from '../src/normalize/codex.ts';
import { splitLines } from '../src/sources/stableRead.ts';
import { Store } from '../src/store.ts';
import { Vault } from '../src/vault.ts';

async function main() {
  const vault = new Vault(path.resolve('data/vault'));
  const store = await Store.open(path.resolve('data'));
  const byId = new Map<string, any[]>();
  for await (const r of codexAdapter.discover()) {
    if (!byId.has(r.sessionId)) byId.set(r.sessionId, []);
    byId.get(r.sessionId)!.push(r);
  }

  let dupGroups = 0, richestOk = 0, vaultMatches = 0;
  const badRichest: string[] = [];
  const badVault: string[] = [];

  for (const [id, refs] of byId) {
    if (refs.length < 2) continue;
    dupGroups++;

    const counts: Array<{ records: number; bytes: number }> = [];
    for (const r of refs) {
      const raw = await fs.readFile(r.path, 'utf8');
      const lines = splitLines(Buffer.from(raw, 'utf8')).filter((l) => codexAdapter.isRelevant(l));
      counts.push({ records: normalizeCodex(r, lines).records.length, bytes: (await fs.stat(r.path)).size });
    }
    const maxRecords = Math.max(...counts.map((c) => c.records));
    const stored = Number(store.getSession('codex', id)?.record_count ?? -1);

    if (stored === maxRecords) richestOk++;
    else badRichest.push(`${id}: store=${stored} maxRecords=${maxRecords} all=${JSON.stringify(counts)}`);

    // The vault must hold one of the copies that produced exactly that record count.
    let vs = -1;
    try { vs = (await fs.stat(vault.dataPath('codex', id))).size; } catch { /* absent */ }
    const accepted = counts.filter((c) => c.records === stored).map((c) => c.bytes);
    if (accepted.includes(vs)) vaultMatches++;
    else badVault.push(`${id}: vaultBytes=${vs} acceptedCopyBytes=[${accepted}] all=${JSON.stringify(counts)}`);
  }

  store.close();
  console.log('同一 sessionId 被发现多次的组数:', dupGroups);
  console.log('store 取到记录数最多的副本:  ', richestOk, '/', dupGroups);
  console.log('vault 与 store 采用的副本一致:', vaultMatches, '/', dupGroups);
  for (const l of badRichest.slice(0, 5)) console.log('  ✗ richest:', l);
  for (const l of badVault.slice(0, 5)) console.log('  ✗ vault  :', l);
  if (badRichest.length || badVault.length) process.exitCode = 1;
}

main();