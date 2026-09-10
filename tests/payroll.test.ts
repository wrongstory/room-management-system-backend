import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { requestHash } from '../src/lib/command.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import {
  payrollDatabaseError,
  SupabasePayrollService,
  toPayrollCycle
} from '../src/modules/payroll/payroll.service.js';
import {
  assertPayrollResponseSize,
  PAYROLL_RESPONSE_MAX_BYTES,
  PayrollCursorCodec,
  payrollCursorScope
} from '../src/modules/payroll/payroll-cursor.js';

const cursorSecret = 'payroll-cursor-secret-for-tests-123456';
const admin: Actor = {
  authUserId: '10000000-0000-4000-8000-000000000001',
  profileId: '20000000-0000-4000-8000-000000000001',
  displayName: '관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: 'admin-token'
};
const maid: Actor = {
  ...admin,
  authUserId: '10000000-0000-4000-8000-000000000002',
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
  itemCount: 11,
  totalAmount: 330000,
  items: [{
    earningId: '30000000-0000-4000-8000-000000000001',
    earnedOn: '2026-08-25',
    amount: 30000,
    alreadyClaimed: false
  }],
  itemsHasMore: true,
  itemsLastEarnedOn: '2026-08-25',
  itemsLastEarningId: '30000000-0000-4000-8000-000000000001',
  lateEarningCount: 0,
  lateEarningAmount: 0,
  lateEarnings: [],
  lateEarningsHasMore: false,
  lateEarningsLastEarnedOn: null,
  lateEarningsLastEarningId: null,
  offsetSettled: false,
  adjustmentAmount: -5000,
  carryInAmount: 0,
  carryOutAmount: 0,
  payableAmount: 325000,
  adjustmentCount: 1
  , paymentAttemptId: null, paymentAttemptNumber: null, paidAt: null,
  checkReasonCode: null, lastReopenReasonCode: null
};

function clients(rpc: ReturnType<typeof vi.fn>): SupabaseClients {
  return { admin: { rpc } } as unknown as SupabaseClients;
}
function service(rpc: ReturnType<typeof vi.fn>): SupabasePayrollService {
  return new SupabasePayrollService(clients(rpc), cursorSecret);
}

describe('payroll pagination service', () => {
  it('lists a bounded conceptual OPEN page and emits opaque continuations', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        payroll: [projection],
        hasMore: true,
        lastMaidProfileId: maid.profileId
      },
      error: null
    }));
    const page = await service(rpc).list(admin, {
      weekStart: projection.weekStart,
      limit: 10
    });

    expect(page.payroll[0]).toMatchObject({
      cycleId: null,
      itemCount: 11,
      totalAmount: 330000
    });
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(page.payroll[0]?.itemsNextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(page)).not.toContain('itemsHasMore');
    expect(rpc).toHaveBeenCalledWith('list_payroll_cycles_page', {
      p_actor_profile_id: admin.profileId,
      p_week_start: projection.weekStart,
      p_maid_profile_id: null,
      p_after_maid_profile_id: null,
      p_limit: 10
    });
  });

  it('decodes only an actor, role, week, filter, sort and kind-bound cursor', async () => {
    const firstRpc = vi.fn(async () => ({
      data: { payroll: [projection], hasMore: true, lastMaidProfileId: maid.profileId },
      error: null
    }));
    const first = await service(firstRpc).list(admin, { weekStart: projection.weekStart });
    const secondRpc = vi.fn(async () => ({
      data: { payroll: [], hasMore: false, lastMaidProfileId: null },
      error: null
    }));
    await service(secondRpc).list(admin, {
      weekStart: projection.weekStart,
      cursor: first.nextCursor as string
    });
    expect(secondRpc).toHaveBeenCalledWith(
      'list_payroll_cycles_page',
      expect.objectContaining({ p_after_maid_profile_id: maid.profileId })
    );

    for (const [actor, input] of [
      [{ ...admin, profileId: '20000000-0000-4000-8000-000000000009' }, { weekStart: projection.weekStart }],
      [{ ...admin, role: 'maid' as const }, { weekStart: projection.weekStart }],
      [admin, { weekStart: '2026-08-17' }],
      [admin, { weekStart: projection.weekStart, maidProfileId: maid.profileId }]
    ] as const) {
      const forbiddenRpc = vi.fn();
      await expect(service(forbiddenRpc).list(actor, {
        ...input,
        cursor: first.nextCursor as string
      })).rejects.toMatchObject({ code: 'PAYROLL_CURSOR_INVALID' });
      expect(forbiddenRpc).not.toHaveBeenCalled();
    }
  });

  it('rejects tampered, wrong-secret, malformed and oversized cursors before RPC', async () => {
    const scope = payrollCursorScope(admin, projection.weekStart, undefined, 'cycles');
    const valid = new PayrollCursorCodec(cursorSecret).encode(scope, {
      maidProfileId: maid.profileId
    });
    for (const cursor of [
      valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A'),
      'raw',
      'x'.repeat(1025)
    ]) {
      const rpc = vi.fn();
      await expect(service(rpc).list(admin, {
        weekStart: projection.weekStart,
        cursor
      })).rejects.toMatchObject({ code: 'PAYROLL_CURSOR_INVALID' });
      expect(rpc).not.toHaveBeenCalled();
    }
    expect(() => new PayrollCursorCodec('short')).toThrowError(
      expect.objectContaining({ code: 'PAYROLL_CURSOR_NOT_CONFIGURED' })
    );
    expect(() => new PayrollCursorCodec('another-secret-at-least-thirty-two-bytes').decode(valid, scope))
      .toThrowError(expect.objectContaining({ code: 'PAYROLL_CURSOR_INVALID' }));
  });

  it('pages items by earned date and earning ID', async () => {
    const scope = payrollCursorScope(admin, projection.weekStart, maid.profileId, 'items');
    const cursor = new PayrollCursorCodec(cursorSecret).encode(scope, {
      earnedOn: '2026-08-25',
      earningId: '30000000-0000-4000-8000-000000000001'
    });
    const nextId = '30000000-0000-4000-8000-000000000002';
    const rpc = vi.fn(async () => ({
      data: {
        entries: [{
          earningId: nextId,
          earnedOn: '2026-08-25',
          amount: 20000,
          alreadyClaimed: false
        }],
        hasMore: false,
        lastEarnedOn: '2026-08-25',
        lastEarningId: nextId
      },
      error: null
    }));
    const page = await service(rpc).listEntries(admin, {
      weekStart: projection.weekStart,
      maidProfileId: maid.profileId,
      kind: 'items',
      limit: 25,
      cursor
    });
    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    expect(rpc).toHaveBeenCalledWith('list_payroll_entries_page', expect.objectContaining({
      p_after_earned_on: '2026-08-25',
      p_after_earning_id: '30000000-0000-4000-8000-000000000001',
      p_kind: 'items',
      p_limit: 25
    }));
  });

  it('blocks developer and maid cross-profile IDOR before any service-role RPC', async () => {
    const rpc = vi.fn();
    await expect(service(rpc).list({ ...admin, role: 'developer' }, { weekStart: projection.weekStart }))
      .rejects.toMatchObject({ statusCode: 403, code: 'PAYROLL_ACCESS_REQUIRED' });
    await expect(service(rpc).listEntries(maid, {
      weekStart: projection.weekStart,
      maidProfileId: admin.profileId,
      kind: 'items'
    })).rejects.toMatchObject({ statusCode: 403, code: 'PAYROLL_ACCESS_REQUIRED' });
    expect(rpc).not.toHaveBeenCalled();

    const selfRpc = vi.fn(async () => ({
      data: { entries: [], hasMore: false, lastEarnedOn: null, lastEarningId: null },
      error: null
    }));
    await expect(service(selfRpc).listEntries(maid, {
      weekStart: projection.weekStart,
      maidProfileId: maid.profileId.toUpperCase(),
      kind: 'items'
    })).resolves.toMatchObject({ entries: [] });
  });

  it('keeps start and replay logically idempotent while returning bounded cursors', async () => {
    const paying = {
      ...projection,
      cycleId: '40000000-0000-4000-8000-000000000001',
      status: 'paying',
      version: 1,
      lockedAmount: 330000,
      paymentStartedAt: '2026-09-10T00:00:00Z'
    };
    const rpc = vi.fn(async () => ({ data: paying, error: null }));
    const input = {
      maidProfileId: maid.profileId,
      weekStart: projection.weekStart,
      expectedVersion: 0,
      idempotencyKey: 'payroll-start-1'
    };
    const first = await service(rpc).start(admin, input);
    const replay = await service(rpc).start(admin, input);
    expect(first).toEqual(replay);
    expect(first.itemsNextCursor).not.toBeNull();
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

  it('uses typed sources and server-owned reason/reversal RPCs', async () => {
    const adjustment = {
      adjustmentId: '70000000-0000-4000-8000-000000000001',
      maidProfileId: maid.profileId,
      bookVersion: 1,
      amount: -5000,
      currency: 'KRW',
      reasonCode: 'earning_correction',
      rootEarningId: '30000000-0000-4000-8000-000000000001',
      correctionOfEarningId: '30000000-0000-4000-8000-000000000001',
      availableWeekStart: projection.weekStart,
      createdAt: '2026-09-10T00:00:00Z'
    };
    const rpc = vi.fn(async () => ({ data: adjustment, error: null }));
    await expect(service(rpc).correct(admin, {
      sourceEarningId: adjustment.rootEarningId,
      amount: -5000,
      expectedVersion: 0,
      idempotencyKey: 'payroll-correction-1'
    })).resolves.toMatchObject({ amount: -5000, reasonCode: 'earning_correction' });
    expect(rpc).toHaveBeenCalledWith('record_payroll_correction', expect.objectContaining({
      p_source_earning_id: adjustment.rootEarningId,
      p_source_adjustment_id: null,
      p_amount: -5000,
      p_expected_book_version: 0
    }));
  });

  it('canonicalizes a strict provider reference before hashing and recording full payment', async () => {
    const result = {
      paymentResultId: '41000000-0000-4000-8000-000000000001',
      paymentAttemptId: '42000000-0000-4000-8000-000000000001',
      payrollCycleId: '43000000-0000-4000-8000-000000000001', resultType: 'paid',
      beforeStatus: 'check', afterStatus: 'paid', cycleVersion: 3, lockedAmount: 325000,
      paymentMethod: 'bank_transfer', providerReferenceId: 'BANK.AB12', occurredAt: '2026-09-10T00:00:00Z'
    };
    const rpc = vi.fn(async () => ({ data: result, error: null }));
    await expect(service(rpc).recordPaymentPaid(admin, {
      paymentAttemptId: result.paymentAttemptId, expectedVersion: 2,
      paymentMethod: 'bank_transfer', providerReferenceId: 'bank.ab12', idempotencyKey: 'payment-paid-1'
    })).resolves.toMatchObject({ providerReferenceId: 'BANK.AB12', lockedAmount: 325000 });
    expect(rpc).toHaveBeenCalledWith('record_payroll_payment_paid', expect.objectContaining({
      p_canonical_reference: 'BANK.AB12', p_payment_method: 'bank_transfer',
      p_request_hash: requestHash({ command: 'payroll.payment.paid', actorProfileId: admin.profileId,
        paymentAttemptId: result.paymentAttemptId, expectedVersion: 2,
        paymentMethod: 'bank_transfer', providerReferenceId: 'BANK.AB12' })
    }));
    for (const providerReferenceId of ['ABCDEFGH', 'AB1234567', 'httpAB12', 'www.ab12', 'AB/12.XY', 'AB 12.XY']) {
      const blocked = vi.fn();
      await expect(service(blocked).recordPaymentPaid(admin, {
        paymentAttemptId: result.paymentAttemptId, expectedVersion: 2,
        paymentMethod: 'bank_transfer', providerReferenceId, idempotencyKey: 'payment-invalid-1'
      })).rejects.toMatchObject({ code: 'PAYROLL_PAYMENT_REFERENCE_INVALID' });
      expect(blocked).not.toHaveBeenCalled();
    }
  });

  it('strips private fields and fails closed on malformed projections', () => {
    expect(toPayrollCycle({ ...projection, rawRequestBody: 'secret' })).not.toHaveProperty('rawRequestBody');
    for (const malformed of [
      { ...projection, maidProfileId: 'not-a-uuid' },
      { ...projection, weekStart: '2026-02-30' },
      { ...projection, itemsHasMore: true, itemsLastEarningId: null },
      { ...projection, items: Array.from({ length: 11 }, () => projection.items[0]) },
      { ...projection, checkReasonCode: 'LEGACY_BANK_STATUS_PENDING' },
      { ...projection, lastReopenReasonCode: 'LEGACY_OPERATOR_CONFIRMED_NO_TRANSFER' }
    ]) {
      expect(() => toPayrollCycle(malformed)).toThrowError(
        expect.objectContaining({ code: 'PAYROLL_COMMAND_FAILED' })
      );
    }
  });

  it('fails closed when the UTF-8 serialized response exceeds 128 KiB', () => {
    expect(() => assertPayrollResponseSize({ value: '가'.repeat(PAYROLL_RESPONSE_MAX_BYTES) }))
      .toThrowError(expect.objectContaining({ code: 'PAYROLL_RESPONSE_TOO_LARGE' }));
    expect(() => assertPayrollResponseSize({ payroll: [projection] })).not.toThrow();
  });

  it.each([
    ['PAYROLL_WEEK_MUST_START_MONDAY', 400],
    ['PAYROLL_PAGE_LIMIT_INVALID', 400],
    ['PAYROLL_CURSOR_INVALID', 400],
    ['PAYROLL_ACCESS_REQUIRED', 403],
    ['PAYROLL_MAID_NOT_FOUND', 404],
    ['PAYROLL_WEEK_NOT_CLOSED', 409],
    ['PAYROLL_PRIOR_LATE_EARNING_PENDING', 409],
    ['NO_PAYROLL_AMOUNT', 409],
    ['IDEMPOTENCY_KEY_REUSED', 409]
  ])('maps %s without exposing raw database details', (code, statusCode) => {
    expect(payrollDatabaseError({ message: `${code}: private detail` }))
      .toMatchObject({ code, statusCode });
  });
});
