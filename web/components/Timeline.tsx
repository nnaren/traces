import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDur, type SourceId } from '../lib/api';

/**
 * Timing overview: turn / step / tool lanes on a shared time domain.
 * Hover reveals exact clock + duration. Drag selects an interval and the ledger
 * can be focused on records active in it. Wheel zooms the time domain.
 * In-flight / unknown spans render as a start marker only — we never invent elapsed time.
 */
const clock = (t: number | null): string => (t == null ? '—' : new Date(t).toLocaleTimeString());

export function Timeline({ source, sessionId }: { source: SourceId; sessionId: string }) {
  const [data, setData] = useState<{ turns: any[]; steps: any[]; spans: any[] } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(0);
  const [sel, setSel] = useState<{ from: number; to: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setData(null); setZoom(1); setPan(0); setSel(null);
    api.timeline(source, sessionId).then(setData).catch(() => {});
  }, [source, sessionId]);

  const domain = useMemo(() => {
    if (!data) return null;
    const ts: number[] = [];
    for (const t of data.turns) { if (t.started_at) ts.push(t.started_at); if (t.ended_at) ts.push(t.ended_at); }
    for (const s of data.steps) { if (s.started_at) ts.push(s.started_at); if (s.ended_at) ts.push(s.ended_at); }
    for (const s of data.spans) {
      if (s.startedAt) ts.push(s.startedAt);
      if (s.timeSeconds != null && s.startedAt) ts.push(s.startedAt + s.timeSeconds * 1000);
    }
    if (ts.length < 2) return null;
    const min = Math.min(...ts), max = Math.max(...ts);
    return { min, max: Math.max(max, min + 1), span: Math.max(max - min, 1) };
  }, [data]);

  if (!data) return <section className="timeline"><span className="muted">加载时间线…</span></section>;
  if (!domain) {
    return <section className="timeline">
      <span className="muted">该会话缺少可用时间戳，无法绘制时间线（来源未记录时间信息）</span>
    </section>;
  }

  const width = 100 * zoom;
  const view = { from: domain.min + (domain.span * pan) / 100, to: domain.min + (domain.span * (pan + 100)) / 100 };
  const px = (t: number) => ((t - view.from) / (view.to - view.from)) * 100;

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const next = Math.min(40, Math.max(1, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    setZoom(next);
  };
  const onDown = (e: React.MouseEvent) => {
    if (e.button === 2) { setSel(null); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const t0 = view.from + ((e.clientX - rect.left) / rect.width) * (view.to - view.from);
    const move = (ev: MouseEvent) => {
      const t1 = view.from + ((ev.clientX - rect.left) / rect.width) * (view.to - view.from);
      setSel({ from: Math.min(t0, t1), to: Math.max(t0, t1) });
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  interface LaneRow {
    key: string; from: number | null; to: number | null; label: string;
    conf?: string; err?: boolean; dur?: number | null;
  }
  const lanes: Array<{ name: string; rows: LaneRow[] }> = [
    { name: 'turn', rows: data.turns.map((t): LaneRow => ({ key: 't' + t.turn_index, from: t.started_at ?? null, to: t.ended_at ?? null, label: 'turn ' + t.turn_index, conf: t.boundary_confidence, dur: t.duration_ms ?? null })) },
    { name: 'step', rows: data.steps.map((s): LaneRow => ({ key: 's' + s.step_index, from: s.started_at ?? null, to: s.ended_at ?? null, label: 'step ' + s.step_index + (s.model ? ' \u00b7 ' + s.model : ''), conf: s.boundary_confidence, dur: null })) },
    { name: 'tool', rows: data.spans.filter((s) => s.kind === 'tool').map((s): LaneRow => ({ key: s.recordId, from: s.startedAt ?? null, to: s.timeSeconds != null && s.startedAt ? s.startedAt + s.timeSeconds * 1000 : null, label: s.toolName ?? 'tool', err: s.isError, dur: s.timeSeconds != null ? s.timeSeconds * 1000 : null })) },
  ];

  return (
    <section className="timeline">
      <div className="tl-head">
        <h3>时间线</h3>
        <span className="muted">{new Date(domain.min).toLocaleTimeString()} → {new Date(domain.max).toLocaleTimeString()} · {(domain.span / 1000).toFixed(1)}s</span>
        <span className="spacer" />
        <button className="link" onClick={() => { setZoom(1); setPan(0); setSel(null); }}>重置视图</button>
      </div>
      <div className="tl-wrap" ref={wrapRef} onWheel={onWheel} onMouseDown={onDown} onContextMenu={(e) => { e.preventDefault(); setSel(null); }}>
        <div className="tl-inner" style={{ width: width + '%' }}>
          {sel && <div className="tl-sel" style={{ left: px(sel.from) + '%', width: (px(sel.to) - px(sel.from)) + '%' }} />}
          {lanes.map((lane) => (
            <div key={lane.name} className="tl-lane">
              <div className="tl-lane-name">{lane.name}</div>
              <div className="tl-lane-body">
                {lane.rows.slice(0, 400).map((r) => {
                  if (r.from == null) return null;
                  const left = px(r.from);
                  const w = r.to != null ? Math.max(0.4, px(r.to) - left) : null;
                  return (
                    <div key={r.key}
                      className={'tl-bar ' + lane.name + (w == null ? ' open' : '') + (r.err ? ' err' : '') + (r.conf === 'explicit' ? ' explicit' : '')}
                      style={{ left: left + '%', width: w == null ? undefined : w + '%' }}
                      title={`${r.label} · ${new Date(r.from).toLocaleTimeString()}${r.to ? ' → ' + new Date(r.to).toLocaleTimeString() : ' (进行中/未知)'}`}
                      onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, text: `${r.label}\n${clock(r.from)}${r.to != null ? ' \u2192 ' + clock(r.to) : ' \u00b7 进行中'}${r.dur != null ? '\n耗时 ' + fmtDur(r.dur / 1000) : ''}` })}
                      onMouseLeave={() => setHover(null)}>
                      {w != null && w > 6 ? r.label.slice(0, 40) : ''}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="tl-legend muted">
        <span><i className="sw explicit" />显式边界</span>
        <span><i className="sw derived" />推断边界</span>
        <span><i className="sw open" />进行中/未知（仅起点）</span>
        <span>滚轮缩放 · 拖拽选区 · 右键清除</span>
      </div>
      {hover && <div className="tl-tip" style={{ left: hover.x + 12, top: hover.y + 12 }}>{hover.text.split('\n').map((l, i) => <div key={i}>{l}</div>)}</div>}
      {sel && <div className="tl-selinfo muted">选中区间 {(sel.to - sel.from) / 1000}s · {(data.spans.filter((s) => s.startedAt != null && s.startedAt <= sel.to && (s.timeSeconds == null || s.startedAt + s.timeSeconds * 1000 >= sel.from)).length)} 条工具记录与该区间相交</div>}
    </section>
  );
}
