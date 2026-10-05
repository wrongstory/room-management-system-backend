import { describe, expect, it } from 'vitest';
import { type PhotoMime, PhotoError } from '../src/modules/photos/photo-binary.js';
import { photoContentDisposition, photoStorageFileName } from '../src/modules/photos/photo-storage-name.js';

describe('canonical server-reserved photo name boundary', () => {
  it.each(['일반방', '폭탄방', '특이사항'])('allows only the server collection kind %s with the matching output extension', kind => {
    for (const mime of ['image/jpeg', 'image/webp'] as const) {
      const fileName = `2026-10-05_${kind}_350_01.${mime === 'image/jpeg' ? 'jpg' : 'webp'}`;
      expect(photoStorageFileName(fileName, mime)).toBe(fileName);
    }
  });
  it.each(['01', '09', '10', '99', '100', '9007199254740993', '9223372036854775807'])('preserves the persisted sequence %s without Number precision loss or truncation', sequence => {
    const fileName = `2026-10-05_일반방_350_${sequence}.jpg`;
    expect(photoStorageFileName(fileName, 'image/jpeg')).toBe(fileName);
  });
  it.each(['0001-01-01', '1900-02-28', '2000-02-29', '2024-02-29', '9999-12-31'])('validates the actual calendar date %s without a timezone conversion', date => {
    const fileName = `${date}_일반방_000_01.jpg`;
    expect(photoStorageFileName(fileName, 'image/jpeg')).toBe(fileName); // Same three-digit room identity contract, including 000.
  });
  it.each([
    '0000-01-01_일반방_350_01.jpg', '2026-00-01_일반방_350_01.jpg', '2026-13-01_일반방_350_01.jpg',
    '2026-01-00_일반방_350_01.jpg', '2026-01-32_일반방_350_01.jpg', '2026-04-31_일반방_350_01.jpg',
    '1900-02-29_일반방_350_01.jpg', '2026-02-29_일반방_350_01.jpg', '10000-01-01_일반방_350_01.jpg',
    '2026-1-01_일반방_350_01.jpg', '2026-01-1_일반방_350_01.jpg', '2026-01-01_일반방_35_01.jpg',
    '2026-01-01_일반방_3500_01.jpg', '2026-01-01_일반방_350_1.jpg', '2026-01-01_일반방_350_00.jpg',
    '2026-01-01_일반방_350_010.jpg', '2026-01-01_일반방_350_001.jpg', '2026-01-01_일반방_350_-01.jpg',
    '2026-01-01_일반방_350_1.5.jpg', '2026-01-01_일반방_350_1e2.jpg', '2026-01-01_일반방_350_9223372036854775808.jpg',
    '2026-01-01_일반방_350_10000000000000000000.jpg', '2026-01-01_일반방_350_01.jpeg',
    '2026-01-01_일반방_350_01.JPG', '2026-01-01_일반방_350_01.webp', '2026-01-01_청소사진_350_01.jpg',
    '2026-01-01_일반방\u200b_350_01.jpg', '2026-01-01_일반방_350_０１.jpg', '2026-01-01_일반방_３５０_01.jpg',
    '2026-01-01_일반방_350_01.jpg', '2026-01-01_일반방_350_01.jpg\u202e',
    '2026-01-01_일반방_350_01.jpg\r\nX-Test: private', '2026-01-01_일반방_350_01.jpg\n',
    '../2026-01-01_일반방_350_01.jpg', '2026-01-01_일반방_350_01.jpg/path',
    '2026-01-01_일반방_350_01.jpg\\path', '2026-01-01_일반방_350_01.jpg%0D%0A',
    '2026-01-01_일반방_350_01.jpg\0', '2026-01-01_일반방_350_01.jpg"', '2026-01-01_일반방_350_01.jpg ',
  ])('rejects noncanonical or unsafe DB name %s without reflecting it', fileName => {
    let caught: unknown;
    try { photoStorageFileName(fileName, 'image/jpeg'); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(PhotoError);
    expect(caught).toMatchObject({ statusCode: 500, code: 'PHOTO_UPLOAD_FAILED', message: 'PHOTO_UPLOAD_FAILED' });
    expect(JSON.stringify(caught)).not.toContain(fileName);
    expect(() => photoContentDisposition(fileName, 'image/jpeg')).toThrow('PHOTO_UPLOAD_FAILED');
  });
  it.each([undefined, null])('treats %s as a legacy name but never invents a readable name', fileName => {
    expect(photoStorageFileName(fileName, 'image/jpeg')).toBeNull();
    expect(photoContentDisposition(fileName, 'image/jpeg')).toBe('inline; filename="photo.jpg"');
    expect(photoContentDisposition(fileName, 'image/webp')).toBe('inline; filename="photo.webp"');
  });
  it.each(['', false, 42, {}, [], 'a'.repeat(1000)])('rejects invalid type or oversized value %#', value => {
    expect(() => photoStorageFileName(value, 'image/jpeg')).toThrow('PHOTO_UPLOAD_FAILED');
  });
  it.each(['image/png', 'image/heic', 'image/heif', undefined, null])('does not infer an extension from unexpected MIME %s', mime => {
    expect(() => photoStorageFileName(null, mime as PhotoMime)).toThrow('PHOTO_UPLOAD_FAILED');
    expect(() => photoStorageFileName('2026-10-05_일반방_350_01.jpg', mime as PhotoMime)).toThrow('PHOTO_UPLOAD_FAILED');
  });
  it.each(['일반방', '폭탄방', '특이사항'])('builds an ASCII-only RFC 5987 header for %s', kind => {
    const fileName = `2026-10-05_${kind}_350_100.webp`;
    const disposition = photoContentDisposition(fileName, 'image/webp');
    expect(disposition).toBe(`inline; filename="photo.webp"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    expect(disposition).toMatch(/^[\x20-\x7e]+$/);
    expect(new Headers({ 'content-disposition': disposition }).get('content-disposition')).toBe(disposition);
    expect(decodeURIComponent(disposition.split("UTF-8''")[1] ?? '')).toBe(fileName);
  });
});
