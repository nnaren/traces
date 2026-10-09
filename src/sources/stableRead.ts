/**
 * Stable reads against files another process is appending to (P5).
 *
 * Mirrors DSH `readStableJsonlFile` (session-persistence-jsonl/src/generation.ts):
 *   before = stat(path); bytes = read(path); after = stat(path)
 *   if identity(before) == identity(after) -> accept
 *   else retry once; if it changed again, accept only the committed prefix.
 *
 * Trailing partial lines are never handed to the parser as complete lines.
 */
import { promises as fs } from 'node:fs';
import type { RawLine } from '../types.ts';

export function fileIdentity(st: {
  dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number;
}): string {
  return [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':');
}

export interface StableReadResult {
  text: Buffer;
  revision: string;
  /** True when we had to fall back to the committed prefix because the writer raced us. */
  raced: boolean;
}

/**
 * Read a file such that the returned bytes are always a prefix that the writer had
 * already committed. Never returns a half-written final line as if it were complete.
 */
export async function readStable(path: string): Promise<StableReadResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await fs.stat(path);
    const text = await fs.readFile(path);
    const after = await fs.stat(path);
    if (fileIdentity(before) === fileIdentity(after)) {
      return { text, revision: fileIdentity(after), raced: false };
    }
    if (attempt === 1) {
      // Writer is still moving. Keep only the prefix that was committed at `before`.
      return {
        text: text.subarray(0, before.size),
        revision: fileIdentity(before),
        raced: true,
      };
    }
  }
  throw new Error('unreachable');
}

/** Split a byte buffer into complete lines, reporting byte ranges. */
export function splitLines(buf: Buffer): RawLine[] {
  const out: RawLine[] = [];
  let start = 0;
  let lineNo = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      const end = i + 1;
      out.push({ lineNo: lineNo++, text: buf.toString('utf8', start, i), byteStart: start, byteEnd: end });
      start = end;
    }
  }
  // NOTE: a trailing fragment without '\n' is intentionally dropped — it is a
  // partially-written line, not data. Re-reading later will pick it up whole.
  return out;
}

export function parseLine(line: RawLine): any | undefined {
  const trimmed = line.text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    line.parseError = err instanceof Error ? err.message : String(err);
    return undefined;
  }
}
