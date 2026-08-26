import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/app-error.js';
import {
  assertIdempotentAccountCreation,
  normalizeDisplayName,
  normalizeKoreanMobile
} from '../src/modules/accounts/account.service.js';

describe('account input normalization', () => {
  it('normalizes Korean mobile numbers without storing formatting', () => {
    expect(normalizeKoreanMobile('010-1234-5678')).toEqual({
      canonical: '+821012345678',
      lastFour: '5678'
    });
    expect(normalizeKoreanMobile('+82 10 1234 5678')).toEqual({
      canonical: '+821012345678',
      lastFour: '5678'
    });
  });

  it('rejects non-mobile phone numbers', () => {
    expect(() => normalizeKoreanMobile('02-1234-5678')).toThrow(AppError);
  });

  it('uses a stable normalized name while preserving the display name', () => {
    expect(normalizeDisplayName('  김  민지  ')).toEqual({
      displayName: '김 민지',
      normalized: '김 민지'
    });
  });

  it('rejects an idempotency key reused for different account input', () => {
    const existing = {
      display_name_normalized: '김민지',
      role: 'maid' as const,
      phone_lookup_hash: 'first-phone-hash'
    };

    expect(() => assertIdempotentAccountCreation(existing, {
      displayNameNormalized: '김민지',
      role: 'admin',
      phoneLookupHash: 'first-phone-hash'
    })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 }));

    expect(() => assertIdempotentAccountCreation(existing, {
      displayNameNormalized: '김민지',
      role: 'maid',
      phoneLookupHash: 'second-phone-hash'
    })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 }));
  });

  it('accepts an exact account creation retry', () => {
    expect(() => assertIdempotentAccountCreation({
      display_name_normalized: '김민지',
      role: 'maid',
      phone_lookup_hash: 'phone-hash'
    }, {
      displayNameNormalized: '김민지',
      role: 'maid',
      phoneLookupHash: 'phone-hash'
    })).not.toThrow();
  });
});
