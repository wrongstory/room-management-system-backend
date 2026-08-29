import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import {
  availabilityDatabaseError,
  SupabaseAvailabilityService
} from '../src/modules/availability/availability.service.js';

const adminActor: Actor = {
  authUserId: 'auth-admin-1',
  profileId: 'admin-1',
  displayName: '관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: 'admin-token'
};

const maidActor: Actor = {
  authUserId: 'auth-maid-1',
  profileId: 'maid-1',
  displayName: '메이드',
  role: 'maid',
  mustChangePassword: false,
  accessToken: 'maid-token'
};

function clients(): SupabaseClients {
  return {
    admin: { rpc: vi.fn(), from: vi.fn() },
    publicClient: {},
    forAccessToken: vi.fn()
  } as unknown as SupabaseClients;
}

describe('availability service authorization and errors', () => {
  it('maps stale and idempotency database contracts to HTTP conflicts', () => {
    expect(availabilityDatabaseError({ message: 'STALE_VERSION' })).toMatchObject({
      statusCode: 409,
      code: 'STALE_VERSION'
    });
    expect(availabilityDatabaseError({ message: 'IDEMPOTENCY_KEY_REUSED' })).toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED'
    });
  });

  it('rejects administrator submission before using the service-role client', async () => {
    const supabaseClients = clients();
    const service = new SupabaseAvailabilityService(supabaseClients);

    await expect(service.submit(adminActor, {
      weekStart: '2026-08-31',
      availableDates: ['2026-08-31'],
      expectedVersion: 0,
      idempotencyKey: 'availability-submit-1'
    })).rejects.toMatchObject({ statusCode: 403, code: 'MAID_REQUIRED' });
    expect(supabaseClients.admin.rpc).not.toHaveBeenCalled();
  });

  it('rejects cross-maid reads before creating an RLS client', async () => {
    const supabaseClients = clients();
    const service = new SupabaseAvailabilityService(supabaseClients);

    await expect(service.listCurrent(
      maidActor,
      '2026-08-31',
      '22222222-2222-4222-8222-222222222222'
    )).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(supabaseClients.forAccessToken).not.toHaveBeenCalled();
  });
});
