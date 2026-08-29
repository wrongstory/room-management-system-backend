import { describe, expect, it, vi } from 'vitest';
import { type Actor, canManageAccounts } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import {
  assertIdempotentAccountCreation,
  normalizeDisplayName,
  normalizeKoreanMobile,
  SupabaseAccountService
} from '../src/modules/accounts/account.service.js';

const actor: Actor = {
  authUserId: 'auth-admin-1',
  profileId: 'admin-1',
  displayName: '관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: 'access-token'
};

const activeAdminProfile = {
  id: 'admin-1',
  auth_user_id: 'auth-admin-1',
  display_name: '관리자',
  display_name_normalized: '관리자',
  login_id: '관리자',
  login_id_normalized: '관리자',
  role: 'admin' as const,
  status: 'active' as const,
  phone_last_four: '5678',
  phone_lookup_hash: 'phone-hash',
  must_change_password: false,
  failed_login_count: 0,
  locked_until: null,
  created_at: '2026-08-26T00:00:00.000Z',
  updated_at: '2026-08-26T00:00:00.000Z'
};

function accountStatusHarness(
  rpcResult: unknown,
  authError: unknown = null,
  profile: unknown = activeAdminProfile
) {
  const callOrder: string[] = [];
  const rpc = vi.fn(async () => {
    callOrder.push('database');
    return rpcResult;
  });
  const updateUserById = vi.fn(async () => {
    callOrder.push('auth');
    return { data: null, error: authError };
  });
  const clients = {
    admin: {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () => ({ data: profile, error: null }))
          }))
        }))
      })),
      rpc,
      auth: { admin: { updateUserById } }
    },
    publicClient: {},
    forAccessToken: vi.fn()
  } as unknown as SupabaseClients;

  return {
    service: new SupabaseAccountService(clients, 'test-phone-pepper-at-least-32-characters'),
    rpc,
    updateUserById,
    callOrder
  };
}

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

  it('allows developer and admin to manage accounts but not maids', () => {
    expect(canManageAccounts('developer')).toBe(true);
    expect(canManageAccounts('admin')).toBe(true);
    expect(canManageAccounts('maid')).toBe(false);
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

  it('rejects the last active admin before mutating Auth state', async () => {
    const harness = accountStatusHarness({
      data: null,
      error: { message: 'LAST_ACTIVE_ADMIN_REQUIRED' }
    });

    await expect(harness.service.changeStatus(actor, {
      targetProfileId: activeAdminProfile.id,
      status: 'inactive',
      reasonCode: 'ADMIN_REQUEST',
      idempotencyKey: 'status-last-admin-0001'
    })).rejects.toMatchObject({ code: 'LAST_ACTIVE_ADMIN_REQUIRED', statusCode: 409 });

    expect(harness.callOrder).toEqual(['database']);
    expect(harness.updateUserById).not.toHaveBeenCalled();
  });

  it('reports a retryable inconsistency when Auth sync fails after DB commit', async () => {
    const inactiveProfile = { ...activeAdminProfile, status: 'inactive' as const };
    const harness = accountStatusHarness(
      { data: inactiveProfile, error: null },
      { message: 'Auth unavailable' }
    );

    await expect(harness.service.changeStatus(actor, {
      targetProfileId: activeAdminProfile.id,
      status: 'inactive',
      reasonCode: 'ADMIN_REQUEST',
      idempotencyKey: 'status-auth-retry-0001'
    })).rejects.toMatchObject({
      code: 'ACCOUNT_AUTH_STATE_INCONSISTENT',
      statusCode: 502
    });

    expect(harness.callOrder).toEqual(['database', 'auth']);
    expect(harness.updateUserById).toHaveBeenCalledWith(
      activeAdminProfile.auth_user_id,
      { ban_duration: '876000h' }
    );
  });

  it('rejects developer role mutation before touching Auth or DB', async () => {
    const developerProfile = {
      ...activeAdminProfile,
      id: 'developer-1',
      auth_user_id: 'auth-developer-1',
      role: 'developer' as const
    };
    const harness = accountStatusHarness({ data: null, error: null }, null, developerProfile);

    await expect(harness.service.changeRole(actor, {
      targetProfileId: developerProfile.id,
      role: 'admin',
      idempotencyKey: 'protect-developer-role-0001'
    })).rejects.toMatchObject({ code: 'DEVELOPER_ACCOUNT_PROTECTED', statusCode: 403 });

    expect(harness.rpc).not.toHaveBeenCalled();
    expect(harness.updateUserById).not.toHaveBeenCalled();
  });
});
