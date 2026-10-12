import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime, type SessionRow, type SourceId, type RecordRow, type IngestJob } from './lib/api';
import { Ledger } from './components/Ledger';
import { Inspector } from './components/Inspector';
import { Timeline } from './components/Timeline';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import {
  EMPTY_NAV, canBack, canForward, pushPoint, stepBack, stepForward,
  type NavPoint, type NavState,
} from './lib/navstack';
import { ancestorsOf, buildSessionTree, collectBranch, flattenTree } from './lib/sessionTree';

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

  // --- navigation history (← / →) ---
  const [nav, setNav] = useState<NavState<SourceId>>(EMPTY_NAV);
  // Read inside the button handlers so they never capture a stale cursor.
  const navRef = useRef(nav);
  navRef.current = nav;

  /** Record a jump. Re-selecting the place we are already at must not grow the stack. */
  const pushNav = useCallback((p: NavPoint<SourceId>) => {
    setNav((n) => pushPoint(n, p));
  }, []);

  /** Apply a history point WITHOUT recording a new one — that is what ← / → do. */
  const openPoint = useCallback(async (p: NavPoint<SourceId>) => {
    const rows = await api.sessions(p.source).catch(() => [] as SessionRow[]);
    const hit = rows.find((r) => r.sessionId === p.sessionId);
    if (!hit) return;
    setFilter(p.source);
    setSel(hit);
    setSelectedRecord(null);
    setJumpTo(null);
    if (p.recordId) {
      const rec = await api.record(p.source, p.sessionId, p.recordId).catch(() => null);
      if (rec) { setSelectedRecord(rec); setInspOpen(true); setJumpTo(rec.recordId); }
    }
  }, []);

  const goBack = useCallback(() => {
    const { nav: next, point } = stepBack(navRef.current);
    if (!point) return;
    setNav(next);
    void openPoint(point);
  }, [openPoint]);

  const goForward = useCallback(() => {
    const { nav: next, point } = stepForward(navRef.current);
    if (!point) return;
    setNav(next);
    void openPoint(point);
  }, [openPoint]);

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

  // Deep link: #/<source>/<sessionId>[/<recordId>]
  // The record segment makes "this exact message" shareable, and is what makes a jump
  // between sessions and messages survive a reload.
  useEffect(() => {
    const apply = () => {
      const m = location.hash.replace(/^#\/?/, '');
      if (!m) return;
      const [src, id, rid] = m.split('/');
      if (!src || !id) return;
      setFilter(src as SourceId);
      api.sessions(src as SourceId).then((rows) => {
        const hit = rows.find((r) => r.sessionId === decodeURIComponent(id));
        if (!hit) return;
        setSel(hit);
        if (!rid) return;
        const recordId = decodeURIComponent(rid);
        setJumpTo(recordId);
        api.record(hit.source, hit.sessionId, recordId).then((rec) => {
          if (rec) { setSelectedRecord(rec); setInspOpen(true); }
        }).catch(() => {});
      }).catch(() => {});
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  // Keep the hash in sync so the view is shareable / reloadable.
  useEffect(() => {
    if (!sel) return;
    let next = '#/' + sel.source + '/' + encodeURIComponent(sel.sessionId);
    if (selectedRecord) next += '/' + encodeURIComponent(selectedRecord.recordId);
    if (location.hash !== next) history.replaceState(null, '', next);
  }, [sel, selectedRecord]);

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
    if (sel) pushNav({ source: sel.source, sessionId: sel.sessionId, recordId });
  }, [jumpToRecord, sel, pushNav]);

  /**
   * Card hover panel → open that session AND scroll the ledger to the clicked message.
   *
   * Selecting and jumping are one gesture here, not two: the session list is where the
   * message was chosen, so opening it and leaving the view at the head would send the user
   * hunting for the one record they just clicked.
   *
   * The order matters. `selectSession` clears `jumpTo`, so the jump is issued AFTER it in
   * the same tick; React batches the two updates and the later `setJumpTo` wins. Setting it
   * before would be silently undone by the session reset.
   */
  const jumpToSessionRecord = useCallback((s: SessionRow, recordId: string) => {
    setSel(s);
    setFilter(s.source);
    setInspOpen(true);
    setSelectedRecord(null);
    // `loadedFor` in the Ledger keys the reload on the session, so a jump within the
    // session already open needs no refetch beyond the pages the ledger drains itself.
    setJumpTo(recordId);
    void api.record(s.source, s.sessionId, recordId).then((row) => setSelectedRecord(row)).catch(() => {});
    pushNav({ source: s.source, sessionId: s.sessionId, recordId });
  }, [pushNav]);

  /** Picking a ledger row must (re)open the panel, however it was closed. */
  const onLedgerSelect = useCallback((rec: RecordRow | null) => {
    setSelectedRecord(rec);
    if (rec) {
      setInspOpen(true);
      if (sel) pushNav({ source: sel.source, sessionId: sel.sessionId, recordId: rec.recordId });
    }
  }, [sel, pushNav]);

  /** Sidebar click: a fresh session, so the inspector goes back to "nothing selected". */
  const selectSession = useCallback((s: SessionRow) => {
    setSel(s);
    setSelectedRecord(null);
    setJumpTo(null);
    setInspOpen(true);
    setFilter(s.source);
    pushNav({ source: s.source, sessionId: s.sessionId, recordId: null });
  }, [pushNav]);

  /**
   * Open a session by id alone — used by the subagent jump link and the 返回父会话 link.
   *
   * Subagents are ordinary sessions here (the adapter keys each rollout by `payload.id`),
   * so this is a lookup plus the same state change a sidebar click makes.
   */
  const openSessionById = useCallback(async (sessionId: string) => {
    let hit = sessions.find((s) => s.sessionId === sessionId) ?? null;
    if (!hit) {
      // The sidebar list is filtered and capped; fall back to a full fetch before giving up.
      const all = await api.sessions().catch(() => [] as SessionRow[]);
      hit = all.find((s) => s.sessionId === sessionId) ?? null;
    }
    if (!hit) {
      setError('找不到会话 ' + sessionId + '（可能尚未摄入，试试「提取新轨迹」）');
      return;
    }
    setError(null);
    setFilter(hit.source);
    setSel(hit);
    setSelectedRecord(null);
    setJumpTo(null);
    setInspOpen(true);
    pushNav({ source: hit.source, sessionId: hit.sessionId, recordId: null });
  }, [sessions, pushNav]);

  // Known session ids, so a jump link is only rendered when it actually resolves.
  const knownSessions = useMemo(() => new Set(sessions.map((s) => s.sessionId)), [sessions]);
  const hasSession = useCallback((id: string) => knownSessions.has(id), [knownSessions]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((s) =>
      (s.sessionId + ' ' + (s.cwd ?? '') + ' ' + (s.cliVersion ?? '') + ' ' + (s.agentNickname ?? ''))
        .toLowerCase().includes(needle));
  }, [sessions, q]);

  /**
   * Subagents are mounted under the conversation that spawned them instead of competing
   * for a top-level card. Depth goes past 1 (codex nests to 4 on this machine) and the
   * deepest parents carry 33 children, so the subtree starts collapsed and shows its size.
   */
  const tree = useMemo(() => buildSessionTree(visible), [visible]);
  // Only an ACTIVE SEARCH forces a subtree open: a match that hides under a collapsed
  // parent is a result the user can never reach. With no query, `visible` IS every session,
  // so feeding it to ancestorsOf would open every parent in the tree and make the collapse
  // control inert.
  //
  // Deliberately NOT forcing open the selected session's chain: an explicit collapse must
  // win, otherwise clicking one of a 33-child parent's subagents would permanently pin that
  // subtree open and the toggle would silently stop responding.
  const forcedOpen = useMemo(() => {
    const open = new Set<string>();
    if (q.trim()) ancestorsOf(visible, sessions).forEach((id) => open.add(id));
    return open;
  }, [visible, sessions, q]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const isCollapsed = useCallback(
    (id: string) => !forcedOpen.has(id) && collapsed.has(id), [collapsed, forcedOpen]);
  const rows = useMemo(() => flattenTree(tree, isCollapsed), [tree, isCollapsed]);
  const toggle = useCallback((id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);

  /**
   * Record kinds the user has switched OFF in the legend. Shared by the timeline and the
   * ledger so one click means the same thing in both views.
   *
   * Default is "everything visible": these are noise-reduction controls for long sessions,
   * not a mode. `reasoning` in particular dominates the ledger on Codex (175 of 603 lines in
   * one measured session), so being able to fold it away matters — but hiding it by default
   * would silently change what the ledger is.
   */
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(new Set());
  /**
   * Toggle a legend GROUP, which may cover several record kinds (`上下文` is `context` +
   * `compacted`, `工具` is `tool` + `subtool`).
   *
   * Group semantics, not per-kind: if every kind in the group is already hidden the click
   * restores the whole group; otherwise it hides the whole group. Toggling kind-by-kind
   * would make a half-hidden group take two clicks to come back, which reads as a stuck
   * control.
   */
  const toggleKinds = useCallback((kinds: readonly string[]) => setHiddenKinds((prev) => {
    const next = new Set(prev);
    const allHidden = kinds.every((k) => next.has(k));
    for (const k of kinds) { if (allHidden) next.delete(k); else next.add(k); }
    return next;
  }), []);  const revealKind = useCallback((kind: string) => setHiddenKinds((prev) => {
    if (!prev.has(kind)) return prev;
    const next = new Set(prev);
    next.delete(kind);
    return next;
  }), []);

  /** Collapse or expand every subtree at once — the 33-child parents make this worth having. */
  const setAllCollapsed = useCallback((shut: boolean) => {
    const next = new Set<string>();
    if (shut) for (const node of tree) collectBranch(node, next);
    setCollapsed(next);
  }, [tree]);

  /**
 * Full user-message list per session, fetched on hover and cached for the session's
 * lifetime. The card itself only needs the FIRST message (already in the list payload),
 * so this stays off the critical path for 300 cards.
 *
 * The entry is created in `loading` state on hover rather than on response, so the panel
 * opens immediately — waiting for the round trip made the first hover look like a dead
 * control.
 */
  type Peek = { status: 'loading' | 'ready'; messages: Array<{ recordId: string; orderIndex: number; text: string }> };
  const [peeked, setPeeked] = useState<Map<string, Peek>>(new Map());
  /**
   * Which panel is currently SHOWN. Separate from `peeked`, which is only the cache: a
   * closed panel must keep its messages so re-hovering opens instantly instead of
   * re-fetching, and it must be closable on mouse-leave.
   */
  const [peekOpen, setPeekOpen] = useState<string | null>(null);
  const peekBusy = useRef(new Set<string>());
  const peekMessages = useCallback((s: SessionRow) => {
    if (peekBusy.current.has(s.sessionId)) return;
    peekBusy.current.add(s.sessionId);
    setPeeked((prev) => {
      if (prev.get(s.sessionId)?.status === 'ready') return prev;
      const next = new Map(prev);
      next.set(s.sessionId, { status: 'loading', messages: [] });
      return next;
    });
    api.messages(s.source, s.sessionId)
      .then((r) => setPeeked((prev) => {
        const next = new Map(prev);
        next.set(s.sessionId, { status: 'ready', messages: r.messages ?? [] });
        return next;
      }))
      .catch(() => setPeeked((prev) => {
        const next = new Map(prev);
        next.set(s.sessionId, { status: 'ready', messages: [] });
        return next;
      }))
      .finally(() => { peekBusy.current.delete(s.sessionId); });
  }, []);

  return (
    <div className="app">
      {/* ← / → sit immediately left of the appearance switcher: both are global chrome,
          and the tour the arrows retrace is exactly what the links below create. */}
      <div className="top-right">
        <div className="nav-btns" role="group" aria-label="导航历史">
          <button type="button" className="nav-btn" onClick={goBack} disabled={!canBack(nav)}
            title="后退：上一个会话 / 消息">
            <span aria-hidden="true">←</span>
          </button>
          <button type="button" className="nav-btn" onClick={goForward}
            disabled={!canForward(nav)}
            title="前进：回到后退前的位置">
            <span aria-hidden="true">→</span>
          </button>
        </div>
        <ThemeSwitcher />
      </div>
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

        {/* One parent on this machine carries 33 subagents, so folding the whole list back to
            its roots has to be one click rather than 55. */}
        {tree.some((n) => n.children.length > 0) && (
          <div className="s-fold">
            <button type="button" onClick={() => setAllCollapsed(true)}
              title="折叠所有子 agent 子树">全部折叠</button>
            <button type="button" onClick={() => setAllCollapsed(false)}
              title="展开所有子 agent 子树">全部展开</button>
          </div>
        )}

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
          {rows.map(({ node, depth }) => {
            const s = node.session;
            const kids = node.children.length;
            const shut = isCollapsed(s.sessionId);
            return (
              <div key={s.source + s.sessionId} className={'s-node d' + depth}>
                {depth > 0 && <div className="s-rail" aria-hidden="true" />}
                {/* A div carrying role=button, not a <button>: the collapse control below is a
                    real button and HTML forbids one button inside another (the parser closes
                    the outer one, which mangles the card). role + tabIndex + Enter/Space keeps
                    the card keyboard-operable without nesting interactive elements. */}
                <div role="button" tabIndex={0}
                  className={'session' + (sel?.source === s.source && sel?.sessionId === s.sessionId ? ' on' : '')}
                  onClick={() => selectSession(s)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSession(s); }
                  }}>
                  <div className="s-row1">
                    {kids > 0 ? (
                      <button type="button" className="s-tw" aria-expanded={!shut}
                        aria-label={(shut ? '展开' : '收起') + kids + ' 个子 agent'}
                        title={shut ? '展开 ' + kids + ' 个子 agent' : '收起子 agent'}
                        onClick={(e) => { e.stopPropagation(); toggle(s.sessionId); }}>
                        <span aria-hidden="true">{shut ? '▸' : '▾'}</span>
                        <em>{kids}</em>
                      </button>
                    ) : <span className="s-tw-sp" />}
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
                  {/* The session's subject, taken from its first REAL user message — a
                      system prompt or injected <environment_context> would title every card
                      identically. Hovering reveals the full question list of the session. */}
                  {s.title ? (
                    <div className="s-title" tabIndex={0}
                      onMouseEnter={() => { setPeekOpen(s.sessionId); void peekMessages(s); }}
                      onFocus={() => { setPeekOpen(s.sessionId); void peekMessages(s); }}
                      onMouseLeave={() => setPeekOpen(null)}>
                      {/* The one-line clamp lives on this inner span. `.s-title` is the
                          positioning context for the panel below and MUST stay
                          overflow:visible, or the panel gets clipped and the card stops
                          opening its message list at all. */}
                      <span className="s-title-t" title={s.title}>{subject(s.title)}</span>
                      {/* `peekOpen` gates visibility, `peeked` caches the fetched list —
                          a closed panel keeps its data so re-hovering opens instantly. */}
                      {peekOpen === s.sessionId && peeked.get(s.sessionId) && (
                        <div className="s-peek" role="tooltip"
                          onMouseEnter={() => void peekMessages(s)}>
                          <div className="s-peek-h">
                            全部用户消息
                            <span>
                              {peeked.get(s.sessionId)!.status === 'loading'
                                ? '载入中…'
                                : peeked.get(s.sessionId)!.messages.length + ' 条'}
                            </span>
                          </div>
                          {peeked.get(s.sessionId)!.status === 'loading'
                            ? <div className="s-peek-empty">读取中…</div>
                            : peeked.get(s.sessionId)!.messages.length === 0
                              ? <div className="s-peek-empty">该会话没有用户消息</div>
                              : (
                                <ol>
                                  {peeked.get(s.sessionId)!.messages.map((m, i) => (
                                    <li key={m.recordId || m.orderIndex + ':' + i}>
                                      {/* Click = open this session and scroll the ledger to
                                          THIS message, not just to its top.
                                          `stopPropagation` is REQUIRED: this button lives inside
                                          the card's own onClick, and `selectSession` clears
                                          `jumpTo` — without it the jump is set and then
                                          immediately wiped in the same event. */}
                                      <button type="button" className="s-msg"
                                        title={m.text.length > 1200 ? `全文 ${m.text.length} 字符，点击在账本中定位` : '在账本中定位这条消息'}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setPeekOpen(null);
                                          jumpToSessionRecord(s, m.recordId);
                                        }}>
                                        <span>{messageBody(m.text)}</span>
                                      </button>
                                    </li>
                                  ))}
                                </ol>
                              )}
                        </div>
                      )}
                    </div>
                  ) : <div className="s-title none">（无用户消息）</div>}
                  <div className="s-id" title={s.sessionId}>{s.sessionId}</div>
                  {/* Every claude-code session on this machine has no cwd (35/35), while
                      codex and dsh all do — so rendering the "unknown" dash here put the
                      same empty line on an entire source's cards. The session header still
                      shows it, where a single dash is informative rather than noise. */}
                  {s.cwd && <div className="s-path" title={s.cwd}>{s.cwd}</div>}
                  <div className="s-stats">
                    {/* Value and label are separate elements so the NUMBER can carry the
                        weight. As one string the whole line was the same dim grey, which
                        buried the only quantitative facts on the card. */}
                    <span><b>{s.recordCount}</b>记录</span>
                    <span><b>{s.turnCount}</b>turn</span>
                    <span><b>{s.stepCount}</b>step</span>
                    {diagCount(s.diagnostics) > 0 && (
                      <span className="warn"><b>{diagCount(s.diagnostics)}</b>异常</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {rows.length === 0 && <div className="empty">无匹配会话</div>}
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
                {/* A subagent's rollout has a parent; make the trip back one click. */}
                {sel.parentSessionId && (
                  <button type="button" className="link"
                    title={'打开父会话 ' + sel.parentSessionId}
                    onClick={() => void openSessionById(sel.parentSessionId!)}>
                    ← 返回父会话{sel.agentNickname ? '（' + sel.agentNickname + '）' : ''}
                  </button>
                )}
              </div>
              <CapabilityMatrix caps={sel.capabilities} diagnostics={sel.diagnostics} />
              <div className="head-meta">
                <span title={sel.cwd}>{sel.cwd ?? '—'}</span>
                {sel.cliVersion && <span className="badge">CLI {sel.cliVersion}</span>}
                <span>{fmtTime(sel.startedAt)}</span>
              </div>
            </header>
            <Timeline source={sel.source} sessionId={sel.sessionId} selected={selectedRecord}
              onJump={onTimelineJump}
              hiddenKinds={hiddenKinds} onToggleKinds={toggleKinds} />
            <div className="body-row">
              <Ledger session={sel} selected={selectedRecord?.recordId ?? null} onSelect={onLedgerSelect}
                jumpTo={jumpTo} onJumpDone={() => setJumpTo(null)}
                hiddenKinds={hiddenKinds} onRevealKind={revealKind}
                inspectorClosed={!inspOpen} onOpenInspector={() => setInspOpen(true)} />
              {inspOpen && (
                <>
                  <Resizer
                    width={inspWidth}
                    onChange={(w) => {
                      setInspWidth(w);
                      try { localStorage.setItem('trajview.inspectorWidth', String(w)); } catch {}
                    }} />
                  <Inspector session={sel} recordId={selectedRecord?.recordId ?? null} onSelect={jumpToRecord} width={inspWidth}
                    hasSession={hasSession} onOpenSession={(id) => void openSessionById(id)} />
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

/**
 * Card subject from a possibly very long first user message.
 *
 * Measured on this machine: the median first message is 37 characters, but the longest is
 * 7457 (a pasted spec). A fixed-width cut lands mid-word and reads as noise, so this
 * prefers, in order: the first non-blank line with markdown structure stripped, then the
 * first sentence of it, and only then a hard cut at a word boundary.
 *
 * The whole message is never returned here — it lives in the hover panel, which scrolls.
 */
function subject(text: string, max = 110): string {
  const firstLine = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  // Headings, quotes and bullets are document structure, not the subject of the request.
  const clean = firstLine.replace(/^[#>\-*+\s]+/, '').replace(/\*\*/g, '').trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const sentence = head.search(/[.。!?！？][)\]]?\s/);
  if (sentence > 20) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(' ');
  return (word > max * 0.5 ? head.slice(0, word) : head) + '…';
}

/**
 * Hover-panel body: keep far more than the card, and say so when it is cut.
 *
 * The panel is scrollable, so there is no layout reason to hide the rest — but a 7k pasted
 * spec would bury every other message, so it is capped with an explicit "已截断" marker and
 * the real length, rather than silently ending mid-sentence.
 */
function messageBody(text: string, max = 1200): string {
  const t = (text ?? '').replace(/\r\n/g, '\n');
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + '\n…（已截断，全文 ' + t.length + ' 字符）';
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
