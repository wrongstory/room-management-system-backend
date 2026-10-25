import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { schedulerOperationBudget, withSchedulerOperationAdmission } from '../src/modules/developer-reset/scheduler-admission.js';
import type { OperationWorkerRpc } from '../src/modules/developer-reset/worker-admission.js';
const hash = (command: string) => createHash('sha256').update(JSON.stringify({ command })).digest('hex');
const id = '13300000-0000-4000-8000-000000000001', target = 'a'.repeat(20), nonce = 'b'.repeat(64);
const binding = { actorId: id, invocationKey: 'reservation-scheduler-202610250400', scheduledAt: '2026-10-25T04:00:00.000Z',
  requestId: 'synthetic-request', commandAt: '2026-10-25T04:00:01.000Z', startedAt: '2026-10-25T04:00:00.000Z',
  reservationHash: hash('reservation.process_due_transitions'), assignmentHash: hash('assignment.process_due_lifecycle') };
const command = (assignment = false) => ({ p_actor_profile_id: id, p_as_of: binding.commandAt,
  p_idempotency_key: binding.invocationKey, p_request_hash: assignment ? binding.assignmentHash : binding.reservationHash });
const heartbeat = () => ({ p_actor_profile_id: id, p_invocation_key: binding.invocationKey, p_scheduled_at: binding.scheduledAt,
  p_status: 'succeeded', p_error_code: null, p_started_at: binding.startedAt, p_completed_at: binding.commandAt,
  p_request_id: binding.requestId, p_transition_count: 0 });
function fake(options: { inactive?: boolean; fail?: string; malformed?: unknown; hang?: string } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db: OperationWorkerRpc = { rpc: vi.fn(async (name, args) => {
    calls.push({ name, args });
    if (options.hang === name) return new Promise<never>(() => undefined);
    if (options.fail === name) return { data: null, error: { code: 'SYNTHETIC_UNKNOWN' } };
    if (name.startsWith('acquire_')) return { data: options.malformed ?? { admissionId: options.inactive ? null : id }, error: null };
    if (name.startsWith('complete_')) return { data: { completed: true }, error: null };
    return { data: name === 'record_scheduler_heartbeat' ? null : {}, error: null };
  }) };
  return { db, calls };
}
const options = (db: OperationWorkerRpc) => ({ config: { target }, db, binding, budgetMs: 1000, nonce: () => nonce });
async function complete(rpc: OperationWorkerRpc['rpc']) {
  await rpc('process_due_reservation_transitions', command());
  await rpc('process_due_assignment_lifecycle', command(true));
  await rpc('record_scheduler_heartbeat', heartbeat());
  return 42;
}
afterEach(() => vi.useRealTimers());
describe('fixed scheduler admission and response-loss behavior', () => {
  it('preserves disabled behavior without creating an admission', async () => {
    const { db, calls } = fake();
    expect(await withSchedulerOperationAdmission({ ...options(db), config: undefined }, complete)).toBe(42);
    expect(calls.map(c => c.name)).toEqual(['process_due_reservation_transitions', 'process_due_assignment_lifecycle', 'record_scheduler_heartbeat']);
  });
  it('keeps two separate commands then heartbeat before exact completion', async () => {
    const { db, calls } = fake();
    expect(await withSchedulerOperationAdmission(options(db), complete)).toBe(42);
    expect(calls.map(c => c.name)).toEqual(['acquire_operation_reservation_scheduler', 'process_due_reservation_transitions',
      'process_due_assignment_lifecycle', 'record_scheduler_heartbeat', 'complete_operation_reservation_scheduler']);
    expect(calls[4]?.args).toEqual({ p_target: target, p_nonce: nonce, p_admission_id: id });
  });
  it('does not call completion when no control exists', async () => {
    const { db, calls } = fake({ inactive: true }); await withSchedulerOperationAdmission(options(db), complete);
    expect(calls).toHaveLength(4);
  });
  it('preserves the nullable historical transition count without treating it as completion proof', async () => {
    const { db, calls } = fake();
    await withSchedulerOperationAdmission(options(db), async rpc => {
      await rpc('process_due_reservation_transitions', command()); await rpc('process_due_assignment_lifecycle', command(true));
      await rpc('record_scheduler_heartbeat', { ...heartbeat(), p_transition_count: null });
    });
    expect(calls.at(-1)?.name).toBe('complete_operation_reservation_scheduler');
    const invalid = fake();
    await expect(withSchedulerOperationAdmission(options(invalid.db), async rpc => {
      await rpc('process_due_reservation_transitions', command()); await rpc('process_due_assignment_lifecycle', command(true));
      await rpc('record_scheduler_heartbeat', { ...heartbeat(), p_transition_count: -1 });
    })).rejects.toThrow(); expect(invalid.calls).toHaveLength(3);
  });
  it.each(['acquire_operation_reservation_scheduler', 'process_due_reservation_transitions', 'process_due_assignment_lifecycle',
    'record_scheduler_heartbeat', 'complete_operation_reservation_scheduler'])('fails closed at %s without repeating any effect', async fail => {
    const { db, calls } = fake({ fail });
    await expect(withSchedulerOperationAdmission(options(db), complete)).rejects.toThrow('OPERATION_WORKER_ADMISSION_UNAVAILABLE');
    expect(calls.at(-1)?.name).toBe(fail); expect(new Set(calls.map(c => c.name)).size).toBe(calls.length);
  });
  it.each([{ admissionId: 'invalid' }, {}, { admissionId: id, extra: true }])('rejects malformed acquisition before writes', async malformed => {
    const { db, calls } = fake({ malformed });
    await expect(withSchedulerOperationAdmission(options(db), complete)).rejects.toThrow(); expect(calls).toHaveLength(1);
  });
  it('cannot complete a partial invocation or use a later invocation heartbeat', async () => {
    const { db, calls } = fake();
    await expect(withSchedulerOperationAdmission(options(db), async rpc => {
      await rpc('process_due_reservation_transitions', command());
    })).rejects.toThrow(); expect(calls).toHaveLength(2);
    const second = fake();
    await expect(withSchedulerOperationAdmission(options(second.db), async rpc => {
      await rpc('process_due_reservation_transitions', command()); await rpc('process_due_assignment_lifecycle', command(true));
      await rpc('record_scheduler_heartbeat', { ...heartbeat(), p_request_id: 'other-request' });
    })).rejects.toThrow(); expect(second.calls).toHaveLength(3);
  });
  it('rejects changed actor/hash/extra args or unrelated writes before dispatch', async () => {
    for (const args of [{ ...command(), p_actor_profile_id: target }, { ...command(), p_request_hash: nonce }, { ...command(), extra: 1 }]) {
      const { db, calls } = fake();
      await expect(withSchedulerOperationAdmission(options(db), async rpc => { await rpc('process_due_reservation_transitions', args); })).rejects.toThrow();
      expect(calls).toHaveLength(1);
    }
    const { db, calls } = fake();
    await expect(withSchedulerOperationAdmission(options(db), async rpc => { await rpc('record_scheduler_heartbeat', heartbeat()); })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it('keeps a response-lost query unresolved and blocks later retained RPC calls', async () => {
    vi.useFakeTimers(); const { db, calls } = fake({ hang: 'process_due_reservation_transitions' });
    let retained: OperationWorkerRpc['rpc'] | undefined;
    const pending = withSchedulerOperationAdmission(options(db), async rpc => { retained = rpc; return complete(rpc); });
    const rejection = expect(pending).rejects.toThrow(); await vi.advanceTimersByTimeAsync(1001); await rejection;
    await expect(Promise.resolve(retained!('record_scheduler_heartbeat', heartbeat()))).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
  it.each(['acquire_operation_reservation_scheduler', 'process_due_assignment_lifecycle'])('redacts transport rejection at %s into the fixed unavailable error', async rejected => {
    const { db, calls } = fake(); const original = db.rpc.bind(db);
    db.rpc = (name, args) => name === rejected ? Promise.reject(new Error('synthetic-private-transport')) : original(name, args);
    await expect(withSchedulerOperationAdmission(options(db), complete)).rejects.toThrow('OPERATION_WORKER_ADMISSION_UNAVAILABLE');
    expect(calls.some(c => c.name.startsWith('complete_'))).toBe(false);
  });
  it('redacts synchronous transport throws before any subsequent write', async () => {
    const db: OperationWorkerRpc = { rpc: () => { throw new Error('synthetic-private-transport'); } };
    await expect(withSchedulerOperationAdmission(options(db), complete)).rejects.toThrow('OPERATION_WORKER_ADMISSION_UNAVAILABLE');
  });
  it('bounds callback hangs and never accepts the success prefix as completion', async () => {
    vi.useFakeTimers(); const { db, calls } = fake();
    const pending = withSchedulerOperationAdmission(options(db), async rpc => { await complete(rpc); return new Promise(() => undefined); });
    const rejection = expect(pending).rejects.toThrow(); await vi.advanceTimersByTimeAsync(1001); await rejection;
    expect(calls.at(-1)?.name).toBe('record_scheduler_heartbeat');
  });
  it('executes a lazy call once even when awaited twice', async () => {
    const { db, calls } = fake();
    await withSchedulerOperationAdmission(options(db), async rpc => {
      const q = rpc('process_due_reservation_transitions', command()); expect(calls).toHaveLength(1); await q; await q;
      await rpc('process_due_assignment_lifecycle', command(true)); await rpc('record_scheduler_heartbeat', heartbeat());
    }); expect(calls).toHaveLength(5);
  });
  it('requires explicit finite observation budget and matching bucket', async () => {
    for (const value of [undefined, '', '0', '-1', '1.5', '120001', 'auto']) expect(() => schedulerOperationBudget(value)).toThrow();
    expect(schedulerOperationBudget('45000')).toBe(45000);
    const { db, calls } = fake();
    await expect(withSchedulerOperationAdmission({ ...options(db), binding: { ...binding, invocationKey: 'reservation-scheduler-202610250401' } }, complete)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
