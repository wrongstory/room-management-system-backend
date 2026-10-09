import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
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
    expect(availabilityDatabaseError({ message: 'AVAILABILITY_WEEK_OUT_OF_RANGE' })).toMatchObject({
      statusCode: 409,
      code: 'AVAILABILITY_WEEK_OUT_OF_RANGE'
    });
    expect(
      availabilityDatabaseError({ message: 'PAST_AVAILABILITY_DATE_NOT_ALLOWED' })
    ).toMatchObject({
      statusCode: 409,
      code: 'PAST_AVAILABILITY_DATE_NOT_ALLOWED'
    });
    expect(availabilityDatabaseError({ message: 'ASSIGNMENT_AVAILABILITY_STALE' })).toMatchObject({
      statusCode: 409,
      code: 'ASSIGNMENT_AVAILABILITY_STALE'
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

const weekDays = Array.from({ length: 7 }, (_, day) => ({
  work_date: new Date(Date.UTC(2026, 7, 31 + day)).toISOString().slice(0, 10),
  available: day === 0
}));
const completeVersion = {
  id: 'version-1', maid_profile_id: 'maid-1', week_start: '2026-08-31',
  version: 1, status: 'submitted', is_current: true, submitted_at: '2026-08-30T00:00:00Z',
  availability_days: weekDays
};

describe('availability read completeness', () => {
  const paths = ['current', 'changes', 'candidates'] as const;
  const read = (service: SupabaseAvailabilityService, path: typeof paths[number]) => path === 'current'
    ? service.listCurrent(maidActor, '2026-08-31')
    : path === 'changes' ? service.listChangeRequests(maidActor, { weekStart: '2026-08-31' })
      : service.listCandidates(adminActor, '2026-08-31');

  function harness(data: unknown, total: string, path: typeof paths[number]) {
    const fetch = vi.fn(async () => new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-range': `0-0/${total}` }
    }));
    const client = createClient('https://example.supabase.co', 'test-key', {
      global: { fetch }, auth: { persistSession: false, autoRefreshToken: false }
    });
    const clientsMock = { forAccessToken: vi.fn(() => client) } as unknown as SupabaseClients;
    return { result: read(new SupabaseAvailabilityService(clientsMock), path), fetch, clientsMock };
  }

  for (const path of paths) {
    it(`${path} rejects a lower remote row cap instead of returning partial success`, async () => {
      const { result, fetch } = harness([completeVersion], '20', path);
      await expect(result).rejects.toMatchObject({ statusCode: 500, code: 'AVAILABILITY_COMMAND_FAILED' });
      const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
      expect(new Headers(init.headers).get('prefer')).toContain('count=exact');
      expect(String(url)).toContain('limit=1000');
    });
    it(`${path} accepts a proven empty result`, async () => {
      await expect(harness([], '0', path).result).resolves.toEqual([]);
    });
    for (const count of ['*', '-1', '1001']) {
      it(`${path} rejects missing, invalid or excessive count ${count}`, async () => {
        await expect(harness([], count, path).result).rejects.toMatchObject({
          statusCode: 500, code: 'AVAILABILITY_COMMAND_FAILED'
        });
      });
    }
  }
  it('preserves seven-day mapping and the maid self RLS filter', async () => {
    const { result, fetch, clientsMock } = harness([completeVersion], '1', 'current');
    await expect(result).resolves.toMatchObject([{ maidProfileId: 'maid-1', days: [{ workDate: '2026-08-31', available: true }, ...weekDays.slice(1).map(day => ({ workDate: day.work_date, available: false }))] }]);
    expect(clientsMock.forAccessToken).toHaveBeenCalledWith('maid-token');
    expect(String((fetch.mock.calls[0] as unknown as [URL])[0])).toContain('maid_profile_id=eq.maid-1');
  });
  for (const days of [undefined, {}, [null, ...weekDays.slice(1)], [], weekDays.slice(0, 6), [...weekDays.slice(0, 6), weekDays[0]], [...weekDays.slice(0, 6), { work_date: '2026-09-07', available: true }]]) {
    it('rejects missing, truncated, duplicate or out-of-week embedded days', async () => {
      await expect(harness([{ ...completeVersion, availability_days: days }], '1', 'current').result)
        .rejects.toMatchObject({ statusCode: 500, code: 'AVAILABILITY_COMMAND_FAILED' });
    });
  }
  it('accepts exactly 1000 complete rows but rejects a hidden 1001st row', async () => {
    const rows = Array.from({ length: 1000 }, (_, id) => ({ ...completeVersion, id: `version-${id}`, maid_profile_id: `maid-${id}` }));
    await expect(harness(rows, '1000', 'current').result).resolves.toHaveLength(1000);
    await expect(harness(rows, '1001', 'current').result).rejects.toMatchObject({ code: 'AVAILABILITY_COMMAND_FAILED' });
  });
});
