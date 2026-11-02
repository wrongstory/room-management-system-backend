import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAtomicOperationRpc, isAtomicOperationRpc } from '../src/modules/developer-reset/operation-atomic-rpc.js';

const target = 'test-project';
const open = { mode: 'OPEN', controlVersion: '4', targetRef: target };
const make = (result: unknown = null, control: unknown = open) => {
  const calls: { name: string; args: Record<string, unknown>; signal: AbortSignal }[] = [];
  return { calls, rpc: vi.fn(async (name: string, args: Record<string, unknown>, signal: AbortSignal) => {
    calls.push({ name, args, signal });
    return { data: name === 'get_operation_admission_control' ? control : { result }, error: null as unknown };
  }) };
};
const input = (rpc: ReturnType<typeof make>['rpc'], name = 'record_unknown_login_failure', args: Record<string, unknown> = {}) =>
  ({ config: { target, budgetMs: 1000 }, name, args, rpc, now: () => 1792886400000, nonce: () => 'a'.repeat(64) });
afterEach(() => vi.useRealTimers());
describe('same-transaction finite audit/read-state adapter', () => {
  it.each([
    ['record_unknown_login_failure', {}, null],
    ['record_actor_activity_event', { p_actor_profile_id: 'id', p_event_type: 'auth.login_failed', p_outcome: 'failed', p_source: 'edge.auth.login', p_request_id: 'request' }, 'event-id'],
    ['record_authorization_denial', { p_actor_profile_id: 'id', p_source: 'edge.authorization.photos', p_reason_code: 'PHOTO_ACCESS_REQUIRED' }, null],
    ['mark_notification_read', { p_actor_profile_id: 'id', p_session_id: 'session', p_notification_id: 'notice' }, { id: 'notice', readAt: '2026-10-25T00:00:00Z' }],
  ] as const)('preserves %s arguments, omitted defaults and original return shape', async (name, args, result) => {
    const f = make(result);
    expect(isAtomicOperationRpc(name)).toBe(true);
    expect(await executeAtomicOperationRpc(input(f.rpc, name, args))).toEqual({ data: result, error: null });
    expect(f.calls.map(c => c.name)).toEqual(['get_operation_admission_control', 'execute_operation_atomic_rpc']);
    expect(f.calls[1]?.args).toEqual({ p_target: target, p_version: '4', p_nonce: 'a'.repeat(64),
      p_deadline: '2026-10-25T00:00:01.000Z', p_rpc_name: name, p_args: args });
  });
  it('rechecks missing control in the effect transaction instead of bypassing the gate', async () => {
    const f = make(null, { mode: 'INACTIVE', controlVersion: null, targetRef: null });
    await executeAtomicOperationRpc(input(f.rpc));
    expect(f.calls[1]?.args.p_version).toBeNull();
  });
  it.each(['REQUESTED', 'UNKNOWN', 'INACTIVE'])('never emits the effect on invalid current mode %s', async mode => {
    const f = make(null, { ...open, mode });
    await expect(executeAtomicOperationRpc(input(f.rpc))).rejects.toMatchObject({ code: 'OPERATION_ATOMIC_RPC_UNAVAILABLE' });
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    { ...open, controlVersion: 4 }, { ...open, controlVersion: '9223372036854775808' },
    { ...open, targetRef: 'other-project' }, { ...open, rawSecret: 'private' },
  ])('rejects mismatched or untrusted control evidence', async control => {
    const f = make(null, control);
    await expect(executeAtomicOperationRpc(input(f.rpc))).rejects.toThrow('OPERATION_ATOMIC_RPC_UNAVAILABLE');
    expect(f.calls).toHaveLength(1);
  });
  it.each(['constructor', 'toString', 'begin_developer_operation_reauth', 'execute_operation_atomic_rpc'])('rejects nonfinite operation %s before any I/O', async name => {
    const f = make(); expect(isAtomicOperationRpc(name)).toBe(false);
    await expect(executeAtomicOperationRpc(input(f.rpc, name))).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  });
  it('rejects changed argument contracts before I/O', async () => {
    const f = make();
    for (const [name, args] of [['mark_notification_read', {}], ['record_unknown_login_failure', { sql: 'SELECT 1' }]] as const) {
      await expect(executeAtomicOperationRpc(input(f.rpc, name, args))).rejects.toThrow();
    }
    expect(f.calls).toHaveLength(0);
  });
  it('keeps original domain errors without a fallback or a synthetic completion', async () => {
    const f = make(); const error = { code: 'P0002', message: 'NOTIFICATION_NOT_FOUND' };
    f.rpc.mockImplementation(async name => name === 'get_operation_admission_control'
      ? { data: open, error: null } : { data: null, error });
    expect(await executeAtomicOperationRpc(input(f.rpc))).toEqual({ data: null, error });
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it('bounds an unresponsive control transport even when AbortSignal is ignored', async () => {
    vi.useFakeTimers();
    const f = make(); let signal: AbortSignal | undefined;
    f.rpc.mockImplementation(async (_name, _args, s) => { signal = s; return new Promise(() => {}); });
    const observed = executeAtomicOperationRpc(input(f.rpc)).catch(error => error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await observed).toMatchObject({ code: 'OPERATION_ATOMIC_RPC_UNAVAILABLE' });
    expect(signal?.aborted).toBe(true); expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['OPERATION_CONTROL_UNAVAILABLE', 'OPERATION_ADMISSION_REJECTED', 'OPERATION_ATOMIC_RPC_REJECTED'])('maps the DB safety rejection %s to a bounded unavailable error', async message => {
    const f = make();
    f.rpc.mockImplementation(async name => name === 'get_operation_admission_control'
      ? { data: open, error: null } : { data: null, error: { code: '42501', message } });
    await expect(executeAtomicOperationRpc(input(f.rpc))).rejects.toMatchObject({ statusCode: 503, code: 'OPERATION_ATOMIC_RPC_UNAVAILABLE' });
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it('does not retry an uncertain effect or send a separate completion', async () => {
    vi.useFakeTimers(); const f = make();
    f.rpc.mockImplementation(async name => name === 'get_operation_admission_control' ? { data: open, error: null } : new Promise(() => {}));
    const observed = executeAtomicOperationRpc(input(f.rpc)).catch(error => error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await observed).toMatchObject({ code: 'OPERATION_ATOMIC_RPC_UNAVAILABLE' }); expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it('shares the original total budget across control and effect', async () => {
    const f = make(); const now = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValue(2001);
    await expect(executeAtomicOperationRpc({ ...input(f.rpc), now })).rejects.toThrow(); expect(f.calls).toHaveLength(1);
  });
  it('rejects a response that cannot prove the fixed envelope', async () => {
    const f = make(); f.rpc.mockImplementation(async name => ({ data: name === 'get_operation_admission_control' ? open : { completed: true }, error: null }));
    await expect(executeAtomicOperationRpc(input(f.rpc))).rejects.toThrow(); expect(f.rpc).toHaveBeenCalledTimes(2);
  });
});
