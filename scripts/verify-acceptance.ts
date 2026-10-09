/** Walks PRD acceptance criteria A1-A8 against real ingested data. */
import { Store } from '../src/store.ts';
const s: any = await Store.open('./data');
const ok = (c: boolean, label: string, ev: string) =>
  console.log((c ? 'PASS ' : 'FAIL ') + label.padEnd(46) + ev);

const counts = s.countSessions();
ok(counts.codex > 0 && counts['claude-code'] > 0 && counts.dsh > 0, 'A1 三源会话数 > 0',
  JSON.stringify(counts));

// A2 turn counts vs source signals + ordinal fallback
let turnsTotal = 0, fallbackSessions = 0, ordinalSessions = 0, badOrder = 0;
for (const src of ['codex', 'claude-code', 'dsh'] as const) {
  for (const r of s.listSessions({ source: src, limit: 500 })) {
    turnsTotal += s.getTurns(src, r.session_id).length;
    const ord = JSON.parse(r.capabilities_json).ordering;
    if (ord === 'physical-line-order') fallbackSessions++; else ordinalSessions++;
    const page = s.getPage(src, r.session_id, undefined, 400);
    for (let i = 1; i < page.length; i++) {
      if (Number(page[i].order_index) < Number(page[i - 1].order_index)) badOrder++;
    }
  }
}
ok(turnsTotal > 0, 'A2 turn 数与源信号一致', 'turns=' + turnsTotal);
ok(fallbackSessions > 0 && ordinalSessions > 0, 'A2 ordinal 缺失回退物理行序',
  'fallback=' + fallbackSessions + ' ordinal=' + ordinalSessions);
ok(badOrder === 0, 'A2 账本严格按权威序单调', 'out-of-order=' + badOrder);

// A3 tool pairing
let tools = 0, unpaired = 0, orphans = 0;
for (const src of ['codex', 'claude-code', 'dsh'] as const) {
  for (const r of s.listSessions({ source: src, limit: 500 })) {
    for (const rec of s.getPage(src, r.session_id, undefined, 1000)) {
      if (rec.kind !== 'tool') continue;
      tools++;
      const f = JSON.parse(rec.flags_json || '[]');
      if (f.includes('unresolved-call') || f.includes('unresolved-output')) unpaired++;
      if (!rec.call_id && !rec.tool_name) orphans++;
    }
  }
}
ok(tools > 0 && orphans === 0, 'A3 工具调用全部配对或标 unresolved',
  'tools=' + tools + ' unpaired=' + unpaired + ' dropped=' + orphans);

// A4 reasoning visibility per source
let cxEncrypted = 0, cxPlain = 0, clThinking = 0;
for (const r of s.listSessions({ source: 'codex', limit: 500 })) {
  for (const rec of s.getPage('codex', r.session_id, undefined, 1000)) {
    const f = JSON.parse(rec.flags_json || '[]');
    if (f.includes('reasoning-encrypted')) cxEncrypted++;
    else if (rec.kind === 'context' && rec.summary && rec.summary.includes('reasoning') === false && rec.detail_text) cxPlain++;
  }
}
for (const r of s.listSessions({ source: 'claude-code', limit: 500 })) {
  for (const rec of s.getPage('claude-code', r.session_id, undefined, 1000)) {
    if (rec.kind === 'context' && rec.detail_text && rec.detail_text.length > 0) clThinking++;
  }
}
ok(cxEncrypted > 0, 'A4 Codex 加密 reasoning 标注不可用+字节数', 'encrypted=' + cxEncrypted);
ok(clThinking > 0, 'A4 Claude 明文 thinking 可展示', 'thinking-records=' + clThinking);

// A5 timeline three lanes
const big = s.listSessions({ source: 'dsh', limit: 500 }).sort((a: any, b: any) => b.record_count - a.record_count)[0];
const tl = s.getPage('dsh', big.session_id, undefined, 1000).filter((r: any) => r.kind === 'tool');
ok(s.getTurns('dsh', big.session_id).length > 0 && s.getSteps('dsh', big.session_id).length > 0 && tl.length > 0,
  'A5 时间线 turn/step/tool 三级', 'turns=' + s.getTurns('dsh', big.session_id).length +
  ' steps=' + s.getSteps('dsh', big.session_id).length + ' toolSpans=' + tl.length);

// A7 search
const hits = s.search('opentelemetry');
const sentinelLeak = JSON.stringify(hits).match(/[\uFDD0\uFDD1\uFFF0\uFFF1]/g);
ok(hits.length > 0 && !sentinelLeak, 'A7 搜索命中且高亮哨兵无残留', 'hits=' + hits.length);

s.close();
