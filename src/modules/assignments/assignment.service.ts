import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';

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
  effective_service_date: string; carryover_count: number; status: string; assignment_version: number;
  room_type_snapshot: unknown; fee_snapshot: number; template_snapshot: unknown;
  rooms?: { room_number: string } | Array<{ room_number: string }> | null;
}
interface ProfileRow { id: string; display_name: string }
interface AttemptRow { id: string; assignment_id: string; attempt_number: number; status: string }
interface SubmissionRow { cleaning_attempt_id: string; version: number; status: string }
interface ScheduleRow { cleaning_target_id: string; revision: number; effective_service_date: string; reason_code: string }

function databaseError(error: { message?: string } | null): AppError {
  const code = error?.message;
  if (code === 'ASSIGNMENT_ACCESS_REQUIRED') {
    return new AppError(403, code, '청소 배정 조회 권한이 필요합니다.');
  }
  return new AppError(500, 'ASSIGNMENT_QUERY_FAILED', '청소 배정을 조회하지 못했습니다.');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw databaseError(null);
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function roomNumber(target: TargetRow): string {
  const room = Array.isArray(target.rooms) ? target.rooms[0] : target.rooms;
  if (!room?.room_number) throw databaseError(null);
  return room.room_number;
}

const rolloverReasonCodes = new Set(['ROLLED_OVER_UNASSIGNED', 'ROLLED_OVER_NOT_STARTED']);

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
  constructor(private readonly clients: SupabaseClients) {}

  async list(actor: Actor, input: AssignmentListInput): Promise<unknown[]> {
    this.requireReader(actor);
    if (actor.role === 'maid' && input.maidProfileId && input.maidProfileId !== actor.profileId) {
      throw new AppError(403, 'ASSIGNMENT_ACCESS_REQUIRED', '다른 메이드의 청소 배정은 조회할 수 없습니다.');
    }
    let query = this.clients.forAccessToken(actor.accessToken).from('cleaning_assignments')
      .select(this.assignmentColumns()).eq('service_date', input.serviceDate)
      .order('sequence_number').order('revision');
    if (!input.includeHistory) query = query.eq('is_current', true);
    if (actor.role === 'maid') {
      query = query.eq('maid_profile_id', actor.profileId).not('notified_at', 'is', null);
    } else if (input.maidProfileId) query = query.eq('maid_profile_id', input.maidProfileId);
    const { data, error } = await query;
    if (error) throw databaseError(error);
    return this.hydrate(actor, this.visibleRows(data, actor));
  }

  async history(actor: Actor, cleaningTargetId: string): Promise<unknown[]> {
    this.requireReader(actor);
    let query = this.clients.forAccessToken(actor.accessToken).from('cleaning_assignments')
      .select(this.assignmentColumns()).eq('cleaning_target_id', cleaningTargetId).order('revision');
    if (actor.role === 'maid') {
      query = query.eq('maid_profile_id', actor.profileId).not('notified_at', 'is', null);
    }
    const { data, error } = await query;
    if (error) throw databaseError(error);
    const rows = this.visibleRows(data, actor);
    if (rows.length === 0) {
      throw actor.role === 'maid'
        ? new AppError(403, 'ASSIGNMENT_ACCESS_REQUIRED', '이 청소 대상의 배정 이력을 조회할 수 없습니다.')
        : new AppError(404, 'ASSIGNMENT_NOT_FOUND', '청소 배정 이력을 찾을 수 없습니다.');
    }
    return this.hydrate(actor, rows);
  }

  private requireReader(actor: Actor): void {
    if (actor.role !== 'admin' && actor.role !== 'maid') {
      throw new AppError(403, 'ASSIGNMENT_ACCESS_REQUIRED', '청소 배정 조회 권한이 필요합니다.');
    }
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

  private async hydrate(actor: Actor, rows: AssignmentRow[]): Promise<unknown[]> {
    if (rows.length === 0) return [];
    const targetIds = [...new Set(rows.map((row) => row.cleaning_target_id))];
    const maidIds = [...new Set(rows.map((row) => row.maid_profile_id))];
    const assignmentIds = rows.map((row) => row.id);
    const [targetsResult, profilesResult, attemptsResult, schedulesResult] = await Promise.all([
      this.clients.admin.from('cleaning_targets').select(
        'id,room_id,cleaning_kind,original_service_date,effective_service_date,carryover_count,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,rooms!inner(room_number)'
      ).in('id', targetIds),
      this.clients.admin.from('profiles').select('id,display_name').in('id', maidIds),
      this.clients.admin.from('cleaning_attempts').select('id,assignment_id,attempt_number,status')
        .in('assignment_id', assignmentIds).order('attempt_number', { ascending: false }),
      this.clients.admin.from('cleaning_target_schedule_revisions')
        .select('cleaning_target_id,revision,effective_service_date,reason_code')
        .in('cleaning_target_id', targetIds).order('revision', { ascending: false })
    ]);
    const firstError = targetsResult.error ?? profilesResult.error ?? attemptsResult.error ?? schedulesResult.error;
    if (firstError) throw databaseError(firstError);
    const targets = new Map(((targetsResult.data ?? []) as unknown as TargetRow[]).map((row) => [row.id, row]));
    const profiles = new Map(((profilesResult.data ?? []) as ProfileRow[]).map((row) => [row.id, row]));
    const attempts = new Map<string, AttemptRow>();
    for (const attempt of (attemptsResult.data ?? []) as AttemptRow[]) {
      if (!attempts.has(attempt.assignment_id)) attempts.set(attempt.assignment_id, attempt);
    }
    const attemptIds = [...attempts.values()].map((attempt) => attempt.id);
    const submissionsResult = attemptIds.length === 0
      ? { data: [] as SubmissionRow[], error: null }
      : await this.clients.admin.from('cleaning_submissions').select('cleaning_attempt_id,version,status')
        .in('cleaning_attempt_id', attemptIds).order('version', { ascending: false });
    if (submissionsResult.error) throw databaseError(submissionsResult.error);
    const submissions = new Map<string, SubmissionRow>();
    for (const submission of (submissionsResult.data ?? []) as SubmissionRow[]) {
      if (!submissions.has(submission.cleaning_attempt_id)) submissions.set(submission.cleaning_attempt_id, submission);
    }
    const schedules = (schedulesResult.data ?? []) as ScheduleRow[];
    return rows.map((row) => {
      const target = targets.get(row.cleaning_target_id);
      const profile = profiles.get(row.maid_profile_id);
      if (!target || !profile) throw databaseError(null);
      const roomType = object(target.room_type_snapshot);
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
      return {
        assignmentId: row.id, cleaningTargetId: row.cleaning_target_id,
        roomId: actor.role === 'maid' ? row.notified_room_id_snapshot : target.room_id,
        roomNumber: actor.role === 'maid' ? row.notified_room_number_snapshot : roomNumber(target),
        maidProfileId: row.maid_profile_id,
        maidDisplayName: actor.role === 'maid' ? actor.displayName : profile.display_name,
        serviceDate: row.service_date, sequenceNumber: row.sequence_number, revision: row.revision,
        isCurrent: row.is_current,
        targetAssignmentVersion: actor.role === 'maid' ? row.revision : target.assignment_version,
        cleaningKind: target.cleaning_kind, roomTypeCode: text(roomType.code), roomTypeName: text(roomType.name),
        elevatorZone: text(roomType.elevatorZone), feeSnapshot: target.fee_snapshot,
        durationMinutes: duration === null || duration === undefined ? null : duration,
        originalServiceDate: target.original_service_date, ...rollover,
        targetStatus: actor.role === 'admin' || targetMatchesRevision ? target.status : null,
        attemptStatus: attempt?.status ?? null, submissionStatus: submission?.status ?? null,
        availableFrom: row.available_from_snapshot, dueAt: row.due_at_snapshot,
        notifiedAt: row.notified_at, endedAt: row.ended_at, createdAt: row.created_at
      };
    });
  }
}
