import { PhotoError, type PhotoMime } from './photo-binary.js';

const maximumSequence = 9223372036854775807n;
const namePattern = /^(\d{4})-(\d{2})-(\d{2})_(일반방|폭탄방|특이사항)_(\d{3})_(\d{2,19})\.(jpg|webp)$/;
const failed = (): never => { throw new PhotoError(500, 'PHOTO_UPLOAD_FAILED'); };

/** Validates an immutable, server-reserved name; never accepts a client filename or creates a new number. */
export function photoStorageFileName(value: unknown, mime: PhotoMime): string | null {
  if (mime !== 'image/jpeg' && mime !== 'image/webp') return failed();
  if (value === undefined || value === null) return null; // Already-reserved legacy identity remains opaque.
  if (typeof value !== 'string' || value.length > 64 || /[\r\n]/.test(value)) return failed();
  const parts = namePattern.exec(value);
  if (!parts || parts[0] !== value) return failed();
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumDay = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (year < 1 || maximumDay === undefined || day < 1 || day > maximumDay) return failed();
  const digits = parts[6];
  if (digits === undefined) return failed();
  const sequence = BigInt(digits);
  if (sequence < 1n || sequence > maximumSequence || sequence.toString().padStart(2, '0') !== digits) return failed();
  if (parts[7] !== (mime === 'image/jpeg' ? 'jpg' : 'webp')) return failed();
  return value;
}

/** ASCII fallback plus RFC 5987 UTF-8 for an authorized, validated server name only. */
export function photoContentDisposition(value: unknown, mime: PhotoMime): string {
  const name = photoStorageFileName(value, mime);
  const fallback = `inline; filename="photo.${mime === 'image/jpeg' ? 'jpg' : 'webp'}"`;
  return name === null ? fallback : `${fallback}; filename*=UTF-8''${encodeURIComponent(name)}`;
}
