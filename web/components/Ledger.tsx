import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDur, fmtTime, splitToolLabel, type RecordRow, type SessionRow, type StepRow, type TurnRow } from '../lib/api';

/**
 * Display number for a turn/step. DSH writes `turn: 1, step: 1` and restarts the step
 * counter inside every turn, so the source's own number is authoritative — the internal
 * indices are flat per-session counters and would read "第 2 轮 · 第 8 步" for what DSH
 * calls turn 2 / step 1. Sources that declare no numbering fall back to 1-based derived.
 */
const turnNo = (idx: number, id?: string) => id ?? String(idx + 1);
const stepNo = (idx: number, id?: string) => id ?? String(idx + 1);

const PAGE = 200;
const ROW_H = 26;
const OVERSCAN = 8;

/**
 * Largest row index whose top offset is <= `y`. `tops` is the prefix-sum array built in
 * the Ledger, so `tops[i]` is the pixel offset of row `i` and `tops[i+1] - tops[i]` is
 * its height. Binary search because the list can hold thousands of rows and this runs
 * on every scroll event.
 */
function rowAt(tops: number[], y: number): number {
  let lo = 0, hi = Math.max(0, tops.length - 1);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Pixel offset of row `idx`, for the timeline's jump-to-record scroll target. */
function offsetOf(rows: RowModel[], idx: number): number {
  let y = 0;
  for (let i = 0; i < idx && i < rows.length; i++) y += rows[i].height;
  return y;
}

/**
 * Tail-first, virtualized trajectory ledger.
 * Opens at the newest records; "load earlier" prepends without disturbing the tail.
 */
export function Ledger({ session, selected, onSelect, jumpTo, onJumpDone, inspectorClosed, onOpenInspector }:
  { session: SessionRow; selected: string | null; onSelect: (rec: RecordRow | null) => void
    /** Set by a timeline click: scroll this record into view. */
    jumpTo?: string | null; onJumpDone?: () => void
    /** Show the "详情" affordance while the inspector panel is collapsed. */
    inspectorClosed?: boolean; onOpenInspector?: () => void }) {
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [bounds, setBounds] = useState<{ turns: TurnRow[]; steps: StepRow[] }>({ turns: [], steps: [] });
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [scrollTop, setScrollTop] = useState(0);
  const [follow, setFollow] = useState(true);
  const [loadingAll, setLoadingAll] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const loadedFor = useRef<string>('');

  const key = session.source + ':' + session.sessionId;

  useEffect(() => {
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    setRecords([]); setHasMore(false); setCursor(undefined); setFollow(true);
    setBounds({ turns: [], steps: [] });
    setScrollTop(0);
    // Turns/steps carry the SOURCE turn/step numbers, which the separators display.
    api.session(session.source, session.sessionId)
      .then((s) => setBounds({ turns: s.turns ?? [], steps: s.steps ?? [] }))
      .catch(() => {});
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

  /**
   * Jump to the FIRST record: drain every remaining earlier page, then scroll to the top.
   *
   * Scrolling alone would land on the oldest record currently loaded (200 of 577 here),
   * not the beginning of the session. Pages are fetched in a loop rather than through
   * `loadEarlier` because each call reads `cursor` from state, which has not updated yet
   * mid-loop.
   */
  const toTop = useCallback(async () => {
    if (loadingAll) return;
    const el = boxRef.current;
    if (!hasMore || cursor === undefined) { if (el) el.scrollTop = 0; return; }

    setLoadingAll(true);
    // Stop following BEFORE the records land, or the tail-pin effect below would yank
    // the view straight back down once the list grows.
    setFollow(false);
    try {
      let cur: number | undefined = cursor;
      let more = true;
      let collected: RecordRow[] = [];
      // Hard ceiling so a pathological session cannot spin forever (50 * 200 = 10k rows).
      for (let i = 0; i < 50 && more && cur !== undefined; i++) {
        const r = await api.records(session.source, session.sessionId, cur, PAGE);
        collected = [...r.records, ...collected];
        more = r.hasMore;
        cur = r.nextBefore;
        if (r.records.length === 0) break;
      }
      if (collected.length) setRecords((prev) => [...collected, ...prev]);
      setHasMore(more);
      setCursor(cur);
      setScrollTop(0);
      const box = boxRef.current;
      if (box) box.scrollTop = 0;
    } finally {
      setLoadingAll(false);
    }
  }, [cursor, hasMore, loadingAll, session.source, session.sessionId]);

  /**
   * Timeline block → this row. Records arrive tail-first, so the target may sit in a page
   * that was never fetched: drain earlier pages until it appears, then centre it.
   *
   * The effect deliberately does NOT re-run on `records` — `buildRows` interleaves turn
   * and step separators, so `rows` is rebuilt on every page load and re-running on it
   * would re-scroll the list out from under the user mid-load.
   */
  const jumpRef = useRef<string | null>(null);
  jumpRef.current = jumpTo ?? null;
  useEffect(() => {
    if (!jumpTo) return;
    let cancelled = false;

    (async () => {
      let recs = records;
      let cur = cursor;
      let more = hasMore;
      // Bounded like toTop: 50 * 200 = 10k rows is far past any realistic target.
      for (let i = 0; i < 50 && !recs.some((r) => r.recordId === jumpTo) && more && cur !== undefined; i++) {
        const r = await api.records(session.source, session.sessionId, cur, PAGE);
        if (cancelled) return;
        recs = [...r.records, ...recs];
        more = r.hasMore;
        cur = r.nextBefore;
      }
      if (cancelled) return;
      if (recs.length !== records.length) {
        setRecords(recs); setHasMore(more); setCursor(cur);
      }

      const built = buildRows(recs, bounds.turns, bounds.steps);
      // Every record has a row of its own, so a timeline click lands directly on it.
      const idx = built.findIndex((r) => r.record?.recordId === jumpTo);
      if (idx < 0) { onJumpDone?.(); return; }
      // Land it a little above centre so the rows above it give context.
      // Sum the heights rather than multiplying, so this keeps working if rows ever vary.
      const target = Math.max(0, offsetOf(built, idx) - viewport / 3);
      setFollow(false);
      setScrollTop(target);
      const el = boxRef.current;
      if (el) el.scrollTop = target;
      onJumpDone?.();
    })().catch(() => onJumpDone?.());

    return () => { cancelled = true; };
    // Intentionally keyed on `jumpTo` alone; see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  // Pin to the tail on first load.
  useEffect(() => {
    const el = boxRef.current;
    if (el && follow && records.length) el.scrollTop = el.scrollHeight;
  }, [records.length, follow]);

  const rows = useMemo(
    () => buildRows(records, bounds.turns, bounds.steps),
    [records, bounds, session.source]);
  const total = rows.length;
  const viewport = boxRef.current?.clientHeight ?? 600;
  // Prefix sums, because a row carrying folded tools is one chip-line taller than the
  // rest: `index * ROW_H` no longer gives the offset of row `index`.
  const tops = useMemo(() => {
    const a = new Array<number>(rows.length + 1);
    a[0] = 0;
    for (let i = 0; i < rows.length; i++) a[i + 1] = a[i] + rows[i].height;
    return a;
  }, [rows]);
  const totalH = tops[rows.length] ?? 0;
  const first = Math.max(0, rowAt(tops, scrollTop) - OVERSCAN);
  const last = Math.min(total, rowAt(tops, scrollTop + viewport) + 1 + OVERSCAN);
  const slice = rows.slice(first, last);

  return (
    <section className="ledger">
      <div className="ledger-head">
        <h3>轨迹账本</h3>
        <span className="muted">{records.length} / {session.recordCount} 条</span>
        {follow
          ? <span className="live">跟随尾部</span>
          : <button className="link" onClick={() => { setFollow(true); const el = boxRef.current; if (el) el.scrollTop = el.scrollHeight; }}>回到尾部</button>}
        {/* Drains every earlier page first, then lands on the session's first record.
            Hidden only at the TRUE top: scrollTop 0 with pages still unloaded means the
            view sits at the head of the loaded slice, not at the session's beginning. */}
        {(scrollTop > 0 || hasMore) && (
          <button className="link" disabled={loadingAll} onClick={toTop}>
            {loadingAll ? '载入中…' : '回到顶部'}
          </button>
        )}
        {inspectorClosed && (
          <button className="link" onClick={onOpenInspector} title="展开右侧详情面板">详情 ▸</button>
        )}
      </div>

      <div className="ledger-box" ref={boxRef} onScroll={onScroll}>
        {hasMore && (
          <button className="load-earlier" onClick={loadEarlier}>载入更早 {PAGE} 条 ▲</button>
        )}
        <div style={{ height: totalH, position: 'relative' }}>
          <div style={{ position: 'absolute', top: tops[first] ?? 0, left: 0, right: 0 }}>
            {slice.map((r) => <Row key={r.rowKey} row={r}
              active={r.record?.recordId === selected}
              onSelect={onSelect} />)}
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

/**
 * Flatten records into ledger rows, inserting turn/step separators.
 *
 * Every source renders 1:1 — an assistant message is one row and each tool call is its own
 * 工具 row, exactly as DSH and Codex have always done. (Claude's tool_use used to be folded
 * into the assistant row as a chip; that made Claude the odd one out and is gone.)
 *
 * Exported for tests.
 */
export function buildRows(records: RecordRow[], turns: TurnRow[], steps: StepRow[]): RowModel[] {
  const turnIds = new Map(turns.map((t) => [t.turn_index, t.source_turn_id]));
  // step_index is a flat counter; the source restarts it per turn, so key on both.
  const stepIds = new Map(steps.map((s) => [`${s.turn_index}:${s.step_index}`, s.source_step_id]));

  const out: RowModel[] = [];
  // Separators are keyed by a running ordinal, NOT by turn/step index. Measured on session
  // 3b04bed9 (claude-code): the source's turn index goes 2 → 3 → 4 → 3 → 4 across the last
  // records, so a key derived from the index repeats 'T3' and 'T4'. React treats duplicate
  // keys as the same node and the list collapses into repeated separator rows with no
  // records between them.
  let lastTurn = -1, lastStep = -1, sep = 0;
  for (const r of records) {
    const t = r.turnIndex ?? -1, s = r.stepIndex ?? -1;
    if (t !== lastTurn) {
      out.push({ rowKey: 'T' + (sep++), height: ROW_H, kind: 'turn',
        label: `turn ${turnNo(t, turnIds.get(t))}`,
        meta: r.startedAt ? fmtTime(r.startedAt) : undefined });
      lastTurn = t; lastStep = -1;
    }
    if (s !== lastStep && s >= 0) {
      out.push({ rowKey: 'S' + (sep++), height: ROW_H, kind: 'step',
        label: `step ${stepNo(s, stepIds.get(`${t}:${s}`))}`,
        meta: r.startedAt ? fmtTime(r.startedAt) : undefined });
      lastStep = s;
    }
    out.push({ rowKey: r.recordId, height: ROW_H, kind: 'record', label: '', record: r });
  }
  return out;
}

function Row({ row, active, onSelect }: { row: RowModel; active: boolean; onSelect: (rec: RecordRow) => void }) {
  if (row.kind === 'turn' || row.kind === 'step') {
    return (
      <div className={'row sep ' + row.kind}>
        <span className="sep-label">{row.label}</span>
        {row.meta && <span className="sep-meta">{row.meta}</span>}
      </div>
    );
  }

  const r = row.record!;
  const isTool = r.kind === 'tool' || r.kind === 'subtool';
  // DSH draws a tool row as `bash {"command":…}` — name in the row's own colour, the
  // JSON object picked out in the tool colour. Rendering the raw `bash({…})` makes the
  // arguments read as part of a call expression instead of as data.
  const parts = isTool ? splitToolLabel(r.summary, r.toolName ?? undefined) : null;

  return (
    <div className={'row rec ' + r.kind + (active ? ' active' : '') + (r.isError ? ' err' : '')}
      style={{ height: row.height }} onClick={() => onSelect(r)}>
      <div className="row-line">
        <span className={'kind ' + r.kind} title={kindTitle(r.kind)}>{kindLabel(r.kind)}</span>
        <span className="idx">{r.orderIndex}</span>
        {parts && parts.args
          ? <span className="sum" title={r.summary}>
              <span className="tname">{parts.name}</span>
              <span className="targs">{parts.args}</span>
            </span>
          : <span className="sum" title={r.summary}>{r.summary || <em className="muted">(空)</em>}</span>}
        {r.usage && <span className="tok" title={usageTitle(r.usage)}>{tokLabel(r.usage)}</span>}
        {r.flags.length > 0 && <span className="flags">{r.flags.map((f) => <i key={f} title={flagTitle(f)}>{flagIcon(f)}</i>)}</span>}
        <span className="dur">{fmtDur(r.timeSeconds)}</span>
      </div>
    </div>
  );
}

/**
 * Ledger row labels, matching the DSH `ui-trajectory` vocabulary:
 * 系统 / 用户 / 上下文 are what the agent was fed, 助手 is the model's own output,
 * 工具 is tool processing. The three-lane timeline uses the same four classes.
 */
function kindLabel(k: string): string {
  switch (k) {
    case 'system': return '系统';
    case 'user': return '用户';
    case 'context': return '上下文';
    case 'compacted': return '压缩';
    case 'message': return '助手';
    case 'reasoning': return '推理';
    case 'tool': return '工具';
    case 'subtool': return '子工具';
    case 'request-header': return '请求头';
    case 'turn-end': return '轮次结束';
    case 'session-end': return '会话结束';
    default: return '记录';
  }
}
function kindTitle(k: string): string {
  const m: Record<string, string> = {
    system: '系统提示词',
    user: '用户提示词',
    context: '上下文输入（系统提醒、运行时快照、附件等注入内容）',
    compacted: '上下文压缩',
    message: '助手输出（模型的响应）',
    reasoning: '推理内容（模型的思考过程，Codex 中与助手消息分离记录）',
    tool: '工具处理',
    subtool: '子工具处理（嵌套调用）',
    'request-header': '请求头',
    'turn-end': '轮次结束标记',
    'session-end': '会话结束标记',
  };
  return m[k] ?? k;
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
