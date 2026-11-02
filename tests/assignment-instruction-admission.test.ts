import { describe, expect, it, vi } from 'vitest';
import { beginHttpAdmission, httpAdmissionRoute } from '../src/modules/developer-reset/http-admission.js';

const actor = { profileId: '00000000-0000-4000-8000-000000000001',
  authUserId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003' };
const cases = [
  ['/v1/assignments/drafts', 'save_cleaning_assignment_draft_with_instruction', 'assignment.save_draft'],
  ['/v1/assignments/target/change', 'change_cleaning_assignment_prestart_with_instruction', 'assignment.prestart_change'],
  ['/v1/assignments/target/change', 'change_cleaning_assignment_for_plan_with_instruction', 'assignment.prestart_change']
] as const;

describe('#534 instruction command admission', () => {
  it.each(cases)('binds %s / %s to its unchanged command and caller hash', async (path, name, command) => {
    const rpc = vi.fn(async (called: string) => ({ data: called === 'get_operation_admission_control'
      ? { mode: 'OPEN', controlVersion: '5', targetRef: 'test-project' }
      : called === 'acquire_operation_http_admission'
      ? { admissionId: '00000000-0000-4000-8000-000000000004', controlVersion: '5', completionMode: 'COMMAND_RECEIPT' }
      : { completed: true }, error: null }));
    const scope = await beginHttpAdmission({ config: { target: 'test-project', budgetMs: 1000 },
      route: httpAdmissionRoute('POST', path), identity: async () => actor, rpc, nonce: () => 'b'.repeat(64) });
    const args = { p_actor_profile_id: actor.profileId, p_idempotency_key: 'instruction-memo-command',
      p_request_hash: 'a'.repeat(64), p_instruction_memo: '수건 5. 물 캡슐 2.' };
    expect(await scope?.execute(name, args, async () => 'saved')).toBe('saved');
    expect(rpc).toHaveBeenNthCalledWith(2, 'acquire_operation_http_admission', expect.objectContaining({
      p_command_name: command, p_request_hash: args.p_request_hash, p_idempotency_key: args.p_idempotency_key
    }), expect.any(AbortSignal));
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(args.p_instruction_memo);
  });

  it.each(cases)('blocks %s / %s before business identity when maintenance is requested', async (path) => {
    const identity = vi.fn(async () => actor);
    const rpc = vi.fn(async () => ({ data: { mode: 'REQUESTED', controlVersion: '5', targetRef: 'test-project' }, error: null }));
    await expect(beginHttpAdmission({ config: { target: 'test-project', budgetMs: 1000 },
      route: httpAdmissionRoute('POST', path), identity, rpc })).rejects.toMatchObject({ code: 'OPERATION_MAINTENANCE_REQUESTED' });
    expect(identity).not.toHaveBeenCalled();
  });
});
