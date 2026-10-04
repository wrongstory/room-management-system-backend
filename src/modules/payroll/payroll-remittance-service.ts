import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import { payrollAdjustmentBookSessionId } from './payroll-adjustment-book.js';
import { assertPayrollResponseSize } from './payroll-cursor.js';
import {
  normalizeRemittanceCommand, normalizeRemittanceHistoryInput, normalizeRemittanceInput,
  PayrollRemittanceCursor, PayrollRemittanceError, remittanceDatabaseError, remittanceErrorStatus,
  remittanceHistoryProjection, remittanceProjection, remittanceRequestFingerprint, remittanceRequestHash,
  type RemittanceInput, type RemittanceCommand, type RemittanceSetInput, type RemittanceProjection,
  type RemittanceHistoryInput, type RemittanceHistoryPage
} from './payroll-remittance-marker.js';

function reader(actor: Actor, input: RemittanceInput, write = false): 'admin' | 'maid' {
  if (actor.mustChangePassword) throw new PayrollRemittanceError('PASSWORD_CHANGE_REQUIRED');
  if (write && actor.role !== 'admin') throw new PayrollRemittanceError('ADMIN_REQUIRED');
  if ((actor.role !== 'admin' && actor.role !== 'maid') || (actor.role === 'maid' && actor.profileId.toLowerCase() !== input.maidProfileId)) {
    throw new PayrollRemittanceError('PAYROLL_ACCESS_REQUIRED');
  }
  return actor.role;
}
function mapped(error: unknown): never {
  if (error instanceof PayrollRemittanceError) throw new AppError(remittanceErrorStatus(error.code), error.code, '송금 표시 정보를 처리하지 못했습니다.');
  throw error;
}
export class SupabasePayrollRemittance {
  private readonly cursors: PayrollRemittanceCursor;
  constructor(private readonly clients: SupabaseClients, secret: string) { this.cursors = new PayrollRemittanceCursor(secret); }

  async get(actor: Actor, value: RemittanceInput): Promise<RemittanceProjection> {
    try {
      const input = normalizeRemittanceInput(value), role = reader(actor, input);
      const { data, error } = await this.clients.admin.rpc('get_payroll_remittance_marker', {
        p_actor_profile_id: actor.profileId, p_session_id: payrollAdjustmentBookSessionId(actor),
        p_expected_actor_role: role, p_maid_profile_id: input.maidProfileId, p_week_start: input.weekStart
      });
      if (error) throw remittanceDatabaseError(error);
      assertPayrollResponseSize(data);
      return remittanceProjection(data, input, role);
    } catch (error) { mapped(error); }
  }
  async command(actor: Actor, value: RemittanceCommand | RemittanceSetInput, set: boolean): Promise<RemittanceProjection> {
    try {
      const { idempotencyKey, ...body } = value;
      const input = normalizeRemittanceCommand(body, idempotencyKey, set), role = reader(actor, input, true);
      const { data, error } = await this.clients.admin.rpc(set ? 'set_payroll_remittance_marker' : 'reconfirm_payroll_remittance_marker', {
        p_actor_profile_id: actor.profileId, p_session_id: payrollAdjustmentBookSessionId(actor),
        p_expected_actor_role: role, p_maid_profile_id: input.maidProfileId, p_week_start: input.weekStart,
        p_expected_version: input.expectedVersion, p_expected_basis_fingerprint: input.expectedBasisFingerprint,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: await remittanceRequestHash(remittanceRequestFingerprint(actor.profileId, input, set)),
        ...(set ? { p_marked: (input as RemittanceSetInput).marked } : {})
      });
      if (error) throw remittanceDatabaseError(error);
      assertPayrollResponseSize(data);
      return remittanceProjection(data, input, role);
    } catch (error) { mapped(error); }
  }
  async history(actor: Actor, value: RemittanceHistoryInput): Promise<RemittanceHistoryPage> {
    try {
      const input = normalizeRemittanceHistoryInput(value), role = reader(actor, input), session = payrollAdjustmentBookSessionId(actor);
      const scope = await this.cursors.scope(actor.profileId, role, session, input);
      const after = input.cursor ? await this.cursors.decode(input.cursor, scope) : null;
      const { data, error } = await this.clients.admin.rpc('list_payroll_remittance_marker_history', {
        p_actor_profile_id: actor.profileId, p_session_id: session, p_expected_actor_role: role,
        p_maid_profile_id: input.maidProfileId, p_week_start: input.weekStart, p_after_version: after, p_limit: input.limit
      });
      if (error) throw remittanceDatabaseError(error);
      assertPayrollResponseSize(data);
      const page = remittanceHistoryProjection(data, input, after);
      const response = { maidProfileId: input.maidProfileId, weekStart: input.weekStart, entries: page.entries,
        nextCursor: page.hasMore && page.lastVersion !== null ? await this.cursors.encode(scope, page.lastVersion) : null };
      assertPayrollResponseSize(response);
      return response;
    } catch (error) { mapped(error); }
  }
}
