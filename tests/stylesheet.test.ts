import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Structural sanity of the stylesheet.
 *
 * These are the checks that catch silent CSS corruption. A rule truncated mid-way — an
 * editor conflict, a sloppy line-filtering rewrite, a lost tail — does NOT throw anywhere:
 * the brace count can still balance because the following rules get absorbed as CSS
 * *nesting*, the page keeps working for most elements, and the only symptom is a handful of
 * controls rendering unstyled. That is exactly what happened with `.s-peek .s-msg`, whose
 * `padding/cursor/font` declarations vanished and left an unclosed brace.
 *
 * So the assertions are deliberately blunt: every declaration block must be well formed,
 * every rule must be preceded by a comment or a selector, and no selector may repeat.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.join(HERE, '..', 'web', 'styles.css');

/** Strip comments so comment text cannot be mistaken for a declaration. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const source = stripComments(readFileSync(CSS, 'utf8'));

/**
 * Stack-based walk: a nesting-free stylesheet never opens a brace while already inside a
 * rule. That single invariant is what a truncated rule violates — its missing `}` makes the
 * parser swallow the FOLLOWING rules as CSS nesting, which browsers accept and which
 * therefore fails silently rather than loudly.
 */
function scan(css: string) {
  const rules: Array<{ selector: string; body: string; context: string }> = [];
  const stack: Array<{ selector: string; start: number; isAt: boolean }> = [];
  let buf = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      const selector = buf.trim();
      buf = '';
      const isAt = selector.startsWith('@');
      if (stack.length && !stack[stack.length - 1].isAt) {
        // A brace inside a style rule = nesting = a swallowed/duplicated block.
        throw new Error(`nested block inside rule "${stack[stack.length - 1].selector}" `
          + `at offset ${stack[stack.length - 1].start} (selector "${selector}")`);
      }
      stack.push({ selector, start: i, isAt });
    } else if (ch === '}') {
      const top = stack.pop();
      if (!top) throw new Error(`stray "}" at offset ${i}`);
      if (!top.isAt) {
        rules.push({
          selector: top.selector,
          body: css.slice(top.start + 1, i).trim(),
          context: stack.map((s) => s.selector).join(' > '),
        });
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (stack.length) throw new Error(`${stack.length} unclosed block(s), innermost: ${stack[stack.length - 1].selector}`);
  return rules;
}

describe('styles.css structure', () => {
  const parsed = scan(source);

  it('has no unclosed, stray or nested braces once comments are stripped', () => {
    // `scan` throws on all three; reaching here means the walk completed cleanly.
    const opens = (source.match(/\{/g) ?? []).length;
    const closes = (source.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(parsed.length).toBeGreaterThan(80);
  });

  it('parses every rule with a non-empty selector and body', () => {
    for (const r of parsed) {
      expect(r.selector.length, `empty selector for {${r.body.slice(0, 40)}}`).toBeGreaterThan(0);
      // A selector that starts like a declaration is the tail of a truncated rule.
      expect(r.selector, `"${r.selector}" looks like a leftover declaration`).not.toMatch(/^[a-z-]+\s*:/i);
      expect(r.body.length, `empty body for ${r.selector}`).toBeGreaterThan(0);
    }
  });

  it('declares no duplicate selector inside the same at-rule context', () => {
    const seen = new Map<string, number>();
    for (const r of parsed) {
      const k = r.context + '||' + r.selector;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    // A repeat usually means a merge left both halves behind — the `.s-peek li` case.
    // Repeats across DIFFERENT media queries are legitimate.
    expect([...seen.entries()].filter(([, n]) => n > 1)).toEqual([]);
  });

  it('keeps the properties every interactive control needs', () => {
    // The specific regression: `.s-peek .s-msg` lost `padding/cursor/font` to a bad merge,
    // so the message buttons rendered as raw <button>s and were not clickable-looking.
    const msg = parsed.find((r) => r.selector === '.s-peek .s-msg');
    expect(msg, '.s-peek .s-msg rule is missing entirely').toBeTruthy();
    for (const prop of ['padding', 'cursor', 'font', 'background', 'border']) {
      expect(msg!.body, `.s-peek .s-msg lost ${prop}`).toContain(prop);
    }
  });

  it('keeps the 3-line clamp on the message text', () => {
    const span = parsed.find((r) => r.selector === '.s-peek .s-msg>span');
    expect(span).toBeTruthy();
    expect(span!.body).toContain('-webkit-line-clamp:3');
    expect(span!.body).toContain('display:-webkit-box');
    expect(span!.body).toContain('-webkit-box-orient:vertical');
  });

  it('does not clamp the hover panel itself (that would clip it away)', () => {
    // `.s-title` is the panel's positioning context: `overflow:hidden` there makes the card
    // stop opening its message list, which is a silent, total loss of the feature.
    const title = parsed.find((r) => r.selector === '.s-title');
    expect(title).toBeTruthy();
    expect(title!.body).not.toMatch(/overflow\s*:\s*hidden/);
    expect(title!.body).toContain('position:relative');
  });
});

describe('built bundle', () => {
  const assets = path.join(HERE, '..', 'web', 'dist', 'assets');

  it('ships a stylesheet whose braces balance', () => {
    const files = readdirSync(assets).filter((f) => f.endsWith('.css'));
    expect(files.length, 'no built CSS found — run npm run build:web').toBeGreaterThan(0);
    for (const f of files) {
      const css = readFileSync(path.join(assets, f), 'utf8');
      expect((css.match(/\{/g) ?? []).length, `${f} braces`).toBe((css.match(/\}/g) ?? []).length);
    }
  });

  it('index.html references assets that actually exist', () => {
    // A cached index.html pointing at a hash the last build deleted is the classic
    // "why is half the page unstyled" cause.
    const html = readFileSync(path.join(HERE, '..', 'web', 'dist', 'index.html'), 'utf8');
    const refs = [...html.matchAll(/\/assets\/([\w.-]+)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(readdirSync(assets), `${r} missing`).toContain(r);
  });
});