import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime, type SessionRow, type SourceId, type RecordRow, type IngestJob } from './lib/api';
import { Ledger } from './components/Ledger';
import { Inspector } from './components/Inspector';
import { Timeline } from './components/Timeline';
import { ThemeSwitcher } from './components/ThemeSwitcher';

const SOURCES: Array<{ id: SourceId | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'dsh', label: 'DSH' },
];

export function App() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<SourceId | 'all'>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<SessionRow | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<RecordRow | null>(null);
  // Set only by a timeline click, so the ledger scrolls there. Reusing `selectedRecord`
  // for this would also fire on ordinary row clicks and yank the list under the cursor.
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  // The panel is genuinely removed when closed, not left as an empty 420px column —
  // the ledger reclaims the space (`.ledger` is flex:1, `.inspector` is flex:none).
  const [inspOpen, setInspOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Persisted inspector width. Restored on next visit so the panel doesn't snap back to
  // 420px every reload. localStorage may be blocked (private mode / file://) — the
  // try/catch on read AND write keeps that from breaking the page.
  const [inspWidth, setInspWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('trajview.inspectorWidth');
      const n = raw == null ? NaN : Number(raw);
      return Number.isFinite(n) ? n : 420;
    } catch { return 420; }
  });

  // --- ingest (refresh) ---
  // 'idle'    : nothing running; button reads "提取新轨迹".
  // 'running' : child ingest is in flight; button is disabled and shows progress.
  // 'done'    : last run finished cleanly; surface a brief "已更新" then revert to idle.
  // 'error'   : last run failed (non-zero exit or spawn failure); show the tail of stderr.
  // On mount we ask the server whether a job is already in flight, so a page refresh
  // mid-ingest lands the user on the running view rather than a misleading "idle".
  const [ingest, setIngest] = useState<
    { state: 'idle' } | { state: 'running'; startedAt: number; stderr: string }
    | { state: 'done'; added: number; at: number }
    | { state: 'error'; message: string; stderr: string; exitCode?: number | null }
  >({ state: 'idle' });
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshCounts = useCallback(() => {
    api.health().then((h) => setCounts(h.sessions)).catch(() => {});
  }, []);
  const refreshSessions = useCallback(() => {
    api.sessions(filter === 'all' ? undefined : filter).then(setSessions).catch((e) => setError(String(e)));
  }, [filter]);

  const stopPolling = () => {
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
  };
  const stopDoneTimer = () => {
    if (doneTimer.current) { clearTimeout(doneTimer.current); doneTimer.current = null; }
  };

  // Poll the server's ingest status until finishedAt is set, then transition to done/error.
  // We deliberately key the closure on `startedAt` rather than re-reading state inside,
  // so the polling loop cannot chase a job that has already been replaced.
  const watchJob = useCallback((startedAt: number) => {
    stopPolling();
    const tick = async () => {
      let job: any;
      try { job = await api.ingestStatus(); } catch (e) {
        setIngest({ state: 'error', message: String(e), stderr: '' });
        return;
      }
      if (job.idle || job.finishedAt === undefined) {
        // Still running (or someone else's job) — keep waiting.
        setIngest((prev) => prev.state === 'running'
          ? { state: 'running', startedAt, stderr: prev.state === 'running' ? prev.stderr : (job.stderr ?? '') }
          : prev);
        pollTimer.current = setTimeout(tick, 800);
        return;
      }
      // Finished. Compare counts before/after so the user can see the new arrivals.
      const before = Object.values(counts).reduce((a, b) => a + b, 0);
      stopPolling();
      if (job.error || (job.exitCode != null && job.exitCode !== 0)) {
        setIngest({ state: 'error', message: job.error ?? 'ingest 失败', stderr: job.stderr ?? '', exitCode: job.exitCode });
        return;
      }
      refreshCounts();
      refreshSessions();
      api.health().then((h) => {
        const after = Object.values(h.sessions).reduce((a, b) => a + b, 0);
        const added = Math.max(0, after - before);
        setIngest({ state: 'done', added, at: Date.now() });
        stopDoneTimer();
        doneTimer.current = setTimeout(() => setIngest({ state: 'idle' }), 4000);
      }).catch(() => {
        setIngest({ state: 'done', added: 0, at: Date.now() });
        stopDoneTimer();
        doneTimer.current = setTimeout(() => setIngest({ state: 'idle' }), 4000);
      });
    };
    pollTimer.current = setTimeout(tick, 400);
  }, [counts, refreshCounts, refreshSessions]);

  const onRefresh = useCallback(() => {
    stopDoneTimer();
    setIngest({ state: 'running', startedAt: Date.now(), stderr: '' });
    api.ingest().then((res) => {
      const job: IngestJob | undefined = (res as any).job;
      const startedAt = job?.startedAt ?? Date.now();
      watchJob(startedAt);
    }).catch((e) => {
      setIngest({ state: 'error', message: String(e), stderr: '' });
    });
  }, [watchJob]);

  // On mount: pick up any job already in flight (e.g. user opened this tab during a run
  // triggered by another tab, or hit refresh mid-ingest). Never triggers one ourselves.
  useEffect(() => {
    let cancelled = false;
    api.ingestStatus().then((s: any) => {
      if (cancelled || s.idle) return;
      if (s.finishedAt === undefined) {
        setIngest({ state: 'running', startedAt: s.startedAt, stderr: s.stderr ?? '' });
        watchJob(s.startedAt);
      }
    }).catch(() => {});
    return () => { cancelled = true; stopPolling(); stopDoneTimer(); };
    // Intentionally empty: only on mount, and we never want this to re-run on filter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api.health().then((h) => setCounts(h.sessions)).catch(() => {});
  }, []);
  useEffect(() => {
    api.sessions(filter === 'all' ? undefined : filter).then(setSessions).catch((e) => setError(String(e)));
  }, [filter]);

  // Deep link: #/<source>/<sessionId>
  useEffect(() => {
    const apply = () => {
      const m = location.hash.replace(/^#\/?/, '');
      if (!m) return;
      const [src, id] = m.split('/');
      if (!src || !id) return;
      setFilter(src as SourceId);
      api.sessions(src as SourceId).then((rows) => {
        const hit = rows.find((r) => r.sessionId === decodeURIComponent(id));
        if (hit) setSel(hit);
      }).catch(() => {});
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  // Keep the hash in sync so the view is shareable / reloadable.
  useEffect(() => {
    const next = sel ? '#/' + sel.source + '/' + encodeURIComponent(sel.sessionId) : '';
    if (next && location.hash !== next) history.replaceState(null, '', next);
  }, [sel]);

  // The inspector's ✕ clears the selection; picking a listed tool call jumps to it.
  useEffect(() => {
    // The inspector's ✕ clears the selection AND collapses the panel.
    const clear = () => { setSelectedRecord(null); setInspOpen(false); };
    window.addEventListener('trajview:clear-selection', clear);
    return () => window.removeEventListener('trajview:clear-selection', clear);
  }, []);

  // The ledger hands back whole records; a jump from the inspector only knows an id,
  // so resolve it before storing.
  const jumpToRecord = useCallback(async (recordId: string) => {
    if (!sel) return;
    const row = await api.record(sel.source, sel.sessionId, recordId).catch(() => null);
    if (row) setSelectedRecord(row);
  }, [sel]);

  /** Timeline block → highlight it in the ledger and load it into the inspector. */
  const onTimelineJump = useCallback((recordId: string) => {
    setJumpTo(recordId);
    setSelectedRecord(null);
    setInspOpen(true);
    void jumpToRecord(recordId);
  }, [jumpToRecord]);

  /** Picking a ledger row must (re)open the panel, however it was closed. */
  const onLedgerSelect = useCallback((rec: RecordRow | null) => {
    setSelectedRecord(rec);
    if (rec) setInspOpen(true);
  }, []);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((s) =>
      (s.sessionId + ' ' + (s.cwd ?? '') + ' ' + (s.cliVersion ?? '')).toLowerCase().includes(needle));
  }, [sessions, q]);

  return (
    <div className="app">
      <ThemeSwitcher />
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">◈</span>
          <div>
            <div className="brand-name">trajview</div>
            <div className="brand-sub">统一轨迹观察台</div>
          </div>
        </div>

        <div className="source-tabs">
          {SOURCES.map((s) => (
            <button key={s.id}
              className={'tab' + (filter === s.id ? ' on' : '')}
              onClick={() => { setFilter(s.id); setSel(null); }}>
              {s.label}
              <em>{s.id === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : (counts[s.id] ?? 0)}</em>
            </button>
          ))}
        </div>

        <input className="search" placeholder="过滤 sessionId / cwd / version"
          value={q} onChange={(e) => setQ(e.target.value)} />

        <div className={'refresh ' + ingest.state}>
          <button className="refresh-btn" onClick={onRefresh} disabled={ingest.state === 'running'}
            title={ingest.state === 'running' ? '摄入进行中…' : '从 ~/.codex、~/.claude、~/.dsh 增量摄入'}>
            {ingest.state === 'running'
              ? <span className="spin">↻</span>
              : <span className="ico">↻</span>}
            <span className="label">
              {ingest.state === 'idle' && '提取新轨迹'}
              {ingest.state === 'running' && '提取中…'}
              {ingest.state === 'done' && (ingest.added > 0 ? `已更新 +${ingest.added}` : '已是最新')}
              {ingest.state === 'error' && '摄入失败'}
            </span>
          </button>
          {ingest.state === 'error' && ingest.stderr && (
            <pre className="refresh-err" title="stderr 末尾">{trimTail(ingest.stderr, 6)}</pre>
          )}
        </div>

        <div className="session-list">
          {error && <div className="err">{error}</div>}
          {visible.map((s) => (
            <button key={s.source + s.sessionId}
              className={'session' + (sel?.source === s.source && sel?.sessionId === s.sessionId ? ' on' : '')}
              onClick={() => { setSel(s); setSelectedRecord(null); }}>
              <div className="s-row1">
                <span className={'pill ' + s.source}>{srcLabel(s.source)}</span>
                <span className="s-time">{fmtTime(s.startedAt)}</span>
              </div>
              {/* A Codex subagent rollout carries its PARENT in session_meta.session_id, so
                  without this badge it is indistinguishable from a root conversation. */}
              {s.parentSessionId && (
                <div className="s-sub" title={'由会话 ' + s.parentSessionId + ' 派生'}>
                  子 agent{s.agentNickname ? ' · ' + s.agentNickname : ''}
                  {s.subagentDepth != null ? ' · 深度 ' + s.subagentDepth : ''}
                </div>
              )}
              <div className="s-id" title={s.sessionId}>{s.sessionId}</div>
              <div className="s-path" title={s.cwd}>{s.cwd ?? '—'}</div>
              <div className="s-stats">
                <span>{s.recordCount} 记录</span>
                <span>{s.turnCount} turn</span>
                <span>{s.stepCount} step</span>
                {diagCount(s.diagnostics) > 0 && <span className="warn">{diagCount(s.diagnostics)} 异常</span>}
              </div>
            </button>
          ))}
          {visible.length === 0 && <div className="empty">无匹配会话</div>}
        </div>
      </aside>

      <main className="main">
        {!sel ? (
          <div className="placeholder">
            <h1>选择一个会话</h1>
            <p>左侧列出本机三源轨迹：Codex rollout、Claude Code JSONL、DeepSeek Harness session log。</p>
            <p className="hint">账本按各源权威序排列 —— DSH 用 <code>seq</code>，Codex 用 <code>ordinal</code>（旧版本回退物理行序），Claude Code 用物理行序。</p>
          </div>
        ) : (
          <>
            <header className="session-head">
              <div className="head-main">
                <span className={'pill ' + sel.source}>{srcLabel(sel.source)}</span>
                <h2 title={sel.sessionId}>{sel.sessionId}</h2>
              </div>
              <CapabilityMatrix caps={sel.capabilities} diagnostics={sel.diagnostics} />
              <div className="head-meta">
                <span title={sel.cwd}>{sel.cwd ?? '—'}</span>
                {sel.cliVersion && <span className="badge">CLI {sel.cliVersion}</span>}
                <span>{fmtTime(sel.startedAt)}</span>
              </div>
            </header>
            <Timeline source={sel.source} sessionId={sel.sessionId} selected={selectedRecord}
              onJump={onTimelineJump} />
            <div className="body-row">
              <Ledger session={sel} selected={selectedRecord?.recordId ?? null} onSelect={onLedgerSelect}
                jumpTo={jumpTo} onJumpDone={() => setJumpTo(null)}
                inspectorClosed={!inspOpen} onOpenInspector={() => setInspOpen(true)} />
              {inspOpen && (
                <>
                  <Resizer
                    width={inspWidth}
                    onChange={(w) => {
                      setInspWidth(w);
                      try { localStorage.setItem('trajview.inspectorWidth', String(w)); } catch {}
                    }} />
                  <Inspector session={sel} recordId={selectedRecord?.recordId ?? null} onSelect={jumpToRecord} width={inspWidth} />
                </>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function CapabilityMatrix({ caps, diagnostics }: { caps: any; diagnostics: any }) {
  const items: Array<[string, string]> = [
    ['排序', caps.ordering], ['思维链', caps.reasoning], ['TTFT', caps.ttft],
    ['usage', caps.usageGranularity], ['缓存口径', caps.cacheSemantics], ['成本', caps.cost],
    ['token 时间轴', caps.tokenTimeline], ['工具耗时', caps.toolDuration], ['子 agent', caps.subagentTree],
  ];
  const unknown = diagnostics.unknownTypeCount ?? 0;
  return (
    <div className="caps">
      {items.map(([k, v]) => (
        <span key={k} className={'cap' + (v === 'none' || v === 'absent' ? ' off' : '')}>
          <b>{k}</b>{v}
        </span>
      ))}
      {unknown > 0 && <span className="cap warn"><b>未知事件</b>{unknown}</span>}
    </div>
  );
}

function diagCount(d: any): number {
  return (d.badLineCount ?? 0) + (d.unresolvedCallCount ?? 0) + (d.unknownTypeCount ?? 0)
    + (d.shadowedCount ?? 0) + (d.ttftMissingCount ?? 0) + (d.usageMissingCount ?? 0);
}
function srcLabel(s: SourceId): string {
  return s === 'codex' ? 'Codex' : s === 'claude-code' ? 'Claude' : 'DSH';
}

/** Last N lines of a captured stream, so the error banner stays short. */
function trimTail(s: string, lines: number): string {
  const arr = s.trimEnd().split('\n');
  return arr.slice(-lines).join('\n');
}

/**
 * Vertical drag handle that lives between the ledger and the inspector. Mouse and touch
 * are handled with Pointer Events so a single set of listeners covers desktop drag and
 * stylus / touch on a tablet.
 *
 *   MIN / MAX clamp the panel: under MIN the JSON trees wrap every word, over MAX the
 *   ledger starves. The cursor switches to col-resize on the document body while dragging
 *   so the user doesn't see the cursor flicker back to default if they wander off the
 *   handle itself.
 *
 *   Double-click resets to the CSS default (420px). Same gesture every native split view
 *   uses, no extra UI to discover.
 */
const MIN_INSP = 240;
const MAX_INSP = 1200;
const DEFAULT_INSP = 420;

function Resizer({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const startX = useRef(0);
  const startW = useRef(width);
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Left mouse button OR touch OR pen — anything that yields a real primary gesture.
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    // Dragging left makes the inspector WIDER — feels more natural than the inverse, and
    // matches what every other split-pane in the world does.
    const next = clamp(startW.current + (startX.current - e.clientX), MIN_INSP, MAX_INSP);
    onChange(next);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  const onDoubleClick = () => onChange(DEFAULT_INSP);

  return (
    <div className="resizer" role="separator" aria-orientation="vertical"
      aria-label="调整详情面板宽度" title="拖动调整宽度 · 双击重置"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick} />
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
