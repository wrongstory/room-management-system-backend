import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildApp, type AppServices } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';
import type { Actor } from '../src/domain/actor.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { PayrollCursorCodec, payrollCursorScope } from '../src/modules/payroll/payroll-cursor.js';
import { SupabasePayrollService } from '../src/modules/payroll/payroll.service.js';
import { PayrollWorkCursorCodec } from '../src/modules/payroll/payroll-work-details-cursor.js';
import { payrollWorkProjection, payrollWorkQuery, type PayrollWorkInput } from '../src/modules/payroll/payroll-work-details.js';

const secret = 'synthetic-payroll-cursor-secret-32bytes';
const sessionId = 'f1000000-0000-4000-8000-000000000001';
const id = (n: number) => `c1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const token = (session: unknown) => `header.${Buffer.from(JSON.stringify({ session_id: session })).toString('base64url')}.signature`;
const admin: Actor = { authUserId: id(1), profileId: id(2), displayName: '합성 관리자', role: 'admin', mustChangePassword: false, accessToken: token(sessionId) };
const maid: Actor = { ...admin, profileId: id(3), role: 'maid' };
const input: PayrollWorkInput = { maidProfileId: maid.profileId, weekStart: '2026-09-28', kind: 'earnings', limit: 25 };
const summary = { cycleId: null, cycleStatus: 'open', cycleVersion: 0, accrualAmount: 32000, expectedAmount: 0, pendingAmount: 0, pendingCount: 0,
  totalAmount: 32000, lateEarningAmount: 0, adjustmentAmount: -2000, carryInAmount: -1000, carryOutAmount: 0, payableAmount: 29000, offsetSettled: false, lockedAmount: null };
const common = { entryId: id(10), entryDate: '2026-09-29', cleaningTargetId: id(4), assignmentId: id(5), attemptId: id(6), submissionId: id(7), inspectionDecisionId: id(8),
  roomNumber: '350', roomTypeCode: 'standard', roomTypeName: '고정된 타입', cleaningKind: 'checkout', sourceKind: 'scheduled_checkout', fieldCompletedAt: '2026-09-29T01:00:00+09:00',
  feeSnapshot: 16000, attemptStatus: 'approved', submissionStatus: 'approved', inspectionDecision: 'approved' };
const earning = { ...common, earningId: id(10), earnedOn: common.entryDate, earningSource: 'cleaning', baseAmount: 16000, bombRoomBonus: 16000, totalAmount: 32000,
  itemContributionAmount: 32000, lateContributionAmount: 0, alreadyClaimed: false, lateCarried: false };
const workflow = { ...common, entryId: common.attemptId, attemptStatus: 'submitted', inspectionDecision: null, inspectionDecisionId: null, submissionStatus: 'submitted',
  earningId: null, baseAmount: null, bombRoomBonus: null, totalAmount: null, expectedContributionAmount: 16000, pendingContributionAmount: 16000, includedInPendingCount: true,
  expectedBaseContributionAmount: 16000, expectedBombContributionAmount: 0 };
const page = (entries: unknown[] = [earning], query = input, hasMore = false) => {
  const last = entries.at(-1) as { entryDate?: string; entryId?: string } | undefined;
  return { weekStart: query.weekStart, maidProfileId: query.maidProfileId, kind: query.kind,
    summary: query.kind === 'workflow' ? { ...summary, expectedAmount: 48000, pendingAmount: 16000, pendingCount: 1 } : summary, entries, hasMore,
    lastEntryDate: last?.entryDate ?? null, lastEntryId: last?.entryId ?? null };
};
function service(rpc: ReturnType<typeof vi.fn>): SupabasePayrollService {
  return new SupabasePayrollService({ admin: { rpc } } as unknown as SupabaseClients, secret);
}
const env: AppEnv = {
  APP_ENV: 'local', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3000, LOG_LEVEL: 'silent', CORS_ORIGINS: 'http://127.0.0.1:4173', corsOrigins: ['http://127.0.0.1:4173'],
  SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'publishable-test', SUPABASE_SECRET_KEY: 'secret-test', ACCOUNT_PHONE_PEPPER: 'synthetic-phone-pepper-minimum-32bytes',
  RESERVATION_PII_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'), RESERVATION_PII_KEY_VERSION: 'test-v1', RESERVATION_PII_KEYRING_JSON: '{}', RESERVATION_GUEST_NAME_PEPPER: 'synthetic-guest-pepper-minimum-32bytes',
  ROOM_PIN_KEY_BASE64: Buffer.alloc(32, 8).toString('base64'), ROOM_PIN_KEY_VERSION: 'pin-v1', ROOM_PIN_KEYRING_JSON: '{}', PAYROLL_CURSOR_HMAC_SECRET: secret,
  NOTIFICATION_CURSOR_HMAC_SECRET: 'synthetic-notification-cursor-32bytes', INSPECTION_CURSOR_HMAC_SECRET: 'synthetic-inspection-cursor-secret-32bytes',
  WEB_PUSH_SUBSCRIPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'), WEB_PUSH_SUBSCRIPTION_KEY_VERSION: 'v1', WEB_PUSH_SUBSCRIPTION_KEYRING_JSON: '{}', WEB_PUSH_BINDING_DIGEST_SECRET: 'synthetic-web-push-binding-secret-32bytes',
  VAPID_CURRENT_KEY_VERSION: 'vapid-v1', VAPID_PUBLIC_KEY: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', VAPID_PUBLIC_KEYRING_JSON: '{}', RESERVATION_SCHEDULER_INTERVAL_SECONDS: 60
};
const query = (candidate = input) => new URLSearchParams({ weekStart: candidate.weekStart, maidProfileId: candidate.maidProfileId, kind: candidate.kind }).toString();
async function app(identity = admin) {
  const read = vi.fn(async () => ({ ...page(), nextCursor: null }));
  const authenticate = vi.fn(async () => identity);
  const services = { auth: { authenticate }, accounts: {}, availability: {}, rooms: {}, reservations: {}, payroll: { listWorkDetails: read } } as unknown as AppServices;
  return { app: await buildApp({ env, services, logger: false }), read, authenticate };
}

describe('#324 work details pure read contract', () => {
  it('keeps actual money and workflow contribution separate and preserves zero compensation', () => {
    expect(payrollWorkProjection(page(), input, null).entries).toEqual([earning]);
    const wf = { ...input, kind: 'workflow' as const };
    expect(payrollWorkProjection(page([workflow], wf), wf, null).entries).toEqual([workflow]);
    const zero = { ...earning, baseAmount: 0, bombRoomBonus: 0, totalAmount: 0, itemContributionAmount: 0, earningSource: 'compensation' };
    expect(payrollWorkProjection({ ...page([zero]), summary: { ...summary, accrualAmount: 0, totalAmount: 0 } }, input, null).entries[0])
      .toMatchObject({ earningSource: 'compensation', totalAmount: 0, feeSnapshot: 16000 });
  });
  it('preserves historical unknown snapshots and long type names without current catalog synthesis', () => {
    const historical = { ...earning, roomNumber: null, roomTypeCode: null, roomTypeName: '형'.repeat(1001) };
    expect(payrollWorkProjection(page([historical]), input, null).entries[0]).toMatchObject({ roomNumber: null, roomTypeCode: null, roomTypeName: historical.roomTypeName });
  });
  it.each(['0001-01-01', '0099-12-31', '2000-02-29', '9999-12-31'])('supports Gregorian %s without Date.UTC year alias', (weekStart) => {
    expect(payrollWorkQuery(new URLSearchParams(query({ ...input, weekStart })))).toMatchObject({ weekStart, limit: 25 });
  });
  it.each(['0000-01-01', '2026-02-29', '2026-04-31', '2026-9-28', '2026-09-28T00:00:00Z'])('rejects invalid %s', (weekStart) => {
    expect(() => payrollWorkQuery(new URLSearchParams(query({ ...input, weekStart })))).toThrow('VALIDATION_ERROR');
  });
  it.each(['&limit=0', '&limit=51', '&limit=01', '&limit=1.5', '&limit=NaN', '&limit=', '&cursor=', '&extra=1', '&kind=workflow', '&weekStart=2026-09-28', '&maidProfileId=' + maid.profileId])
    ('rejects duplicate/unknown/noncanonical query %s', (extra) => { expect(() => payrollWorkQuery(new URLSearchParams(query() + extra))).toThrow('VALIDATION_ERROR'); });
  it.each([
    { extra: 'private' }, { entryId: id(99) }, { earnedOn: '2026-09-28' }, { baseAmount: -1 }, { bombRoomBonus: 15000 }, { totalAmount: 16000 }, { baseAmount: '16000' },
    { itemContributionAmount: 1 }, { lateContributionAmount: 32000 }, { lateCarried: true }, { earningSource: 'compensation' }, { inspectionDecision: 'rejected' }, { submissionId: null },
    { fieldCompletedAt: null }, { fieldCompletedAt: '2026-02-30T01:00:00Z' }, { fieldCompletedAt: '2026-09-28T00:00:00Z' },
    { attemptStatus: 'cancelled' }, { roomTypeName: 0 }, { feeSnapshot: Number.MAX_SAFE_INTEGER + 1 }
  ])('fails closed on invalid earning %#', (change) => { expect(() => payrollWorkProjection(page([{ ...earning, ...change }]), input, null)).toThrow('PAYROLL_COMMAND_FAILED'); });
  it.each([
    { earningId: id(10) }, { totalAmount: 0 }, { expectedBaseContributionAmount: 1 }, { pendingContributionAmount: 17000 }, { includedInPendingCount: false },
    { entryId: id(10) }, { submissionStatus: 'draft' }, { submissionId: null }
  ])('fails closed on malformed non-earning workflow %#', (change) => {
    const wf = { ...input, kind: 'workflow' as const };
    expect(() => payrollWorkProjection(page([{ ...workflow, ...change }], wf), wf, null)).toThrow('PAYROLL_COMMAND_FAILED');
  });
  it.each([
    { extra: 'private' }, { weekStart: '2026-09-21' }, { maidProfileId: id(99) }, { kind: 'workflow' }, { entries: null }, { hasMore: true }, { lastEntryId: id(99) },
    { lastEntryDate: null }, { entries: [earning, earning] }, { summary: { ...summary, cycleVersion: 1 } }, { summary: { ...summary, accrualAmount: -1 } }
  ])('rejects context, ordering, membership or summary corruption %#', (change) => { expect(() => payrollWorkProjection({ ...page(), ...change }, input, null)).toThrow('PAYROLL_COMMAND_FAILED'); });
  it('rejects validly typed complete-page and partial-page aggregate inconsistencies', () => {
    for (const candidate of [{ ...summary, accrualAmount: 32001 }, { ...summary, totalAmount: 32001 }, { ...summary, lateEarningAmount: 1 }]) {
      expect(() => payrollWorkProjection({ ...page(), summary: candidate }, input, null)).toThrow('PAYROLL_COMMAND_FAILED');
    }
    const first = { ...input, limit: 1 };
    expect(() => payrollWorkProjection({ ...page([earning], first, true), summary: { ...summary, accrualAmount: 31999 } }, first, null)).toThrow('PAYROLL_COMMAND_FAILED');
    expect(() => payrollWorkProjection(page([]), input, null)).toThrow('PAYROLL_COMMAND_FAILED');
    expect(payrollWorkProjection({ ...page([]), summary: { ...summary, accrualAmount: 0, totalAmount: 0 } }, input, null).entries).toEqual([]);
  });
  it.each(['', '\t', '\n', '\u00a0', ' \t\r\n\u00a0 '])('normalizes legacy blank snapshot strings %j at the SQL-raw to HTTP adapter boundary', async (blank) => {
    const rpc = vi.fn(async () => ({ data: page([{ ...earning, roomNumber: blank, roomTypeCode: blank, roomTypeName: blank }]), error: null }));
    const payroll = service(rpc);
    const services = { auth: { authenticate: vi.fn(async () => admin) }, accounts: {}, availability: {}, rooms: {}, reservations: {}, payroll } as unknown as AppServices;
    const http = await buildApp({ env, services, logger: false });
    try {
      const result = await http.inject({ method: 'GET', url: `/v1/payroll/work-details?${query()}`, headers: { authorization: 'Bearer synthetic-token' } });
      expect(result.statusCode).toBe(200);
      expect(result.json().entries[0]).toMatchObject({ roomNumber: null, roomTypeCode: null, roomTypeName: null });
      expect(result.headers['cache-control']).toBe('no-store');
    } finally { await http.close(); }
  });
});

describe('#324 session-bound service and cursor', () => {
  it('matches the independently shared Node/Edge synthetic session-HMAC cursor vector exactly', () => {
    const expected = 'eyJmYW1pbHkiOiJwYXlyb2xsLXdvcmstZGV0YWlscyIsInYiOjEsInNjb3BlIjp7ImFjdG9yUHJvZmlsZUlkIjoiYzEwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwiYWN0b3JSb2xlIjoiYWRtaW4iLCJzZXNzaW9uQmluZGluZyI6IlBveUE2MmQyazV5LU1YdlQ5aWZrYnFRT0ZJaTgxTElPVzhKSHZ3T1k1djgiLCJ3ZWVrU3RhcnQiOiIyMDI2LTA5LTI4IiwibWFpZFByb2ZpbGVJZCI6ImMxMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMyIsImtpbmQiOiJlYXJuaW5ncyIsInNvcnQiOiJlbnRyeURhdGU6YXNjLGVudHJ5SWQ6YXNjIn0sImFmdGVyIjp7ImVudHJ5RGF0ZSI6IjIwMjYtMDktMjkiLCJlbnRyeUlkIjoiYzEwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDEwIn19.tqU-nQ64ObG7gSQt6P2J_ZACyWynGjlFCj-yHyQOCog';
    const codec = new PayrollWorkCursorCodec(secret);
    const scope = codec.scope(admin.profileId, 'admin', sessionId, input);
    expect(scope.sessionBinding).toBe('PoyA62d2k5y-MXvT9ifkbqQOFIi81LIOW8JHvwOY5v8');
    expect(codec.encode(scope, { entryDate: earning.entryDate, entryId: earning.entryId })).toBe(expected);
    expect(codec.decode(expected, scope)).toEqual({ entryDate: earning.entryDate, entryId: earning.entryId });
    expect(codec.encode(codec.scope(admin.profileId, 'admin', sessionId.toUpperCase(), input), { entryDate: earning.entryDate, entryId: earning.entryId })).toBe(expected);
  });
  it('calls the exact SQL signature once with the authenticated role and session', async () => {
    const rpc = vi.fn(async () => ({ data: page(), error: null }));
    const response = await service(rpc).listWorkDetails(admin, input);
    expect(response).toEqual({ weekStart: input.weekStart, maidProfileId: maid.profileId, kind: 'earnings', summary, entries: [earning], nextCursor: null });
    expect(rpc).toHaveBeenCalledWith('list_payroll_work_details_page', {
      p_actor_profile_id: admin.profileId, p_session_id: sessionId, p_expected_actor_role: 'admin', p_week_start: input.weekStart,
      p_maid_profile_id: maid.profileId, p_kind: 'earnings', p_after_entry_date: null, p_after_entry_id: null, p_limit: 25
    });
  });
  it('continues only the same authenticated scope without exposing raw session ID', async () => {
    const rpc = vi.fn(async (_name: string, args: { p_after_entry_id: string | null }) => ({ data: args.p_after_entry_id ? page([], { ...input, limit: 1 }) : page([earning], { ...input, limit: 1 }, true), error: null }));
    const payroll = service(rpc);
    const first = await payroll.listWorkDetails(admin, { ...input, limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor ?? '';
    expect(Buffer.from(cursor.split('.')[0] ?? '', 'base64url').toString()).not.toContain(sessionId);
    expect(await payroll.listWorkDetails(admin, { ...input, limit: 1, cursor })).toMatchObject({ entries: [], nextCursor: null });
    expect(rpc.mock.calls[1]?.[1].p_after_entry_id).toBe(earning.earningId);
    for (const [actor, scoped] of [
      [{ ...admin, accessToken: token(id(98)) }, input], [{ ...admin, profileId: id(99) }, input], [maid, input],
      [admin, { ...input, weekStart: '2026-09-21' }], [admin, { ...input, maidProfileId: id(99) }], [admin, { ...input, kind: 'workflow' as const }]
    ] as const) {
      await expect(payroll.listWorkDetails(actor, { ...scoped, cursor })).rejects.toMatchObject({ statusCode: 400, code: 'PAYROLL_CURSOR_INVALID' });
    }
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('rejects old-family, tampered and signed malformed cursor positions', async () => {
    const rpc = vi.fn();
    const old = new PayrollCursorCodec(secret).encode(payrollCursorScope(admin, input.weekStart, maid.profileId, 'items'), { earnedOn: earning.earnedOn, earningId: earning.earningId });
    const codec = new PayrollWorkCursorCodec(secret);
    const scope = codec.scope(admin.profileId, 'admin', sessionId, input);
    const malformed = Buffer.from(JSON.stringify({ family: 'payroll-work-details', v: 1, scope, after: { entryId: 'bad', entryDate: '2026-09-29' } })).toString('base64url');
    const signature = createHmac('sha256', secret).update(`payroll-work-details:v1:${malformed}`).digest('base64url');
    for (const cursor of [old, 'not-cursor', `${malformed}.${signature}`, codec.encode(scope, { entryDate: earning.earnedOn, entryId: earning.earningId }) + 'x']) {
      await expect(service(rpc).listWorkDetails(admin, { ...input, cursor })).rejects.toMatchObject({ code: 'PAYROLL_CURSOR_INVALID' });
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['SESSION_REVOKED', 'PAYROLL_ACCESS_REQUIRED', 'PASSWORD_CHANGE_REQUIRED', 'PAYROLL_WEEK_MUST_START_MONDAY', 'PAYROLL_MAID_NOT_FOUND', 'PAYROLL_WEEK_NOT_CLOSED'])('maps exact safe %s', async (message) => {
    const rpc = vi.fn(async () => ({ data: null, error: { message } }));
    await expect(service(rpc).listWorkDetails(admin, input)).rejects.toMatchObject({ code: message });
  });
  it.each(['private SESSION_REVOKED', 'PAYROLL_ACCESS_REQUIRED: private', ' PASSWORD_CHANGE_REQUIRED '])('redacts embedded private errors %s', async (message) => {
    await expect(service(vi.fn(async () => ({ data: null, error: { message } }))).listWorkDetails(admin, input)).rejects.toMatchObject({ code: 'PAYROLL_COMMAND_FAILED', statusCode: 500 });
  });
  it('rejects developer/other maid/temporary password/missing session before any SQL', async () => {
    const rpc = vi.fn();
    for (const actor of [{ ...admin, role: 'developer' as const }, { ...maid, profileId: id(99) }, { ...admin, mustChangePassword: true }, { ...admin, accessToken: token(null) }]) {
      await expect(service(rpc).listWorkDetails(actor, input)).rejects.toBeDefined();
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects oversized UTF-8 raw RPC data with the bounded response error', async () => {
    await expect(service(vi.fn(async () => ({ data: { ...page(), private: '가'.repeat(128 * 1024) }, error: null }))).listWorkDetails(admin, input))
      .rejects.toMatchObject({ code: 'PAYROLL_RESPONSE_TOO_LARGE', statusCode: 500 });
  });
});

describe('#324 exact GET transport', () => {
  const headers = { authorization: 'Bearer synthetic-token' };
  it.each(['admin', 'maid'] as const)('allows authenticated %s and normalizes query', async (role) => {
    const fixture = await app(role === 'admin' ? admin : maid);
    try {
      const response = await fixture.app.inject({ method: 'GET', url: `/v1/payroll/work-details?${query()}`, headers });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(fixture.read).toHaveBeenCalledWith(role === 'admin' ? admin : maid, input);
    } finally { await fixture.app.close(); }
  });
  it.each(['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const)('rejects %s before authentication', async (method) => {
    const fixture = await app();
    try {
      const response = await fixture.app.inject({ method, url: `/v1/payroll/work-details?${query()}`, headers });
      expect(response.statusCode).toBe(404); expect(response.headers['cache-control']).toBe('no-store'); expect(fixture.authenticate).not.toHaveBeenCalled();
    } finally { await fixture.app.close(); }
  });
  it.each(['/v1/payroll/work-details/', '/v1//payroll/work-details', '/v1/payroll/work-details/extra', '/v1/payroll/%77ork-details', '/v1/payroll/work%2Ddetails'])('rejects alias %s before authentication', async (path) => {
    const fixture = await app();
    try {
      const response = await fixture.app.inject({ method: 'GET', url: path + '?' + query(), headers });
      expect(response.statusCode).toBe(404); expect(response.headers['cache-control']).toBe('no-store'); expect(fixture.authenticate).not.toHaveBeenCalled();
    } finally { await fixture.app.close(); }
  });
  it('rejects duplicate query before service and preserves no-store auth failures', async () => {
    const fixture = await app();
    try {
      const response = await fixture.app.inject({ method: 'GET', url: `/v1/payroll/work-details?${query()}&kind=earnings`, headers });
      expect(response.statusCode).toBe(400); expect(response.headers['cache-control']).toBe('no-store'); expect(fixture.read).not.toHaveBeenCalled();
      const unauthenticated = await fixture.app.inject({ method: 'GET', url: `/v1/payroll/work-details?${query()}` });
      expect(unauthenticated.statusCode).toBe(401); expect(unauthenticated.headers['cache-control']).toBe('no-store');
    } finally { await fixture.app.close(); }
  });
});
