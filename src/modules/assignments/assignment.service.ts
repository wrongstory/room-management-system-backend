import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import { assignmentCancellationCapability, parseRoomTypeSnapshot } from './assignment-preview-core.js';
import { type AssignmentScheduleRead, parseAssignmentScheduleReads } from './assignment-schedule-core.js';

export interface AssignmentListInput {
  serviceDate: string;
  maidProfileId?: string | undefined;
  includeHistory?: boolean | undefined;
}

export interface AssignmentService {
  list(actor: Actor, input: AssignmentListInput): Promise<unknown[]>;
  history(actor: Actor, cleaningTargetId: string): Promise<unknown[]>;
}

interface AssignmentRow {
  id: string; cleaning_target_id: string; maid_profile_id: string;
  service_date: string; sequence_number: number; revision: number; is_current: boolean;
  available_from_snapshot: string | null; due_at_snapshot: string | null;
  notified_at: string | null; notified_room_id_snapshot: string | null;
  notified_room_number_snapshot: string | null;
  ended_at: string | null; created_at: string;
}
interface TargetRow {
  id: string; room_id: string; cleaning_kind: string; original_service_date: string;
  source?: string;
  effective_service_date: string; carryover_count: number; status: string; assignment_version: number;
  room_type_snapshot: unknown; fee_snapshot: number; template_snapshot: unknown;
  rooms?: { room_number: string } | Array<{ room_number: string }> | null;
}
interface ProfileRow { id: string; display_name: string }
interface AttemptRow { id: string; assignment_id: string; attempt_number: number; status: string; started_at?: string | null }
interface SubmissionRow { cleaning_attempt_id: string; version: number; status: string }
interface ScheduleRow { cleaning_target_id: string; revision: number; effective_service_date: string; reason_code: string }

function databaseError(error: { message?: string } | null): AppError {
  const code = error?.message;
  if (code === 'ASSIGNMENT_ACCESS_REQUIRED') {
    return new AppError(403, code, '청소 배정 조회 권한이 필요합니다.');
  }
  if (code === 'SESSION_REVOKED') return new AppError(401, code, '다시 로그인해 주세요.');
  if (code === 'PASSWORD_CHANGE_REQUIRED') return new AppError(403, code, '비밀번호 변경이 필요합니다.');
  return new AppError(500, 'ASSIGNMENT_QUERY_FAILED', '청소 배정을 조회하지 못했습니다.');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw databaseError(null);
  return value as Record<string, unknown>;
}

function roomNumber(target: TargetRow): string {
  const room = Array.isArray(target.rooms) ? target.rooms[0] : target.rooms;
  if (!room?.room_number) throw databaseError(null);
  return room.room_number;
}

const rolloverReasonCodes = new Set(['ROLLED_OVER_UNASSIGNED', 'ROLLED_OVER_NOT_STARTED']);
const readLimit = 1000;
const hydrationBatchSize = 100;

function completeRows(result: { data: unknown; error: { message?: string } | null; count: number | null }): unknown[] {
  if (result.error) throw databaseError(result.error);
  if (!Array.isArray(result.data) || !Number.isSafeInteger(result.count) ||
    result.count === null || result.count < 0 || result.count > readLimit || result.data.length !== result.count) {
    throw databaseError(null);
  }
  return result.data;
}

function rolloverSnapshot(target: TargetRow, row: AssignmentRow, schedules: ScheduleRow[]) {
  if (!Number.isSafeInteger(target.carryover_count) || target.carryover_count < 0) {
    throw databaseError(null);
  }
  const evidence = schedules
    .filter((candidate) => candidate.cleaning_target_id === row.cleaning_target_id &&
      candidate.revision <= row.revision && rolloverReasonCodes.has(candidate.reason_code))
    .sort((left, right) => right.revision - left.revision);
  const rolloverCount = Math.min(target.carryover_count, evidence.length);
  return {
    rolloverCount,
    rolloverReason: rolloverCount === 0 ? null : evidence[0]?.reason_code ?? null
  };
}

export class SupabaseAssignmentService implements AssignmentService {
  constructor(private readonly clients: SupabaseClients, private readonly clock: () => Date = () => new Date()) {}

  async list(actor: Actor, input: AssignmentListInput): Promise<unknown[]> {
    this.requireReader(actor);
    if (actor.role === 'maid' && input.maidProfileId && input.maidProfileId !== actor.profileId) {
      throw new AppError(403, 'ASSIGNMENT_ACCESS_REQUIRED', '다른 메이드의 청소 배정은 조회할 수 없습니다.');
    }
    const today = new Date(this.clock().getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const includeOverdue = !input.includeHistory && input.serviceDate === today;
    let query = this.clients.forAccessToken(actor.accessToken).from('cleaning_assignments')
      .select(this.assignmentColumns(), { count: 'exact' }).eq('service_date', input.serviceDate)
      .order('sequence_number').order('revision');
    if (!input.includeHistory) query = query.eq('is_current', true);
    if (actor.role === 'maid') {
      query = query.eq('maid_profile_id', actor.profileId).not('notified_at', 'is', null);
    } else if (input.maidProfileId) query = query.eq('maid_profile_id', input.maidProfileId);
    const rows = this.visibleRows(completeRows(await query.limit(readLimit)), actor);
    if (includeOverdue) {
      let overdue = this.clients.forAccessToken(actor.accessToken).from('cleaning_assignments')
        .select(`${this.assignmentColumns()},cleaning_targets!inner(status)`, { count: 'exact' })
        .lt('service_date', today).eq('is_current', true)
        .not('cleaning_targets.status', 'in', '(approved,cancelled)')
        .order('service_date').order('sequence_number').order('revision').order('id');
      if (actor.role === 'maid') {
        overdue = overdue.eq('maid_profile_id', actor.profileId).not('notified_at', 'is', null);
      } else if (input.maidProfileId) overdue = overdue.eq('maid_profile_id', input.maidProfileId);
      rows.push(...this.visibleRows(completeRows(await overdue.limit(readLimit)), actor));
      if (rows.length > readLimit) throw databaseError(null);
      rows.sort((left, right) => left.service_date.localeCompare(right.service_date) ||
        left.sequence_number - right.sequence_number || left.revision - right.revision || left.id.localeCompare(right.id));
    }
    return this.hydrate(actor, rows, !input.includeHistory);
  }

  async history(actor: Actor, cleaningTargetId: string): Promise<unknown[]> {
    this.requireReader(actor);
    let query = this.clients.forAccessToken(actor.accessToken).from('cleaning_assignments')
      .select(this.assignmentColumns(), { count: 'exact' }).eq('cleaning_target_id', cleaningTargetId).order('revision');
    if (actor.role === 'maid') {
      query = query.eq('maid_profile_id', actor.profileId).not('notified_at', 'is', null);
    }
    const rows = this.visibleRows(completeRows(await query.limit(readLimit)), actor);
    if (rows.length === 0) {
      throw actor.role === 'maid'
        ? new AppError(403, 'ASSIGNMENT_ACCESS_REQUIRED', '이 청소 대상의 배정 이력을 조회할 수 없습니다.')
        : new AppError(404, 'ASSIGNMENT_NOT_FOUND', '청소 배정 이력을 찾을 수 없습니다.');
    }
    return this.hydrate(actor, rows, false);
  }

  private requireReader(actor: Actor): void {
    if (actor.role !== 'admin' && actor.role !== 'maid') {
      throw new AppError(403, 'ASSIGNMENT_ACCESS_REQUIRED', '청소 배정 조회 권한이 필요합니다.');
    }
    if (actor.mustChangePassword) throw databaseError({ message: 'PASSWORD_CHANGE_REQUIRED' });
  }

  private visibleRows(data: unknown, actor: Actor): AssignmentRow[] {
    const rows = (data ?? []) as AssignmentRow[];
    return actor.role === 'maid'
      ? rows.filter((row) => row.maid_profile_id === actor.profileId && typeof row.notified_at === 'string')
      : rows;
  }

  private assignmentColumns(): string {
    return [
      'id', 'cleaning_target_id', 'maid_profile_id', 'service_date', 'sequence_number', 'revision',
      'is_current', 'available_from_snapshot', 'due_at_snapshot', 'notified_at',
      'notified_room_id_snapshot', 'notified_room_number_snapshot', 'ended_at', 'created_at'
    ].join(',');
  }

  private async relatedRows(table: string, columns: string, key: string, ids: string[], order?: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let offset = 0; offset < ids.length; offset += hydrationBatchSize) {
      let query = this.clients.admin.from(table).select(columns, { count: 'exact' })
        .in(key, ids.slice(offset, offset + hydrationBatchSize));
      if (order) query = query.order(order, { ascending: false });
      rows.push(...completeRows(await query.limit(readLimit)));
    }
    return rows;
  }

  private async scheduleReads(actor: Actor, rows: AssignmentRow[], includeCurrent: boolean) {
    let sessionId: string;
    try {
      const claims = JSON.parse(Buffer.from(actor.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { session_id?: unknown };
      if (typeof claims.session_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.session_id)) throw new Error();
      sessionId = claims.session_id.toLowerCase();
    } catch { throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.'); }
    const result = new Map<string, AssignmentScheduleRead>();
    for (let offset = 0; offset < rows.length; offset += hydrationBatchSize) {
      const ids = rows.slice(offset, offset + hydrationBatchSize).map((row) => row.id);
      const response = await this.clients.admin.rpc('get_assignment_schedule_read', {
        p_actor_profile_id: actor.profileId, p_session_id: sessionId,
        p_assignment_ids: ids, p_include_current: includeCurrent, p_expected_actor_role: actor.role
      });
      if (response.error) throw databaseError(response.error);
      try {
        for (const [id, read] of parseAssignmentScheduleReads(response.data, ids, includeCurrent)) result.set(id, read);
      } catch { throw databaseError(null); }
    }
    return result;
  }

  private async hydrate(actor: Actor, rows: AssignmentRow[], includeCurrent: boolean): Promise<unknown[]> {
    if (rows.length === 0) return [];
    const targetIds = [...new Set(rows.map((row) => row.cleaning_target_id))];
    const maidIds = [...new Set(rows.map((row) => row.maid_profile_id))];
    const assignmentIds = rows.map((row) => row.id);
    const [targetRows, profileRows, attemptRows, scheduleRows] = await Promise.all([
      this.relatedRows('cleaning_targets',
        'id,room_id,cleaning_kind,source,original_service_date,effective_service_date,carryover_count,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,rooms!inner(room_number)'
      , 'id', targetIds),
      this.relatedRows('profiles', 'id,display_name', 'id', maidIds),
      this.relatedRows('cleaning_attempts', 'id,assignment_id,attempt_number,status,started_at', 'assignment_id', assignmentIds, 'attempt_number'),
      this.relatedRows('cleaning_target_schedule_revisions', 'cleaning_target_id,revision,effective_service_date,reason_code', 'cleaning_target_id', targetIds, 'revision')
    ]);
    const targets = new Map((targetRows as TargetRow[]).map((row) => [row.id, row]));
    const profiles = new Map((profileRows as ProfileRow[]).map((row) => [row.id, row]));
    const attempts = new Map<string, AttemptRow>();
    const capabilityAttempts = new Map<string, AttemptRow[]>();
    for (const attempt of attemptRows as AttemptRow[]) {
      if (!attempts.has(attempt.assignment_id)) attempts.set(attempt.assignment_id, attempt);
      const all = capabilityAttempts.get(attempt.assignment_id) ?? [];
      all.push(attempt);
      capabilityAttempts.set(attempt.assignment_id, all);
    }
    const attemptIds = [...attempts.values()].map((attempt) => attempt.id);
    const submissionRows = await this.relatedRows('cleaning_submissions', 'cleaning_attempt_id,version,status', 'cleaning_attempt_id', attemptIds, 'version');
    const submissions = new Map<string, SubmissionRow>();
    for (const submission of submissionRows as SubmissionRow[]) {
      if (!submissions.has(submission.cleaning_attempt_id)) submissions.set(submission.cleaning_attempt_id, submission);
    }
    const schedules = scheduleRows as ScheduleRow[];
    // Revalidate actor/session/ownership last, in the same DB snapshot as the
    // new facts. History never hydrates current reservation/occupancy state.
    const scheduleReads = await this.scheduleReads(actor, rows, includeCurrent);
    return rows.map((row) => {
      const target = targets.get(row.cleaning_target_id);
      const profile = profiles.get(row.maid_profile_id);
      if (!target || !profile) throw databaseError(null);
      let roomType: ReturnType<typeof parseRoomTypeSnapshot>;
      try { roomType = parseRoomTypeSnapshot(object(target.room_type_snapshot)); }
      catch { throw databaseError(null); }
      const template = object(target.template_snapshot);
      const duration = template.durationMinutes;
      if (!Number.isSafeInteger(target.fee_snapshot) || target.fee_snapshot < 0 ||
        (duration !== null && duration !== undefined && (!Number.isSafeInteger(duration) || (duration as number) <= 0))) {
        throw databaseError(null);
      }
      const rollover = rolloverSnapshot(target, row, schedules);
      const attempt = attempts.get(row.id);
      const submission = attempt ? submissions.get(attempt.id) : undefined;
      const targetMatchesRevision = row.is_current && target.assignment_version === row.revision &&
        target.effective_service_date === row.service_date;
      const cancellation = assignmentCancellationCapability(actor.role, row.is_current,
        target.source, target.status, capabilityAttempts.get(row.id) ?? []);
      const scheduleRead = scheduleReads.get(row.id);
      if (!scheduleRead) throw databaseError(null);
      return {
        assignmentId: row.id, cleaningTargetId: row.cleaning_target_id,
        roomId: actor.role === 'maid' ? row.notified_room_id_snapshot : target.room_id,
        roomNumber: actor.role === 'maid' ? row.notified_room_number_snapshot : roomNumber(target),
        maidProfileId: row.maid_profile_id,
        maidDisplayName: actor.role === 'maid' ? actor.displayName : profile.display_name,
        serviceDate: row.service_date, sequenceNumber: row.sequence_number, revision: row.revision,
        isCurrent: row.is_current,
        targetAssignmentVersion: actor.role === 'maid' ? row.revision : target.assignment_version,
        cleaningKind: target.cleaning_kind, sourceKind: target.source ?? null,
        roomTypeCode: roomType?.code ?? null, roomTypeName: roomType?.name ?? null,
        elevatorZone: roomType?.elevatorZone ?? null, roomTypeSnapshot: roomType, feeSnapshot: target.fee_snapshot,
        durationMinutes: duration === null || duration === undefined ? null : duration,
        originalServiceDate: target.original_service_date, effectiveServiceDate: row.service_date, ...rollover,
        ...cancellation,
        targetStatus: actor.role === 'admin' || targetMatchesRevision ? target.status : null,
        attemptStatus: attempt?.status ?? null, submissionStatus: submission?.status ?? null,
        availableFrom: row.available_from_snapshot, dueAt: row.due_at_snapshot,
        ...scheduleRead,
        notifiedAt: row.notified_at, endedAt: row.ended_at, createdAt: row.created_at
      };
    });
  }
}
