import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { scanZstdFrames, decodeZstdConcatenation } from '../src/sources/dsh.ts';

function frame(text: string): Buffer {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

describe('zstd frame concatenation (risk #11)', () => {
  it('walks every frame in a concatenated file', () => {
    const buf = Buffer.concat([frame('a\n'), frame('b\n'), frame('c\n')]);
    const { frames, tornStart } = scanZstdFrames(buf);
    expect(tornStart).toBeUndefined();
    expect(frames).toHaveLength(3);
    const { text, frameCount } = decodeZstdConcatenation(buf);
    expect(frameCount).toBe(3);
    expect(text).toBe('a\nb\nc\n');
  });

  it('a single-shot decompressor only sees the FIRST frame — proving the scan is needed', () => {
    const buf = Buffer.concat([frame('first\n'), frame('second\n')]);
    // node's zstdDecompressSync on the whole buffer yields only the first frame.
    expect(zlib.zstdDecompressSync(buf).toString()).toBe('first\n');
    expect(decodeZstdConcatenation(buf).text).toBe('first\nsecond\n');
  });

  it('drops a torn trailing frame but keeps everything committed', () => {
    const good = Buffer.concat([frame('x\n'), frame('y\n')]);
    const tail = frame('z'.repeat(400));           // large enough to truncate mid-frame
    const truncated = Buffer.concat([good, tail.subarray(0, tail.length - 6)]);
    const { text, truncated: wasTruncated } = decodeZstdConcatenation(truncated);
    expect(wasTruncated).toBe(true);
    expect(text).toBe('x\ny\n');
  });

  it('keeps a frame that ends exactly at EOF (complete, not torn)', () => {
    const buf = Buffer.concat([frame('p\n'), frame('q\n')]);
    const { frames, tornStart } = scanZstdFrames(buf);
    expect(tornStart).toBeUndefined();
    expect(frames[frames.length - 1].end).toBe(buf.length);
  });

  it('survives a corrupt middle frame instead of failing the session', () => {
    const good = Buffer.concat([frame('a\n'), frame('c\n')]);
    const bad = frame('b\n');
    bad[bad.length - 3] ^= 0xff; // corrupt the payload
    const buf = Buffer.concat([good, bad]);
    const { text } = decodeZstdConcatenation(buf);
    expect(text).toContain('a\n');
    expect(text).toContain('c\n');
  });
});
