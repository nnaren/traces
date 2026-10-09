import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readStable, splitLines, parseLine } from '../src/sources/stableRead.ts';
import type { RawLine } from '../src/types.ts';
import { cleanup, tempDir } from './helpers.ts';

const dir = await tempDir('stabletest');
afterAll(() => cleanup(dir));

describe('stable read against a concurrently appended file (P5)', () => {
  it('drops a trailing partial line instead of emitting it as complete', async () => {
    const p = path.join(dir, 'a.jsonl');
    await fs.writeFile(p, '{"a":1}\n{"b":2}\n{"c":');
    const lines = splitLines(await readStable(p).then((r) => r.text));
    expect(lines.map((l) => l.text)).toEqual(['{"a":1}', '{"b":2}']);
    // byte ranges must be contiguous and cover only complete lines
    expect(lines[1].byteEnd).toBe(lines[0].byteEnd + 8);
  });

  it('emits the whole line once it is complete', async () => {
    const p = path.join(dir, 'b.jsonl');
    await fs.writeFile(p, '{"a":1}\n');
    expect(splitLines(await readStable(p).then((r) => r.text))).toHaveLength(1);
  });

  it('returns only the committed prefix when the writer races us', async () => {
    const p = path.join(dir, 'c.jsonl');
    await fs.writeFile(p, '{"a":1}\n');
    // Simulate a race by appending during the read.
    const original = fs.readFile;
    const spy = async (...args: any[]) => {
      await fs.appendFile(p, '{"late":true}\n');
      return (original as any)(...args);
    };
    (fs as any).readFile = spy;
    try {
      const r = await readStable(p);
      // Either the append happened before our stat (then we see it) or we fall back to
      // the committed prefix — both are safe; what must NOT happen is a torn line.
      const lines = splitLines(r.text);
      for (const l of lines) expect(() => JSON.parse(l.text)).not.toThrow();
    } finally {
      (fs as any).readFile = original;
    }
  });

  it('records a parse error instead of throwing on a bad line', () => {
    const line: RawLine = { lineNo: 3, text: '{not json', byteStart: 0, byteEnd: 9 };
    expect(parseLine(line)).toBeUndefined();
    expect(line.parseError).toBeTruthy();
  });
});
