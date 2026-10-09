/**
 * DeepSeek Harness adapter — `<root>/--<projectKey>--/<sessionId>/session*.jsonl.zstd`
 *
 * The critical fact: the physical container is a CONCATENATION OF INDEPENDENT ZSTD
 * FRAMES, not a single stream. A standard decompressor may only decode the first
 * frame (risk #11), so we parse frame headers and block headers to walk exact
 * frame boundaries — mirroring DSH `scanZstdFrames` (session-persistence-jsonl/src/zstd.ts).
 *
 * Other measured facts:
 *  - `seq` is the authoritative order (dense, gap-free). `time` may repeat or go backwards.
 *  - Unknown event types MUST be refused unless `ignorable === true` (risk #12).
 *  - header `version` in the wild is 0, while the current writer constant is 3
 *    (deepseek-harness@ddefc45fbc, types.ts:88). We route on the PARSED header,
 *    never on the filename (R5).
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { SessionRef, SourceCapabilities, TrajectorySourceAdapter, RawLine } from '../types.ts';
import { parseLine } from './stableRead.ts';

export const DSH_CAPABILITIES: SourceCapabilities = {
  reasoning: 'plaintext',
  usageGranularity: 'per-record',
  cacheSemantics: 'separate',
  cost: 'none',
  ttft: 'derivable',
  tokenTimeline: 'yes',
  toolDuration: 'derivable',
  subagentTree: 'structural',
  ordering: 'seq',
  unknownEventPolicy: 'refuse',
};

const ZSTD_MAGIC = 0xfd2fb528;

/** Walk a concatenated-zstd buffer, returning the byte range of every complete frame. */
export function scanZstdFrames(buf: Buffer): { frames: Array<{ start: number; end: number }>; tornStart?: number } {
  const frames: Array<{ start: number; end: number }> = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) { off++; continue; }
    try {
      const len = frameLength(buf, off);
      // A frame is torn only when its declared length runs past EOF or its header is
      // malformed. A frame that ends exactly at EOF is COMPLETE and must be kept.
      if (len === undefined || off + len > buf.length) return { frames, tornStart: off };
      frames.push({ start: off, end: off + len });
      off += len;
    } catch {
      return { frames, tornStart: off };
    }
  }
  return { frames };
}

/** Exact byte length of the frame beginning at `start`, or undefined if malformed. */
function frameLength(buf: Buffer, start: number): number | undefined {
  let p = start + 4;
  if (p >= buf.length) return undefined;
  const descriptor = buf[p++];
  const fcsFlag = (descriptor >> 6) & 0b11;
  const singleSegment = (descriptor >> 5) & 0b1;
  const checksum = (descriptor >> 2) & 0b1;
  const didFlag = descriptor & 0b11;
  if (!singleSegment) p += 1;                                    // Window_Descriptor
  p += [0, 1, 2, 4][didFlag];                                     // Dictionary_ID
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  p += fcsSize;
  for (;;) {
    if (p + 3 > buf.length) return undefined;
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = (bh & 1) === 1;
    const type = (bh >> 1) & 0b11;
    const size = bh >>> 3;
    if (type === 3) return undefined;                             // reserved
    if (type === 1) { p += 1; }                                   // RLE: 1 content byte
    else if (size === 0) {
      // RFC 8878 §3.1.1.4.1 "Block_Size == 0" escape: the real size follows as
      // 1, 2 or 4 extra bytes (value + 256). Without this a legitimate small frame
      // looks like a torn one.
      const b0 = buf[p];
      if (b0 === undefined) return undefined;
      const width = b0 < 4 ? 1 : b0 < 8 ? 2 : b0 < 16 ? 4 : 0;
      if (width === 0) return undefined;
      let real = 0;
      for (let i = 0; i < width; i++) {
        const b = buf[p + 1 + i];
        if (b === undefined) return undefined;
        real += b * 256 ** i;
      }
      p += 1 + width + real;
    } else { p += size; }
    if (last) break;
  }
  if (checksum) p += 4;
  return p - start;
}

/** Decode every complete frame; a torn trailing frame yields only its committed prefix. */
export function decodeZstdConcatenation(buf: Buffer): { text: string; frameCount: number; truncated: boolean } {
  const { frames, tornStart } = scanZstdFrames(buf);
  const usable = tornStart === undefined ? frames : frames.filter((f) => f.start !== tornStart);
  const parts: string[] = [];
  let ok = 0;
  for (const f of usable) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'));
      ok++;
    } catch {
      // A corrupt MIDDLE frame must not kill the whole session (U-5.10).
    }
  }
  return { text: parts.join(''), frameCount: ok, truncated: tornStart !== undefined };
}

export const dshHome = (): string => process.env.TRAJVIEW_DSH_HOME ?? path.join(homedir(), '.dsh');

export const dshAdapter: TrajectorySourceAdapter = {
  id: 'dsh',
  capabilities: DSH_CAPABILITIES,

  async *discover(): AsyncIterable<SessionRef> {
    const base = path.join(dshHome(), 'sessions');
    let projects: string[] = [];
    try { projects = await fs.readdir(base); } catch { return; }
    for (const proj of projects) {
      const pdir = path.join(base, proj);
      const sessions = await fs.readdir(pdir).catch(() => []);
      for (const s of sessions.sort()) {
        const sdir = path.join(pdir, s);
        const files = await fs.readdir(sdir).catch(() => []);
        // Match every versioned filename form; route on the parsed header (R5).
        for (const f of files.sort()) {
          if (!f.endsWith('.jsonl.zstd') && !f.endsWith('.jsonl')) continue;
          const p = path.join(sdir, f);
          const st = await fs.stat(p).catch(() => undefined);
          yield {
            source: 'dsh',
            sessionId: s,
            path: p,
            cwd: decodeProjectKey(proj),
            byteSize: st?.size,
            revision: st ? [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':') : undefined,
          };
          break;
        }
      }
    }
  },

  async readAll(ref: SessionRef): Promise<RawLine[]> {
    const buf = await fs.readFile(ref.path);
    const { text } = ref.path.endsWith('.zstd') ? decodeZstdConcatenation(buf) : { text: buf.toString('utf8') };
    const out: RawLine[] = [];
    let start = 0;
    let lineNo = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        out.push({ lineNo: lineNo++, text: text.slice(start, i), byteStart: start, byteEnd: i + 1 });
        start = i + 1;
      }
    }
    return out;
  },

  isRelevant(raw: RawLine): boolean {
    const o = parseLine(raw);
    if (!o) return raw.parseError !== undefined;
    // The header line and all events are relevant; refusals happen in the normalizer.
    return true;
  },
};

/** `--media-vdc-NEW_CODE-x--` -> `/media/vdc/NEW_CODE/x` (best effort; lossy by design). */
export function decodeProjectKey(key: string): string | undefined {
  if (!key.startsWith('--') || !key.endsWith('--')) return undefined;
  const inner = key.slice(2, -2);
  return `/${inner.split('-').join('/')}`;
}
