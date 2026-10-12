import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDur, type SourceId, type RecordRow, type TimelineSpan } from '../lib/api';

/**
 * Three-lane timing overview, following the DSH `ui-trajectory` scheme: lanes are
 * assigned by activity class, not by the turn/step hierarchy.
 *
 *   输入  用户的输入与上下文输入   records kind = user / context / compacted
 *   模型  模型处理（一次调用一条）  `steps` rows — a step IS one model call
 *   工具  工具处理                 records kind = tool / subtool
 *
 * Two projections (DSH has the same pair, and defaults to the first):
 *   等长  every block is one unit wide, laid out in chronological order — dense and
 *         always readable, but block width carries no duration meaning
 *   比例  block width is real elapsed time on a shared clock
 *
 * Duration is never invented: a record with no recorded elapsed time renders as a
 * start marker only. Turn edges keep their explicit/derived provenance so a derived
 * edge never masquerades as a logged one.
 */
const LANES = [
  { key: 'in', name: '输入' },
  { key: 'model', name: '模型' },
  { key: 'tool', name: '工具' },
] as const;

type LaneIndex = 0 | 1 | 2;

/**
 * Lane assignment by record kind (DSH's `laneFor`).
 *
 * 输入 = what the agent was fed (system / user / context / compacted).
 * 模型 = the model's own output. `message` and `reasoning` are both model output but
 *        neither reaches this function today: the server keeps them out of `spans`
 *        precisely so the 模型 lane can be drawn from `steps` (one block per model
 *        call) instead of double-rendering each call twice.
 * 工具 = tool processing.
 */
function laneFor(kind: string): LaneIndex {
  if (kind === 'tool' || kind === 'subtool') return 2;
  if (kind === 'message' || kind === 'reasoning') return 1;
  // A hook injection is neither the user's input nor the model's output: an external rule
  // spoke between them. 输入 is the honest lane — it is what the model was fed, and what it
  // then reacted to.
  if (kind === 'hook') return 0;
  return 0;
}

/**
 * Display number for a turn/step. DSH writes `turn: 1, step: 1` and RESTARTS the step
 * counter inside every turn, so its own number is authoritative; the flat per-session
 * index would read "步 8" for what DSH calls turn 2 / step 1.
 */
const turnNo = (idx: number, id?: string) => id ?? String(idx + 1);
const stepNo = (idx: number, id?: string) => id ?? String(idx + 1);

const clock = (t: number | null): string => (t == null ? '—' : new Date(t).toLocaleTimeString());

interface Span {
  key: string;
  lane: LaneIndex;
  kind: string;
  /** Ledger record this span stands for, used to match the selected row. */
  recordId?: string;
  turnIndex?: number;
  stepIndex?: number;
  /** Authoritative ledger position; the timeline orders by this, never by timestamp. */
  order: number;
  from: number;
  /** null ⇒ no recorded end time. Rendered as a start marker, never given a width. */
  to: number | null;
  /** 0..1 fraction of the span consumed by TTFT; only meaningful when `to` is known. */
  ttft: number | null;
  label: string;
  err: boolean;
  conf: string;
}

interface Edge {
  t: number;
  conf: string;
  scope: 'turn' | 'step';
  edge: 'start' | 'end';
  id: number;
  /** The source's own number, authoritative when present. */
  label: string;
}

export function Timeline({ source, sessionId, selected, onJump }: {
  source: SourceId; sessionId: string; selected: RecordRow | null;
  /** Click a block to bring its ledger row into view. */
  onJump?: (recordId: string) => void;
}) {
  const [data, setData] = useState<{ turns: any[]; steps: any[]; spans: TimelineSpan[] } | null>(null);
  const [mode, setMode] = useState<'span' | 'time'>('span');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(0);
  const [sel, setSel] = useState<{ from: number; to: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  // Horizontal offset, in px. Kept out of CSS scrollTop so the track keeps `overflow:hidden`
  // and shows no scrollbar — the right-drag gesture below is the only way to move.
  const [scrollX, setScrollX] = useState(0);
  const [trackW, setTrackW] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef(0);
  scrollRef.current = scrollX;

  // Track width drives how much room each record gets. Without it a 569-record session
  // would divide ~1100px into sub-pixel cells and render as a grey smear.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => setTrackW(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  useEffect(() => {
    setData(null); setZoom(1); setPan(0); setSel(null); setScrollX(0);
    api.timeline(source, sessionId).then(setData).catch(() => {});
  }, [source, sessionId]);

  /** 输入 / 模型 / 工具 collapsed into one lane-addressed, time-ordered span list. */
  const spans = useMemo<Span[]>(() => {
    if (!data) return [];
    const out: Span[] = [];

    for (const s of data.spans) {
      if (s.startedAt == null) continue;
      // A record's own elapsed time, or the span of the model call it anchors. The
      // server only attaches the latter to the record that owns a COMPLETED step, so a
      // record with no duration still degrades to a start marker rather than borrowing
      // a sibling's time.
      const ownDur = s.timeSeconds != null && Number.isFinite(s.timeSeconds) && s.timeSeconds > 0
        ? s.timeSeconds * 1000 : null;
      const stepDur = s.stepStartedAt != null && s.stepEndedAt != null && s.stepEndedAt > s.stepStartedAt
        ? s.stepEndedAt - s.stepStartedAt : null;
      const dur = ownDur ?? stepDur;
      // Prefer the step's window when it owns one: the model call starts at `step/start`,
      // which precedes the message being written.
      const from = stepDur != null && s.stepStartedAt != null ? s.stepStartedAt : s.startedAt;
      out.push({
        key: s.recordId, lane: laneFor(s.kind), kind: s.kind,
        recordId: s.recordId, turnIndex: s.turnIndex, stepIndex: s.stepIndex,
        order: s.orderIndex,
        from,
        to: dur != null ? from + dur : null,
        ttft: stepDur != null && s.ttftMs != null && stepDur > 0
          ? Math.max(0, Math.min(1, s.ttftMs / stepDur)) : null,
        label: s.toolName ? s.toolName + ' · ' + (s.summary || '') : (s.summary || s.kind),
        err: s.isError, conf: 'record',
      });
    }

    // The 模型 lane is RECORD-based (message / reasoning), matching DSH: one block per
    // ledger row, so selection rings exactly the row you clicked. Step-level timing is
    // carried onto the anchoring record by the server rather than drawn as its own block,
    // which previously made every other record in the step look like it had no time.

    // Authoritative order — the ledger's own ordering. Never timestamps: DSH's `step/start`
    // precedes its system message, so a time sort silently reorders the lanes.
    out.sort((a, b) => a.order - b.order || a.lane - b.lane || (a.key < b.key ? -1 : 1));
    return out;
  }, [data]);

  /**
   * Boundary markers taken straight from the logged `turn/start|end` and
   * `step/start|end` events. Each carries its own provenance, so a derived edge never
   * draws the same as a logged one. Turn edges span the whole plot; step edges are
   * lighter and stay inside the model lane, which is the only lane a step occupies.
   */
  const edges = useMemo(() => {
    if (!data || !spans.length) return [];
    const out: Edge[] = [];
    for (const t of data.turns) {
      const label = turnNo(t.turn_index, t.source_turn_id);
      if (t.started_at != null) {
        out.push({ t: t.started_at, conf: t.boundary_confidence, scope: 'turn', edge: 'start', id: t.turn_index, label });
      }
      if (t.ended_at != null) {
        out.push({ t: t.ended_at, conf: t.boundary_confidence, scope: 'turn', edge: 'end', id: t.turn_index, label });
      }
    }
    for (const s of data.steps) {
      const label = stepNo(s.step_index, s.source_step_id);
      if (s.started_at != null) {
        out.push({ t: s.started_at, conf: s.boundary_confidence, scope: 'step', edge: 'start', id: s.step_index, label });
      }
      if (s.ended_at != null) {
        out.push({ t: s.ended_at, conf: s.boundary_confidence, scope: 'step', edge: 'end', id: s.step_index, label });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }, [data, spans]);

  /**
   * Projection domain. In 等长 mode every span occupies exactly one unit, so the
   * domain is the record count and a turn edge lands on the first span at/after it.
   * In 比例 mode the domain is real milliseconds.
   */
  const model = useMemo(() => {
    if (!spans.length) return null;

    if (mode === 'span') {
      const n = spans.length;
      return {
        kind: 'span' as const, min: 0, max: n,
        at: (i: number) => i,
        width: (i: number, to: number | null) => (to == null ? 0 : 1),
        edges: edges.map((e) => ({
          ...e,
          pos: spans.findIndex((s) => s.from >= e.t) === -1
            ? n : Math.max(0, spans.findIndex((s) => s.from >= e.t)),
        })),
      };
    }

    let min = Infinity, max = -Infinity;
    for (const s of spans) {
      if (s.from < min) min = s.from;
      const end = s.to ?? s.from;
      if (end > max) max = end;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const span = Math.max(max - min, 1);
    return {
      kind: 'time' as const, min, max: Math.max(max, min + 1),
      at: (t: number) => t - min,
      width: (from: number, to: number | null) => (to == null ? 0 : Math.max(0, to - from)),
      edges: edges.map((e) => ({ ...e, pos: e.t - min })),
      realSpan: span,
    };
  }, [spans, edges, mode]);

  if (!data) return <section className="timeline"><span className="muted">加载时间线…</span></section>;
  if (!model || !spans.length) {
    return <section className="timeline">
      <span className="muted">该会话没有带时间戳的记录，无法绘制时间线（来源未记录时间信息）</span>
    </section>;
  }

  const total = model.max - model.min;
  const view = { from: model.min + (total * pan) / 100, to: model.min + (total * (pan + 100)) / 100 };

  /**
   * Layout is in PIXELS, not percentages, because a percentage layout has no floor: it
   * always squeezes the whole session into the container width, which at 569 records
   * leaves each block ~1.9px — illegible and impossible to click.
   *
   * MIN_CELL is the smallest a cell may get (block + DSH's two 8% insets). When the
   * records cannot all fit at that size the canvas grows past the container and the
   * right-drag gesture pans it.
   */
  const MIN_CELL = 12;
  const viewW = Math.max(1, trackW || 1000);
  const domainCells = model.kind === 'span' ? Math.max(1, spans.length) : 1;
  const cell = zoom * (model.kind === 'span' ? Math.max(MIN_CELL, viewW / domainCells) : viewW);
  const innerW = cell * domainCells;

  const maxScroll = Math.max(0, innerW - viewW);
  const sx = Math.min(scrollX, maxScroll);

  /** Domain → px within the (scrollable) canvas. */
  const raw = (v: number) => (model.kind === 'span' ? v * cell
    : ((v - view.from) / (view.to - view.from)) * innerW);
  /** Domain → px on screen, after the pan offset. */
  const px = (v: number) => raw(v) - sx;

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(40, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
  };

  const onDown = (e: React.MouseEvent) => {
    // Right button pans. It used to clear the selection; double-click does that now.
    if (e.button === 2) {
      if (maxScroll <= 0) return;
      const startX = e.clientX, startSx = scrollRef.current;
      const move = (ev: MouseEvent) => setScrollX(startSx - (ev.clientX - startX));
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    // Screen x → domain, undoing the pan so a drag under the cursor selects what it covers.
    const toDomain = (clientX: number) => (model.kind === 'span'
      ? (clientX - rect.left + sx) / cell
      : view.from + ((clientX - rect.left + sx) / Math.max(1, innerW)) * (view.to - view.from));
    const t0 = toDomain(e.clientX);
    const startX = e.clientX;
    const move = (ev: MouseEvent) => {
      // A click (on a block) must not leave a zero-width selection behind, and a drag
      // must not fire on every intermediate movement as a zero-width one first.
      if (Math.abs(ev.clientX - startX) < 3) return;
      const t1 = toDomain(ev.clientX);
      setSel({ from: Math.min(t0, t1), to: Math.max(t0, t1) });
    };
    const up = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startX) < 3) setSel(null);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  /**
   * Position of a span in the ACTIVE projection. 等长 mode is indexed by record order,
   * NOT by timestamp — using `s.from` there would place every block far outside the
   * [0, count] domain and render nothing on screen.
   */
  const axis = (s: Span, i: number) => (model.kind === 'span' ? i : model.at(s.from));
  const widthOf = (s: Span, i: number) =>
    (model.kind === 'span' ? 1 : (s.to != null ? model.width(s.from, s.to) : 0));

  /**
   * Whether this span occupies a measurable block. DSH's SEQUENCE projection gives every
   * cell `end = start + 1` regardless of whether the source recorded an elapsed time, so
   * an input record still renders as a full unit there. Only the 比例 projection can tell
   * a completed span from a bare start marker — otherwise 用户/上下文 (which never carry a
   * duration) would collapse to dashed ticks in 等长 mode.
   */
  const isClosed = (s: Span) => (model.kind === 'span' ? true : s.to != null);

  /** Selection is in domain units; in 等长 mode a selected range is a run of records. */
  const hit = sel ? spans.filter((s, i) => {
    const a = axis(s, i), b = a + widthOf(s, i);
    return a <= sel.to && b >= sel.from;
  }).length : 0;

  const head = model.kind === 'span'
    ? <span className="muted">{spans.length} 条记录 · 等长排布（块宽不代表时长）</span>
    : <span className="muted">
      {new Date(model.min).toLocaleTimeString()} → {new Date(model.max).toLocaleTimeString()}
      {' · '}{((model as any).realSpan / 1000).toFixed(1)}s
    </span>;

  return (
    <section className="timeline">
      <div className="tl-head">
        <h3>时间线</h3>
        {head}
        <span className="spacer" />
        <button className={'tl-mode' + (mode === 'span' ? ' on' : '')}
          onClick={() => { setMode('span'); setSel(null); }}>等长</button>
        <button className={'tl-mode' + (mode === 'time' ? ' on' : '')}
          onClick={() => { setMode('time'); setSel(null); }}>比例</button>
        <button className="link" onClick={() => { setZoom(1); setPan(0); setSel(null); setScrollX(0); }}>重置视图</button>
      </div>

      <div className="tl-plot">
        <div className="tl-labels">
          {LANES.map((l) => <span key={l.key}>{l.name}</span>)}
        </div>
        <div className="tl-track" ref={trackRef} onWheel={onWheel} onMouseDown={onDown}
          onDoubleClick={() => setSel(null)}
          onContextMenu={(e) => e.preventDefault()}>
          <div className="tl-inner" style={{ width: innerW }}>
            {sel && <div className="tl-selection" style={{ left: px(sel.from) + 'px', width: Math.max(0, px(sel.to) - px(sel.from)) + 'px' }}>
              <i className="tl-edge l" /><i className="tl-edge r" />
            </div>}
            {model.edges.map((e) => (
              <div key={`${e.scope}-${e.edge}-${e.id}-${e.t}`}
                className={'tl-edge-mark tl-edge-' + e.scope + ' is-' + e.edge
                  + (e.conf === 'explicit' ? ' explicit' : ' derived')}
                style={{ left: px(e.pos) + 'px' }}
                title={`${e.scope === 'turn' ? '轮次' : '步'} ${e.label} ${e.edge === 'start' ? '起始' : '结束'}`
                  + ` · ${e.conf === 'explicit' ? '显式边界' : '推断边界'}`
                  + `\n${new Date(e.t).toLocaleTimeString()}`} />
            ))}
            {spans.map((s, i) => {
              const start = axis(s, i);
              const rawW = widthOf(s, i);
              // Width comes from the active projection; `isClosed` decides whether a missing
              // end time collapses this to a start marker (比例 only).
              const closed = isClosed(s);
              const left = px(start);
              const w = closed ? Math.max(0.3, px(start + rawW) - left) : null;
              const known = w != null && w > 0.05;
              // DSH insets every span by min(width*8%, 1px) on BOTH sides, so adjacent
              // blocks stay visually separate instead of fusing into one bar.
              const gap = known ? Math.min(w * 0.08, 1) : 0;
              // Ring exactly the block for the selected ledger row. Every lane is record-based
              // now, so the record id is the whole match — no turn/step approximation,
              // which used to ring a step's tool blocks along with its model block.
              const isCurrent = selected != null && selected.recordId === s.recordId;
              return (
                <div key={s.key}
                  className={'tl-span' + (known ? '' : ' start') + (s.err ? ' err' : '') + (isCurrent ? ' current' : '')}
                  data-lane={s.lane}
                  data-kind={s.kind}
                  style={{
                    left: left + gap + 'px',
                    width: known ? Math.max(2, w - gap * 2) + 'px' : undefined,
                    // TTFT prefix: the leading slice of a model call spent waiting for first token.
                    ...(s.ttft != null && known
                      ? { backgroundImage: `linear-gradient(to right,
                          var(--ttft) 0, var(--ttft) ${(s.ttft * 100).toFixed(2)}%,
                          var(--bar) ${(s.ttft * 100).toFixed(2)}%, var(--bar) 100%)` }
                      : {}),
                  }}
                  title={`${s.label} · ${clock(s.from)}${closed ? ' → ' + clock(s.to) : ' (无结束时间)'}`}
                  onClick={() => { if (s.recordId && onJump) onJump(s.recordId); }}
                  onMouseEnter={(e) => setHover({
                    x: e.clientX, y: e.clientY,
                    text: `${s.label}\n${clock(s.from)}${closed ? ' → ' + clock(s.to) : ' · 无结束时间（仅起点）'}`
                      + `${closed ? '\n耗时 ' + fmtDur((s.to! - s.from) / 1000) : ''}`
                      + `${s.ttft != null && closed ? '\nTTFT ' + fmtDur(((s.to! - s.from) * s.ttft) / 1000) : ''}`
                      + `\n边界 ${s.conf === 'explicit' ? '显式' : s.conf === 'derived' ? '推断' : '记录时间戳'}`,
                  })}
                  onMouseLeave={() => setHover(null)}>
                  {known && w > 4 ? <i className="tl-tag">{i + 1}</i> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Rendered OUTSIDE .tl-track: that box is `overflow:hidden`, and keeping the tip
          out of it removes any chance of the ancestor clipping it. It is
          `position:fixed`, so its own coordinates are viewport-based either way. */}
      {hover && <div className="tl-tip" style={{ left: hover.x + 12, top: hover.y + 14 }}>
        {hover.text.split('\n').map((l, i) => <div key={i}>{l}</div>)}
      </div>}

      <div className="tl-legend muted">
        <span><i className="sw system" />系统</span>
        <span><i className="sw user" />用户</span>
        <span><i className="sw context" />上下文</span>
        <span><i className="sw model" />模型</span>
        <span><i className="sw tool" />工具</span>
        <span><i className="sw start" />无结束时间（仅起点）</span>
        <span><i className="sw edge-ex" />轮次边界（实线=显式）</span>
        <span><i className="sw edge-step" />步边界</span>
        <span><i className="sw edge-dv" />推断边界（虚线）</span>
        <span>滚轮缩放 · 左键拖拽选区 · 右键拖拽平移 · 双击清除选区</span>
      </div>
      {sel && <div className="tl-selinfo muted">
        {model.kind === 'span'
          ? `选中 ${Math.round(sel.to - sel.from)} 条记录区间 · ${hit} 条相交`
          : `选中区间 ${((sel.to - sel.from) / 1000).toFixed(2)}s · ${hit} 条记录相交`}
      </div>}
    </section>
  );
}