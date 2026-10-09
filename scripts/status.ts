import { Store } from '../src/store.ts';
const s: any = await Store.open('./data');
const q = (sql: string) => s.db.prepare(sql).get() as any;
console.log('sessions :', JSON.stringify(s.countSessions()));
console.log('records  :', q('SELECT count(*) c FROM records').c);
console.log('turns    :', q('SELECT count(*) c FROM turns').c);
console.log('steps    :', q('SELECT count(*) c FROM steps').c);
console.log('tool recs:', q("SELECT count(*) c FROM records WHERE kind='tool'").c);
console.log('unresolved:', q("SELECT count(*) c FROM records WHERE flags_json LIKE '%unresolved%'").c);
console.log('shadowed :', q("SELECT count(*) c FROM records WHERE flags_json LIKE '%shadowed%'").c);
console.log('fts rows :', q('SELECT count(*) c FROM records_fts').c);
console.log('by source:');
for (const r of s.db.prepare("SELECT source, count(*) n, sum(record_count) rec FROM sessions GROUP BY source").all() as any[]) {
  console.log('  ', r.source.padEnd(12), 'sessions=' + String(r.n).padEnd(4), 'records=' + r.rec);
}
s.close();
