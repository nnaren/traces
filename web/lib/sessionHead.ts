/**
 * What the session header shows.
 *
 * The header is the one place in the app that has to answer "what am I looking at" without
 * the ledger being open, so its inputs are all derived here — from the first message, from
 * the spawn record, and from the counters — and nothing is decided inside the component.
 *
 * Kept free of React so the decisions (which text is a title, what an unknown looks like,
 * how a token count reads) are testable against fixtures instead of eyeballed in a browser.
 */

/** The parts of a session row the header text depends on. */
export interface HeaderSubject {
  sessionId: string;
  /** First REAL user message — a system prompt or injected context is not a subject. */
  title?: string | null;
  /** The spawn label: codex nickname, DSH catalog label, Claude description. */
  agentNickname?: string | null;
}

/**
 * Card/header subject from a possibly very long first user message.
 *
 * Measured on this machine: the median first message is 37 characters, but the longest is
 * 7457 (a pasted spec). A fixed-width cut lands mid-word and reads as noise, so this
 * prefers, in order: the first non-blank line with markdown structure stripped, then the
 * first sentence of it, and only then a hard cut at a word boundary.
 *
 * The whole message is never returned here — the full text is on the element's tooltip, and
 * the card's hover panel scrolls it.
 */
export function subject(text: string, max = 110): string {
  const firstLine = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  // Headings, quotes and bullets are document structure, not the subject of the request.
  const clean = firstLine.replace(/^[#>\-*+\s]+/, '').replace(/\*\*/g, '').trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  // Two passes, because the corpus is mostly Chinese. The first looks for a real sentence
  // break (punctuation followed by whitespace or the end); the second accepts the bare
  // punctuation, which is the only thing a continuous CJK line ever has. The `> 20` guard on
  // both is what keeps `e.g.` and `1.` from ending a title.
  const spaced = head.search(/[.。!?！？][)\]]?(\s|$)/);
  const idx = spaced > 20 ? spaced : head.search(/[.。!?！？]/);
  if (idx > 20) return head.slice(0, idx + 1);
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
export function messageBody(text: string, max = 1200): string {
  const t = (text ?? '').replace(/\r\n/g, '\n');
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + '\n…（已截断，全文 ' + t.length + ' 字符）';
}

/**
 * A root conversation's title: its first message.
 *
 * The id is the FALLBACK, not the title. Sessions with no human turn exist — 28 of the 177
 * codex subagents on this machine, and every session whose only "user" row is an injected
 * `<environment_context>` — and there the id is genuinely the best name available. It is
 * shown in the properties row regardless, so nothing is lost by preferring the message.
 */
export function sessionTitle(s: HeaderSubject): string {
  const text = (s.title ?? '').trim();
  if (text) return subject(text);
  if (s.agentNickname) return s.agentNickname;
  return s.sessionId;
}

/**
 * A subagent's name.
 *
 * The spawn label wins over the child's first message on purpose: a subagent transcript
 * STARTS with its delegation prompt, which is the same boilerplate for every sibling
 * ("# Review Task Executor …"), so using it as the name would make five children of one
 * review session read as five copies of the same row. The label is what the caller asked
 * for ("评审 ReviewTask-3"), and the prompt stays one click away in the ledger.
 */
export function subagentLabel(s: HeaderSubject): string {
  if (s.agentNickname) return s.agentNickname;
  const text = (s.title ?? '').trim();
  if (text) return subject(text);
  return s.sessionId;
}

/**
 * Token count in the compact form the subagent menu uses ("762K tok").
 *
 * `null`/unknown renders as the dash, never as `0`: a source that logs no usage (every
 * claude-code session in this store) has not reported a total of nothing, it has reported
 * nothing at all, and the two must not look the same.
 */
export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.round(n)} tok`;
  if (n < 1e6) return trim(n / 1e3, 100) + 'K tok';
  if (n < 1e9) return trim(n / 1e6, 100) + 'M tok';
  return trim(n / 1e9, 100) + 'G tok';
}
/** Three significant-ish digits: 762K, 42.7K, 18.5M — one decimal only while it matters. */
function trim(v: number, flat: number): string {
  return (v >= flat ? Math.round(v) : Math.round(v * 10) / 10).toString();
}

/**
 * Wall-clock span in the menu's own units ("14秒", "2分09秒", "1时20分", "3天4时").
 *
 * Two largest units, because that is how the eye reads a duration: "22分26秒" is exact,
 * while "21分" silently rounds off the part a user waiting on the subagent is watching.
 * An unknown span is the dash, like every other unknown here.
 */
export function fmtSpan(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = ms / 1000;
  if (s < 1) return '<1秒';
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  if (d > 0) return `${d}天${h}时`;
  if (h > 0) return `${h}时${m}分`;
  if (m > 0) return `${m}分${pad(sec)}秒`;
  return `${sec}秒`;
}

/** A session's span, from its own timestamps. Unknown either end → unknown span. */
export function spanOf(s: { startedAt?: number | null; endedAt?: number | null }, now = Date.now()): number | null {
  if (s.startedAt == null) return null;
  return (s.endedAt ?? now) - s.startedAt;
}

/**
 * Whether the source recorded an end for this session.
 *
 * `open` is deliberately NOT called "running": 18 of the 195 codex subagents on this machine
 * have no `ended_at`, and that means the log never wrote one — which is not the same claim
 * as "this agent is still working". The menu's tooltip says so.
 */
export function sessionStatus(s: { endedAt?: number | null }): 'done' | 'open' {
  return s.endedAt == null ? 'open' : 'done';
}
