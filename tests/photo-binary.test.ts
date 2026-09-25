import { readFile } from 'node:fs/promises';
import { ImageMagick, MagickColors, MagickFormat, MagickReadSettings } from '@imagemagick/magick-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkPhotoEnvelope, checkPhotoInputEnvelope, initializePhotoDecoder, PhotoError, PHOTO_INPUT_MAX_BYTES, PHOTO_MAX_BYTES, photoMime, readPhotoBody, verifyPhotoBinary } from '../src/modules/photos/photo-binary.js';

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
function motionPhotoJpeg(bytes: Uint8Array, legacy = false): Uint8Array {
  const metadata = legacy
    ? '<rdf:Description xmlns:Camera="http://ns.google.com/photos/1.0/camera/" Camera:MicroVideo="1" Camera:MicroVideoOffset="36"/>'
    : '<rdf:Description xmlns:Camera="http://ns.google.com/photos/1.0/camera/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" Camera:MotionPhoto="1" Camera:MotionPhotoVersion="1"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource" Item:Semantic="Primary" Item:Mime="image/jpeg"/><rdf:li rdf:parseType="Resource" Item:Semantic="MotionPhoto" Item:Mime="video/mp4" Item:Length="36"/></rdf:Seq></Container:Directory></rdf:Description>';
  const xmp = new TextEncoder().encode(`http://ns.adobe.com/xap/1.0/\0<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${metadata}</rdf:RDF></x:xmpmeta>`);
  const app1 = new Uint8Array(xmp.length + 4);
  app1.set([255, 225, (xmp.length + 2) >> 8, (xmp.length + 2) & 255]); app1.set(xmp, 4);
  const box = (kind: string, payload = new Uint8Array()) => {
    const result = new Uint8Array(8 + payload.length), view = new DataView(result.buffer);
    view.setUint32(0, result.length, false); result.set(new TextEncoder().encode(kind), 4); result.set(payload, 8); return result;
  };
  const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\0\0isom'));
  const tail = new Uint8Array(ftyp.length + 16); tail.set(ftyp); tail.set(box('moov'), ftyp.length); tail.set(box('mdat'), ftyp.length + 8);
  return new Uint8Array([...bytes.slice(0, 2), ...app1, ...bytes.slice(2), ...tail]);
}
function samsungMotionPhotoJpeg(bytes: Uint8Array, versioned = false): Uint8Array {
  const box = (kind: string, payload = new Uint8Array()) => {
    const result = new Uint8Array(8 + payload.length), view = new DataView(result.buffer);
    view.setUint32(0, result.length, false); result.set(new TextEncoder().encode(kind), 4); result.set(payload, 8); return result;
  };
  const ftyp = box('ftyp', new TextEncoder().encode('mp42\0\0\0\0mp42'));
  const video = new Uint8Array(ftyp.length + 16); video.set(ftyp); video.set(box('moov'), ftyp.length); video.set(box('mdat'), ftyp.length + 8);
  const metadata = new Uint8Array([0, 0, 1, 10, 4, 0, 0, 0, 116, 101, 115, 116]);
  const motionName = new TextEncoder().encode('MotionPhoto_Data');
  const motionHeader = new Uint8Array(8 + motionName.length);
  motionHeader.set([0, 0, 0x30, 0x0a]); new DataView(motionHeader.buffer).setUint32(4, motionName.length, true); motionHeader.set(motionName, 8);
  const versionName = new TextEncoder().encode('MotionPhoto_Version');
  const versionField = versioned ? new Uint8Array(8 + versionName.length + 4) : new Uint8Array();
  if (versioned) {
    versionField.set([0, 0, 0x31, 0x0a]);
    new DataView(versionField.buffer).setUint32(4, versionName.length, true);
    versionField.set(versionName, 8);
    versionField.set([0, 0, 0, 1], 8 + versionName.length);
  }
  const count = versioned ? 3 : 2, directorySize = 12 + count * 12, footerSize = 8;
  const videoLength = video.length + versionField.length + directorySize + footerSize;
  const xmpMetadata = `<rdf:Description xmlns:Camera="http://ns.google.com/photos/1.0/camera/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" Camera:MotionPhoto="1"><Container:Directory><rdf:Seq><rdf:li><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg" Item:Padding="0"/></rdf:li><rdf:li><Container:Item Item:Semantic="MotionPhoto" Item:Mime="video/mp4" Item:Length="${videoLength}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description>`;
  const xmp = new TextEncoder().encode(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${xmpMetadata}</rdf:RDF></x:xmpmeta>`);
  const app1 = new Uint8Array(xmp.length + 4);
  app1.set([255, 225, (xmp.length + 2) >> 8, (xmp.length + 2) & 255]); app1.set(xmp, 4);
  const primary = new Uint8Array([...bytes.slice(0, 2), ...app1, ...bytes.slice(2)]);
  const directoryStart = primary.length + metadata.length + motionHeader.length + video.length + versionField.length;
  const directory = new Uint8Array(directorySize + footerSize), view = new DataView(directory.buffer);
  directory.set(new TextEncoder().encode('SEFH')); view.setUint32(4, versioned ? 107 : 106, true); view.setUint32(8, count, true);
  directory.set(metadata.slice(0, 4), 12); view.setUint32(16, directoryStart - primary.length, true); view.setUint32(20, metadata.length, true);
  directory.set(motionHeader.slice(0, 4), 24); view.setUint32(28, directoryStart - primary.length - metadata.length, true); view.setUint32(32, motionHeader.length + video.length, true);
  if (versioned) {
    directory.set(versionField.slice(0, 4), 36);
    view.setUint32(40, versionField.length, true);
    view.setUint32(44, versionField.length, true);
  }
  view.setUint32(directorySize, directorySize, true); directory.set(new TextEncoder().encode('SEFT'), directorySize + 4);
  return new Uint8Array([...primary, ...metadata, ...motionHeader, ...video, ...versionField, ...directory]);
}
function ultraHdrJpeg(bytes: Uint8Array, motion: 'none' | 'declared' | 'samsung-fallback' = 'none'): Uint8Array {
  const app1 = (metadata: string) => {
    const xmp = new TextEncoder().encode(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${metadata}</rdf:RDF></x:xmpmeta>`);
    const segment = new Uint8Array(xmp.length + 4);
    segment.set([255, 225, (xmp.length + 2) >> 8, (xmp.length + 2) & 255]); segment.set(xmp, 4);
    return segment;
  };
  const gainMapMetadata = '<rdf:Description xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" hdrgm:GainMapMax="2" hdrgm:HDRCapacityMax="2"/>';
  const gainMap = fixture('image/jpeg', 4, 4), gainMapXmp = app1(gainMapMetadata);
  const gainMapJpeg = new Uint8Array([...gainMap.slice(0, 2), ...gainMapXmp, ...gainMap.slice(2)]);
  const box = (kind: string, payload = new Uint8Array()) => {
    const result = new Uint8Array(8 + payload.length), view = new DataView(result.buffer);
    view.setUint32(0, result.length, false); result.set(new TextEncoder().encode(kind), 4); result.set(payload, 8); return result;
  };
  const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\0\0isom'));
  const video = new Uint8Array(ftyp.length + 16); video.set(ftyp); video.set(box('moov'), ftyp.length); video.set(box('mdat'), ftyp.length + 8);
  const motionAttributes = motion === 'none' ? '' : ' xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" GCamera:MotionPhoto="1"';
  const motionItem = motion === 'declared' ? `<rdf:li><Container:Item Item:Semantic="MotionPhoto" Item:Mime="video/mp4" Item:Length="${video.length}"/></rdf:li>` : '';
  const primaryMetadata = `<rdf:Description xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"${motionAttributes}><Container:Directory><rdf:Seq><rdf:li><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainMapJpeg.length}"/></rdf:li>${motionItem}</rdf:Seq></Container:Directory></rdf:Description>`;
  const primaryXmp = app1(primaryMetadata);
  const primary = new Uint8Array([...bytes.slice(0, 2), ...primaryXmp, ...bytes.slice(2)]);
  return new Uint8Array([...primary, ...gainMapJpeg, ...(motion === 'none' ? [] : video)]);
}
function samsungStillMetadata(bytes: Uint8Array): Uint8Array {
  // Synthetic metadata only; no user camera bytes, values or identifiers.
  const fields = ['Image_UTC_Data', 'Camera_Capture_Mode_Info'].map((name, index) => {
    const encoded = new TextEncoder().encode(name), field = new Uint8Array(8 + encoded.length + 4);
    const view = new DataView(field.buffer);
    view.setUint32(0, (0x0a01 + index) * 65536, true);
    view.setUint32(4, encoded.length, true); field.set(encoded, 8); return field;
  });
  const directorySize = 12 + fields.length * 12;
  const directoryStart = bytes.length + fields.reduce((sum, field) => sum + field.length, 0);
  const directory = new Uint8Array(directorySize + 8), view = new DataView(directory.buffer);
  directory.set(new TextEncoder().encode('SEFH')); view.setUint32(4, 106, true); view.setUint32(8, fields.length, true);
  let offset = bytes.length;
  fields.forEach((field, index) => {
    const entry = 12 + index * 12;
    directory.set(field.subarray(0, 4), entry); view.setUint32(entry + 4, directoryStart - offset, true); view.setUint32(entry + 8, field.length, true);
    offset += field.length;
  });
  view.setUint32(directorySize, directorySize, true); directory.set(new TextEncoder().encode('SEFT'), directorySize + 4);
  return new Uint8Array([...bytes, ...fields.flatMap(field => [...field]), ...directory]);
}

describe('independent server image verification', () => {
  it('does not upscale small or narrow JPEGs and preserves their legacy bytes', async () => {
    for (const [width, height] of [[16, 16], [640, 480], [1280, 960], [3000, 300]]) {
      const input = fixture('image/jpeg', width, height);
      const output = await verifyPhotoBinary(input, 'image/jpeg');
      expect(output).toEqual(await verifyPhotoBinary(input, 'image/jpeg', 'legacy'));
    }
  });
  it('downsamples large JPEG decoding while preserving EXIF rotation, colors and stripped output', async () => {
    const width = 3200, height = 2400, rgb = new Uint8Array(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel++) rgb[pixel * 3 + (pixel < width * height / 2 ? 0 : 2)] = 255;
    const jpg = ImageMagick.read(rgb, new MagickReadSettings({ format: MagickFormat.Rgb, width, height, depth: 8 }), image =>
      image.write(MagickFormat.Jpeg, data => Uint8Array.from(data)));
    // Synthetic TIFF IFD0 orientation=6 (90 degrees clockwise), no private metadata.
    const exif = Uint8Array.from([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
    const raw = new Uint8Array([...jpg.slice(0, 2), ...exif, ...jpg.slice(2)]);
    const output = await verifyPhotoBinary(raw, 'image/jpeg');
    expect(output).toEqual(await verifyPhotoBinary(raw, 'image/jpeg'));
    expect(output.sizeBytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    ImageMagick.read(output.bytes, image => {
      expect([image.width, image.height]).toEqual([960, 1280]);
      expect(image.profileNames).toEqual([]);
      image.getPixels(pixels => {
        const left = pixels.getPixel(100, 640), right = pixels.getPixel(850, 640);
        expect(left[2]).toBeGreaterThan(left[0] ?? 0);
        expect(right[0]).toBeGreaterThan(right[2] ?? 0);
      });
    });
    const bomb = jpg.slice();
    for (let i = 2; i < bomb.length - 9; i++) if (bomb[i] === 255 && bomb[i + 1] === 192) { bomb[i + 7] = 127; bomb[i + 8] = 255; break; }
    await expect(verifyPhotoBinary(bomb, 'image/jpeg')).rejects.toMatchObject({ code: 'PHOTO_DECODE_LIMIT_EXCEEDED' });
  });
  it.each(['plain', 'ultra-hdr'] as const)('normalizes %s JPEG with fully indexed Samsung SEF metadata and strips the trailer', async (kind) => {
    const hdr = kind === 'plain' ? fixture() : ultraHdrJpeg(fixture()), original = samsungStillMetadata(hdr);
    checkPhotoInputEnvelope(original, 'image/jpeg');
    expect(() => checkPhotoEnvelope(original, 'image/jpeg', true)).toThrow(PhotoError);
    const output = await verifyPhotoBinary(original, 'image/jpeg');
    expect(output).toEqual(await verifyPhotoBinary(hdr, 'image/jpeg'));
    checkPhotoEnvelope(output.bytes, output.mime, true);
    expect(output.sizeBytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
  });
  it.each(['plain', 'ultra-hdr'] as const)('rejects forged Samsung %s metadata boundaries, fields, names, video and loose bytes', async (kind) => {
    const hdr = kind === 'plain' ? fixture() : ultraHdrJpeg(fixture()), original = samsungStillMetadata(hdr);
    const directory = original.length - 44;
    const corruptions: Array<(bytes: Uint8Array) => void> = [
      b => { b[b.length - 1] = 0; },
      b => { new DataView(b.buffer).setUint32(b.length - 8, 0xffffffff, true); },
      b => { new DataView(b.buffer).setUint32(directory + 8, 129, true); },
      b => { new DataView(b.buffer).setUint32(directory + 16, 1, true); },
      b => { new DataView(b.buffer).setUint32(directory + 28, 0xffffffff, true); },
      b => { new DataView(b.buffer).setUint32(directory + 20, 0xffffffff, true); },
      b => { b[hdr.length] = 1; },
      b => { new DataView(b.buffer).setUint32(hdr.length + 4, 129, true); },
      b => { b[hdr.length + 8] = 0; },
      b => { new DataView(b.buffer).setUint32(hdr.length, 0x0a300000, true); new DataView(b.buffer).setUint32(directory + 12, 0x0a300000, true); },
    ];
    for (const corrupt of corruptions) {
      const forged = original.slice(); corrupt(forged);
      await expect(verifyPhotoBinary(forged, 'image/jpeg')).rejects.toMatchObject({ code: 'INVALID_PHOTO_BINARY' });
    }
    for (const forged of [original.slice(0, -1), new Uint8Array([...original, 0]), samsungStillMetadata(new Uint8Array([...hdr, 0])), samsungStillMetadata(samsungStillMetadata(hdr))]) {
      await expect(verifyPhotoBinary(forged, 'image/jpeg')).rejects.toMatchObject({ code: 'INVALID_PHOTO_BINARY' });
    }
  });
  it('decodes JPEG/WebP and rechecks stripped output/final digest deterministically', async () => {
    for (const mime of ['image/jpeg', 'image/webp'] as const) {
      const raw = fixture(mime), a = await verifyPhotoBinary(raw, mime), b = await verifyPhotoBinary(raw, mime);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/); expect(a).toEqual(b);
      expect(a.sizeBytes).toBe(a.bytes.length); checkPhotoEnvelope(a.bytes, mime, true);
    }
  });
  it('accepts and strips smartphone-sized JPEG input while keeping stored bytes below 300KiB', async () => {
    for (const n of [307199, 307200, 307201]) {
      const output = await verifyPhotoBinary(padJpeg(fixture(), n), 'image/jpeg');
      expect(output.sizeBytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    }
    const twelveMegapixel = fixture('image/jpeg', 4032, 3024);
    expect((await verifyPhotoBinary(twelveMegapixel, 'image/jpeg')).sizeBytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    await expect(verifyPhotoBinary(padJpeg(fixture(), PHOTO_INPUT_MAX_BYTES + 1), 'image/jpeg')).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE' });
  });
  it('extracts a standards-marked Android Motion Photo still while rejecting an unmarked trailer', async () => {
    const jpg = fixture(), motion = motionPhotoJpeg(jpg);
    const output = await verifyPhotoBinary(motion, 'image/jpeg');
    expect(output.mime).toBe('image/jpeg');
    expect(output.sizeBytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    checkPhotoEnvelope(output.bytes, output.mime, true);
    await expect(verifyPhotoBinary(new Uint8Array([...jpg, ...motion.slice(motion.length - 36)]), 'image/jpeg')).rejects.toMatchObject({ code: 'INVALID_PHOTO_BINARY' });
    const forged = motion.slice();
    forged[forged.length - 31] = 0;
    await expect(verifyPhotoBinary(forged, 'image/jpeg')).rejects.toMatchObject({ code: 'INVALID_PHOTO_BINARY' });
    expect((await verifyPhotoBinary(motionPhotoJpeg(jpg, true), 'image/jpeg')).sizeBytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
  });
  it('extracts a Samsung SEF Motion Photo still while rejecting malformed SEF trailers', async () => {
    const motion = samsungMotionPhotoJpeg(fixture());
    const output = await verifyPhotoBinary(motion, 'image/jpeg');
    expect(output.mime).toBe('image/jpeg');
    expect(output.sizeBytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    checkPhotoEnvelope(output.bytes, output.mime, true);
    for (const offset of [motion.length - 1, motion.length - 8, motion.length - 20, motion.length - 44]) {
      const forged = motion.slice(); forged[offset] = (forged[offset] ?? 0) ^ 1;
      await expect(verifyPhotoBinary(forged, 'image/jpeg')).rejects.toMatchObject({ code: 'INVALID_PHOTO_BINARY' });
    }
  });
  it('accepts Samsung mpv3 when a verified MotionPhoto_Version field follows the video', async () => {
    const motion = samsungMotionPhotoJpeg(fixture(), true);
    const output = await verifyPhotoBinary(motion, 'image/jpeg');
    expect(output.mime).toBe('image/jpeg');
    expect(output.sizeBytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    checkPhotoEnvelope(output.bytes, output.mime, true);
    for (const offset of [motion.length - 20, motion.length - 56]) {
      const forged = motion.slice(); forged[offset] = (forged[offset] ?? 0) ^ 1;
      await expect(verifyPhotoBinary(forged, 'image/jpeg')).rejects.toMatchObject({ code: 'INVALID_PHOTO_BINARY' });
    }
  });
  it('extracts Android Ultra HDR and Ultra HDR Motion Photo primary images', async () => {
    for (const motion of ['none', 'declared', 'samsung-fallback'] as const) {
      const original = ultraHdrJpeg(fixture(), motion);
      const output = await verifyPhotoBinary(original, 'image/jpeg');
      expect(output.mime).toBe('image/jpeg');
      expect(output.sizeBytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
      checkPhotoEnvelope(output.bytes, output.mime, true);
    }
  });
  it('rejects forged Ultra HDR directory lengths, gain maps and undeclared trailers', async () => {
    const declared = ultraHdrJpeg(fixture(), 'declared');
    const brokenLength = declared.slice();
    const lengthText = new TextEncoder().encode('Item:Length="');
    const index = brokenLength.findIndex((_, offset) => lengthText.every((value, inner) => brokenLength[offset + inner] === value));
    expect(index).toBeGreaterThan(0);
    brokenLength[index + lengthText.length] = 57;
    await expect(verifyPhotoBinary(brokenLength, 'image/jpeg')).rejects.toMatchObject({ code: 'INVALID_PHOTO_BINARY' });
    const brokenGainMap = ultraHdrJpeg(fixture());
    const lastGainMapByte = brokenGainMap.length - 1;
    brokenGainMap[lastGainMapByte] = (brokenGainMap[lastGainMapByte] ?? 0) ^ 1;
    await expect(verifyPhotoBinary(brokenGainMap, 'image/jpeg')).rejects.toMatchObject({ code: 'INVALID_PHOTO_BINARY' });
    const undeclared = new Uint8Array([...ultraHdrJpeg(fixture()), ...declared.slice(-36)]);
    await expect(verifyPhotoBinary(undeclared, 'image/jpeg')).rejects.toMatchObject({ code: 'INVALID_PHOTO_BINARY' });
  });
  it('decodes a synthetic HEIF sample to metadata-free JPEG, and rejects malformed containers', async () => {
    // Synthetic 32px HEVC fixture from libheif fuzzing/data/corpus/hevc32.heif (LGPL-3.0).
    const heic = Uint8Array.from(Buffer.from('AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAXttZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABnwABAAAAAAAAAGwAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA+2lwcnAAAADbaXBjbwAAAHZodmNDAQNwAAAAAAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQAqQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbq5Ka5uAhoMCAAAAMDIAAAAwAhYgABAAZEAcFzwIkAAAATY29scm5jbHgAAQANAAaAAAAAFGlzcGUAAAAAAAAAQAAAAEAAAAAoY2xhcAAAACAAAAABAAAAIAAAAAH////gAAAAAv///+AAAAACAAAADnBpeGkAAAAAAQgAAAAYaXBtYQAAAAAAAAABAAEFgQIDBYQAAAB0bWRhdAAAAGgoAa8TgPUrAhGDczL1mz4HCRRzxqbGjnnUrr1cLTO799zRz6nw0QjRMp+4I2Da10D3ghQEMvB53CWoI0S3qXIb99YsvLFaQ9ZLHxsJsZ9SxlvNJ5EgD4Y4miuaKu3bxPGXDHirp/9TzA==', 'base64'));
    for (const mime of ['image/heic', 'image/heif'] as const) {
      const output = await verifyPhotoBinary(heic, mime);
      expect(output.mime).toBe('image/jpeg');
      expect(output.sizeBytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
      checkPhotoEnvelope(output.bytes, output.mime, true);
    }
    const bad = heic.slice(); bad[4] = 0;
    expect(() => checkPhotoInputEnvelope(bad, 'image/heic')).toThrow(PhotoError);
    expect(() => checkPhotoInputEnvelope(heic, 'image/jpeg')).toThrow(PhotoError);
  });
  it('compresses high-detail JPEG input rather than trusting the original size', async () => {
    const width = 1280, height = 960, rgb = new Uint8Array(width * height * 3);
    let seed = 1;
    for (let index = 0; index < rgb.length; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      rgb[index] = (seed >>> 24) & 255;
    }
    const raw = ImageMagick.read(rgb, new MagickReadSettings({ format: MagickFormat.Rgb, width, height, depth: 8 }), image => {
      image.quality = 85;
      return image.write(MagickFormat.Jpeg, data => Uint8Array.from(data));
    });
    expect(raw.length).toBeGreaterThan(PHOTO_MAX_BYTES);
    const output = await verifyPhotoBinary(raw, 'image/jpeg');
    expect(output.sizeBytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    expect(output.sizeBytes).toBeLessThan(raw.length);
  });
  it('cancels oversized unknown/lying-length streams and rejects partial/empty bodies', async () => {
    for (const length of [null, '100']) {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(PHOTO_INPUT_MAX_BYTES)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
      await expect(readPhotoBody(stream, length, PHOTO_INPUT_MAX_BYTES)).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE' });
      expect(cancelled).toBe(true);
    }
    const raw = fixture();
    expect(await readPhotoBody(new Response(raw).body, String(raw.length))).toEqual(raw);
    expect(await readPhotoBody(new Response(Buffer.from(padJpeg(raw, 307201))).body, '307201', PHOTO_INPUT_MAX_BYTES)).toHaveLength(307201);
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
