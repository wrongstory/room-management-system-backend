import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const helper = '../scripts/photo-gzip.mjs';
const { canonicalGzipHeader, canonicalPhotoGzip } = await import(helper);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('portable pinned photo WASM gzip', () => {
  it('normalizes only OS/mtime without modifying input, payload, CRC or size trailer', () => {
    const original = gzipSync(Buffer.from('synthetic portable asset'), { level: 9 });
    const expected = canonicalPhotoGzip(Buffer.from('synthetic portable asset'));
    for (const os of [0, 3, 10, 255]) {
      const candidate = Buffer.from(original); candidate[9] = os; candidate.writeUInt32LE(123456, 4);
      const before = Buffer.from(candidate), result = canonicalGzipHeader(candidate);
      expect(result).toEqual(expected); expect(candidate).toEqual(before);
      expect(result.subarray(10)).toEqual(original.subarray(10));
      expect(Array.from(result.subarray(0, 10))).toEqual([31, 139, 8, 0, 0, 0, 0, 0, 2, 255]);
    }
    const flagged = Buffer.from(original); flagged[3] = 8;
    expect(() => canonicalGzipHeader(flagged)).toThrow('Unexpected photo gzip header');
    expect(() => canonicalGzipHeader(Buffer.alloc(10))).toThrow('Unexpected photo gzip header');
  });
  it('pins source and complete canonical compressed bytes, preserves decompression and detects corruption', () => {
    const wasm = readFileSync('node_modules/@imagemagick/magick-wasm/dist/x86/magick.wasm');
    expect(sha(wasm)).toBe('5a4ed1017eda113144c86ae839c22c610afebcfebfa22b1da18e00e98d78b0f7');
    const gzip = canonicalPhotoGzip(wasm);
    expect(gzip.length).toBe(5269861);
    expect(sha(gzip)).toBe('0ec87668655bced27afa7b39764f188fe16dc947d4fb37ea10e822112867121c');
    expect(gunzipSync(gzip).equals(wasm)).toBe(true);
    const corrupted = Buffer.from(gzip); corrupted[100] = (corrupted[100] ?? 0) ^ 1;
    expect(sha(canonicalGzipHeader(corrupted))).not.toBe(sha(gzip));
  });
});
