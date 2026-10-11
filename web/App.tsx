import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtTime, type SessionRow, type SourceId, type RecordRow } from './lib/api';
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
                <Inspector session={sel} recordId={selectedRecord?.recordId ?? null} onSelect={jumpToRecord} />
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
