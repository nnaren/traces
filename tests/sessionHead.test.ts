import { describe, expect, it } from 'vitest';
import {
  fmtSpan, fmtTokens, messageBody, sessionStatus, sessionTitle, spanOf, subject, subagentLabel,
} from '../web/lib/sessionHead.ts';

/**
 * What the session header says.
 *
 * The header replaced "sessionId as the title" with "first message as the title", so these
 * are the decisions that change what a reader sees at the top of every page: which text is
 * the title, what an unmeasured number looks like, and which name a subagent goes by.
 *
 * The fixtures are the real shapes on this machine — a DSH review session whose first
 * message starts `/ai001-code-review`, and subagents whose transcripts all open with the
 * same delegation boilerplate.
 */

/** The measured first message of the DSH review session the header screenshot came from. */
const DSH_FIRST = '/ai001-code-review \nrange_json: /home/10240493/CODE/bscode/v40/bpf/bps/code/pps/review_range.json\n\n请按 ruleset 评审';
/** Every DSH/Claude subagent transcript opens with its role prompt, which is NOT its name. */
const DELEGATION_PROMPT = '# Review Task Executor\n\nYou are a code review subagent for one `ReviewTask` from `code-review`…';

describe('sessionTitle', () => {
  it('titles a conversation with its first message', () => {
    expect(sessionTitle({ sessionId: 'session-c7b1', title: DSH_FIRST }))
      .toBe('/ai001-code-review');
  });

  /**
   * A session with no human turn has nothing better than its id, and 28 of the 177 codex
   * subagents here are exactly that. Falling back to the id is honest; showing an empty
   * header is not, and the id is printed in the properties row either way.
   */
  it('falls back to the id when there is no first message', () => {
    expect(sessionTitle({ sessionId: '019dbda3' })).toBe('019dbda3');
    expect(sessionTitle({ sessionId: '019dbda3', title: '   ' })).toBe('019dbda3');
  });

  it('prefers the spawn label over the id for a session that has one', () => {
    expect(sessionTitle({ sessionId: 'x', title: null, agentNickname: 'ReviewTask-3 SIP指标评审' }))
      .toBe('ReviewTask-3 SIP指标评审');
  });
});

describe('subagentLabel', () => {
  /**
   * THE reason the label wins over the first message: five children of one review session
   * share the same boilerplate prompt as their opening line. Titling them from it produces
   * five identical rows in the very menu whose job is telling them apart.
   */
  it('names a subagent by its spawn label, not by its delegation prompt', () => {
    expect(subagentLabel({ sessionId: 'c1', title: DELEGATION_PROMPT, agentNickname: 'ReviewTask-3 评审执行' }))
      .toBe('ReviewTask-3 评审执行');
  });

  it('falls back to the prompt when the source recorded no label', () => {
    expect(subagentLabel({ sessionId: 'c1', title: DELEGATION_PROMPT })).toBe('Review Task Executor');
  });

  it('falls back to the id when the source recorded neither', () => {
    expect(subagentLabel({ sessionId: 'c1' })).toBe('c1');
  });
});

describe('subject', () => {
  it('takes the first non-blank line and strips markdown structure', () => {
    expect(subject('# heading\n\nbody')).toBe('heading');
    expect(subject('\n\n- bullet item')).toBe('bullet item');
  });

  it('keeps a pasted 7457-character spec to one readable line', () => {
    const long = 'x'.repeat(7457);
    const out = subject(long);
    expect(out.length).toBeLessThanOrEqual(111);
    expect(out.endsWith('…')).toBe(true);
  });

  it('prefers a sentence boundary over a mid-word cut', () => {
    // Only reachable once the text is too long to show whole: a short message is returned
    // as-is, because truncating it would lose information for nothing.
    const text = '先把这次评审的范围和规则说清楚，然后再看每一条结论对不对得上。' + '补充说明。'.repeat(40);
    expect(subject(text).endsWith('。')).toBe(true);
    expect(subject(text).length).toBeLessThanOrEqual(111);
  });

  it('does not let a leading sentence fragment swallow the whole title', () => {
    // A period in the first 20 characters is abbreviation-like, not a sentence end.
    expect(subject('e.g. review the change set and report findings')).toContain('review');
  });
});

describe('messageBody', () => {
  it('says so when it truncates, and by how much', () => {
    const body = messageBody('y'.repeat(5000));
    expect(body).toContain('已截断');
    expect(body).toContain('5000');
  });

  it('leaves a short message untouched', () => {
    expect(messageBody('short')).toBe('short');
  });
});

describe('fmtTokens', () => {
  it('uses the compact forms the menu shows', () => {
    expect(fmtTokens(0)).toBe('0 tok');
    expect(fmtTokens(999)).toBe('999 tok');
    expect(fmtTokens(42700)).toBe('42.7K tok');
    expect(fmtTokens(762000)).toBe('762K tok');
    expect(fmtTokens(18_500_000)).toBe('18.5M tok');
    expect(fmtTokens(5_200_000)).toBe('5.2M tok');
  });

  /**
   * A source that logs no usage has reported nothing, which is NOT the same as having
   * reported zero — every claude-code session in this store is the first case, and printing
   * "0 tok" would be a fact none of the three sources actually stated.
   */
  it('renders an unmeasured total as the dash, never as 0', () => {
    expect(fmtTokens(null)).toBe('—');
    expect(fmtTokens(undefined)).toBe('—');
    expect(fmtTokens(NaN)).toBe('—');
    expect(fmtTokens(0)).not.toBe('—');
  });
});

describe('fmtSpan', () => {
  it('reads as two units, the way a waiting reader counts', () => {
    expect(fmtSpan(14_000)).toBe('14秒');
    expect(fmtSpan(85_000)).toBe('1分25秒');
    expect(fmtSpan(129_000)).toBe('2分09秒');
    expect(fmtSpan(1_346_000)).toBe('22分26秒');
    expect(fmtSpan(4_800_000)).toBe('1时20分');
    expect(fmtSpan(267_000_000)).toBe('3天2时');
  });

  it('never rounds a sub-minute span down to nothing', () => {
    expect(fmtSpan(300)).toBe('<1秒');
  });

  it('renders an unknown or negative span as the dash', () => {
    expect(fmtSpan(null)).toBe('—');
    expect(fmtSpan(-1)).toBe('—');
  });
});

describe('spanOf / sessionStatus', () => {
  it('measures a closed session between its own timestamps', () => {
    expect(spanOf({ startedAt: 1_000, endedAt: 131_000 })).toBe(130_000);
  });

  it('measures an open one up to now, so a running subagent still shows elapsed time', () => {
    expect(spanOf({ startedAt: 1_000, endedAt: null }, 61_000)).toBe(60_000);
  });

  it('cannot measure a session that never recorded a start', () => {
    expect(spanOf({})).toBeNull();
  });

  /**
   * `ended_at` absent means the source wrote no end — which is not the same claim as "this
   * agent is still working". 18 of the 195 codex subagents here are in that state, so the
   * menu must not present them as live.
   */
  it('distinguishes "recorded an end" from "never recorded one"', () => {
    expect(sessionStatus({ endedAt: 5 })).toBe('done');
    expect(sessionStatus({ endedAt: null })).toBe('open');
    expect(sessionStatus({})).toBe('open');
  });
});
