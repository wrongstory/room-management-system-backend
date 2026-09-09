import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { requestHash } from '../src/lib/command.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import {
  payrollDatabaseError,
  SupabasePayrollService,
  toPayrollCycle
} from '../src/modules/payroll/payroll.service.js';

const admin: Actor = {
  authUserId: 'auth-admin',
  profileId: '20000000-0000-4000-8000-000000000001',
  displayName: '관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: 'admin-token'
};
const maid: Actor = {
  ...admin,
  authUserId: 'auth-maid',
  profileId: '20000000-0000-4000-8000-000000000002',
  displayName: '메이드',
  role: 'maid',
  accessToken: 'maid-token'
};
const projection = {
  cycleId: null,
  maidProfileId: maid.profileId,
  weekStart: '2026-08-24',
  status: 'open',
  version: 0,
  lockedAmount: null,
  paymentStartedAt: null,
  itemCount: 1,
  totalAmount: 30000,
  items: [{
    earningId: '30000000-0000-4000-8000-000000000001',
    earnedOn: '2026-08-25',
    amount: 30000,
    alreadyClaimed: false
  }],
  lateEarningCount: 0,
  lateEarningAmount: 0,
  lateEarnings: []
};

function clients(rpc: ReturnType<typeof vi.fn>): SupabaseClients {
  return { admin: { rpc } } as unknown as SupabaseClients;
}

describe('payroll service', () => {
  it('lists conceptual OPEN payroll through the actor-bound projection RPC', async () => {
    const rpc = vi.fn(async () => ({ data: [projection], error: null }));
    const result = await new SupabasePayrollService(clients(rpc))
      .list(maid, projection.weekStart);

    expect(result).toEqual([projection]);
    expect(rpc).toHaveBeenCalledWith('list_payroll_cycles', {
      p_actor_profile_id: maid.profileId,
      p_week_start: projection.weekStart,
      p_maid_profile_id: null
    });
  });

  it('blocks developer and maid IDOR before any service-role RPC', async () => {
    const rpc = vi.fn();
    const service = new SupabasePayrollService(clients(rpc));
    await expect(service.list({ ...admin, role: 'developer' }, projection.weekStart))
      .rejects.toMatchObject({ statusCode: 403, code: 'PAYROLL_ACCESS_REQUIRED' });
    await expect(service.list(maid, projection.weekStart, admin.profileId))
      .rejects.toMatchObject({ statusCode: 403, code: 'PAYROLL_ACCESS_REQUIRED' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('starts a PAYING snapshot with the canonical actor-scoped request hash', async () => {
    const paying = {
      ...projection,
      cycleId: '40000000-0000-4000-8000-000000000001',
      status: 'paying',
      version: 1,
      lockedAmount: 30000,
      paymentStartedAt: '2026-09-10T00:00:00Z',
      items: [{ ...projection.items[0], alreadyClaimed: true }]
    };
    const rpc = vi.fn(async () => ({ data: paying, error: null }));
    const input = {
      maidProfileId: maid.profileId,
      weekStart: projection.weekStart,
      expectedVersion: 0,
      idempotencyKey: 'payroll-start-1'
    };
    await expect(new SupabasePayrollService(clients(rpc)).start(admin, input))
      .resolves.toEqual(paying);
    expect(rpc).toHaveBeenCalledWith('start_payroll_cycle', {
      p_actor_profile_id: admin.profileId,
      p_maid_profile_id: maid.profileId,
      p_week_start: projection.weekStart,
      p_expected_version: 0,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash({
        command: 'payroll.start',
        actorProfileId: admin.profileId,
        maidProfileId: maid.profileId,
        weekStart: projection.weekStart,
        expectedVersion: 0
      })
    });
  });

  it('keeps only the strict public projection including bounded late earnings', () => {
    expect(toPayrollCycle({
      ...projection,
      rawRequestBody: 'secret',
      lateEarningCount: 1,
      lateEarningAmount: 10000,
      lateEarnings: [{
        earningId: '30000000-0000-4000-8000-000000000002',
        earnedOn: '2026-08-26',
        amount: '10000',
        rawLedger: 'private'
      }]
    })).toEqual({
      ...projection,
      lateEarningCount: 1,
      lateEarningAmount: 10000,
      lateEarnings: [{
        earningId: '30000000-0000-4000-8000-000000000002',
        earnedOn: '2026-08-26',
        amount: 10000
      }]
    });
  });

  it('fails closed on malformed UUID, date and ISO timestamp projections', () => {
    for (const malformed of [
      { ...projection, maidProfileId: 'not-a-uuid' },
      { ...projection, weekStart: '2026-02-30' },
      { ...projection, paymentStartedAt: '2026' }
    ]) {
      expect(() => toPayrollCycle(malformed)).toThrowError(
        expect.objectContaining({ code: 'PAYROLL_COMMAND_FAILED' })
      );
    }
  });

  it.each([
    ['PAYROLL_WEEK_MUST_START_MONDAY', 400],
    ['PAYROLL_ACCESS_REQUIRED', 403],
    ['PAYROLL_MAID_NOT_FOUND', 404],
    ['PAYROLL_WEEK_NOT_CLOSED', 409],
    ['NO_PAYROLL_AMOUNT', 409],
    ['IDEMPOTENCY_KEY_REUSED', 409]
  ])('maps %s without exposing raw database details', (code, statusCode) => {
    expect(payrollDatabaseError({ message: `${code}: private detail` }))
      .toMatchObject({ code, statusCode });
  });

  it('redacts unknown database errors', () => {
    const result = payrollDatabaseError({ message: 'postgres secret detail' });
    expect(result).toMatchObject({ statusCode: 500, code: 'PAYROLL_COMMAND_FAILED' });
    expect(result.message).not.toContain('postgres');
  });
});
