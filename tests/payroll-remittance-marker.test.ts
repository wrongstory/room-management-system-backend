import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildApp, type AppServices } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';
import type { Actor } from '../src/domain/actor.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { requestHash } from '../src/lib/command.js';
import { SupabasePayrollService } from '../src/modules/payroll/payroll.service.js';
import { readRemittanceBatch, remittanceBatchQuery } from '../src/modules/payroll/payroll-remittance-batch.js';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';
import { normalizeRemittanceCommand, normalizeRemittanceHistoryInput, PayrollRemittanceCursor,
  remittanceQuery, remittanceProjection, remittanceHistoryProjection, remittanceRequestFingerprint,
  remittanceRequestHash, remittanceErrorStatus, remittanceDatabaseError
} from '../src/modules/payroll/payroll-remittance-marker.js';
const secret = 'synthetic-payroll-cursor-secret-32bytes';
const session = 'f1000000-0000-4000-8000-000000000001';
const id = (n: number) => `c1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const token = (value: unknown) => `e30.${Buffer.from(JSON.stringify({session_id:value})).toString('base64url')}.synthetic`;
const admin: Actor = { authUserId: id(1), profileId: id(2), displayName: '합성 관리자', role: 'admin', mustChangePassword: false, accessToken: token(session) };
const maid: Actor = { ...admin, role: 'maid', profileId: id(3) };
const input = { maidProfileId: maid.profileId, weekStart: '2026-09-21' };
const basis = { accrualAmount: 32000, totalAmount: 32000, adjustmentAmount: -2000, carryInAmount: -1000,
  carryOutAmount: 0, payableAmount: 29000, lateEarningAmount: 0, lockedAmount: null };
const marker = { ...input, marked: false, version: 0, lastChangedBy: null, lastChangedAt: null, confirmedBy: null, confirmedAt: null,
  needsReconfirmation: false, basis, confirmedBasis: null, basisFingerprint: 'a'.repeat(64), canSet: true, canClear: false, canReconfirm: false, setBlockedReason: null };
const on = { ...marker, marked: true, version: 1, lastChangedBy: admin.profileId, lastChangedAt: '2026-09-28T01:00:00+09:00',
  confirmedBy: admin.profileId, confirmedAt: '2026-09-28T01:00:00+09:00', confirmedBasis: basis, canClear: true };
const command = { ...input, marked: true, expectedVersion: 0, expectedBasisFingerprint: marker.basisFingerprint };
const query = new URLSearchParams(input).toString();
const revision = { revisionId: id(4), version: 1, eventType: 'marked', marked: true, actorProfileId: admin.profileId,
  occurredAt: '2026-09-28T01:00:00+09:00', basis };
const history = { entries: [revision], hasMore: false, lastVersion: 1 };
const env = {
  APP_ENV: 'local', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3000, LOG_LEVEL: 'silent',
  CORS_ORIGINS: 'http://127.0.0.1:4173', corsOrigins: ['http://127.0.0.1:4173'],
  SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'publishable-test', SUPABASE_SECRET_KEY: 'secret-test',
  ACCOUNT_PHONE_PEPPER: 'synthetic-phone-pepper-minimum-32bytes',
  RESERVATION_PII_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'), RESERVATION_PII_KEY_VERSION: 'test-v1',
  RESERVATION_PII_KEYRING_JSON: '{}', RESERVATION_GUEST_NAME_PEPPER: 'synthetic-guest-pepper-minimum-32bytes',
  ROOM_PIN_KEY_BASE64: Buffer.alloc(32, 8).toString('base64'), ROOM_PIN_KEY_VERSION: 'pin-v1', ROOM_PIN_KEYRING_JSON: '{}',
  PAYROLL_CURSOR_HMAC_SECRET: secret, NOTIFICATION_CURSOR_HMAC_SECRET: 'synthetic-notification-cursor-32bytes',
  INSPECTION_CURSOR_HMAC_SECRET: 'synthetic-inspection-cursor-secret-32bytes',
  WEB_PUSH_SUBSCRIPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'), WEB_PUSH_SUBSCRIPTION_KEY_VERSION: 'v1',
  WEB_PUSH_SUBSCRIPTION_KEYRING_JSON: '{}', WEB_PUSH_BINDING_DIGEST_SECRET: 'synthetic-web-push-binding-secret-32bytes',
  VAPID_CURRENT_KEY_VERSION: 'vapid-v1',
  VAPID_PUBLIC_KEY: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  VAPID_PUBLIC_KEYRING_JSON: '{}', RESERVATION_SCHEDULER_INTERVAL_SECONDS: 60
} as unknown as AppEnv;
function setup(data: unknown = marker, error: string | null = null, actor = admin) {
  const rpc = vi.fn(async () => ({ data, error: error ? { message: error } : null }));
  const payroll = new SupabasePayrollService({ admin: { rpc } } as unknown as SupabaseClients, secret);
  return { rpc, payroll, actor };
}
async function app(data: unknown = marker, error: string | null = null, actor = admin) {
  const fixture = setup(data, error, actor);
  const authenticate = vi.fn(async () => actor);
  const services = { auth: { authenticate }, accounts: {}, availability: {}, rooms: {}, reservations: {}, payroll: fixture.payroll } as unknown as AppServices;
  return { ...fixture, authenticate, app: await buildApp({ env, services, logger: false }) };
}
const headers = { authorization: 'Bearer synthetic', 'idempotency-key': 'marker-331-synthetic' };

const batchQuery = (ids = [id(3)]) => new URLSearchParams({ weekStart: input.weekStart, maidProfileIds: ids.join(',') });
describe('#414 bounded remittance batch', () => {
  it.each([
    '', 'weekStart=2026-09-21', 'maidProfileIds=', 'maidProfileIds=bad&weekStart=2026-09-21',
    batchQuery([id(3), id(3).toUpperCase()]).toString(),
    batchQuery(Array.from({length:11}, (_, i) => id(i + 3))).toString(),
    batchQuery().toString() + '&extra=1', batchQuery().toString() + '&weekStart=2026-09-21',
    batchQuery().toString() + '&maidProfileIds=' + id(4),
    'maidProfileIds=' + id(3) + ',&weekStart=2026-09-21',
    'maidProfileIds=' + id(3) + '&weekStart=2026-02-29',
  ])('rejects invalid whole query before reads: %s', async (query) => {
    const read = vi.fn();
    await expect(readRemittanceBatch(admin, new URLSearchParams(query), read)).rejects.toThrow('VALIDATION_ERROR');
    expect(read).not.toHaveBeenCalled();
  });
  it('accepts ten IDs and normalizes case', () => {
    const ids = Array.from({length:10}, (_, i) => id(i+3));
    expect(remittanceBatchQuery(batchQuery(ids.map((id) => id.toUpperCase()))))
      .toEqual(ids.map((maidProfileId) => ({ ...input, maidProfileId })));
  });
  it('enforces password, role and all maid scopes before reads', async () => {
    for (const [actor, ids, code] of [
      [{...admin, mustChangePassword:true}, [id(3)], 'PASSWORD_CHANGE_REQUIRED'],
      [{...admin, role:'developer'}, [id(3)], 'PAYROLL_ACCESS_REQUIRED'],
      [maid, [id(3), id(4)], 'PAYROLL_ACCESS_REQUIRED'],
    ] as const) {
      const read = vi.fn();
      await expect(readRemittanceBatch(actor, batchQuery([...ids]), read)).rejects.toThrow(code);
      expect(read).not.toHaveBeenCalled();
    }
  });
  it('keeps input order with only three reads in flight', async () => {
    const ids = Array.from({length:10}, (_, i) => id(i+3));
    const releases: Array<() => void> = [];
    let active = 0, peak = 0;
    const read = vi.fn(async (value) => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      active--;
      return {...marker, ...value};
    });
    const pending = readRemittanceBatch(admin, batchQuery(ids), read);
    expect(read).toHaveBeenCalledTimes(3);
    for (let i=0; i<10; i++) {
      releases.pop()?.();
      await new Promise((resolve) => setImmediate(resolve));
      expect(active).toBeLessThanOrEqual(3);
    }
    expect((await pending).markers.map((row) => row.maidProfileId)).toEqual(ids);
    expect(peak).toBe(3); expect(active).toBe(0); expect(read).toHaveBeenCalledTimes(10);
  });
  it('drains in-flight reads and stops taking new items after first failure', async () => {
    const releases: Array<(value: typeof marker) => void> = [];
    const failure = new Error('SESSION_REVOKED');
    const read = vi.fn((value) => value.maidProfileId === id(3)
      ? Promise.reject(failure)
      : new Promise<typeof marker>((resolve) => { releases.push(resolve); }));
    let settled = false;
    const pending = readRemittanceBatch(admin, batchQuery([id(3),id(4),id(5),id(6)]), read);
    const checked = expect(pending).rejects.toBe(failure);
    void pending.then(() => { settled=true; }, () => { settled=true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false); expect(read).toHaveBeenCalledTimes(3);
    for (const release of releases) release(marker);
    await checked; expect(settled).toBe(true); expect(read).toHaveBeenCalledTimes(3);
  });
  it('Fastify batches existing RPCs with each actor/session and preserves reconfirmation', async () => {
    const fixture = await app();
    const drift = {...on, basis: {...basis, accrualAmount:33000}, needsReconfirmation:true, canReconfirm:true};
    fixture.rpc.mockImplementation(async (...args: unknown[]) => ({
      data:{...drift, maidProfileId:(args[1] as Record<string,string>).p_maid_profile_id}, error:null
    }));
    try {
      const response = await fixture.app.inject({method:'GET',url:'/v1/payroll/remittance-markers?' + batchQuery([id(3),id(4)]),headers});
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({weekStart:input.weekStart, markers:[id(3),id(4)].map((maidProfileId) => ({...drift,maidProfileId}))});
      expect(fixture.authenticate).toHaveBeenCalledTimes(1); expect(fixture.rpc).toHaveBeenCalledTimes(2);
      for (const maidProfileId of [id(3),id(4)]) expect(fixture.rpc).toHaveBeenCalledWith('get_payroll_remittance_marker', {
        p_actor_profile_id:admin.profileId,p_session_id:session,p_expected_actor_role:'admin',p_maid_profile_id:maidProfileId,p_week_start:input.weekStart
      });
    } finally { await fixture.app.close(); }
  });
  it('Fastify returns only error for RPC failure, bad projection and invalid query', async () => {
    for (const [data, error, query, status, code] of [
      [marker, 'SESSION_REVOKED', batchQuery(), 401, 'SESSION_REVOKED'],
      [{...marker,maidProfileId:id(4)}, null, batchQuery(), 500, 'PAYROLL_COMMAND_FAILED'],
      [{...marker,private:'x'.repeat(140000)}, null, batchQuery(), 500, 'PAYROLL_RESPONSE_TOO_LARGE'],
      [marker, null, batchQuery([id(3),id(3)]), 400, 'VALIDATION_ERROR'],
    ] as const) {
      const fixture = await app(data, error);
      try {
        const response = await fixture.app.inject({method:'GET',url:'/v1/payroll/remittance-markers?' + query,headers});
        expect(response.statusCode).toBe(status); expect(response.json().error.code).toBe(code);
        expect(response.json()).not.toHaveProperty('markers'); expect(response.headers['cache-control']).toBe('no-store');
        if (status === 400) expect(fixture.rpc).not.toHaveBeenCalled();
      } finally { await fixture.app.close(); }
    }
  });
  it('Fastify permits self maid and denies developer/other maid/password gate', async () => {
    for (const actor of [maid, {...maid,profileId:id(4)}, {...admin,role:'developer' as const}, {...admin,mustChangePassword:true}]) {
      const fixture = await app({...marker,canSet:false,setBlockedReason:'ADMIN_REQUIRED'}, null, actor);
      try {
        const response = await fixture.app.inject({method:'GET',url:'/v1/payroll/remittance-markers?' + batchQuery(),headers});
        expect(response.statusCode).toBe(actor === maid ? 200 : 403);
        if (actor !== maid) expect(fixture.rpc).not.toHaveBeenCalled();
      } finally { await fixture.app.close(); }
    }
  });
  it('Fastify rejects aliases and wrong methods before authentication', async () => {
    const fixture = await app();
    try {
      for (const [method, path] of [['HEAD','remittance-markers'],['POST','remittance-markers'],['PUT','remittance-markers'],['DELETE','remittance-markers'],
        ['GET','remittance-markers/'],['GET','remittance%2Dmarkers'],['GET','remittance-markers/history'],['GET','/remittance-markers']] as const) {
        const response=await fixture.app.inject({method,url:'/v1/payroll/'+path});
        expect(response.statusCode).toBe(404);
      }
      expect(fixture.authenticate).not.toHaveBeenCalled(); expect(fixture.rpc).not.toHaveBeenCalled();
    } finally { await fixture.app.close(); }
  });
  it('documents CSV bounds and exact batch response in Swagger', () => {
    const operation = openApiDocument.paths['/v1/payroll/remittance-markers'].get;
    expect(operation.operationId).toBe('listPayrollRemittanceMarkers');
    expect(operation.parameters[0]).toMatchObject({name:'maidProfileIds',style:'form',explode:false,schema:{type:'string',minLength:36,maxLength:369}});
    const pattern = new RegExp((operation.parameters[0] as {schema:{pattern:string}}).schema.pattern);
    expect(pattern.test(Array.from({length:10}, (_, i) => id(i+3)).join(','))).toBe(true);
    expect(pattern.test(Array.from({length:11}, (_, i) => id(i+3)).join(','))).toBe(false);
    expect(pattern.test(id(3) + ',')).toBe(false);
    expect(openApiDocument.components.schemas.PayrollRemittanceBatch).toMatchObject({additionalProperties:false,required:['weekStart','markers']});
  });
});

describe('#331 remittance strict display-only contract', () => {
  it('preserves independent marker and financial tuple without status-based inference', () => {
    expect(remittanceProjection(marker, input, 'admin')).toEqual(marker);
    const drift = { ...on, basis: { ...basis, accrualAmount: 33000, lateEarningAmount: 1000 }, needsReconfirmation: true, canReconfirm: true };
    expect(remittanceProjection(drift, input, 'admin')).toEqual(drift);
    expect(remittanceProjection({ ...drift, canSet: false, canClear: false, canReconfirm: false, setBlockedReason: 'ADMIN_REQUIRED' }, input, 'maid').marked).toBe(true);
  });
  it.each(Object.keys(basis).filter((key) => key !== 'lockedAmount'))('every financial basis field %s independently triggers needsReconfirmation', (field) => {
    const changed = { ...basis, [field]: field === 'lockedAmount' ? 29000 : (basis[field as keyof typeof basis] ?? 0) + (field.startsWith('carry') ? -1 : 1) };
    expect(remittanceProjection({ ...on, basis: changed, needsReconfirmation: true, canReconfirm: true }, input, 'admin').needsReconfirmation).toBe(true);
    expect(() => remittanceProjection({ ...on, basis: changed }, input, 'admin')).toThrow('PAYROLL_COMMAND_FAILED');
  });
  it('actual payment locking alone leaves the financial confirmation valid', () => {
    const locked = { ...on, basis: { ...basis, lockedAmount: 29000 } };
    expect(remittanceProjection(locked, input, 'admin').needsReconfirmation).toBe(false);
    expect(() => remittanceProjection({ ...locked, needsReconfirmation: true, canReconfirm: true }, input, 'admin')).toThrow('PAYROLL_COMMAND_FAILED');
  });
  it('does not infer a false mark from cleared actual payment or current amount zero', () => {
    const zero = { ...basis, accrualAmount: 0, totalAmount: 0, adjustmentAmount: 0, carryInAmount: 0, payableAmount: 0 };
    expect(remittanceProjection({ ...on, basis: zero, needsReconfirmation: true, canSet: false, canReconfirm: true, setBlockedReason: 'NO_PAYROLL_AMOUNT' }, input, 'admin').marked).toBe(true);
  });
  it.each(['0001-01-01', '0099-12-31', '2000-02-29', '9999-12-31'])('accepts strict Gregorian %s without year alias', (weekStart) => {
    expect(remittanceQuery(new URLSearchParams({ ...input, weekStart }))).toEqual({ ...input, weekStart });
  });
  it.each(['0000-01-01', '2026-02-29', '2026-04-31', '2026-9-21', '2026-09-21T00:00:00Z'])('rejects invalid date %s', (weekStart) => {
    expect(() => remittanceQuery(new URLSearchParams({ ...input, weekStart }))).toThrow('VALIDATION_ERROR');
  });
  it.each(['&limit=1', '&cursor=x', '&extra=1', '&weekStart=2026-09-21', `&maidProfileId=${maid.profileId}`])('rejects get query %s', (suffix) => {
    expect(() => remittanceQuery(new URLSearchParams(query+suffix))).toThrow('VALIDATION_ERROR');
  });
  it.each(['&limit=0', '&limit=101', '&limit=01', '&limit=1.5', '&limit=NaN', '&cursor=', `&cursor=${'x'.repeat(1025)}`, '&afterVersion=1', '&limit=20&limit=20'])('rejects history query %s', (suffix) => {
    expect(() => remittanceQuery(new URLSearchParams(query+suffix), true)).toThrow('VALIDATION_ERROR');
  });
  it('normalizes UUID and enforces history boundaries', () => {
    expect(remittanceQuery(new URLSearchParams({ ...input, maidProfileId: input.maidProfileId.toUpperCase() }))).toEqual(input);
    expect(remittanceQuery(new URLSearchParams(query), true)).toEqual({ ...input, limit: 20 });
    expect(remittanceQuery(new URLSearchParams(`${query}&limit=100`), true)).toEqual({ ...input, limit: 100 });
    expect(() => normalizeRemittanceHistoryInput({ ...input, limit: 101 })).toThrow('VALIDATION_ERROR');
  });
  it.each([{ marked: 1 }, { marked: 'true' }, { expectedVersion: -1 }, { expectedVersion: '0' }, { expectedVersion: Number.MAX_SAFE_INTEGER+1 },
    { expectedBasisFingerprint: 'A'.repeat(64) }, { expectedBasisFingerprint: 'a'.repeat(63) }, { extra: 'private' }])('rejects command %#', (change) => {
    expect(() => normalizeRemittanceCommand({ ...command, ...change }, headers['idempotency-key'], true)).toThrow('VALIDATION_ERROR');
  });
  it.each(['short', 'x'.repeat(129), 'key with spaces', '', undefined, ' key-synthetic '])('rejects idempotency %s', (key) => {
    expect(() => normalizeRemittanceCommand(command, key, true)).toThrow('VALIDATION_ERROR');
  });
  it('does not accept marked on reconfirm and hashes same canonical command as legacy runtime helper', async () => {
    expect(() => normalizeRemittanceCommand(command, headers['idempotency-key'], false)).toThrow('VALIDATION_ERROR');
    const parsed = normalizeRemittanceCommand(command, headers['idempotency-key'], true);
    const value = remittanceRequestFingerprint(admin.profileId.toUpperCase(), parsed, true);
    expect(await remittanceRequestHash(value)).toBe(requestHash(value));
    expect(value).not.toHaveProperty('idempotencyKey');
    expect(value).not.toHaveProperty('session_id');
  });
  it.each([{ private: 'hidden' }, { marked: 'true' }, { version: -1 }, { version: '0' }, { version: 1 }, { maidProfileId: id(99) },
    { weekStart: '2026-09-28' }, { basisFingerprint: 'A'.repeat(64) }, { needsReconfirmation: true }, { canClear: true }, { canReconfirm: true },
    { lastChangedAt: '2026-02-30T01:00:00Z' }, { confirmedAt: '2026-09-28T01:00:00Z' }, { confirmedBasis: basis }, { setBlockedReason: 'UNKNOWN' }])
    ('rejects marker output corruption %#', (change) => { expect(() => remittanceProjection({ ...marker, ...change }, input, 'admin')).toThrow('PAYROLL_COMMAND_FAILED'); });
  it.each([{ extra: 'secret' }, { lockedAmount: 0 }, { lockedAmount: -1 }, { accrualAmount: -1 }, { totalAmount: 1.5 }, { carryInAmount: 1 }, { carryOutAmount: 1 },
    { lateEarningAmount: '0' }, { payableAmount: Number.MAX_SAFE_INTEGER+1 }])('rejects basis corruption %#', (change) => {
    expect(() => remittanceProjection({ ...marker, basis: { ...basis, ...change } }, input, 'admin')).toThrow('PAYROLL_COMMAND_FAILED');
  });
  it('whitelists and validates history sort/membership/event-type and continuation metadata', () => {
    expect(remittanceHistoryProjection(history, { ...input, limit: 20 }, null)).toEqual(history);
    for (const candidate of [{ ...history, private: true }, { ...history, hasMore: true }, { ...history, lastVersion: 2 },
      { ...history, entries: [revision,revision] }, { ...history, entries: [{ ...revision, eventType: 'paid' }] },
      { ...history, entries: [{ ...revision, eventType: 'cleared', marked: true }] }]) {
      expect(() => remittanceHistoryProjection(candidate, { ...input, limit: 20 }, null)).toThrow('PAYROLL_COMMAND_FAILED');
    }
    expect(() => remittanceHistoryProjection(history, { ...input, limit: 20 }, 1)).toThrow('PAYROLL_COMMAND_FAILED');
  });
});

describe('#331 service role/session and command parity', () => {
  it('uses only new get/set/reconfirm/history RPCs with exact context binding', async () => {
    const fixture = setup();
    expect(await fixture.payroll.getRemittanceMarker(admin, input)).toEqual(marker);
    expect(fixture.rpc.mock.calls[0]).toEqual(['get_payroll_remittance_marker', {
      p_actor_profile_id: admin.profileId, p_session_id: session, p_expected_actor_role: 'admin',
      p_maid_profile_id: input.maidProfileId, p_week_start: input.weekStart,
    }]);
    await fixture.payroll.setRemittanceMarker(admin, { ...command, idempotencyKey: headers['idempotency-key'] });
    const args = fixture.rpc.mock.calls[1] as unknown as [string,Record<string,unknown>];
    expect(args[0]).toBe('set_payroll_remittance_marker');
    expect(args[1]).toMatchObject({ p_marked: true, p_expected_version: 0, p_expected_basis_fingerprint: marker.basisFingerprint, p_idempotency_key: headers['idempotency-key'] });
    const { marked: _marked, ...reconfirm } = command;
    await fixture.payroll.reconfirmRemittanceMarker(admin, { ...reconfirm, idempotencyKey: headers['idempotency-key'] });
    const reconfirmArgs = fixture.rpc.mock.calls[2] as unknown as [string,Record<string,unknown>];
    expect(reconfirmArgs[0]).toBe('reconfirm_payroll_remittance_marker');
    expect(reconfirmArgs[1]).not.toHaveProperty('p_marked');
    expect(reconfirmArgs[1].p_request_hash).not.toBe(args[1].p_request_hash);
  });
  it.each(['SESSION_REVOKED', 'PASSWORD_CHANGE_REQUIRED', 'ADMIN_REQUIRED', 'PAYROLL_ACCESS_REQUIRED', 'PAYROLL_MAID_NOT_FOUND',
    'PAYROLL_WEEK_MUST_START_MONDAY','PAYROLL_WEEK_NOT_CLOSED','PAYROLL_REMITTANCE_MARKER_STALE_VERSION','PAYROLL_REMITTANCE_BASIS_CHANGED',
    'PAYROLL_REMITTANCE_RECONFIRM_NOT_REQUIRED','PAYROLL_REMITTANCE_MARKER_NOT_SET','NO_PAYROLL_AMOUNT','IDEMPOTENCY_KEY_REUSED'])
    ('preserves exact database error %s', async (code) => {
      await expect(setup(marker,code).payroll.getRemittanceMarker(admin,input)).rejects.toMatchObject({ code, statusCode: remittanceErrorStatus(code) });
    });
  it('does not substring match or leak raw DB errors', async () => {
    const failure = remittanceDatabaseError({message:'private_detail SESSION_REVOKED'});
    expect(failure.code).toBe('PAYROLL_COMMAND_FAILED');
    await expect(setup(marker,'secret-token-value').payroll.getRemittanceMarker(admin,input)).rejects.toMatchObject({ code:'PAYROLL_COMMAND_FAILED',statusCode:500 });
  });
  it('blocks other maid, developer, temporary password, and invalid session before RPC', async () => {
    const fixture = setup();
    for (const actor of [{...maid,profileId:id(99)},{...admin,role:'developer' as const},{...admin,mustChangePassword:true},{...admin,accessToken:token(null)}]) {
      await expect(fixture.payroll.getRemittanceMarker(actor,input)).rejects.toBeDefined();
    }
    await expect(fixture.payroll.setRemittanceMarker(maid,{...command,idempotencyKey:headers['idempotency-key']})).rejects.toMatchObject({code:'ADMIN_REQUIRED'});
    expect(fixture.rpc).not.toHaveBeenCalled();
  });
  it('enforces immutable maid read capability projection', async () => {
    const response = {...marker,canSet:false,setBlockedReason:'ADMIN_REQUIRED'};
    expect(await setup(response,null,maid).payroll.getRemittanceMarker(maid,input)).toEqual(response);
    await expect(setup(marker).payroll.getRemittanceMarker(maid,input)).rejects.toMatchObject({code:'PAYROLL_COMMAND_FAILED'});
  });
  it('rejects corrupted cleared RPC replies retaining a current confirmation in every service action', async () => {
    const cleared = { ...on, marked: false, version: 2, canClear: false };
    const fixture = setup(cleared);
    const { marked: _marked, ...reconfirm } = command;
    await expect(fixture.payroll.getRemittanceMarker(admin, input)).rejects.toMatchObject({ code: 'PAYROLL_COMMAND_FAILED', statusCode: 500 });
    await expect(fixture.payroll.setRemittanceMarker(admin, { ...command, idempotencyKey: headers['idempotency-key'] })).rejects.toMatchObject({ code: 'PAYROLL_COMMAND_FAILED', statusCode: 500 });
    await expect(fixture.payroll.reconfirmRemittanceMarker(admin, { ...reconfirm, idempotencyKey: headers['idempotency-key'] })).rejects.toMatchObject({ code: 'PAYROLL_COMMAND_FAILED', statusCode: 500 });
    expect(fixture.rpc).toHaveBeenCalledTimes(3);
    const valid = { ...cleared, confirmedBy: null, confirmedAt: null, confirmedBasis: null };
    expect(await setup(valid).payroll.getRemittanceMarker(admin, input)).toEqual(valid);
  });
  it('paginates history with exact RPC afterVersion and refuses cursor reused across actor/session/week/maid', async () => {
    const fixture=setup({...history,hasMore:true});
    const first=await fixture.payroll.listRemittanceMarkerHistory(admin,{...input,limit:1});
    expect(first.nextCursor).toBeTypeOf('string');
    const nextCursor = first.nextCursor;
    if (typeof nextCursor !== 'string') throw new Error('Expected remittance history continuation');
    expect(JSON.stringify(first)).not.toContain('lastVersion');
    const nextFixture=setup({entries:[{...revision,revisionId:id(5),version:2}],hasMore:false,lastVersion:2});
    await nextFixture.payroll.listRemittanceMarkerHistory(admin,{...input,limit:1,cursor:nextCursor});
    expect((nextFixture.rpc.mock.calls[0] as unknown as [string,Record<string,unknown>])[1].p_after_version).toBe(1);
    for(const [actor,filter] of [[{...admin,profileId:id(99)},input],[{...admin,accessToken:token(id(99))},input],[admin,{...input,weekStart:'2026-09-14'}],[admin,{...input,maidProfileId:id(99)}]] as const) {
      await expect(fixture.payroll.listRemittanceMarkerHistory(actor,{...filter,limit:1,cursor:nextCursor})).rejects.toMatchObject({code:'PAYROLL_CURSOR_INVALID'});
    }
    expect(fixture.rpc).toHaveBeenCalledTimes(1);
  });
});
describe('#331 session-bound HMAC cursor', () => {
  it('matches independent Node HMAC golden vector shared with Edge', async () => {
    const expected = 'eyJmYW1pbHkiOiJwYXlyb2xsLXJlbWl0dGFuY2UtaGlzdG9yeSIsInYiOjEsInNjb3BlIjp7ImFjdG9yUHJvZmlsZUlkIjoiYzEwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwiYWN0b3JSb2xlIjoiYWRtaW4iLCJzZXNzaW9uQmluZGluZyI6InNoRHU5T0doZlZiMDVNTGwxYzBuemxNa2c3YUZNUng4dHFNU1lnUEpycDQiLCJtYWlkUHJvZmlsZUlkIjoiYzEwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAzIiwid2Vla1N0YXJ0IjoiMjAyNi0wOS0yMSIsInNvcnQiOiJ2ZXJzaW9uOmFzYyJ9LCJhZnRlclZlcnNpb24iOjF9.7sbSRlxL6NbCCpADbyMTcTi601-uwZQfv3nsBpOLYtM';
    const codec = new PayrollRemittanceCursor(secret), scope = await codec.scope(admin.profileId, 'admin', session, input);
    expect(await codec.encode(scope, 1)).toBe(expected);
    expect(await codec.decode(expected, scope)).toBe(1);
  });
  it('uses a new domain, canonical Base64URL, fatal UTF8 and safe positive afterVersion', async () => {
    const codec = new PayrollRemittanceCursor(secret), scope=await codec.scope(admin.profileId,'admin',session,input);
    const cursor=await codec.encode(scope,1);
    expect(await codec.decode(cursor,scope)).toBe(1);
    const [encodedPayload] = cursor.split('.');
    if (!encodedPayload) throw new Error('Expected remittance cursor payload');
    expect(Buffer.from(encodedPayload, 'base64url').toString()).not.toContain(session);
    for(const value of [`${cursor}=`,cursor.replace(/.$/,'!'),'old.payload','x'.repeat(1025)]) await expect(codec.decode(value,scope)).rejects.toThrow('PAYROLL_CURSOR_INVALID');
    const payload=Buffer.from(JSON.stringify({family:'payroll-remittance-history',v:1,scope,afterVersion:'1'})).toString('base64url');
    const sig=createHmac('sha256',secret).update(`payroll-remittance-history:v1:${payload}`).digest('base64url');
    await expect(codec.decode(`${payload}.${sig}`,scope)).rejects.toThrow('PAYROLL_CURSOR_INVALID');
    const badUtf=Buffer.from([0xff]).toString('base64url'), utfSig=createHmac('sha256',secret).update(`payroll-remittance-history:v1:${badUtf}`).digest('base64url');
    await expect(codec.decode(`${badUtf}.${utfSig}`,scope)).rejects.toThrow('PAYROLL_CURSOR_INVALID');
    expect(()=>new PayrollRemittanceCursor('short')).toThrow('PAYROLL_CURSOR_NOT_CONFIGURED');
  });
});
describe('#331 exact Fastify routes', () => {
  it('serves canonical GET/PUT/reconfirm/history and no-store', async () => {
    const fixture=await app();
    try {
      const get=await fixture.app.inject({method:'GET',url:`/v1/payroll/remittance-marker?${query}`,headers});
      expect(get.statusCode).toBe(200);expect(get.json()).toEqual(marker);expect(get.headers['cache-control']).toBe('no-store');
      const set=await fixture.app.inject({method:'PUT',url:'/v1/payroll/remittance-marker',headers,payload:command});
      expect(set.statusCode).toBe(200);
      const {marked:_marked,...reconfirm}=command;
      expect((await fixture.app.inject({method:'POST',url:'/v1/payroll/remittance-marker/reconfirm',headers,payload:reconfirm})).statusCode).toBe(200);
    } finally {await fixture.app.close();}
    const fixture2=await app(history);
    try {expect((await fixture2.app.inject({method:'GET',url:`/v1/payroll/remittance-marker/history?${query}`,headers})).statusCode).toBe(200);}finally{await fixture2.app.close();}
  });
  it.each(['/v1/payroll/remittance-marker/','/v1//payroll/remittance-marker','/v1/payroll/%72emittance-marker',
    '/v1/payroll/remittance%2Dmarker','/v1/payroll/remittance-marker/extra','/v1/payroll/remittance-marker/history/',
    '/v1/payroll%2fremittance-marker'])('rejects alias %s before authentication',async path=>{
    const fixture=await app();try{const response=await fixture.app.inject({method:'GET',url:`${path}?${query}`,headers});
      expect(response.statusCode).toBe(404);expect(response.headers['cache-control']).toBe('no-store');expect(fixture.authenticate).not.toHaveBeenCalled();}finally{await fixture.app.close();}
  });
  it.each([['HEAD',''],['POST',''],['PATCH',''],['DELETE',''],['PUT','/history'],['GET','/reconfirm'],['HEAD','/history']])('rejects method %s%s',async (method,suffix)=>{
    const fixture=await app();try{const response=await fixture.app.inject({method:method as 'GET',url:`/v1/payroll/remittance-marker${suffix}`,headers});
      expect(response.statusCode).toBe(404);expect(response.headers['cache-control']).toBe('no-store');expect(fixture.authenticate).not.toHaveBeenCalled();}finally{await fixture.app.close();}
  });
  it('validates query/body/header without RPC and preserves auth-first 401/no-store',async()=>{
    const fixture=await app();try{
      for(const candidate of [{url:'/v1/payroll/remittance-marker?unknown=1',payload:command,headers},
        {url:'/v1/payroll/remittance-marker',payload:{...command,amount:32000},headers},
        {url:'/v1/payroll/remittance-marker',payload:command,headers:{authorization:headers.authorization}}]){
        const response=await fixture.app.inject({method:'PUT',...candidate});expect(response.statusCode).toBe(400);expect(response.headers['cache-control']).toBe('no-store');
      }
      expect(fixture.rpc).not.toHaveBeenCalled();
      const response=await fixture.app.inject({method:'GET',url:`/v1/payroll/remittance-marker?${query}`});expect(response.statusCode).toBe(401);expect(response.headers['cache-control']).toBe('no-store');
    }finally{await fixture.app.close();}
  });
  it('returns safe DB errors and caps raw response before projection',async()=>{
    for(const [data,error,status,code] of [[marker,'PAYROLL_REMITTANCE_BASIS_CHANGED',409,'PAYROLL_REMITTANCE_BASIS_CHANGED'],
      [{...marker,secret:'x'.repeat(140000)},null,500,'PAYROLL_RESPONSE_TOO_LARGE'],[{...marker,secret:'raw'},null,500,'PAYROLL_COMMAND_FAILED']] as const){
      const fixture=await app(data,error);try{const response=await fixture.app.inject({method:'GET',url:`/v1/payroll/remittance-marker?${query}`,headers});
        expect(response.statusCode).toBe(status);expect(response.json().error.code).toBe(code);expect(response.headers['cache-control']).toBe('no-store');expect(response.body).not.toContain('raw');}finally{await fixture.app.close();}
    }
  });
});
