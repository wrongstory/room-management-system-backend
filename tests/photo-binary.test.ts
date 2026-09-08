import { readFile } from 'node:fs/promises';
import { ImageMagick, MagickColors, MagickFormat } from '@imagemagick/magick-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkPhotoEnvelope, initializePhotoDecoder, PhotoError, PHOTO_MAX_BYTES, photoMime, readPhotoBody, verifyPhotoBinary } from '../src/modules/photos/photo-binary.js';

beforeAll(async () => { await initializePhotoDecoder(await readFile(new URL(import.meta.resolve('@imagemagick/magick-wasm/magick.wasm')))); });
const fixture = (mime: 'image/jpeg' | 'image/webp' = 'image/jpeg', width = 16, height = 16) =>
  ImageMagick.read(MagickColors.White, width, height, image => image.write(mime === 'image/jpeg' ? MagickFormat.Jpeg : MagickFormat.WebP, data => Uint8Array.from(data)));
function padJpeg(bytes: Uint8Array, size: number): Uint8Array {
  const chunks = [bytes.slice(0, 2)];
  let padding = size - bytes.length;
  while (padding > 0) {
    const n = Math.min(65537, padding);
    if (n < 4) throw new Error('fixture padding');
    const chunk = new Uint8Array(n); chunk.set([255, 254, (n - 2) >> 8, (n - 2) & 255]);
    chunks.push(chunk); padding -= n;
  }
  chunks.push(bytes.slice(2));
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
describe('independent server image verification', () => {
  it('decodes JPEG/WebP and rechecks stripped output/final digest deterministically', async () => {
    for (const mime of ['image/jpeg', 'image/webp'] as const) {
      const raw = fixture(mime), a = await verifyPhotoBinary(raw, mime), b = await verifyPhotoBinary(raw, mime);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/); expect(a).toEqual(b);
      expect(a.sizeBytes).toBe(a.bytes.length); checkPhotoEnvelope(a.bytes, mime, true);
    }
  });
  it('raw exact 307200 accepted; 307201 rejects before rescue compression', async () => {
    for (const n of [307199, 307200]) expect((await verifyPhotoBinary(padJpeg(fixture(), n), 'image/jpeg')).sizeBytes).toBeLessThan(n);
    await expect(verifyPhotoBinary(padJpeg(fixture(), 307201), 'image/jpeg')).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE' });
  });
  it('cancels oversized unknown/lying-length streams and rejects partial/empty bodies', async () => {
    for (const length of [null, '100']) {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(PHOTO_MAX_BYTES)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
      await expect(readPhotoBody(stream, length)).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE' });
      expect(cancelled).toBe(true);
    }
    const raw = fixture();
    expect(await readPhotoBody(new Response(raw).body, String(raw.length))).toEqual(raw);
    await expect(readPhotoBody(new Response(raw).body, '1')).rejects.toBeInstanceOf(PhotoError);
    await expect(readPhotoBody(new Response(new Uint8Array()).body, null)).rejects.toBeInstanceOf(PhotoError);
  });
  it('rejects trailing polyglot, truncated entropy, MIME disguise, RIFF mismatch and animation', async () => {
    const jpg = fixture(), webp = fixture('image/webp');
    for (const bytes of [new Uint8Array([...jpg, ...new TextEncoder().encode('<script/>')]), jpg.slice(0, -5), new Uint8Array([...jpg.slice(0, -8), 255, 217])]) {
      await expect(verifyPhotoBinary(bytes, 'image/jpeg')).rejects.toBeInstanceOf(PhotoError);
    }
    await expect(verifyPhotoBinary(jpg, 'image/webp')).rejects.toBeInstanceOf(PhotoError);
    await expect(verifyPhotoBinary(webp, 'image/jpeg')).rejects.toBeInstanceOf(PhotoError);
    const bad = webp.slice(); bad[4] = (bad[4] ?? 0) + 1;
    await expect(verifyPhotoBinary(bad, 'image/webp')).rejects.toBeInstanceOf(PhotoError);
    const animated = new Uint8Array(30); animated.set(new TextEncoder().encode('RIFF')); new DataView(animated.buffer).setUint32(4, 22, true);
    animated.set(new TextEncoder().encode('WEBPVP8X'), 8); animated[16] = 10; animated[20] = 2;
    await expect(verifyPhotoBinary(animated, 'image/webp')).rejects.toBeInstanceOf(PhotoError);
    expect(() => photoMime('image/jpeg; charset=utf8')).toThrow(PhotoError);
  });
  it('strips EXIF and rejects an oversized pixel header before decoding', async () => {
    const jpg = fixture();
    const exif = Uint8Array.from([255, 225, 0, 22, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const raw = new Uint8Array([...jpg.slice(0, 2), ...exif, ...jpg.slice(2)]);
    const result = await verifyPhotoBinary(raw, 'image/jpeg');
    expect(new TextDecoder().decode(result.bytes)).not.toContain('Exif');
    const bomb = jpg.slice();
    for (let i = 2; i < bomb.length - 9; i++) if (bomb[i] === 255 && bomb[i + 1] === 192) { bomb[i + 7] = 127; bomb[i + 8] = 255; break; }
    await expect(verifyPhotoBinary(bomb, 'image/jpeg')).rejects.toMatchObject({ code: 'PHOTO_DECODE_LIMIT_EXCEEDED' });
  });
});
