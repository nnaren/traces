import React, { useMemo, useState } from 'react';

/**
 * Structured JSON viewer for tool payloads, following DSH's `JsonTree` idea
 * (collapsible nodes, per-type colouring) without depending on its internal package.
 *
 * Tool arguments are the one place where flat text really hurts: a `bash` call carries
 * a single long `command`, while a `read` carries path/offset/limit, and nested
 * options read far better as a tree than as one escaped line.
 *
 * Values are rendered as React text nodes — never injected as HTML.
 */

type Node = { key: string; value: unknown };

function kindOf(v: unknown): 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return t as any;
  return 'object';
}

/** Long scalars would flood the panel, so they truncate until expanded. */
const LONG = 220;

function Scalar({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  const k = kindOf(value);
  if (k === 'string') {
    const s = value as string;
    if (s.length > LONG && !open) {
      return (
        <span className="jt-str">
          <span title={s}>“{s.slice(0, LONG)}…”</span>
          <button className="jt-more" onClick={() => setOpen(true)}>展开</button>
        </span>
      );
    }
    return <span className="jt-str">“{s}”</span>;
  }
  if (k === 'number') return <span className="jt-num">{String(value)}</span>;
  if (k === 'boolean') return <span className="jt-bool">{String(value)}</span>;
  return <span className="jt-null">null</span>;
}

function Branch({ label, value, depth, defaultOpen }: {
  label: React.ReactNode; value: unknown; depth: number; defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const k = kindOf(value);
  const entries: Node[] = Array.isArray(value)
    ? (value as unknown[]).map((v, i) => ({ key: String(i), value: v }))
    : Object.entries(value as object).map(([kk, v]) => ({ key: kk, value: v }));
  const size = k === 'array' ? (value as unknown[]).length : Object.keys(value as object).length;

  return (
    <div className="jt-node">
      <button className="jt-row jt-branch" onClick={() => setOpen(!open)} aria-expanded={open}>
        <i className={'jt-caret' + (open ? ' open' : '')} />
        {label}
        <span className="jt-size">{k === 'array' ? `[${size}]` : `{${size}}`}</span>
      </button>
      {open && (
        <div className="jt-children">
          {entries.map((e) => (
            <Entry key={e.key} node={e} depth={depth + 1} />
          ))}
          {size === 0 && <span className="jt-empty">（空）</span>}
        </div>
      )}
    </div>
  );
}

function Entry({ node, depth }: { node: Node; depth: number }) {
  const k = kindOf(node.value);
  const key = <span className="jt-key">{node.key}</span>;
  if (k === 'array' || k === 'object') {
    // Deep levels start collapsed so a big payload stays scannable.
    return <Branch label={key} value={node.value} depth={depth} defaultOpen={depth < 1} />;
  }
  return (
    <div className="jt-row">
      <span className="jt-indent" />
      {key}
      <span className="jt-colon">:</span>
      <Scalar value={node.value} />
    </div>
  );
}

export function JsonTree({ text, defaultDepth = 1 }: { text: string; defaultDepth?: number }) {
  const parsed = useMemo(() => {
    try { return { ok: true as const, value: JSON.parse(text) }; }
    catch { return { ok: false as const, value: null }; }
  }, [text]);

  // Not JSON (some sources pass bare strings). Show it as-is rather than pretending.
  if (!parsed.ok) {
    return <pre className="code tall">{text}</pre>;
  }

  const k = kindOf(parsed.value);
  if (k !== 'array' && k !== 'object') {
    return (
      <div className="jt-root">
        <div className="jt-row"><span className="jt-indent" /><Scalar value={parsed.value} /></div>
      </div>
    );
  }

  const entries: Node[] = k === 'array'
    ? (parsed.value as unknown[]).map((v, i) => ({ key: String(i), value: v }))
    : Object.entries(parsed.value as object).map(([kk, v]) => ({ key: kk, value: v }));

  return (
    <div className="jt-root">
      {entries.length === 0 && <span className="jt-empty">（空对象）</span>}
      {entries.map((e) => <Entry key={e.key} node={e} depth={0} />)}
    </div>
  );
}