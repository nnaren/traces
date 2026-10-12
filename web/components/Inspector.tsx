import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtDur, splitToolLabel, type RecordRow, type SessionRow, type SiblingTool, type StepRow, type TurnRow } from '../lib/api';
import { Markdown } from './Markdown';
import { JsonTree } from './JsonTree';
import { subagentRefs } from '../lib/subagent';

/**
 * Record inspector, following the DSH `ui-trajectory` inspector:
 *   header  kind badge + 第 N 轮 · 第 M 步
 *   tabs    概述 / 预览 / 原始内容
 *   概述    来源 · 状态 · Token · 请求计时
 *   预览    思考 · 输入 · 输出
 *
 * Timing lives on the STEP (one step is one model call), so a record that belongs to a
 * step borrows that step's TTFT / decode / throughput. Anything the source never recorded
 * renders as "—" — a missing measurement is never filled with a guess.
 */

const KIND_LABEL: Record<string, string> = {
  system: '系统', user: '用户', context: '上下文', compacted: '压缩',
  message: '助手', reasoning: '推理', tool: '工具', subtool: '子工具',
  'request-header': '请求头', 'turn-end': '轮次结束', 'session-end': '会话结束',
};

/**
 * Display number for a turn/step. DSH restarts its step counter inside every turn, so the
 * source's own number wins; `turnIndex+1` / `stepIndex+1` is only the fallback for sources
 * that declare no numbering (Claude Code, Codex).
 */
const turnNo = (idx?: number, id?: string) => id ?? (idx != null ? String(idx + 1) : '—');
const stepNo = (idx?: number, id?: string) => id ?? (idx != null ? String(idx + 1) : '—');

type Tab = 'overview' | 'preview' | 'raw' | 'input' | 'output' | 'schema' | 'timing';

export function Inspector({ session, recordId, onSelect, width, hasSession, onOpenSession }: {
  session: SessionRow; recordId: string | null; onSelect?: (recordId: string) => void;
  /** Pixel width override applied as an inline style. Falls back to the CSS default. */
  width?: number;
  /** Whether a subagent id resolves to a session we can open; gates the jump link. */
  hasSession?: (sessionId: string) => boolean;
  /** Open another session (a subagent's own trajectory) without leaving the app. */
  onOpenSession?: (sessionId: string) => void;
}) {
  const [rec, setRec] = useState<(RecordRow & { siblings?: SiblingTool[] }) | null>(null);
  const [step, setStep] = useState<StepRow | null>(null);
  const [turn, setTurn] = useState<TurnRow | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  // Collapsible sections. 工具调用 is intentionally absent: it is always shown.
  const [open, setOpen] = useState<Record<string, boolean>>({
    source: true, timing: true, thinking: true,
  });

  useEffect(() => {
    if (!recordId) { setRec(null); setStep(null); setTurn(null); return; }
    let alive = true;
    setRec(null); setStep(null); setTurn(null);
    api.record(session.source, session.sessionId, recordId).then((r) => {
      if (!alive) return;
      setRec(r);
      // Timing/TTFT/reasoning belong to the step, and the source's own turn/step
      // numbers live on the turn/step rows — pull the session once to find both.
      if (r.stepIndex != null || r.turnIndex != null) {
        api.session(session.source, session.sessionId).then((s) => {
          if (!alive) return;
          setStep(r.stepIndex != null
            ? s.steps.find((x) => x.step_index === r.stepIndex) ?? null : null);
          setTurn(r.turnIndex != null
            ? s.turns.find((x) => x.turn_index === r.turnIndex) ?? null : null);
        }).catch(() => {});
      }
    }).catch(() => { if (alive) setRec(null); });
    return () => { alive = false; };
  }, [recordId, session.source, session.sessionId]);

  const timing = useMemo(() => computeTiming(rec, step), [rec, step]);
  const tools = rec?.siblings ?? [];
  const isTool = rec?.kind === 'tool' || rec?.kind === 'subtool';
  const turnId = turn?.source_turn_id;
  const stepId = step?.source_step_id;

  // Switching between a tool row and a prose row must not strand the panel on a tab
  // that record kind does not have. This hook MUST stay above the early return below —
  // a hook after a conditional return changes the hook order and React throws.
  useEffect(() => { setTab('overview'); }, [rec?.recordId]);

  if (!rec) {
    return <aside className="inspector empty-state" style={width ? { width } : undefined}>选择账本中的一条记录以查看详情</aside>;
  }

  // Encrypted reasoning no longer produces its own record, so the flag may be absent:
  // the authoritative signal is the step's declared availability.
  const stepReasoning = parseJson<any>(step?.reasoning_json, null);
  // A 推理 block carries its own thinking as content, so neither the flag nor the step's
  // copy should raise an encryption notice on it.
  const encrypted = rec.kind !== 'reasoning'
    && (rec.flags.includes('reasoning-encrypted') || stepReasoning?.availability === 'encrypted');
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const sec = (key: string, title: string, extra?: React.ReactNode, children?: React.ReactNode) => (
    <section className="insp-sec">
      <button className="insp-sec-head" onClick={() => toggle(key)} aria-expanded={!!open[key]}>
        <i className={'caret' + (open[key] ? ' open' : '')} />
        <span>{title}</span>
        {extra}
      </button>
      {open[key] && children}
    </section>
  );

  return (
    <aside className="inspector" style={width ? { width } : undefined}>
      <div className="insp-head">
        <span className={'kind ' + rec.kind}>{KIND_LABEL[rec.kind] ?? rec.kind}</span>
        <span className="idx">
          {rec.turnIndex != null && <>第 {turnNo(rec.turnIndex, turnId)} 轮</>}
          {rec.stepIndex != null && <> · 第 {stepNo(rec.stepIndex, stepId)} 步</>}
          {rec.turnIndex == null && rec.stepIndex == null && <>#{rec.orderIndex}</>}
        </span>
        {rec.isError && <span className="badge err">错误</span>}
        {rec.flags.length > 0 && <span className="badge warn">{rec.flags.length} 标记</span>}
        <span className="spacer" />
        <button className="insp-close" title="清除选择" onClick={() => window.dispatchEvent(new Event('trajview:clear-selection'))}>✕</button>
      </div>

      {/* Both kinds open on 概述. Its content grows a kind-specific section (助手 gets a
          预览, a tool gets 参数 + 结果) so the common facts stay on one screen. */}
      <div className="tabs insp-tabs">
        {isTool ? (
          <>
            <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>概述</button>
            <button className={tab === 'input' ? 'on' : ''} onClick={() => setTab('input')}>参数</button>
            <button className={tab === 'output' ? 'on' : ''} onClick={() => setTab('output')}>结果</button>
            <button className={tab === 'schema' ? 'on' : ''} onClick={() => setTab('schema')}>Schema</button>
            <button className={tab === 'timing' ? 'on' : ''} onClick={() => setTab('timing')}>计时</button>
          </>
        ) : (
          <>
            <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>概述</button>
            <button className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>预览</button>
            <button className={tab === 'raw' ? 'on' : ''} onClick={() => setTab('raw')}>原始内容</button>
          </>
        )}
      </div>

      {/* Rendered once, right under the tabs, rather than inside 结果: that section starts
          COLLAPSED and the 结果 tab is not the default, so a link placed there is invisible
          exactly when the user needs it. This way a subagent-spawning call always shows its
          jump link the moment the record opens, on every tab. */}
      {isTool && <SubagentLinks rec={rec} hasSession={hasSession} onOpenSession={onOpenSession} />}

      {tab === 'overview' && (
        <>
          {sec('source', '来源', rec.orderIndex != null ? <em className="muted">#{rec.orderIndex}</em> : undefined,
            <div className="kv">
              <span>类型</span><code>{KIND_LABEL[rec.kind] ?? rec.kind} · {rec.kind}</code>
              {rec.toolName && <><span>工具</span><code>{rec.toolName}</code></>}
              {rec.callId && <><span>callId</span><code>{rec.callId}</code></>}
              {rec.sourceSeq != null && <><span>源序号</span><code>{rec.sourceSeq}</code></>}
              {step?.model && <><span>模型</span><code>{step.model}</code></>}
              <span>轮次/步</span><code>{rec.turnIndex ?? '—'} / {rec.stepIndex ?? '—'}</code>
            </div>)}

          {sec('state', '状态', undefined,
            <div className="kv">
              <span>状态</span><code className={stateClass(rec)}>{stateLabel(rec)}</code>
              {step && <><span>边界</span><code>{step.boundary_confidence === 'explicit' ? '显式' : '推断'}</code></>}
            </div>)}

          {sec('token', 'Token', rec.usage ? <em className="muted">scope={rec.usage.scope}</em> : undefined,
            rec.usage ? (
              <>
                <div className="usage-grid">
                  <Metric label="输入" v={rec.usage.inputTokens} />
                  <Metric label="缓存读" v={rec.usage.cachedInputTokens} />
                  <Metric label="缓存写" v={rec.usage.cacheWriteInputTokens} />
                  <Metric label="输出" v={rec.usage.outputTokens} />
                  <Metric label="推理" v={rec.usage.reasoningTokens} />
                  <Metric label="合计" v={rec.usage.totalTokens} />
                </div>
                <div className="kv tight">
                  <span>缓存口径</span><code>{rec.usage.cacheSemantics}</code>
                  {rec.usage.crossSourceComparable === false && (
                    <><span>跨源</span><code className="warn">口径不同，不可与其它源相加</code></>
                  )}
                </div>
              </>
            ) : <div className="note">来源未记录 usage。</div>)}

          {sec('timing', '请求计时', <em className="muted">取自 step</em>,
            <div className="kv tight">
              <span>开始时间</span><code>{timing.start}</code>
              <span>总时长</span><code>{timing.total}</code>
              <span>首 token 延迟</span><code>{timing.ttft}</code>
              <span>生成</span><code>{timing.decode}</code>
              <span>吞吐量</span><code>{timing.throughput}</code>
            </div>)}

          {/* Kind-specific tail: a tool surfaces what it was called with and what came
              back; a message surfaces its own text. Both stay collapsible like the
              sections above. */}
          {isTool ? (
            <>
              {sec('arg', '参数', undefined, renderArgs(rec))}

              {sec('ret', '结果', <em className="muted">{fmtDur(rec.timeSeconds)}</em>,
                rec.tool?.outputText != null ? (
                  <pre className={'code' + (rec.isError ? ' err-code' : '')}>{rec.tool.outputText}</pre>
                ) : (
                  <div className="note">
                    {rec.flags.includes('unresolved-call')
                      ? '该调用没有对应结果（孤儿 call，已保留未丢弃）。'
                      : '来源未记录该调用的输出。'}
                  </div>
                ))}
            </>
          ) : (
            sec('pv', '预览', <em className="muted">完整内容见「预览」标签</em>,
              <PreviewBody rec={rec} step={step} tools={tools} encrypted={encrypted}
                open={open} toggle={toggle} onSelect={onSelect} />)
          )}
        </>
      )}

      {tab === 'preview' && <PreviewBody rec={rec} step={step} tools={tools} encrypted={encrypted} open={open} toggle={toggle} onSelect={onSelect} />}

      {tab === 'raw' && (
        <pre className="code tall raw">{rawJson(rec, step)}</pre>
      )}

      {tab === 'input' && renderArgs(rec)}

      {tab === 'output' && (
        rec.tool?.outputText != null ? (
          <pre className={'code tall' + (rec.isError ? ' err-code' : '')}>{rec.tool.outputText}</pre>
        ) : (
          <div className="note">
            {rec.flags.includes('unresolved-call')
              ? '该调用没有对应结果（孤儿 call，已保留未丢弃）。'
              : '来源未记录该调用的输出。'}
          </div>
        )
      )}

      {tab === 'schema' && (
        <div className="note">
          来源未记录工具 Schema。<br />
          本工具日志只保存了名称与参数：
          {rec.toolName ? <><br /><code>{rec.toolName}</code></> : null}
          {rec.tool?.parentCallId != null && <><br />父调用 <code>{rec.tool.parentCallId}</code>（嵌套深度 {rec.tool.depth ?? 0}）</>}
          {rec.tool?.depth ? <><br />嵌套深度 <code>{rec.tool.depth}</code></> : null}
        </div>
      )}

      {tab === 'timing' && (
        <>
          <div className="kv tight">
            <span>开始时间</span><code>{rec.tool?.startedAt ? fmtMs(rec.tool.startedAt) : (rec.startedAt ? fmtMs(rec.startedAt) : '—')}</code>
            <span>结束时间</span><code>{rec.tool?.endedAt ? fmtMs(rec.tool.endedAt) : '—'}</code>
            <span>总时长</span><code>{fmtDur(rec.timeSeconds)}</code>
          </div>
          {rec.tool?.durationMs == null && (
            <div className="note">来源未记录该调用的结束时间，因此时长不可得。</div>
          )}
          {rec.isError && <div className="note">该调用以错误结束。</div>}
        </>
      )}
    </aside>
  );
}

/**
 * Jump links from a tool call to the subagent conversation it drove.
 *
 * A Codex subagent is a session of its own, so the `agent_id` in `spawn_agent`'s result (or
 * in `wait_agent`'s `targets`) opens directly. Links are only rendered for ids that resolve
 * to a session we actually hold — a dead link is worse than no link, and an unresolved id
 * usually means the child rollout has not been ingested yet.
 */
function SubagentLinks({ rec, hasSession, onOpenSession }: {
  rec: RecordRow; hasSession?: (id: string) => boolean; onOpenSession?: (id: string) => void;
}) {
  if (!onOpenSession) return null;
  const refs = subagentRefs(rec).filter((r) => (hasSession ? hasSession(r.id) : true));
  if (refs.length === 0) return null;
  return (
    <div className="sub-jump">
      {refs.map((r) => (
        <button key={r.id} type="button" className="sub-jump-btn" title={'打开子 agent 会话 ' + r.id}
          onClick={() => onOpenSession(r.id)}>
          <span className="sub-jump-ico">↗</span>
          打开子 agent 会话
          {r.nickname ? <b> · {r.nickname}</b> : null}
          <code>{r.id.slice(0, 8)}…</code>
        </button>
      ))}
    </div>
  );
}

/**
 * 预览 = 思考（有则显示）+ 内容 + 工具调用。
 *
 * Rendered from one place and used twice — as the 概述 section and as the 预览 tab —
 * so the two can never drift apart. 工具调用 is always listed: it is what the assistant
 * DID, so folding it away only adds a click to the thing being inspected.
 */
function PreviewBody({ rec, step, tools, encrypted, open, toggle, onSelect }: {
  rec: RecordRow;
  step: StepRow | null;
  tools: SiblingTool[];
  encrypted: boolean;
  open: Record<string, boolean>;
  toggle: (k: string) => void;
  onSelect?: (recordId: string) => void;
}) {
  // A Codex `Reasoning` item is its own 推理 block, laid out exactly like a 助手 row.
  // Its text IS the thinking, so it is shown as the content directly — a 思考 collapse
  // around it would be a box inside a box saying the same thing twice.
  const isReasoning = rec.kind === 'reasoning';
  const thinkText = reasoningText(step) ?? '';
  const showThink = !isReasoning && (thinkText.trim().length > 0 || encrypted);
  const body = rec.detail ?? rec.summary ?? '（无输出）';

  return (
    <div className="preview">
      {showThink && (
        <div className="think">
          <button className="think-toggle" aria-expanded={!!open.thinking}
            onClick={() => toggle('thinking')}>
            <i className={'caret' + (open.thinking ? ' open' : '')} />
            思考
            {encrypted && <em className="muted">加密</em>}
          </button>
          {open.thinking && (
            <div className="think-quote">
              {encrypted
                ? <span className="muted">该源的思维链内容为加密存储，无法展示。仅显示其存在性与字节数。</span>
                : <Markdown text={thinkText} className="think-body" />}
            </div>
          )}
        </div>
      )}

      <Markdown className="preview-body" text={body} />

      <div className="calls">
        <div className="calls-head static">
          <span>工具调用</span>
          <em className="muted">{tools.length}</em>
        </div>
        {tools.length > 0 ? (
          <ul className="toolcalls">
            {tools.map((t) => (
              <li key={t.recordId} className={t.isError ? 'err' : ''}
                onClick={() => onSelect?.(t.recordId)}>
                <span className="tc-wrench">⚒</span>
                <span className="tc-name">{t.toolName ?? t.kind}</span>
                <span className="tc-args" title={t.summary}>{stripToolArgs(t.summary)}</span>
                <span className="tc-dur">{fmtDur(t.timeSeconds)}</span>
              </li>
            ))}
          </ul>
        ) : <div className="note">该 step 没有工具调用。</div>}
      </div>
    </div>
  );
}

function Metric({ label, v }: { label: string; v: number | null | undefined }) {
  return <div className={'metric' + (v === null || v === undefined ? ' unknown' : '')}>
    <span>{label}</span><b>{v === null || v === undefined ? '—' : v}</b>
  </div>;
}

function fmtMs(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function parseJson<T>(s: string | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function reasoningText(step: StepRow | null): string | undefined {
  const r = parseJson<any>(step?.reasoning_json, null);
  return r?.text;
}

/** DSH shows `bash {"command":…` — the tool name is already a separate column there. */
function stripToolArgs(summary: string): string {
  const { args } = splitToolLabel(summary);
  return args;
}

/**
 * The 参数 panel, shared by the overview section and the 输入 tab.
 *
 * A blank `inputRaw` has two very different meanings and must not be collapsed into one
 * message:
 *  - `missing-arguments` — the model/provider emitted `arguments: ""` and the tool layer
 *    reported an argument-level failure. The parameters never existed in the transcript and
 *    are NOT recoverable; saying only "来源未记录" hides an upstream data-loss bug behind a
 *    benign-sounding note.
 *  - anything else — a legitimately argument-less call, or a source that simply does not log
 *    inputs. The generic note is correct there.
 */
function renderArgs(rec: RecordRow) {
  if (rec.tool?.inputRaw) return <JsonTree text={rec.tool.inputRaw} />;
  if (rec.flags.includes('missing-arguments')) {
    return (
      <div className="note warn-note">
        上游模型未产出该调用的任何参数（<code>arguments</code> 为空字符串），工具层因此报参数解析失败。
        <br />
        这不是来源漏记，而是参数在生成阶段已丢失，<strong>无法从轨迹中恢复</strong>；下方「结果」为工具层的原始报错。
      </div>
    );
  }
  return <div className="note">来源未记录该调用的参数。</div>;
}

function stateLabel(rec: RecordRow): string {
  if (rec.isError) return '错误';
  if (rec.flags.includes('missing-arguments')) return '参数缺失';
  if (rec.flags.includes('running')) return '进行中';
  if (rec.flags.includes('partial')) return '未正常结束';
  if (rec.flags.includes('unresolved-call')) return '调用无结果';
  if (rec.flags.includes('unresolved-output')) return '结果无对应调用';
  return '已完成';
}
function stateClass(rec: RecordRow): string {
  if (rec.isError) return 'err';
  if (rec.flags.includes('missing-arguments')) return 'warn';
  if (rec.flags.includes('running') || rec.flags.includes('partial')) return 'warn';
  return '';
}

/**
 * Timing is a STEP property. A record only knows its own elapsed time, so anything not
 * carried by the step stays "—" instead of being approximated from the record.
 *
 * The block's start is `step/start`, NOT the record's own timestamp: an assistant
 * message lands when the response COMPLETES, so using its timestamp would show the end
 * of the call as its beginning (e.g. 10:48:57.551 instead of 10:48:53.800).
 */
function computeTiming(rec: RecordRow | null, step: StepRow | null) {
  const stepMs = step?.started_at != null && step?.ended_at != null
    ? step.ended_at - step.started_at : null;
  const total = stepMs ?? (rec?.timeSeconds != null ? rec.timeSeconds * 1000 : null);

  const ttft = step?.ttft_ms ?? null;
  const decode = step?.decode_ms ?? null;
  const out = rec?.usage?.outputTokens;
  const throughput = decode != null && decode > 0 && typeof out === 'number'
    ? (out / (decode / 1000)).toFixed(1) + ' tok/s' : '—';

  const startAt = step?.started_at ?? rec?.startedAt;

  return {
    start: startAt != null ? fmtMs(startAt) : '—',
    total: total != null ? (total / 1000).toFixed(2) + ' 秒' : '—',
    ttft: ttft != null ? (ttft / 1000).toFixed(2) + ' 秒' : '—',
    decode: decode != null ? (decode / 1000).toFixed(2) + ' 秒' : '—',
    throughput,
  };
}

function rawJson(rec: RecordRow, step: StepRow | null): string {
  return JSON.stringify({ record: rec, step }, null, 2);
}