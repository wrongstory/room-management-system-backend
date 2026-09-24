import { readFile } from 'node:fs/promises';
import { ImageMagick, MagickColors, MagickError, MagickErrorSeverity, MagickFormat, MagickImage } from '@imagemagick/magick-wasm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializePhotoDecoder, PhotoError, photoFailureDiagnostic, readPhotoBody, verifyPhotoBinary } from '../src/modules/photos/photo-binary.js';

const requestId = '10000000-0000-4000-8000-000000000001';
let jpeg: Uint8Array;
beforeAll(async () => {
  await initializePhotoDecoder(await readFile(new URL(import.meta.resolve('@imagemagick/magick-wasm/magick.wasm'))));
  jpeg = ImageMagick.read(MagickColors.White, 16, 16, image => image.write(MagickFormat.Jpeg, data => Uint8Array.from(data)));
});
afterEach(() => vi.restoreAllMocks());

describe('bounded private photo failure diagnostics', () => {
  it('distinguishes body and envelope rejection without changing public errors', async () => {
    const bodyError = await readPhotoBody(null, '1').catch(error => error);
    const envelopeError = await verifyPhotoBinary(new Uint8Array([1]), 'image/jpeg').catch(error => error);
    for (const [error, phase] of [[bodyError, 'BODY'], [envelopeError, 'INPUT_ENVELOPE']]) {
      expect(error).toMatchObject({ statusCode: 400, code: 'INVALID_PHOTO_BINARY' });
      expect(photoFailureDiagnostic(error, requestId)).toEqual({ status: 400, code: `PHOTO_${phase}_REJECTED`, requestId });
    }
  });

  it.each(['INPUT_DECODE', 'TRANSFORM', 'ENCODE', 'OUTPUT_DECODE'] as const)('classifies %s exceptions without retaining native content', async phase => {
    const create = MagickImage.create.bind(MagickImage);
    let created = 0;
    vi.spyOn(MagickImage, 'create').mockImplementation(() => {
      const image = create();
      const output = ++created === 2;
      const fail = () => { throw new Error('synthetic-private-native-message'); };
      if (phase === 'INPUT_DECODE' && !output || phase === 'OUTPUT_DECODE' && output) vi.spyOn(image, 'read').mockImplementation(fail);
      if (phase === 'TRANSFORM' && !output) vi.spyOn(image, 'autoOrient').mockImplementation(fail);
      if (phase === 'ENCODE' && !output) vi.spyOn(image, 'write').mockImplementation(fail);
      return image;
    });
    const error = await verifyPhotoBinary(jpeg, 'image/jpeg').catch(error => error);
    expect(error).toMatchObject({ statusCode: 400, code: 'INVALID_PHOTO_BINARY' });
    expect(photoFailureDiagnostic(error, requestId)).toEqual({ status: 400, code: `PHOTO_${phase}_NATIVE`, requestId });
    expect(JSON.stringify(error)).not.toContain('synthetic-private');
    expect(error.cause).toBeUndefined();
  });

  it('records the warning origin, not the later encode phase', async () => {
    const create = MagickImage.create.bind(MagickImage);
    vi.spyOn(MagickImage, 'create').mockImplementationOnce(() => {
      const image = create();
      vi.spyOn(image, 'autoOrient').mockImplementation(() => { image.onWarning?.({ error: new MagickError('synthetic-private-warning') }); });
      return image;
    });
    const error = await verifyPhotoBinary(jpeg, 'image/jpeg').catch(error => error);
    expect(photoFailureDiagnostic(error, requestId)).toEqual({ status: 400, code: 'PHOTO_TRANSFORM_WARNING', requestId });
  });

  it.each([
    [MagickErrorSeverity.ResourceLimitError, 'RESOURCE'],
    [MagickErrorSeverity.CorruptImageError, 'CORRUPT'],
    [MagickErrorSeverity.CacheError, 'CACHE'],
    [MagickErrorSeverity.PolicyError, 'POLICY'],
    [MagickErrorSeverity.MissingDelegateError, 'DELEGATE'],
  ])('uses numeric native severity %s only', async (severity, kind) => {
    const native = Object.create(MagickError.prototype);
    Object.defineProperty(native, 'severity', { value: severity });
    for (const key of ['message', 'stack', 'relatedErrors']) Object.defineProperty(native, key, { get() { throw new Error('must not inspect native content'); } });
    vi.spyOn(MagickImage, 'create').mockImplementationOnce(() => { throw native; });
    const error = await verifyPhotoBinary(jpeg, 'image/jpeg').catch(error => error);
    expect(photoFailureDiagnostic(error, requestId)).toEqual({ status: 400, code: `PHOTO_INPUT_DECODE_${kind}`, requestId });
  });

  it('allows only three scalar fields and closed codes; arbitrary request IDs never enter logs', () => {
    const error = new PhotoError(400, 'synthetic-private-code', { phase: 'BODY', kind: 'REJECTED' });
    expect(photoFailureDiagnostic(error, 'private-header\n')).toEqual({ status: 400, code: 'PHOTO_BODY_REJECTED', requestId: 'unavailable' });
    expect(photoFailureDiagnostic(new Error('private'), requestId)).toBeNull();
    expect(photoFailureDiagnostic(new PhotoError(400, 'INVALID_PHOTO_BINARY'), requestId)).toBeNull();
    expect(photoFailureDiagnostic(new PhotoError(500, 'private', { phase: 'BODY', kind: 'REJECTED' }), requestId)).toBeNull();
    if (!error.diagnostic) throw new Error('expected diagnostic');
    Object.assign(error.diagnostic, { phase: 'private-phase' });
    expect(photoFailureDiagnostic(error, requestId)).toBeNull();
    Object.assign(error.diagnostic, { phase: 'BODY', kind: 'private-kind' });
    expect(photoFailureDiagnostic(error, requestId)).toBeNull();
  });
});
