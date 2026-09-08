import { initializeImageMagick, MagickImage, MagickReadSettings, MagickFormat, ResourceLimits } from '@imagemagick/magick-wasm';

// 제품 크기 제한과 별개인, source-controlled decoder 자원 상한이다.
export const PHOTO_MAX_BYTES = 307200;
export const PHOTO_MAX_PIXELS = 4194304;
export const PHOTO_MAX_DIMENSION = 4096;
export const PHOTO_DECODE_BUDGET_MS = 1500;
export type PhotoMime = 'image/jpeg' | 'image/webp';
export class PhotoError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code); this.name = 'PhotoError';
  }
}
/** Pinned local build artifact only: no CDN/network fallback, exact compressed and decoded checksums. */
export async function initializeCompressedPhotoDecoder(compressed: Uint8Array): Promise<void> {
  const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength))), x => x.toString(16).padStart(2, '0')).join('');
  if (compressed.length !== 5269861 || await digest(compressed) !== '0ec87668655bced27afa7b39764f188fe16dc947d4fb37ea10e822112867121c') throw new PhotoError(503, 'PHOTO_DECODER_UNAVAILABLE');
  // A single bounded output buffer avoids Blob/Response concatenation and duplicate 15MB allocations at cold start.
  const stream = new ReadableStream<BufferSource>({ start(c) { c.enqueue(new Uint8Array(compressed.buffer as ArrayBuffer, compressed.byteOffset, compressed.byteLength)); c.close(); } }).pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader(), bytes = new Uint8Array(14828458); let offset = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      if (offset + result.value.length > bytes.length) { await reader.cancel(); throw new PhotoError(503, 'PHOTO_DECODER_UNAVAILABLE'); }
      bytes.set(result.value, offset); offset += result.value.length;
    }
  } finally { reader.releaseLock(); }
  if (offset !== bytes.length || await digest(bytes) !== '5a4ed1017eda113144c86ae839c22c610afebcfebfa22b1da18e00e98d78b0f7') throw new PhotoError(503, 'PHOTO_DECODER_UNAVAILABLE');
  await initializePhotoDecoder(bytes);
}
const invalid = (): never => { throw new PhotoError(400, 'INVALID_PHOTO_BINARY'); };
function byte(bytes: Uint8Array, index: number): number { const value = bytes[index]; if (value === undefined) return invalid(); return value; }
const tooLarge = (): never => { throw new PhotoError(413, 'PHOTO_TOO_LARGE'); };
export function photoMime(value: string | null): PhotoMime {
  if (value !== 'image/jpeg' && value !== 'image/webp') throw new PhotoError(415, 'PHOTO_MEDIA_TYPE_UNSUPPORTED');
  return value;
}

/** Content-Length는 증거가 아니다. 초과 chunk에서 cancel하고 decoder/provider는 호출하지 않는다. */
export async function readPhotoBody(stream: ReadableStream<Uint8Array> | null, contentLength: string | null): Promise<Uint8Array> {
  if (contentLength !== null && (!/^\d{1,10}$/.test(contentLength) || Number(contentLength) > PHOTO_MAX_BYTES)) tooLarge();
  if (!stream) return invalid();
  const reader = stream.getReader();
  const bytes = new Uint8Array(PHOTO_MAX_BYTES);
  let length = 0, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 5000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) invalid();
      if (length + value.byteLength > PHOTO_MAX_BYTES) { await reader.cancel(); tooLarge(); }
      bytes.set(value, length); length += value.byteLength;
    }
  } catch (error) {
    if (error instanceof PhotoError) throw error;
    throw new PhotoError(400, 'INVALID_PHOTO_BINARY');
  } finally { clearTimeout(timer); reader.releaseLock(); }
  if (timedOut) throw new PhotoError(408, 'PHOTO_BODY_TIMEOUT');
  if (!length || (contentLength !== null && Number(contentLength) !== length)) invalid();
  return bytes.slice(0, length);
}
function dimensions(width: number, height: number): void {
  if (width < 1 || height < 1 || width > PHOTO_MAX_DIMENSION || height > PHOTO_MAX_DIMENSION || width * height > PHOTO_MAX_PIXELS) {
    throw new PhotoError(413, 'PHOTO_DECODE_LIMIT_EXCEEDED');
  }
}
function jpegShape(b: Uint8Array, clean: boolean): void {
  if (b[0] !== 255 || b[1] !== 216) invalid();
  let p = 2, frames = 0, scans = 0;
  while (p < b.length) {
    if (b[p++] !== 255) invalid();
    while (b[p] === 255) p++;
    const marker = byte(b, p++);
    if (marker === 217) { if (p !== b.length || frames !== 1 || scans < 1) invalid(); return; }
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215)) invalid();
    if (p + 2 > b.length) invalid();
    const size = byte(b, p) * 256 + byte(b, p + 1);
    if (size < 2 || p + size > b.length) invalid();
    if (clean && (marker === 225 || marker === 237 || marker === 254)) invalid();
    if ([192, 193, 194].includes(marker)) {
      if (++frames !== 1 || size < 8) invalid();
      dimensions(byte(b, p + 5) * 256 + byte(b, p + 6), byte(b, p + 3) * 256 + byte(b, p + 4));
    } else if (marker >= 195 && marker <= 207 && ![196, 200, 204].includes(marker)) invalid();
    p += size;
    if (marker === 218) {
      scans++;
      for (;;) {
        if (p >= b.length) invalid();
        if (b[p] !== 255) { p++; continue; }
        if (byte(b, p + 1) === 0 || (byte(b, p + 1) >= 208 && byte(b, p + 1) <= 215)) { p += 2; continue; }
        break;
      }
    }
  }
  invalid();
}
function webpShape(b: Uint8Array, clean: boolean): void {
  const text = (a: number, n: number) => String.fromCharCode(...b.subarray(a, a + n));
  if (b.length < 20 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WEBP') invalid();
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (view.getUint32(4, true) + 8 !== b.length) invalid();
  let p = 12, frames = 0;
  const chunks = new Set<string>();
  while (p < b.length) {
    if (p + 8 > b.length) invalid();
    const kind = text(p, 4), size = view.getUint32(p + 4, true), start = p + 8;
    if (!['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'EXIF', 'ICCP', 'XMP '].includes(kind) || chunks.has(kind) || start + size + (size % 2) > b.length) invalid();
    chunks.add(kind);
    if (clean && ['EXIF', 'XMP ', 'ICCP'].includes(kind)) invalid();
    if (kind === 'VP8X') {
      if (size !== 10 || (byte(b, start) & 2)) invalid();
      const u24 = (i: number) => byte(b, i) + byte(b, i + 1) * 256 + byte(b, i + 2) * 65536;
      dimensions(u24(start + 4) + 1, u24(start + 7) + 1);
    }
    if (kind === 'VP8 ') {
      if (++frames !== 1 || size < 10 || text(start + 3, 3) !== '\x9d\x01\x2a') invalid();
      dimensions(view.getUint16(start + 6, true) & 16383, view.getUint16(start + 8, true) & 16383);
    }
    if (kind === 'VP8L') {
      if (++frames !== 1 || size < 5 || b[start] !== 47) invalid();
      dimensions(1 + byte(b, start + 1) + ((byte(b, start + 2) & 63) << 8), 1 + (byte(b, start + 2) >> 6) + (byte(b, start + 3) << 2) + ((byte(b, start + 4) & 15) << 10));
    }
    p = start + size + (size % 2);
  }
  if (p !== b.length || frames !== 1) invalid();
}
export function checkPhotoEnvelope(bytes: Uint8Array, mime: PhotoMime, clean = false): void {
  if (bytes.length > PHOTO_MAX_BYTES) tooLarge();
  if (!bytes.length) invalid();
  if (mime === 'image/jpeg') jpegShape(bytes, clean); else webpShape(bytes, clean);
}

let initialization: Promise<void> | undefined;
/** 정본 wasm bytes는 pinned dependency에서만 가져오고 사용자 URL은 받지 않는다. */
export function initializePhotoDecoder(wasm: Uint8Array): Promise<void> {
  initialization ??= initializeImageMagick(wasm).then(() => {
    ResourceLimits.width = BigInt(PHOTO_MAX_DIMENSION);
    ResourceLimits.height = BigInt(PHOTO_MAX_DIMENSION);
    // Area is a cache threshold (>= spills to disk), not our inclusive pixel validation limit.
    ResourceLimits.area = BigInt(PHOTO_MAX_PIXELS + 1);
    // ImageMagick counts its sentinel as an extra entry; envelope still allows exactly one frame.
    ResourceLimits.listLength = 2n;
    ResourceLimits.memory = 67108864n;
    ResourceLimits.maxMemoryRequest = 67108864n;
    ResourceLimits.maxProfileSize = BigInt(PHOTO_MAX_BYTES);
    ResourceLimits.disk = 0n;
    ResourceLimits.time = 1n;
  });
  return initialization;
}
export interface VerifiedPhoto { bytes: Uint8Array; mime: PhotoMime; sizeBytes: number; sha256: string }
export async function verifyPhotoBinary(raw: Uint8Array, mime: PhotoMime): Promise<VerifiedPhoto> {
  checkPhotoEnvelope(raw, mime);
  if (!initialization) throw new PhotoError(503, 'PHOTO_DECODER_UNAVAILABLE');
  await initialization;
  const started = performance.now();
  const format = mime === 'image/jpeg' ? MagickFormat.Jpeg : MagickFormat.WebP;
  let bytes: Uint8Array;
  try {
    const settings = new MagickReadSettings(); settings.format = format;
    const image = MagickImage.create();
    let warning = false;
    image.onWarning = () => { warning = true; };
    try {
      image.read(raw, settings);
      if (warning) invalid();
      dimensions(image.width, image.height);
      if (image.format !== format) invalid();
      image.autoOrient(); image.strip(); image.quality = 90;
      bytes = image.write(format, (data) => Uint8Array.from(data));
      if (warning) invalid();
    } finally { image.dispose(); }
    checkPhotoEnvelope(bytes, mime, true);
    const decoded = MagickImage.create();
    decoded.onWarning = () => { warning = true; };
    try {
      decoded.read(bytes, settings);
      if (warning || decoded.format !== format || decoded.profileNames.length !== 0) invalid();
      dimensions(decoded.width, decoded.height);
    } finally { decoded.dispose(); }
  } catch (error) {
    if (error instanceof PhotoError) throw error;
    // Native messages may contain file bytes/profiles; never attach the original cause.
    throw new PhotoError(400, 'INVALID_PHOTO_BINARY');
  }
  if (performance.now() - started > PHOTO_DECODE_BUDGET_MS) throw new PhotoError(413, 'PHOTO_DECODE_LIMIT_EXCEEDED');
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return { bytes, mime, sizeBytes: bytes.length, sha256: Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('') };
}
