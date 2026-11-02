import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AdmissionRpc, beginHttpAdmission, HttpAdmissionError, httpAdmissionRoute, withAdmissionRpc} from '../src/modules/developer-reset/http-admission.js';

const actor = { profileId: '00000000-0000-4000-8000-000000000001',
  authUserId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003' };
const id = '00000000-0000-4000-8000-000000000004';
const config = { target: 'synthetic-target', budgetMs: 10000 };
const route = httpAdmissionRoute('POST', '/v1/attempts/synthetic/lifecycle');
const command = 'manage_cleaning_attempt_lifecycle';
const args = (action = 'allow_finish') => ({ p_actor_profile_id: actor.profileId,
  p_session_id: actor.sessionId, p_action: action, p_idempotency_key: 'lifecycle-retry-key', p_request_hash: 'a'.repeat(64) });
function fixture(mode = 'OPEN') {
  const calls: string[] = [];
  const rpc = vi.fn<AdmissionRpc>(async name => {
    calls.push(name);
    return { data: name === 'get_operation_admission_control'
      ? { mode, controlVersion: mode === 'INACTIVE' ? null : '1', targetRef: mode === 'INACTIVE' ? null : config.target }
      : name === 'acquire_operation_lifecycle_admission'
      ? { admissionId: id, controlVersion: '1', completionMode: 'COMMAND_RECEIPT' }
      : { completed: true }, error: null };
  });
  return { calls, rpc, input: { config, route, rpc, identity: async () => actor, nonce: () => 'b'.repeat(64) } };
}
afterEach(() => vi.useRealTimers());

describe('fixed three-action lifecycle receipt admission', () => {
  it.each(['allow_finish', 'allow_upload', 'interrupt_handover'])('binds actual %s args before one lazy SDK effect', async action => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input);
    const input = args(action);
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      f.calls.push('effect'); expect(JSON.parse(String(init?.body))).toEqual(input);
      return new Response(JSON.stringify({ applied: true }), { headers: { 'content-type': 'application/json' } });
    });
    const client = withAdmissionRpc(createClient('https://synthetic.invalid', 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false }, global: { fetch },
    }), () => scope);
    const query = client.rpc(command, input);
    expect(fetch).not.toHaveBeenCalled(); expect(f.rpc).toHaveBeenCalledTimes(1);
    await Promise.all([query, query]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual(['get_operation_admission_control', 'acquire_operation_lifecycle_admission', 'effect', 'complete_operation_http_admission']);
    expect(f.rpc.mock.calls[1]?.[1]).toEqual({ p_target: config.target, p_version: '1',
      p_actor: actor.profileId, p_auth: actor.authUserId, p_session: actor.sessionId,
      p_nonce: 'b'.repeat(64), p_deadline: expect.any(String), p_action: action,
      p_idempotency_key: input.p_idempotency_key, p_request_hash: input.p_request_hash });
    expect(f.rpc.mock.calls[2]?.[1]).toEqual({ p_admission_id: id, p_nonce: 'b'.repeat(64),
      p_actor: actor.profileId, p_auth: actor.authUserId, p_session: actor.sessionId });
  });
  it.each([undefined, null, '', 'expire_scheduled', 'ALLOW_FINISH', 'allow_finish ', {}, true])('rejects non-public action %j before acquire', async action => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input); const invoke = vi.fn(async () => 1);
    await expect(scope?.execute(command, { ...args(), p_action: action }, invoke)).rejects.toThrow(HttpAdmissionError);
    expect(f.rpc).toHaveBeenCalledTimes(1); expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['p_actor_profile_id', 'p_session_id', 'p_idempotency_key', 'p_request_hash'])('rejects invalid %s before acquire', async field => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input); const invoke = vi.fn(async () => 1);
    await expect(scope?.execute(command, { ...args(), [field]: null }, invoke)).rejects.toThrow(HttpAdmissionError);
    expect(f.rpc).toHaveBeenCalledTimes(1); expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['p_actor_profile_id', 'p_session_id', 'p_action', 'p_idempotency_key', 'p_request_hash'])('rejects %s drift while acquiring without dispatch or fictitious completion', async field => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input); const input = args();
    f.rpc.mockImplementationOnce(async () => {
      Object.assign(input, { [field]: field === 'p_action' ? 'allow_upload' : field === 'p_request_hash' ? 'c'.repeat(64) : 'changed-value' });
      return { data: { admissionId: id, controlVersion: '1', completionMode: 'COMMAND_RECEIPT' }, error: null };
    });
    const invoke = vi.fn(async () => 1);
    await expect(scope?.execute(command, input, invoke)).rejects.toThrow(HttpAdmissionError);
    expect(f.rpc).toHaveBeenCalledTimes(2); expect(invoke).not.toHaveBeenCalled();
  });
  it('a different RPC cannot acquire this terminal receipt and one scope cannot run twice', async () => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input);
    expect(scope?.matches('complete_limited_cleaning_attempt_field_work')).toBe(false);
    await expect(scope?.execute('complete_limited_cleaning_attempt_field_work', args(), async () => 1)).rejects.toThrow(HttpAdmissionError);
    await scope?.execute(command, args(), async () => 1);
    await expect(scope?.execute(command, args('allow_upload'), async () => 1)).rejects.toThrow(HttpAdmissionError);
    expect(f.rpc).toHaveBeenCalledTimes(3);
  });
  it.each(['REQUESTED', 'UNKNOWN'])('%s blocks before any effect', async mode => {
    const f = fixture(mode); await expect(beginHttpAdmission(f.input)).rejects.toThrow(HttpAdmissionError);
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('missing control and disabled mode preserve existing behavior without claiming readiness', async () => {
    const f = fixture('INACTIVE'); expect(await beginHttpAdmission(f.input)).toBeUndefined();
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(await beginHttpAdmission({ ...f.input, config: undefined })).toBeUndefined();
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it.each([null, { completed: false }, { completed: true, assumed: true }])('invalid terminal %j does not retry effect or substitute original result', async data => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input);
    f.rpc.mockResolvedValueOnce({ data: { admissionId: id, controlVersion: '1', completionMode: 'COMMAND_RECEIPT' }, error: null })
      .mockResolvedValueOnce({ data, error: { code: 'OPERATION_COMPLETION_UNVERIFIED' } });
    const invoke = vi.fn(async () => ({ error: 'original-failure' }));
    expect(await scope?.execute(command, args(), invoke)).toEqual({ error: 'original-failure' });
    expect(f.rpc).toHaveBeenCalledTimes(3); expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('lost response probes only the exact receipt, then preserves the original error', async () => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input); const lost = new Error('synthetic');
    await expect(scope?.execute(command, args(), async () => { throw lost; })).rejects.toBe(lost);
    expect(f.calls).toEqual(['get_operation_admission_control', 'acquire_operation_lifecycle_admission', 'complete_operation_http_admission']);
  });
  it('deadline on a hung effect retains UNKNOWN and never retries or completes by expiry', async () => {
    vi.useFakeTimers(); const f = fixture();
    const scope = await beginHttpAdmission({ ...f.input, config: { ...config, budgetMs: 10 } });
    let signal: AbortSignal | undefined;
    const result = scope?.execute(command, args(), current => { signal = current; return new Promise(() => {}); }).catch(e => e);
    await vi.advanceTimersByTimeAsync(11);
    expect(await result).toBeInstanceOf(HttpAdmissionError); expect(signal?.aborted).toBe(true);
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });
});
