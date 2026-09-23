import { initializeImageMagick, MagickImage, MagickReadSettings, MagickFormat, ResourceLimits } from '@imagemagick/magick-wasm';

// 제품 크기 제한과 별개인, source-controlled decoder 자원 상한이다.
export const PHOTO_MAX_BYTES = 307200;
export const PHOTO_INPUT_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_MAX_PIXELS = 4194304;
export const PHOTO_MAX_DIMENSION = 4096;
export const PHOTO_INPUT_MAX_PIXELS = 12582912;
export const PHOTO_INPUT_MAX_DIMENSION = 5000;
export const PHOTO_DECODE_BUDGET_MS = 1500;
export type PhotoMime = 'image/jpeg' | 'image/webp';
export type PhotoInputMime = PhotoMime | 'image/heic' | 'image/heif';
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
export function photoMime(value: string | null): PhotoInputMime {
  if (value !== 'image/jpeg' && value !== 'image/webp' && value !== 'image/heic' && value !== 'image/heif') throw new PhotoError(415, 'PHOTO_MEDIA_TYPE_UNSUPPORTED');
  return value;
}

/** Content-Length는 증거가 아니다. 초과 chunk에서 cancel하고 decoder/provider는 호출하지 않는다. */
export async function readPhotoBody(stream: ReadableStream<Uint8Array> | null, contentLength: string | null, maxBytes = PHOTO_MAX_BYTES): Promise<Uint8Array> {
  if (contentLength !== null && (!/^\d{1,10}$/.test(contentLength) || Number(contentLength) > maxBytes)) tooLarge();
  if (!stream) return invalid();
  const reader = stream.getReader();
  const bytes = new Uint8Array(maxBytes);
  let length = 0, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 5000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) invalid();
      if (length + value.byteLength > maxBytes) { await reader.cancel(); tooLarge(); }
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
function dimensions(width: number, height: number, input = false): void {
  const maxDimension = input ? PHOTO_INPUT_MAX_DIMENSION : PHOTO_MAX_DIMENSION;
  const maxPixels = input ? PHOTO_INPUT_MAX_PIXELS : PHOTO_MAX_PIXELS;
  if (width < 1 || height < 1 || width > maxDimension || height > maxDimension || width * height > maxPixels) {
    throw new PhotoError(413, 'PHOTO_DECODE_LIMIT_EXCEEDED');
  }
}
function isoBmffVideoTail(b: Uint8Array, start: number, end = b.length): boolean {
  if (start < 0 || end > b.length || start + 16 > end) return false;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const text = (offset: number) => String.fromCharCode(...b.subarray(offset, offset + 4));
  let offset = start, first = true, media = false, index = false;
  while (offset < end) {
    if (offset + 8 > end) return false;
    let size = view.getUint32(offset, false), headerSize = 8;
    const kind = text(offset + 4);
    if (size === 1) {
      if (offset + 16 > end) return false;
      const extended = view.getBigUint64(offset + 8, false);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(extended); headerSize = 16;
    } else if (size === 0) size = end - offset;
    if (size < headerSize || offset + size > end) return false;
    if (first && kind !== 'ftyp') return false;
    if (kind === 'mdat') media = true;
    if (kind === 'moov' || kind === 'moof') index = true;
    first = false; offset += size;
  }
  return offset === end && media && index;
}
function samsungSefMotionPhotoTail(b: Uint8Array, primaryEnd: number, videoStart: number): boolean {
  if (b.length < 20 || videoStart <= primaryEnd || videoStart >= b.length - 20) return false;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const text = (offset: number, length: number) => String.fromCharCode(...b.subarray(offset, offset + length));
  if (text(b.length - 4, 4) !== 'SEFT') return false;
  const directorySize = view.getUint32(b.length - 8, true);
  const directoryStart = b.length - 8 - directorySize;
  if (directoryStart <= videoStart || directorySize < 24 || text(directoryStart, 4) !== 'SEFH') return false;
  const count = view.getUint32(directoryStart + 8, true);
  if (count < 1 || count > 128 || directorySize !== 12 + count * 12) return false;
  let expectedStart = primaryEnd, motionField = false;
  for (let index = 0; index < count; index++) {
    const entry = directoryStart + 12 + index * 12;
    const marker = b.subarray(entry, entry + 4);
    const negativeOffset = view.getUint32(entry + 4, true);
    const fieldLength = view.getUint32(entry + 8, true);
    if (!negativeOffset || fieldLength < 8 || negativeOffset > directoryStart) return false;
    const fieldStart = directoryStart - negativeOffset;
    if (fieldStart !== expectedStart || fieldStart + fieldLength > directoryStart) return false;
    if (!marker.every((value, markerIndex) => value === b[fieldStart + markerIndex])) return false;
    const isMotion = marker[0] === 0 && marker[1] === 0 && marker[2] === 0x30 && marker[3] === 0x0a;
    if (isMotion) {
      if (motionField || index !== count - 1 || fieldStart + fieldLength !== directoryStart) return false;
      const nameLength = view.getUint32(fieldStart + 4, true);
      if (nameLength !== 16 || text(fieldStart + 8, nameLength) !== 'MotionPhoto_Data' || fieldStart + 8 + nameLength !== videoStart) return false;
      motionField = true;
    }
    expectedStart = fieldStart + fieldLength;
  }
  return motionField && expectedStart === directoryStart && isoBmffVideoTail(b, videoStart, directoryStart);
}
function motionPhotoTail(b: Uint8Array, primaryEnd: number, xmpPackets: string[]): boolean {
  const xmp = xmpPackets.join('\n');
  if (!xmp.includes('http://ns.google.com/photos/1.0/camera/')) return false;
  const enabled = /(?:\bMotionPhoto|\bMicroVideo)\s*=\s*["']1["']/.test(xmp) ||
    /<[^>]*:(?:MotionPhoto|MicroVideo)>\s*1\s*<\//.test(xmp);
  if (!enabled) return false;
  const legacy = /\bMicroVideoOffset\s*=\s*["']([1-9]\d{0,9})["']/.exec(xmp);
  const candidates: number[] = [];
  if (legacy) {
    const offset = Number(legacy[1]);
    if (offset === b.length - primaryEnd) candidates.push(primaryEnd);
  }
  if (xmp.includes('http://ns.google.com/photos/1.0/container/') && xmp.includes('http://ns.google.com/photos/1.0/container/item/')) {
    const items = xmp.match(/<[^>]+>/g) ?? [];
    const primary = items.find(item => /\bSemantic\s*=\s*["']Primary["']/.test(item) && /\bMime\s*=\s*["']image\/jpeg["']/.test(item));
    const motion = items.find(item => /\bSemantic\s*=\s*["']MotionPhoto["']/.test(item) && /\bMime\s*=\s*["']video\/(?:mp4|quicktime)["']/.test(item));
    const length = motion && /\bLength\s*=\s*["']([1-9]\d{0,9})["']/.exec(motion);
    const paddingMatch = primary && /\bPadding\s*=\s*["'](\d{1,9})["']/.exec(primary);
    const padding = paddingMatch ? Number(paddingMatch[1]) : 0;
    if (primary && length) {
      const offset = b.length - Number(length[1]);
      if (offset === primaryEnd + padding || samsungSefMotionPhotoTail(b, primaryEnd, offset)) candidates.push(offset);
    }
  }
  return candidates.some(offset => isoBmffVideoTail(b, offset) || samsungSefMotionPhotoTail(b, primaryEnd, offset));
}
function jpegShape(b: Uint8Array, clean: boolean): number {
  if (b[0] !== 255 || b[1] !== 216) invalid();
  let p = 2, frames = 0, scans = 0;
  const xmpPackets: string[] = [];
  while (p < b.length) {
    if (b[p++] !== 255) invalid();
    while (b[p] === 255) p++;
    const marker = byte(b, p++);
    if (marker === 217) {
      if (frames !== 1 || scans < 1 || p !== b.length && (clean || !motionPhotoTail(b, p, xmpPackets))) invalid();
      return p;
    }
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215)) invalid();
    if (p + 2 > b.length) invalid();
    const size = byte(b, p) * 256 + byte(b, p + 1);
    if (size < 2 || p + size > b.length) invalid();
    if (clean && (marker === 225 || marker === 237 || marker === 254)) invalid();
    if (!clean && marker === 225) {
      const packet = new TextDecoder().decode(b.subarray(p + 2, p + size));
      if (packet.startsWith('http://ns.adobe.com/xap/1.0/\u0000') || packet.startsWith('http://ns.adobe.com/xmp/extension/\u0000')) xmpPackets.push(packet);
    }
    if ([192, 193, 194].includes(marker)) {
      if (++frames !== 1 || size < 8) invalid();
      dimensions(byte(b, p + 5) * 256 + byte(b, p + 6), byte(b, p + 3) * 256 + byte(b, p + 4), !clean);
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
  return invalid();
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
      dimensions(u24(start + 4) + 1, u24(start + 7) + 1, !clean);
    }
    if (kind === 'VP8 ') {
      if (++frames !== 1 || size < 10 || text(start + 3, 3) !== '\x9d\x01\x2a') invalid();
      dimensions(view.getUint16(start + 6, true) & 16383, view.getUint16(start + 8, true) & 16383, !clean);
    }
    if (kind === 'VP8L') {
      if (++frames !== 1 || size < 5 || b[start] !== 47) invalid();
      dimensions(1 + byte(b, start + 1) + ((byte(b, start + 2) & 63) << 8), 1 + (byte(b, start + 2) >> 6) + (byte(b, start + 3) << 2) + ((byte(b, start + 4) & 15) << 10), !clean);
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

function heicShape(bytes: Uint8Array): void {
  if (bytes.length < 24) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid();
    let size = view.getUint32(offset, false);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) invalid();
      const extended = view.getBigUint64(offset + 8, false);
      if (extended > BigInt(bytes.length)) invalid();
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) size = bytes.length - offset;
    if (size < headerSize || offset + size > bytes.length) invalid();
    if (offset === 0) {
      if (text(offset + 4) !== 'ftyp' || size < headerSize + 8) invalid();
      const brands = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
      let compatible = brands.has(text(offset + headerSize));
      for (let p = offset + headerSize + 8; p + 4 <= offset + size; p += 4) compatible ||= brands.has(text(p));
      if (!compatible || (size - headerSize - 8) % 4 !== 0) invalid();
    }
    offset += size;
  }
}

export function checkPhotoInputEnvelope(bytes: Uint8Array, mime: PhotoInputMime): void {
  void photoInputPayload(bytes, mime);
}
function photoInputPayload(bytes: Uint8Array, mime: PhotoInputMime): Uint8Array {
  if (!bytes.length) invalid();
  if (bytes.length > PHOTO_INPUT_MAX_BYTES) tooLarge();
  if (mime === 'image/jpeg') return bytes.subarray(0, jpegShape(bytes, false));
  if (mime === 'image/webp') webpShape(bytes, false);
  else heicShape(bytes);
  return bytes;
}

let initialization: Promise<void> | undefined;
/** 정본 wasm bytes는 pinned dependency에서만 가져오고 사용자 URL은 받지 않는다. */
export function initializePhotoDecoder(wasm: Uint8Array): Promise<void> {
  initialization ??= initializeImageMagick(wasm).then(() => {
    ResourceLimits.width = BigInt(PHOTO_INPUT_MAX_DIMENSION);
    ResourceLimits.height = BigInt(PHOTO_INPUT_MAX_DIMENSION);
    // Area is a cache threshold (>= spills to disk), not our inclusive pixel validation limit.
    ResourceLimits.area = BigInt(PHOTO_INPUT_MAX_PIXELS + 1);
    // ImageMagick counts its sentinel as an extra entry; envelope still allows exactly one frame.
    ResourceLimits.listLength = 2n;
    ResourceLimits.memory = 134217728n;
    ResourceLimits.maxMemoryRequest = 134217728n;
    ResourceLimits.maxProfileSize = BigInt(PHOTO_INPUT_MAX_BYTES);
    ResourceLimits.disk = 0n;
    ResourceLimits.time = 1n;
  });
  return initialization;
}
export interface VerifiedPhoto { bytes: Uint8Array; mime: PhotoMime; sizeBytes: number; sha256: string }
export async function verifyPhotoBinary(raw: Uint8Array, mime: PhotoInputMime): Promise<VerifiedPhoto> {
  const source = photoInputPayload(raw, mime);
  if (!initialization) throw new PhotoError(503, 'PHOTO_DECODER_UNAVAILABLE');
  await initialization;
  const started = performance.now();
  const inputFormat = mime === 'image/jpeg' ? MagickFormat.Jpeg : mime === 'image/webp' ? MagickFormat.WebP : MagickFormat.Heic;
  const outputMime: PhotoMime = mime === 'image/webp' ? 'image/webp' : 'image/jpeg';
  const outputFormat = outputMime === 'image/webp' ? MagickFormat.WebP : MagickFormat.Jpeg;
  let bytes: Uint8Array;
  try {
    const settings = new MagickReadSettings(); settings.format = inputFormat;
    if (mime === 'image/heic' || mime === 'image/heif') settings.frameCount = 1;
    const image = MagickImage.create();
    let warning = false;
    image.onWarning = () => { warning = true; };
    try {
      image.read(source, settings);
      if (warning) invalid();
      dimensions(image.width, image.height, true);
      if (mime === 'image/heic' || mime === 'image/heif' ? ![MagickFormat.Heic, MagickFormat.Heif].includes(image.format as 'HEIC' | 'HEIF') : image.format !== inputFormat) invalid();
      image.autoOrient(); image.strip();
      const longest = Math.max(image.width, image.height);
      if (longest > 1280) {
        const scale = 1280 / longest;
        image.resize(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
      }
      image.quality = longest <= 1280 && source.length <= PHOTO_MAX_BYTES ? 90 : 65;
      bytes = image.write(outputFormat, (data) => Uint8Array.from(data));
      if (bytes.length > PHOTO_MAX_BYTES) {
        image.quality = 45;
        bytes = image.write(outputFormat, (data) => Uint8Array.from(data));
      }
      if (bytes.length > PHOTO_MAX_BYTES) {
        const scale = Math.min(1, 960 / Math.max(image.width, image.height));
        image.resize(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
        image.quality = 45;
        bytes = image.write(outputFormat, (data) => Uint8Array.from(data));
      }
      if (warning) invalid();
    } finally { image.dispose(); }
    checkPhotoEnvelope(bytes, outputMime, true);
    const decoded = MagickImage.create();
    decoded.onWarning = () => { warning = true; };
    try {
      const outputSettings = new MagickReadSettings(); outputSettings.format = outputFormat;
      decoded.read(bytes, outputSettings);
      if (warning || decoded.format !== outputFormat || decoded.profileNames.length !== 0) invalid();
      dimensions(decoded.width, decoded.height);
    } finally { decoded.dispose(); }
  } catch (error) {
    if (error instanceof PhotoError) throw error;
    // Native messages may contain file bytes/profiles; never attach the original cause.
    throw new PhotoError(400, 'INVALID_PHOTO_BINARY');
  }
  if (performance.now() - started > PHOTO_DECODE_BUDGET_MS) throw new PhotoError(413, 'PHOTO_DECODE_LIMIT_EXCEEDED');
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return { bytes, mime: outputMime, sizeBytes: bytes.length, sha256: Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('') };
}
