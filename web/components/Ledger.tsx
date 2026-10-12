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
 * Head-first, virtualized trajectory ledger.
 * Opens at the session's FIRST records — the question and the context that frame the rest.
 * "Load later" appends below without disturbing the head.
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
  const [atEnd, setAtEnd] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [pendingTail, setPendingTail] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const loadedFor = useRef<string>('');
  /**
   * Which session's FIRST page has finished loading. The jump effect refuses to run until
   * this equals `key`.
   *
   * Without it, a jump into a different session raced its own page load: the reload effect
   * cleared `records` and fired a fetch, while the jump effect read the PREVIOUS session's
   * stale `records`/`cursor` and drained from there — mixing two sessions' rows. Whichever
   * promise settled last then won, so the drained pages (and the scroll target computed from
   * them) were discarded and the ledger sat wherever it landed.
   */
  const [readyKey, setReadyKey] = useState('');

  const key = session.source + ':' + session.sessionId;

  useEffect(() => {
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    setRecords([]); setHasMore(false); setCursor(undefined); setAtEnd(false);
    setBounds({ turns: [], steps: [] });
    setScrollTop(0);
    setPendingTail(false);
    // Turns/steps carry the SOURCE turn/step numbers, which the separators display.
    api.session(session.source, session.sessionId)
      .then((s) => setBounds({ turns: s.turns ?? [], steps: s.steps ?? [] }))
      .catch(() => {});
    // Head-first: no cursor means the OLDEST records, so the list opens at the top.
    api.recordsAfter(session.source, session.sessionId, undefined, PAGE)
      .then((r) => {
        setRecords(r.records); setHasMore(r.hasMore); setCursor(r.nextAfter ?? undefined);
        // Publish readiness only for the session that actually landed.
        setReadyKey((prev) => (prev === key ? prev : key));
      })
      .catch(() => setReadyKey((prev) => (prev === key ? prev : key)));
  }, [key, session.source, session.sessionId]);

  /** Append the next page below the loaded slice. */
  const loadLater = useCallback(() => {
    if (!hasMore || cursor === undefined) return;
    api.recordsAfter(session.source, session.sessionId, cursor, PAGE).then((r) => {
      setRecords((prev) => [...prev, ...r.records]);
      setHasMore(r.hasMore);
      setCursor(r.nextAfter ?? undefined);
    });
  }, [cursor, hasMore, session.source, session.sessionId]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    // "At the end" is the newest LOADED record, which is what growing the list below anchors
    // to — the mirror of the old tail-first `follow` flag.
    setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  /**
   * Jump to the session's first record.
   *
   * Head-first loading makes this a plain scroll reset: the oldest records are the ones
   * already loaded. It used to have to drain every earlier page out of the tail-first layout,
   * because there the top of the loaded slice was the middle of the session.
   */
  const toTop = useCallback(() => {
    setScrollTop(0);
    const el = boxRef.current;
    if (el) el.scrollTop = 0;
  }, []);

  /**
   * Jump to the session's LAST record — the mirror of toTop.
   *
   * Kept even though the list now opens at the top: a session that is still running has its
   * newest output at the end, and head-first paging puts those pages out of reach. Without
   * this the only way to follow a live trajectory is scrolling page by page.
   *
   * Pages are drained in a loop rather than through `loadLater` because each call reads
   * `cursor` from state, which has not updated yet mid-loop.
   */
  const toTail = useCallback(async () => {
    if (loadingAll) return;
    const el = boxRef.current;
    if (!hasMore || cursor === undefined) {
      if (el) el.scrollTop = el.scrollHeight;
      setScrollTop(el?.scrollTop ?? 0);
      setAtEnd(true);
      return;
    }

    setLoadingAll(true);
    try {
      let cur: number | undefined = cursor;
      let more = true;
      const collected: RecordRow[] = [];
      // Ceiling so a pathological session cannot spin forever (50 * 200 = 10k rows).
      for (let i = 0; i < 50 && more && cur !== undefined; i++) {
        const r = await api.recordsAfter(session.source, session.sessionId, cur, PAGE);
        collected.push(...r.records);
        more = r.hasMore;
        cur = r.nextAfter ?? undefined;
        if (r.records.length === 0) break;
      }
      if (collected.length) setRecords((prev) => [...prev, ...collected]);
      setHasMore(more);
      setCursor(cur);
      setAtEnd(true);
      // Scroll AFTER the rows render: the target offset depends on the full page sum, which
      // does not exist until the new records are laid out.
      setPendingTail(true);
    } finally {
      setLoadingAll(false);
    }
  }, [cursor, hasMore, loadingAll, session.source, session.sessionId]);

  /**
   * Pin to the bottom once the drained pages are laid out.
   *
   * Reading `scrollHeight` before the render would land on the OLD bottom, which is the top
   * of the freshly appended block — the exact bug a direct `scrollTop = scrollHeight` inside
   * the same tick has.
   */
  useEffect(() => {
    if (!pendingTail || !records.length) return;
    const el = boxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
    setPendingTail(false);
  }, [pendingTail, records]);

  /**
   * Timeline block → this row. Records arrive head-first, so the target may sit in a page
   * that was never fetched: drain LATER pages until it appears, then centre it.
   *
   * Gated on `readyKey === key` — a jump issued in the same batch as a session switch must
   * wait for THAT session's first page, or it drains from the outgoing session's cursor.
   *
   * The effect deliberately does NOT re-run on `records` — `buildRows` interleaves turn
   * and step separators, so `rows` is rebuilt on every page load and re-running on it
   * would re-scroll the list out from under the user mid-load. `readyKey` is the one extra
   * dependency: it changes exactly once per session load, which is the moment the records
   * this closure reads become current.
   */
  useEffect(() => {
    if (!jumpTo) return;
    if (readyKey !== key) return;
    let cancelled = false;

    (async () => {
      let recs = records;
      let cur = cursor;
      let more = hasMore;
      // Bounded: 50 * 200 = 10k rows is far past any realistic target.
      for (let i = 0; i < 50 && !recs.some((r) => r.recordId === jumpTo) && more && cur !== undefined; i++) {
        const r = await api.recordsAfter(session.source, session.sessionId, cur, PAGE);
        if (cancelled) return;
        recs = [...recs, ...r.records];
        more = r.hasMore;
        cur = r.nextAfter ?? undefined;
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
      setScrollTop(target);
      const el = boxRef.current;
      if (el) el.scrollTop = target;
      onJumpDone?.();
    })().catch(() => onJumpDone?.());

    return () => { cancelled = true; };
    // `records`/`cursor`/`bounds`/`viewport` are deliberately omitted (see above);
    // `readyKey` and `key` are included because they decide WHEN this runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo, readyKey, key]);

  // Open at the head: the browser restores a previous scroll offset when the same element
  // is reused across sessions, and this list must always start at the session's first record.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !records.length) return;
    if (scrollTop > 0) return; // the user has moved; never yank them back
    el.scrollTop = 0;
  }, [records.length, scrollTop]);

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
        {/* Only a status here — the "load later" control lives at the BOTTOM of the list,
            where the unread records are. Duplicating it in the header put two identical
            buttons on screen at once. */}
        {atEnd
          ? <span className="live">已到最新</span>
          : hasMore
            ? <span className="muted">向下滚动载入更多</span>
            : <span className="muted">已全部载入</span>}
        {/* Head-first: scrollTop 0 IS the session's beginning, so this is just a reset. */}
        {scrollTop > 0 && (
          <button className="link" onClick={toTop}>回到顶部</button>
        )}
        {/* Still needed: a running session's newest output lives at the end, and head-first
            paging puts it out of reach without this. */}
        {!atEnd && (
          <button className="link" disabled={loadingAll} onClick={() => void toTail()}
            title="载入剩余记录并跳到最后一条">
            {loadingAll ? '载入中…' : '回到尾部'}
          </button>
        )}
        {inspectorClosed && (
          <button className="link" onClick={onOpenInspector} title="展开右侧详情面板">详情 ▸</button>
        )}
      </div>

      <div className="ledger-box" ref={boxRef} onScroll={onScroll}>
        {/* Head-first, so "more" is BELOW the loaded slice, not above it. */}
        {hasMore && (
          <button className="load-later" onClick={loadLater}>载入后续 {PAGE} 条 ▾</button>
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
    case 'hook': return '钩子';
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
    hook: '钩子注入（生命周期钩子向对话写入的文本；钩子脚本自身的执行不在轨迹中）',
    'request-header': '请求头',
    'turn-end': '轮次结束标记',
    'session-end': '会话结束标记',
  };
  return m[k] ?? k;
}
function flagIcon(f: string): string {
  if (f === 'unresolved-call' || f === 'unresolved-output') return '⚠';
  if (f === 'hook-injected') return '⚓';
  if (f === 'hook-triggered') return '↳';
  if (f === 'missing-arguments') return '⚡';
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
    'missing-arguments': '上游未产出该调用的参数，且工具层报参数解析失败（参数已丢失，不可恢复）',
    'hook-injected': '生命周期钩子向对话注入了文本（钩子脚本自身的执行不留痕）',
    'hook-triggered': '这是模型对上一条钩子注入的首次工具响应',
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
