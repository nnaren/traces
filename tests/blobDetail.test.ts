/**
 * Payload-storage invariants.
 *
 * Records carry raw per-source payloads as `detail_text`, or a sha256 blob ref when the
 * payload is larger than the threshold. The UI only ever shows a payload it can read back,
 * so the one invariant that must never break is:
 *
 *   a record that HAD a detailText must always be able to hand it back via recordDetail().
 *
 * That holds even when the blob cannot be written (read-only data dir, full disk, a
 * directory squatting the content-addressed path). Degrading to inline is correct;
 * silently losing the payload is not.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.ts';
import type { NormRecord, NormSession, SourceCapabilities } from '../src/types.ts';
import { cleanup, tempDir } from './helpers.ts';

const dir = await tempDir('blob');
afterAll(() => cleanup(dir));

const CAPS: SourceCapabilities = {
  reasoning: 'plaintext', usageGranularity: 'per-record', cacheSemantics: 'separate',
  cost: 'none', ttft: 'native', tokenTimeline: 'yes', toolDuration: 'derivable',
  subagentTree: 'none', ordering: 'seq', unknownEventPolicy: 'refuse',
};

function session(sessionId: string, detailText: string): NormSession {
  const record: NormRecord = {
    recordId: 'r0', kind: 'tool', orderIndex: 0, turnIndex: 0, stepIndex: 0,
    text: 'payload', detailText, timeSeconds: null, flags: [],
  };
  return {
    source: 'dsh', sessionId, capabilities: CAPS,
    turns: [{ turnIndex: 0, boundaryConfidence: 'explicit' }],
    steps: [{ stepIndex: 0, turnIndex: 0, boundaryConfidence: 'explicit' }],
    records: [record],
    diagnostics: {
      badLineCount: 0, unknownTypeCount: 0, unresolvedCallCount: 0, shadowedCount: 0,
      reopened: false, ttftMissingCount: 0, usageMissingCount: 0, parseErrors: [],
    },
  };
}

const detailOf = (s: Store, id: string) => {
  const row = s.getRecord('dsh', id, 'r0')!;
  return s.recordDetail(row);
};

describe('payload storage', () => {
  it('round-trips a payload larger than the threshold through a blob', async () => {
    const s = await Store.open(path.join(dir, 'big'));
    const big = 'x'.repeat(20 * 1024);
    s.writeSession(session('big', big), '/v', '/f');

    const row = s.getRecord('dsh', 'big', 'r0')!;
    expect(row.detail_text).toBeNull();          // spilled out of the row
    expect(row.detail_blob).toBeTruthy();       // and is addressable
    expect(detailOf(s, 'big')).toBe(big);       // ...and comes back intact
    s.close();
  });

  it('keeps a payload at or below the threshold inline', async () => {
    const s = await Store.open(path.join(dir, 'small'));
    const small = 'y'.repeat(1024);
    s.writeSession(session('small', small), '/v', '/f');

    const row = s.getRecord('dsh', 'small', 'r0')!;
    expect(row.detail_text).toBe(small);
    expect(row.detail_blob).toBeNull();
    expect(detailOf(s, 'small')).toBe(small);
    s.close();
  });

  it('treats exactly the threshold as inline and one byte more as a blob', async () => {
    const s = await Store.open(path.join(dir, 'edge'));
    const at = 'z'.repeat(16 * 1024);
    s.writeSession(session('at', at), '/v', '/f');
    expect(s.getRecord('dsh', 'at', 'r0')!.detail_blob).toBeNull();

    const over = 'z'.repeat(16 * 1024 + 1);
    s.writeSession(session('over', over), '/v', '/f');
    expect(s.getRecord('dsh', 'over', 'r0')!.detail_blob).toBeTruthy();
    expect(detailOf(s, 'over')).toBe(over);
    s.close();
  });

  // Regression: putBlob() swallowed write failures but still handed back the digest, so the
  // row recorded a blob ref that could never be read and the payload was simply gone.
  it('never loses a payload when the blob cannot be written', async () => {
    const bdir = path.join(dir, 'blocked');
    const store = await Store.open(bdir);
    store.close(); // creates bdir/blobs

    const payload = 'q'.repeat(20 * 1024);
    const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
    // Squat the content-addressed path with a directory so the blob write fails.
    await fs.mkdir(path.join(bdir, 'blobs', digest.slice(0, 2), digest), { recursive: true });

    const s = await Store.open(bdir);
    s.writeSession(session('blocked', payload), '/v', '/f');

    const row = s.getRecord('dsh', 'blocked', 'r0')!;
    // Whatever the store chose, the payload must still be readable.
    expect(row.detail_blob).toBeNull();       // could not store a blob -> must inline
    expect(detailOf(s, 'blocked')).toBe(payload);
    s.close();
  });

  it('never leaves a record with a detail that is neither inline nor addressable', async () => {
    const s = await Store.open(path.join(dir, 'inv'));
    for (const [id, len] of [['a', 0], ['b', 100], ['c', 16 * 1024], ['d', 40 * 1024]] as Array<[string, number]>) {
      s.writeSession(session(id, 'k'.repeat(len)), '/v', '/f');
    }
    for (const id of ['a', 'b', 'c', 'd']) {
      const row = s.getRecord('dsh', id, 'r0')!;
      expect(row.detail_text === null && row.detail_blob === null,
        `${id}: has detail_text=null and detail_blob=null`).toBe(false);
    }
    s.close();
  });
});