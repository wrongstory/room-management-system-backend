import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AdmissionRpc, beginHttpAdmission, HttpAdmissionError, httpAdmissionRoute,
  withAdmissionRpc } from '../src/modules/developer-reset/http-admission.js';

const actor = { profileId: '00000000-0000-4000-8000-000000000001',
  authUserId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003' };
const id = '00000000-0000-4000-8000-000000000004';
const quarantine = '00000000-0000-4000-8000-000000000005';
const config = { target: 'synthetic-target', budgetMs: 10000 };
const route = httpAdmissionRoute('POST', `/v1/offline-quarantines/${quarantine}/resolve`);
const command = 'resolve_offline_event_quarantine';
const reasons = { record_only: 'OFFLINE_RECORD_ONLY', reject_effect: 'OFFLINE_REJECT_EFFECT',
  correction_link: 'OFFLINE_CORRECTION_APPROVED' };
const args = (resolution: keyof typeof reasons = 'record_only') => ({
  p_actor_profile_id: actor.profileId, p_session_id: actor.sessionId, p_quarantine_id: quarantine,
  p_resolution: resolution, p_expected_execution_version: resolution === 'correction_link' ? 2 : null,
  p_reason_code: reasons[resolution], p_idempotency_key: 'offline-resolution-key', p_request_hash: 'a'.repeat(64),
});
const admitted = { data: { admissionId: id, controlVersion: '1', completionMode: 'OFFLINE_RESOLUTION' }, error: null };
function fixture(mode = 'OPEN') {
  const calls: string[] = [];
  const rpc = vi.fn<AdmissionRpc>(async name => {
    calls.push(name);
    return name === 'get_operation_admission_control'
      ? { data: { mode, controlVersion: mode === 'INACTIVE' ? null : '1', targetRef: mode === 'INACTIVE' ? null : config.target }, error: null }
      : name === 'acquire_operation_offline_resolution_admission' ? admitted : { data: { completed: true }, error: null };
  });
  return { calls, rpc, input: { config, route, rpc, identity: async () => actor, nonce: () => 'b'.repeat(64) } };
}
afterEach(() => vi.useRealTimers());

describe('one offline quarantine resolution terminal adapter', () => {
  it.each(['record_only', 'reject_effect', 'correction_link'] as const)('binds the actual %s RPC before one lazy SDK dispatch', async resolution => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input); const input = args(resolution);
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      f.calls.push('effect'); expect(JSON.parse(String(init?.body))).toEqual(input);
      return new Response(JSON.stringify({ synthetic: true }), { headers: { 'content-type': 'application/json' } });
    });
    const client = withAdmissionRpc(createClient('https://synthetic.invalid', 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false }, global: { fetch },
    }), () => scope);
    const query = client.rpc(command, input);
    expect(fetch).not.toHaveBeenCalled();
    await Promise.all([query, query]); expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual(['get_operation_admission_control', 'acquire_operation_offline_resolution_admission',
      'effect', 'complete_operation_offline_resolution_admission']);
    expect(f.rpc.mock.calls[1]?.[1]).toEqual({ p_target: config.target, p_version: '1',
      p_actor: actor.profileId, p_auth: actor.authUserId, p_session: actor.sessionId,
      p_nonce: 'b'.repeat(64), p_deadline: expect.any(String), p_resolution: resolution,
      p_idempotency_key: input.p_idempotency_key, p_request_hash: input.p_request_hash });
    expect(f.rpc.mock.calls[2]?.[1]).toEqual({ p_admission_id: id, p_nonce: 'b'.repeat(64),
      p_actor: actor.profileId, p_auth: actor.authUserId, p_session: actor.sessionId,
      p_quarantine_id: quarantine, p_resolution: resolution });
  });
  it.each(Object.keys(args()))('rejects invalid or missing %s before acquisition', async field => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input); const invoke = vi.fn(async () => 1);
    await expect(scope?.execute(command, { ...args(), [field]: undefined }, invoke)).rejects.toThrow(HttpAdmissionError);
    expect(f.rpc).toHaveBeenCalledTimes(1); expect(invoke).not.toHaveBeenCalled();
  });
  it.each([
    { p_resolution: 'RECORD_ONLY' }, { p_resolution: 'expire' }, { p_resolution: '__proto__' },
    { p_expected_execution_version: 1 }, { p_reason_code: 'OFFLINE_REJECT_EFFECT' }, { extra: true },
    { ...args('correction_link'), p_expected_execution_version: 1.5 },
    { ...args('correction_link'), p_expected_execution_version: 0 },
  ])('rejects altered finite command shape %j', async change => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input); const invoke = vi.fn(async () => 1);
    await expect(scope?.execute(command, { ...args(), ...change }, invoke)).rejects.toThrow(HttpAdmissionError);
    expect(f.rpc).toHaveBeenCalledTimes(1); expect(invoke).not.toHaveBeenCalled();
  });
  it.each(Object.keys(args()))('detects %s mutation during acquire without dispatch or completion', async field => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input); const input = args();
    f.rpc.mockImplementationOnce(async () => { Object.assign(input, { [field]: 'changed-value' }); return admitted; });
    const invoke = vi.fn(async () => 1);
    await expect(scope?.execute(command, input, invoke)).rejects.toThrow(HttpAdmissionError);
    expect(f.rpc).toHaveBeenCalledTimes(2); expect(invoke).not.toHaveBeenCalled();
  });
  it('does not let a different RPC or repeated builder effect reuse the scope', async () => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input);
    expect(scope?.matches('sync_offline_completion_event')).toBe(false);
    await expect(scope?.execute('sync_offline_completion_event', args(), async () => 1)).rejects.toThrow(HttpAdmissionError);
    await scope?.execute(command, args(), async () => 1);
    await expect(scope?.execute(command, args(), async () => 1)).rejects.toThrow(HttpAdmissionError);
    expect(f.rpc).toHaveBeenCalledTimes(3);
  });
  it.each(['COMMAND_RECEIPT', 'OPAQUE', null])('rejects wrong completion mode %j before dispatch', async completionMode => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input); const invoke = vi.fn(async () => 1);
    f.rpc.mockResolvedValueOnce({ data: { ...admitted.data, completionMode }, error: null });
    await expect(scope?.execute(command, args(), invoke)).rejects.toThrow(HttpAdmissionError);
    expect(invoke).not.toHaveBeenCalled(); expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it('lost response observes the same terminal once and preserves the original error', async () => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input); const lost = new Error('synthetic-loss');
    await expect(scope?.execute(command, args(), async () => { throw lost; })).rejects.toBe(lost);
    expect(f.calls).toEqual(['get_operation_admission_control', 'acquire_operation_offline_resolution_admission',
      'complete_operation_offline_resolution_admission']);
  });
  it.each([null, { completed: false }, { completed: true, trustedHttp: true }])('a successful HTTP effect cannot replace rejected terminal %j', async data => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input);
    f.rpc.mockResolvedValueOnce(admitted).mockResolvedValueOnce({ data, error: { code: 'OPERATION_COMPLETION_UNVERIFIED' } });
    const invoke = vi.fn(async () => ({ success: true }));
    expect(await scope?.execute(command, args(), invoke)).toEqual({ success: true });
    expect(invoke).toHaveBeenCalledTimes(1); expect(f.rpc).toHaveBeenCalledTimes(3);
  });
  it('completion keeps the captured target when the caller changes its object after dispatch', async () => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input); const input = args();
    await scope?.execute(command, input, async () => { input.p_quarantine_id = id; return 1; });
    expect(f.rpc.mock.calls[2]?.[1].p_quarantine_id).toBe(quarantine);
  });
  it.each(['REQUESTED', 'UNKNOWN'])('%s stops before a domain effect', async mode => {
    const f = fixture(mode); await expect(beginHttpAdmission(f.input)).rejects.toThrow(HttpAdmissionError);
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('inactive control does not claim integration or change the service', async () => {
    const f = fixture('INACTIVE'); expect(await beginHttpAdmission(f.input)).toBeUndefined();
  });
  it('hung effect expires as UNKNOWN, with no effect retry or completion by deadline', async () => {
    vi.useFakeTimers(); const f = fixture(); const scope = await beginHttpAdmission({ ...f.input, config: { ...config, budgetMs: 10 } });
    let signal: AbortSignal | undefined;
    const pending = scope?.execute(command, args(), current => { signal = current; return new Promise(() => {}); }).catch(e => e);
    await vi.advanceTimersByTimeAsync(11); expect(await pending).toBeInstanceOf(HttpAdmissionError);
    expect(signal?.aborted).toBe(true); expect(f.rpc).toHaveBeenCalledTimes(2);
  });
});
