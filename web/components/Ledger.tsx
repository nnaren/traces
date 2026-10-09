import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDur, fmtTime, type RecordRow, type SessionRow } from '../lib/api';

const PAGE = 200;
const ROW_H = 26;
const OVERSCAN = 8;

/**
 * Tail-first, virtualized trajectory ledger.
 * Opens at the newest records; "load earlier" prepends without disturbing the tail.
 */
export function Ledger({ session, selected, onSelect }:
  { session: SessionRow; selected: string | null; onSelect: (id: string | null) => void }) {
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [scrollTop, setScrollTop] = useState(0);
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const loadedFor = useRef<string>('');

  const key = session.source + ':' + session.sessionId;

  useEffect(() => {
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    setRecords([]); setHasMore(false); setCursor(undefined); setFollow(true);
    setScrollTop(0);
    api.records(session.source, session.sessionId, undefined, PAGE)
      .then((r) => { setRecords(r.records); setHasMore(r.hasMore); setCursor(r.nextBefore); })
      .catch(() => {});
  }, [key, session.source, session.sessionId]);

  const loadEarlier = useCallback(() => {
    if (!hasMore || cursor === undefined) return;
    api.records(session.source, session.sessionId, cursor, PAGE).then((r) => {
      setRecords((prev) => [...r.records, ...prev]);
      setHasMore(r.hasMore);
      setCursor(r.nextBefore);
    });
  }, [cursor, hasMore, session.source, session.sessionId]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(atBottom);
  };

  // Pin to the tail on first load.
  useEffect(() => {
    const el = boxRef.current;
    if (el && follow && records.length) el.scrollTop = el.scrollHeight;
  }, [records.length, follow]);

  const rows = useMemo(() => buildRows(records), [records]);
  const total = rows.length;
  const viewport = boxRef.current?.clientHeight ?? 600;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN);
  const slice = rows.slice(first, last);

  return (
    <section className="ledger">
      <div className="ledger-head">
        <h3>轨迹账本</h3>
        <span className="muted">{records.length} / {session.recordCount} 条</span>
        {follow
          ? <span className="live">跟随尾部</span>
          : <button className="link" onClick={() => { setFollow(true); const el = boxRef.current; if (el) el.scrollTop = el.scrollHeight; }}>回到尾部</button>}
      </div>

      <div className="ledger-box" ref={boxRef} onScroll={onScroll}>
        {hasMore && (
          <button className="load-earlier" onClick={loadEarlier}>载入更早 {PAGE} 条 ▲</button>
        )}
        <div style={{ height: total * ROW_H, position: 'relative' }}>
          <div style={{ position: 'absolute', top: first * ROW_H, left: 0, right: 0 }}>
            {slice.map((r) => <Row key={r.rowKey} row={r} active={r.record?.recordId === selected} onSelect={onSelect} />)}
          </div>
        </div>
        {total === 0 && <div className="empty">该会话没有记录</div>}
      </div>
    </section>
  );
}

interface RowModel {
  rowKey: string; height: number;
  kind: 'turn' | 'step' | 'record';
  label: string; record?: RecordRow; meta?: string;
}

function buildRows(records: RecordRow[]): RowModel[] {
  const out: RowModel[] = [];
  let lastTurn = -1, lastStep = -1;
  for (const r of records) {
    const t = r.turnIndex ?? -1, s = r.stepIndex ?? -1;
    if (t !== lastTurn) {
      out.push({ rowKey: 'T' + t, height: ROW_H, kind: 'turn', label: `turn ${t}`, meta: r.startedAt ? fmtTime(r.startedAt) : undefined });
      lastTurn = t; lastStep = -1;
    }
    if (s !== lastStep && s >= 0) {
      out.push({ rowKey: 'S' + t + '-' + s, height: ROW_H, kind: 'step', label: `step ${s}`, meta: r.startedAt ? fmtTime(r.startedAt) : undefined });
      lastStep = s;
    }
    out.push({ rowKey: r.recordId, height: ROW_H, kind: 'record', label: '', record: r });
  }
  return out;
}

function Row({ row, active, onSelect }: { row: RowModel; active: boolean; onSelect: (id: string) => void }) {
  if (row.kind === 'turn' || row.kind === 'step') {
    return (
      <div className={'row sep ' + row.kind}>
        <span className="sep-label">{row.label}</span>
        {row.meta && <span className="sep-meta">{row.meta}</span>}
      </div>
    );
  }
  const r = row.record!;
  return (
    <div className={'row rec ' + r.kind + (active ? ' active' : '') + (r.isError ? ' err' : '')}
      style={{ height: ROW_H }} onClick={() => onSelect(r.recordId)}>
      <span className={'kind ' + r.kind}>{kindIcon(r.kind)}</span>
      <span className="idx">{r.orderIndex}</span>
      <span className="sum" title={r.summary}>{r.summary || <em className="muted">(空)</em>}</span>
      {r.usage && <span className="tok" title={usageTitle(r.usage)}>{tokLabel(r.usage)}</span>}
      {r.flags.length > 0 && <span className="flags">{r.flags.map((f) => <i key={f} title={flagTitle(f)}>{flagIcon(f)}</i>)}</span>}
      <span className="dur">{fmtDur(r.timeSeconds)}</span>
    </div>
  );
}

function kindIcon(k: string): string {
  switch (k) {
    case 'user': return '▸';
    case 'message': return '◆';
    case 'context': return '≡';
    case 'tool': case 'subtool': return '⚙';
    case 'compacted': return '⇲';
    case 'turn-end': return '■';
    case 'request-header': return '⎔';
    default: return '·';
  }
}
function flagIcon(f: string): string {
  if (f === 'unresolved-call' || f === 'unresolved-output') return '⚠';
  if (f === 'reasoning-encrypted') return '🔒';
  if (f === 'partial' || f === 'running') return '◌';
  if (f === 'shadowed') return '◑';
  if (f === 'usage-missing' || f === 'ttft-missing') return '∅';
  return '•';
}
function flagTitle(f: string): string {
  const m: Record<string, string> = {
    'unresolved-call': '工具调用没有结果（孤儿 call，已保留未丢弃）',
    'unresolved-output': '工具结果没有对应调用（孤儿 output）',
    'reasoning-encrypted': '思维链已加密，无法展示内容',
    partial: '未正常结束', running: '进行中', shadowed: '被 surfaceOp.replace 遮蔽（仍保留）',
    'usage-missing': '来源未记录 usage', 'ttft-missing': '来源未记录 TTFT',
  };
  return m[f] ?? f;
}
function tokLabel(u: any): string {
  if (u.totalTokens == null) return 'tok —';
  const c = u.cachedInputTokens ? ' ·c' + u.cachedInputTokens : '';
  return `tok ${u.totalTokens}${c}`;
}
function usageTitle(u: any): string {
  return [
    'scope=' + u.scope, 'cache=' + u.cacheSemantics,
    'in=' + (u.inputTokens ?? '—'), 'cached=' + (u.cachedInputTokens ?? '—'),
    'cacheWrite=' + (u.cacheWriteInputTokens ?? '—'), 'out=' + (u.outputTokens ?? '—'),
    'reasoning=' + (u.reasoningTokens ?? '—'), 'total=' + (u.totalTokens ?? '—'),
    'crossSourceComparable=' + u.crossSourceComparable,
  ].join('\n');
}
