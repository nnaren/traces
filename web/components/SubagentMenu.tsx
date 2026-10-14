import React, { useEffect, useRef, useState } from 'react';
import type { SubagentSummary } from '../lib/api';
import { fmtSpan, fmtTokens, sessionStatus, spanOf, subagentLabel } from '../lib/sessionHead';

/** Panel width, mirrored from `.submenu-pop` — the flip test needs it before the panel opens. */
const PANEL_W = 430;

/**
 * The session header's subagent menu: "N 个子智能体" on a conversation, the current
 * subagent's own name on a subagent's page, and the same list of children either way.
 *
 * The list is passed in already resolved by the server (see `api.subagents`) — this component
 * decides only how it is shown and when it closes. Two closures matter because the menu is
 * an absolute overlay on a page that scrolls underneath it:
 *
 *  - a pointer press anywhere OUTSIDE dismisses it, which is what every dropdown in the
 *    world does and what a user reaching for the ledger expects;
 *  - Escape dismisses it, because the toggle is a real button and keyboard users need a way
 *    out that does not require hitting the same control again.
 *
 * Presses INSIDE the panel are ignored, otherwise the first click on a row would both open
 * the subagent and be swallowed as an outside press.
 */
export function SubagentMenu({
  items, activeId, selfLabel, loading, error, onPick,
}: {
  /** The children of the session in view — on a subagent's page, its SIBLINGS. */
  items: SubagentSummary[];
  /** The session currently open, so the menu can mark where the user already is. */
  activeId: string;
  /** Shown in the toggle when the open session is itself one of the items. */
  selfLabel: string;
  loading: boolean;
  /** The list could not be read. Distinct from "this session has no subagents". */
  error?: boolean;
  onPick: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // `mousedown`, not `click`: a press that ends on another control must not first be
    // swallowed as an outside click here.
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /**
   * Which edge the panel grows from.
   *
   * The button sits right after the title, so it is normally near the LEFT of the header and
   * the panel wants to grow rightwards; anchoring it to the button's right edge instead sent
   * a 430px panel off the left of the window, where `.main`'s `overflow:hidden` clipped the
   * labels off. The flip is measured rather than assumed, because a long title pushes the
   * button far enough right that growing rightwards would be clipped at the other edge.
   */
  const [align, setAlign] = useState<'left' | 'right'>('left');
  useEffect(() => {
    if (!open) return;
    const b = btn.current?.getBoundingClientRect();
    if (b) setAlign(window.innerWidth - b.left < PANEL_W + 24 ? 'right' : 'left');
  }, [open]);

  // Switching sessions leaves the menu pointing at a list that no longer exists; a stale
  // panel over the new header is worse than a closed one.
  useEffect(() => { setOpen(false); }, [items]);

  // On a subagent's own page the toggle carries ITS name (that is the control that switches
  // between siblings); on a conversation it carries the count of what it will reveal.
  const trigger = activeId && items.some((i) => i.sessionId === activeId)
    ? selfLabel
    : `${items.length} 个子智能体`;

  /**
   * A failed read keeps the control VISIBLE and disabled, with the cause in its tooltip.
   *
   * Hiding it would leave a session that really does have subagents looking exactly like one
   * that has none, and the usual reason is a server started before this endpoint existed —
   * a dead control with no message is the one state that gives the reader nothing to act on.
   */
  if (error && items.length === 0) {
    return (
      <div className="submenu">
        <button type="button" className="submenu-btn bad" disabled
          title={'读取子智能体列表失败：服务未重启到最新代码时，该接口返回 404。重启 npm start 后刷新页面。'}>
          <span className="submenu-lbl">子智能体列表读取失败</span>
        </button>
      </div>
    );
  }

  return (
    <div className="submenu" ref={box}>
      <button type="button" ref={btn} className={'submenu-btn' + (open ? ' on' : '')}
        aria-expanded={open} aria-haspopup="true"
        title={items.length + ' 个子智能体，点击切换'}
        onClick={() => setOpen((v) => !v)}>
        <span className="submenu-lbl">{trigger}</span>
        <span className="submenu-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className={'submenu-pop align-' + align} role="menu">
          {loading && items.length === 0 && <div className="submenu-empty">载入中…</div>}
          {!loading && items.length === 0 && <div className="submenu-empty">没有子智能体</div>}
          {items.map((s) => {
            const span = spanOf(s);
            const done = sessionStatus(s) === 'done';
            const on = s.sessionId === activeId;
            return (
              <button type="button" key={s.sessionId} role="menuitem"
                className={'sub-row' + (on ? ' on' : '')}
                onClick={() => { setOpen(false); onPick(s.sessionId); }}
                title={s.sessionId + (done ? '' : ' · 来源没有记录结束时间')}>
                {/* Status dot, not a bullet: filled = the source wrote an end, hollow =
                    it did not. A spinning "running" animation here would be a claim the
                    store cannot support. */}
                <span className={'sub-dot ' + (done ? 'done' : 'open')} aria-hidden="true" />
                <span className="sub-main">
                  <span className="sub-label">{subagentLabel(s)}</span>
                  <span className="sub-meta">{subagentMeta(s, done)}</span>
                </span>
                <span className="sub-nums">
                  <span className="sub-tok">{fmtTokens(s.tokens)}</span>
                  <span className="sub-dur">{fmtSpan(span)}</span>
                </span>
                <span className="sub-go" aria-hidden="true">›</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The grey second line: what this child is, in the source's own terms.
 *
 * Depth is omitted when the source recorded none (28 of the 177 codex subagents on this
 * machine have a parent but no depth) rather than printed as a 0 that reads like "top level".
 */
function subagentMeta(s: SubagentSummary, done: boolean): string {
  const parts = ['# ' + (s.depth != null ? srcLabel(s.source) + ' · 深度 ' + s.depth : srcLabel(s.source))];
  parts.push(done ? '已完成' : '进行中');
  if (s.childCount > 0) parts.push(s.childCount + ' 个子代理');
  return parts.join(' · ');
}

function srcLabel(s: string): string {
  return s === 'codex' ? 'Codex' : s === 'claude-code' ? 'Claude' : 'DSH';
}
