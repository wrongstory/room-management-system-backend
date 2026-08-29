import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';

export interface AvailabilityDay {
  workDate: string;
  available: boolean;
}

export interface AvailabilityVersion {
  id: string;
  maidProfileId: string;
  weekStart: string;
  version: number;
  status: 'submitted' | 'superseded';
  current: boolean;
  submittedAt: string;
  days: AvailabilityDay[];
}

export interface AvailabilityChangeRequest {
  id: string;
  availabilityVersionId: string;
  maidProfileId: string;
  weekStart: string;
  sourceVersion: number;
  requestedAvailableDates: string[];
  reasonCode: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReasonCode: string | null;
  approvedVersionId: string | null;
}

export interface AvailabilityCandidate {
  workDate: string;
  weekStart: string;
  availabilityVersion: number;
  maidProfileId: string;
  displayName: string;
}

export interface SubmitAvailabilityInput {
  weekStart: string;
  availableDates: string[];
  expectedVersion: number;
  idempotencyKey: string;
}

export interface RequestAvailabilityChangeInput {
  weekStart: string;
  requestedAvailableDates: string[];
  reasonCode: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface DecideAvailabilityChangeInput {
  changeRequestId: string;
  decision: 'approved' | 'rejected';
  reasonCode: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface AvailabilityChangeRequestFilters {
  status?: 'pending' | 'approved' | 'rejected' | undefined;
  weekStart?: string | undefined;
  maidProfileId?: string | undefined;
}

export interface AvailabilityService {
  listCurrent(actor: Actor, weekStart: string, maidProfileId?: string): Promise<AvailabilityVersion[]>;
  listChangeRequests(
    actor: Actor,
    filters: AvailabilityChangeRequestFilters
  ): Promise<AvailabilityChangeRequest[]>;
  submit(actor: Actor, input: SubmitAvailabilityInput): Promise<AvailabilityVersion>;
  requestChange(
    actor: Actor,
    input: RequestAvailabilityChangeInput
  ): Promise<AvailabilityChangeRequest>;
  decideChange(
    actor: Actor,
    input: DecideAvailabilityChangeInput
  ): Promise<AvailabilityChangeRequest>;
  listCandidates(actor: Actor, workDate: string): Promise<AvailabilityCandidate[]>;
}

interface AvailabilityDayRow {
  work_date: string;
  available: boolean;
}

interface AvailabilityVersionRow {
  id: string;
  maid_profile_id: string;
  week_start: string;
  version: number;
  status: 'submitted' | 'superseded';
  is_current: boolean;
  submitted_at: string;
  availability_days?: AvailabilityDayRow[];
}

interface AvailabilityChangeRequestRow {
  id: string;
  availability_version_id: string;
  maid_profile_id: string;
  week_start: string;
  source_version: number;
  requested_available_dates: string[];
  reason_code: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason_code: string | null;
  approved_version_id: string | null;
}

const availabilityVersionColumns = [
  'id',
  'maid_profile_id',
  'week_start',
  'version',
  'status',
  'is_current',
  'submitted_at',
  'availability_days(work_date,available)'
].join(',');

const changeRequestColumns = [
  'id',
  'availability_version_id',
  'maid_profile_id',
  'week_start',
  'source_version',
  'requested_available_dates',
  'reason_code',
  'status',
  'requested_at',
  'decided_by',
  'decided_at',
  'decision_reason_code',
  'approved_version_id'
].join(',');

function ensureMaid(actor: Actor): void {
  if (actor.role !== 'maid') {
    throw new AppError(403, 'MAID_REQUIRED', '메이드 계정만 가능일을 제출할 수 있습니다.');
  }
}

function ensureAdmin(actor: Actor): void {
  if (actor.role !== 'admin') {
    throw new AppError(403, 'ADMIN_REQUIRED', '관리자만 가능일 변경을 결정할 수 있습니다.');
  }
}

function toAvailabilityVersion(row: AvailabilityVersionRow): AvailabilityVersion {
  return {
    id: row.id,
    maidProfileId: row.maid_profile_id,
    weekStart: row.week_start,
    version: row.version,
    status: row.status,
    current: row.is_current,
    submittedAt: row.submitted_at,
    days: [...(row.availability_days ?? [])]
      .sort((left, right) => left.work_date.localeCompare(right.work_date))
      .map((day) => ({ workDate: day.work_date, available: day.available }))
  };
}

function toChangeRequest(row: AvailabilityChangeRequestRow): AvailabilityChangeRequest {
  return {
    id: row.id,
    availabilityVersionId: row.availability_version_id,
    maidProfileId: row.maid_profile_id,
    weekStart: row.week_start,
    sourceVersion: row.source_version,
    requestedAvailableDates: row.requested_available_dates,
    reasonCode: row.reason_code,
    status: row.status,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionReasonCode: row.decision_reason_code,
    approvedVersionId: row.approved_version_id
  };
}

export function availabilityDatabaseError(
  error: { code?: string; message?: string } | null
): AppError {
  const message = error?.message ?? '';
  const mappings: Array<[string, number, string, string]> = [
    ['ACTIVE_MAID_REQUIRED', 403, 'ACTIVE_MAID_REQUIRED', '활성 메이드 계정만 가능일을 제출할 수 있습니다.'],
    ['ACTIVE_ADMIN_REQUIRED', 403, 'ACTIVE_ADMIN_REQUIRED', '활성 관리자만 변경 요청을 처리할 수 있습니다.'],
    ['OUTSIDE_AVAILABILITY_WINDOW', 409, 'OUTSIDE_AVAILABILITY_WINDOW', '가능일은 일요일 12:00–23:59 KST에 제출할 수 있습니다.'],
    ['CHANGE_REQUEST_BEFORE_DEADLINE', 409, 'CHANGE_REQUEST_BEFORE_DEADLINE', '제출 마감 전에는 새 version으로 다시 제출해 주세요.'],
    ['STALE_VERSION', 409, 'STALE_VERSION', '가능일 version이 변경되었습니다. 최신 상태를 다시 확인해 주세요.'],
    ['IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 요청에 사용한 Idempotency-Key입니다.'],
    ['PENDING_CHANGE_REQUEST_EXISTS', 409, 'PENDING_CHANGE_REQUEST_EXISTS', '처리 중인 가능일 변경 요청이 이미 있습니다.'],
    ['INVALID_TRANSITION', 409, 'INVALID_TRANSITION', '이미 처리된 변경 요청입니다.'],
    ['AVAILABILITY_NOT_FOUND', 404, 'AVAILABILITY_NOT_FOUND', '제출된 가능일을 찾을 수 없습니다.'],
    ['CHANGE_REQUEST_NOT_FOUND', 404, 'CHANGE_REQUEST_NOT_FOUND', '가능일 변경 요청을 찾을 수 없습니다.'],
    ['WEEK_START_MUST_BE_MONDAY', 400, 'WEEK_START_MUST_BE_MONDAY', 'weekStart는 월요일이어야 합니다.'],
    ['AVAILABILITY_DATES_MUST_BE_UNIQUE', 400, 'AVAILABILITY_DATES_MUST_BE_UNIQUE', '가능일은 중복 없이 입력해 주세요.'],
    ['AVAILABILITY_DATE_OUTSIDE_WEEK', 400, 'AVAILABILITY_DATE_OUTSIDE_WEEK', '가능일은 대상 주차의 월요일–일요일 범위여야 합니다.']
  ];
  for (const [needle, statusCode, code, userMessage] of mappings) {
    if (message.includes(needle)) {
      return new AppError(statusCode, code, userMessage);
    }
  }
  return new AppError(500, 'AVAILABILITY_COMMAND_FAILED', '가능일 변경을 완료하지 못했습니다.');
}

export class SupabaseAvailabilityService implements AvailabilityService {
  constructor(private readonly clients: SupabaseClients) {}

  async listCurrent(
    actor: Actor,
    weekStart: string,
    maidProfileId?: string
  ): Promise<AvailabilityVersion[]> {
    if (actor.role === 'maid' && maidProfileId && maidProfileId !== actor.profileId) {
      throw new AppError(403, 'FORBIDDEN', '다른 메이드의 가능일은 조회할 수 없습니다.');
    }
    const client = this.clients.forAccessToken(actor.accessToken);
    let query = client
      .from('availability_versions')
      .select(availabilityVersionColumns)
      .eq('week_start', weekStart)
      .eq('is_current', true)
      .order('maid_profile_id');

    if (actor.role === 'maid') {
      query = query.eq('maid_profile_id', actor.profileId);
    } else if (maidProfileId) {
      query = query.eq('maid_profile_id', maidProfileId);
    }

    const { data, error } = await query;
    if (error) {
      throw availabilityDatabaseError(error);
    }
    return (data as unknown as AvailabilityVersionRow[]).map(toAvailabilityVersion);
  }

  async submit(actor: Actor, input: SubmitAvailabilityInput): Promise<AvailabilityVersion> {
    ensureMaid(actor);
    const { data, error } = await this.clients.admin.rpc('submit_weekly_availability', {
      p_actor_profile_id: actor.profileId,
      p_week_start: input.weekStart,
      p_available_dates: input.availableDates,
      p_expected_version: input.expectedVersion,
      p_idempotency_key: input.idempotencyKey
    });
    if (error || !data) {
      throw availabilityDatabaseError(error);
    }
    return this.getVersionById((data as AvailabilityVersionRow).id);
  }

  async listChangeRequests(
    actor: Actor,
    filters: AvailabilityChangeRequestFilters
  ): Promise<AvailabilityChangeRequest[]> {
    if (actor.role === 'maid' && filters.maidProfileId && filters.maidProfileId !== actor.profileId) {
      throw new AppError(403, 'FORBIDDEN', '다른 메이드의 가능일 변경 요청은 조회할 수 없습니다.');
    }
    const client = this.clients.forAccessToken(actor.accessToken);
    let query = client
      .from('availability_change_requests')
      .select(changeRequestColumns)
      .order('requested_at', { ascending: false });

    if (actor.role === 'maid') {
      query = query.eq('maid_profile_id', actor.profileId);
    } else if (filters.maidProfileId) {
      query = query.eq('maid_profile_id', filters.maidProfileId);
    }
    if (filters.status) {
      query = query.eq('status', filters.status);
    }
    if (filters.weekStart) {
      query = query.eq('week_start', filters.weekStart);
    }

    const { data, error } = await query;
    if (error) {
      throw availabilityDatabaseError(error);
    }
    return (data as unknown as AvailabilityChangeRequestRow[]).map(toChangeRequest);
  }

  async requestChange(
    actor: Actor,
    input: RequestAvailabilityChangeInput
  ): Promise<AvailabilityChangeRequest> {
    ensureMaid(actor);
    const { data, error } = await this.clients.admin.rpc('request_availability_change', {
      p_actor_profile_id: actor.profileId,
      p_week_start: input.weekStart,
      p_requested_available_dates: input.requestedAvailableDates,
      p_reason_code: input.reasonCode,
      p_expected_version: input.expectedVersion,
      p_idempotency_key: input.idempotencyKey
    });
    if (error || !data) {
      throw availabilityDatabaseError(error);
    }
    return toChangeRequest(data as AvailabilityChangeRequestRow);
  }

  async decideChange(
    actor: Actor,
    input: DecideAvailabilityChangeInput
  ): Promise<AvailabilityChangeRequest> {
    ensureAdmin(actor);
    const { data, error } = await this.clients.admin.rpc('decide_availability_change', {
      p_actor_profile_id: actor.profileId,
      p_change_request_id: input.changeRequestId,
      p_decision: input.decision,
      p_reason_code: input.reasonCode,
      p_expected_version: input.expectedVersion,
      p_idempotency_key: input.idempotencyKey
    });
    if (error || !data) {
      throw availabilityDatabaseError(error);
    }
    return toChangeRequest(data as AvailabilityChangeRequestRow);
  }

  async listCandidates(actor: Actor, workDate: string): Promise<AvailabilityCandidate[]> {
    ensureAdmin(actor);
    const client = this.clients.forAccessToken(actor.accessToken);
    const { data, error } = await client
      .from('availability_candidates')
      .select('work_date,week_start,availability_version,maid_profile_id,display_name')
      .eq('work_date', workDate)
      .order('display_name');
    if (error) {
      throw availabilityDatabaseError(error);
    }
    return (data ?? []).map((row) => ({
      workDate: row.work_date,
      weekStart: row.week_start,
      availabilityVersion: row.availability_version,
      maidProfileId: row.maid_profile_id,
      displayName: row.display_name
    })) as AvailabilityCandidate[];
  }

  private async getVersionById(versionId: string): Promise<AvailabilityVersion> {
    const { data, error } = await this.clients.admin
      .from('availability_versions')
      .select(availabilityVersionColumns)
      .eq('id', versionId)
      .single();
    if (error || !data) {
      throw availabilityDatabaseError(error);
    }
    return toAvailabilityVersion(data as unknown as AvailabilityVersionRow);
  }
}
