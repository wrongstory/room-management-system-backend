import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';

export interface CleaningHistoryInput {
  date: string;
  maidProfileId?: string | undefined;
  query?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface CleaningHistoryService {
  list(actor: Actor, input: CleaningHistoryInput): Promise<unknown>;
}

interface CursorValue {
  fieldCompletedAt: string;
  attemptId: string;
  scope: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function sessionId(actor: Actor): string {
  try {
    const encoded = actor.accessToken.split('.')[1] ?? '';
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { session_id?: unknown };
    if (typeof claims.session_id !== 'string' || !uuidPattern.test(claims.session_id)) throw new Error();
    return claims.session_id.toLowerCase();
  } catch {
    throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.');
  }
}

function scope(actor: Actor, input: CleaningHistoryInput): string {
  return [actor.profileId.toLowerCase(), input.date, input.maidProfileId?.toLowerCase() ?? '', input.query ?? ''].join('|');
}

function decodeCursor(value: string | undefined, expectedScope: string): CursorValue | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof parsed.fieldCompletedAt !== 'string' || !timePattern.test(parsed.fieldCompletedAt) ||
      !Number.isFinite(Date.parse(parsed.fieldCompletedAt)) ||
      typeof parsed.attemptId !== 'string' || !uuidPattern.test(parsed.attemptId) ||
      parsed.scope !== expectedScope
    ) throw new Error();
    return {
      fieldCompletedAt: parsed.fieldCompletedAt,
      attemptId: parsed.attemptId.toLowerCase(),
      scope: expectedScope
    };
  } catch {
    throw new AppError(400, 'INVALID_CLEANING_HISTORY_CURSOR', '청소 이력 cursor가 올바르지 않습니다.');
  }
}

function encodeCursor(value: unknown, cursorScope: string): string | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw databaseError(null);
  const row = value as Record<string, unknown>;
  if (
    typeof row.fieldCompletedAt !== 'string' || !timePattern.test(row.fieldCompletedAt) ||
    typeof row.attemptId !== 'string' || !uuidPattern.test(row.attemptId)
  ) throw databaseError(null);
  return Buffer.from(JSON.stringify({
    fieldCompletedAt: row.fieldCompletedAt,
    attemptId: row.attemptId.toLowerCase(),
    scope: cursorScope
  })).toString('base64url');
}

function databaseError(error: { message?: string } | null): AppError {
  const code = error?.message;
  if (code === 'CLEANING_HISTORY_MAID_SCOPE_REQUIRED') {
    return new AppError(403, code, '메이드는 본인 청소 이력만 조회할 수 있습니다.');
  }
  if (code === 'CLEANING_HISTORY_ACCESS_REQUIRED' || code === 'ACTIVE_SESSION_REQUIRED') {
    return new AppError(403, code, '청소 이력 조회 권한이 필요합니다.');
  }
  if (code === 'INVALID_CLEANING_HISTORY_QUERY') {
    return new AppError(400, code, '청소 이력 조회 조건이 올바르지 않습니다.');
  }
  return new AppError(500, 'CLEANING_HISTORY_QUERY_FAILED', '청소 이력을 조회하지 못했습니다.');
}

export class SupabaseCleaningHistoryService implements CleaningHistoryService {
  constructor(private readonly clients: SupabaseClients) {}

  async list(actor: Actor, input: CleaningHistoryInput): Promise<unknown> {
    if (actor.role !== 'admin' && actor.role !== 'maid') {
      throw new AppError(403, 'CLEANING_HISTORY_ACCESS_REQUIRED', '청소 이력 조회 권한이 필요합니다.');
    }
    const cursorScope = scope(actor, input);
    const cursor = decodeCursor(input.cursor, cursorScope);
    const { data, error } = await this.clients.admin.rpc('list_cleaning_history', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId(actor),
      p_date: input.date,
      p_maid_profile_id: input.maidProfileId ?? null,
      p_query: input.query ?? null,
      p_limit: input.limit ?? 50,
      p_cursor_field_completed_at: cursor?.fieldCompletedAt ?? null,
      p_cursor_attempt_id: cursor?.attemptId ?? null
    });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) throw databaseError(error);
    const page = data as Record<string, unknown>;
    if (!Array.isArray(page.items)) throw databaseError(null);
    return { ...page, nextCursor: encodeCursor(page.nextCursor, cursorScope) };
  }
}
