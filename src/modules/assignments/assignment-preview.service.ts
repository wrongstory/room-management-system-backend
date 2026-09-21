import { randomUUID } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import {
  AssignmentPreviewError,
  optimizeAssignmentPreview,
  type AssignmentPreviewResult
} from './assignment-preview-core.js';

export interface AssignmentPreviewInput {
  serviceDate: string;
  previewSeed?: string | undefined;
}

export interface AssignmentDurationPolicy {
  id: unknown;
  version: unknown;
  status: unknown;
  standardMinutes: unknown;
  premiumMinutes: unknown;
  oceanPremiumMinutes: unknown;
  oceanFamilyMinutes: unknown;
  createdAt: unknown;
  confirmedAt: unknown;
}

export interface AssignmentPreviewService {
  preview(actor: Actor, input: AssignmentPreviewInput): Promise<AssignmentPreviewResult>;
  durationPolicy(actor: Actor): Promise<AssignmentDurationPolicy | null>;
}

function previewError(error: { message?: string } | null): AppError {
  const code = error?.message ?? '';
  const statuses: Readonly<Record<string, number>> = {
    ADMIN_REQUIRED: 403,
    PROFILE_INACTIVE: 403,
    PASSWORD_CHANGE_REQUIRED: 403,
    ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED: 400,
    INVALID_ASSIGNMENT_DURATION_POLICY: 400,
    ASSIGNMENT_DURATION_POLICY_RETIRED: 410,
    ASSIGNMENT_DURATION_POLICY_VERSION_CONFLICT: 409,
    IDEMPOTENCY_KEY_CONFLICT: 409,
    IDEMPOTENCY_CONFLICT: 409,
    IDEMPOTENCY_KEY_REUSED: 409,
    ACTIVE_ACCOUNT_REQUIRED: 403,
    ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED: 422
  };
  const status = statuses[code];
  return status === undefined
    ? new AppError(500, 'ASSIGNMENT_PREVIEW_FAILED', '배정 미리보기를 처리하지 못했습니다.')
    : new AppError(status, code, '배정 미리보기 조건 또는 확정 설정을 확인해 주세요.');
}

export function previewServiceDate(value: string, now = new Date()): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  const today = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 33 * 3_600_000).toISOString().slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    (value !== today && value !== tomorrow)
  ) {
    throw previewError({ message: 'ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED' });
  }
  return value;
}

function durationProjection(value: unknown): AssignmentDurationPolicy | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw previewError(null);
  const row = value as Record<string, unknown>;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    standardMinutes: row.standardMinutes,
    premiumMinutes: row.premiumMinutes,
    oceanPremiumMinutes: row.oceanPremiumMinutes,
    oceanFamilyMinutes: row.oceanFamilyMinutes,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt
  };
}

export class SupabaseAssignmentPreviewService implements AssignmentPreviewService {
  constructor(private readonly clients: SupabaseClients) {}

  async preview(actor: Actor, input: AssignmentPreviewInput): Promise<AssignmentPreviewResult> {
    const serviceDate = previewServiceDate(input.serviceDate);
    const previewSeed = input.previewSeed ?? randomUUID();
    const { data, error } = await this.clients.admin.rpc('get_assignment_preview_snapshot', {
      p_actor_profile_id: actor.profileId,
      p_service_date: serviceDate
    });
    if (error || !data) throw previewError(error);
    try {
      return await optimizeAssignmentPreview(data, previewSeed);
    } catch (error) {
      if (error instanceof AssignmentPreviewError) {
        throw previewError({ message: error.code });
      }
      throw previewError(null);
    }
  }

  async durationPolicy(actor: Actor): Promise<AssignmentDurationPolicy | null> {
    const { data, error } = await this.clients.admin.rpc('get_assignment_duration_policy', {
      p_actor_profile_id: actor.profileId
    });
    if (error) throw previewError(error);
    return durationProjection(data);
  }
}
