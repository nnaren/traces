import React from 'react';

/**
 * Minimal, safe Markdown renderer for assistant output.
 *
 * DSH renders assistant messages as real Markdown (inline code chips, bold, lists,
 * fenced blocks) rather than a <pre> dump. trajview ships no markdown dependency, so
 * this covers the subset agents actually emit. Everything is built as React elements —
 * there is no dangerouslySetInnerHTML anywhere, so raw HTML in a transcript can never
 * execute.
 *
 * Supported blocks: fenced code, ATX headings, ul/ol, blockquote, hr, paragraph.
 * Supported inline: `code`, **bold**, *italic*, ~~strike~~, [text](url).
 * Anything unrecognised falls through as literal text.
 */

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(~~[^~]+~~)|(\[[^\]]*\]\([^)]*\))/;

/** Parse one line of inline markdown into React nodes. */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = text;
  let i = 0;
  while (rest.length > 0) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) {
      out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    } else if (tok.startsWith('~~')) {
      out.push(<del key={k}>{inline(tok.slice(2, -2), k)}</del>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    } else {
      const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(tok);
      if (link) {
        // Only http(s) links are linkified; anything else stays inert text.
        const href = link[2];
        out.push(/^https?:\/\//i.test(href)
          ? <a key={k} href={href} target="_blank" rel="noreferrer noopener">{inline(link[1], k)}</a>
          : <span key={k}>{link[1]}</span>);
      } else {
        out.push(tok);
      }
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const nodes: React.ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = (key: string) => {
    if (!para.length) return;
    nodes.push(<p key={key}>{inline(para.join(' '), key)}</p>);
    para = [];
  };
  const flushList = (key: string) => {
    if (!list) return;
    const items = list.items.map((it, n) => <li key={`${key}-i${n}`}>{inline(it, `${key}-i${n}`)}</li>);
    nodes.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    list = null;
  };
  const flushAll = (key: string) => { flushPara(key); flushList(key); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const k = `l${i}`;

    // fenced code block
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flushAll(k);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^```\s*$/.test(lines[j])) body.push(lines[j++]);
      nodes.push(
        <pre key={k} className="md-code" data-lang={fence[1] || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      i = j;
      continue;
    }

    if (line.trim() === '') { flushAll(k); continue; }

    if (/^(?:---|___|\*\*\*)\s*$/.test(line)) { flushAll(k); nodes.push(<hr key={k} />); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll(k);
      const level = Math.min(6, heading[1].length);
      const Tag = ('h' + level) as keyof JSX.IntrinsicElements;
      nodes.push(<Tag key={k}>{inline(heading[2], k)}</Tag>);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushAll(k);
      nodes.push(<blockquote key={k}>{inline(quote[1], k)}</blockquote>);
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara(k);
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) { flushList(k); list = { ordered, items: [] }; }
      list.items.push((ul ?? ol)![1]);
      continue;
    }

    flushList(k);
    para.push(line.trim());
  }
  flushAll('tail');

  return <div className={'md ' + (className ?? '')}>{nodes}</div>;
}