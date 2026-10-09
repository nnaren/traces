import React, { useEffect, useState } from 'react';
import { api, fmtDur, fmtTime, type RecordRow, type SessionRow } from '../lib/api';

export function Inspector({ session, recordId }: { session: SessionRow; recordId: string | null }) {
  const [rec, setRec] = useState<RecordRow | null>(null);
  const [tab, setTab] = useState<'summary' | 'detail'>('detail');

  useEffect(() => {
    if (!recordId) { setRec(null); return; }
    api.record(session.source, session.sessionId, recordId).then(setRec).catch(() => setRec(null));
  }, [recordId, session.source, session.sessionId]);

  if (!rec) return <aside className="inspector empty-state">选择账本中的一条记录以查看详情</aside>;

  const encrypted = rec.flags.includes('reasoning-encrypted');

  return (
    <aside className="inspector">
      <div className="insp-head">
        <span className={'kind ' + rec.kind}>{rec.kind}</span>
        <span className="idx">#{rec.orderIndex}</span>
        {rec.toolName && <span className="badge">{rec.toolName}</span>}
        {rec.callId && <span className="badge" title={rec.callId}>call {rec.callId.slice(0, 10)}</span>}
        {rec.isError && <span className="badge err">错误</span>}
        <span className="spacer" />
        <span className="muted">{fmtDur(rec.timeSeconds)}</span>
      </div>

      <div className="kv">
        {rec.startedAt && <><span>开始</span><code>{fmtTime(rec.startedAt)}</code></>}
        <span>时长</span><code>{fmtDur(rec.timeSeconds)}</code>
        {rec.sourceSeq && <><span>源序号</span><code>{rec.sourceSeq}</code></>}
      </div>

      {rec.usage && (
        <div className="usage">
          <div className="usage-head">
            usage · scope=<b>{rec.usage.scope}</b> · 缓存口径=<b>{rec.usage.cacheSemantics}</b>
            {rec.usage.crossSourceComparable === false && <span className="warn" title="口径不同，不可与其它源直接相加">· 不可跨源相加</span>}
          </div>
          <div className="usage-grid">
            <Metric label="输入" v={rec.usage.inputTokens} />
            <Metric label="缓存读" v={rec.usage.cachedInputTokens} />
            <Metric label="缓存写" v={rec.usage.cacheWriteInputTokens} />
            <Metric label="输出" v={rec.usage.outputTokens} />
            <Metric label="推理" v={rec.usage.reasoningTokens} />
            <Metric label="合计" v={rec.usage.totalTokens} />
          </div>
        </div>
      )}

      {rec.flags.length > 0 && (
        <div className="flags-detail">{rec.flags.map((f) => <span key={f} className="chip">{f}</span>)}</div>
      )}

      {encrypted && (
        <div className="note">
          该源的思维链内容为加密存储，无法展示。这里只显示其存在性与字节数（见「输出」标签页）。
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}>摘要</button>
        <button className={tab === 'detail' ? 'on' : ''} onClick={() => setTab('detail')}>输出</button>
      </div>

      <pre className="code">
        {tab === 'summary'
          ? (rec.summary || '（空）')
          : (rec.detail ?? rec.summary ?? '（无详情）')}
      </pre>
    </aside>
  );
}

function Metric({ label, v }: { label: string; v: number | null | undefined }) {
  return <div className={'metric' + (v === null || v === undefined ? ' unknown' : '')}>
    <span>{label}</span><b>{v === null || v === undefined ? '—' : v}</b>
  </div>;
}
