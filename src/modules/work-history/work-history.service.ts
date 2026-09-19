import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';

export interface WorkHistoryInput {
  weekStart: string;
  maidProfileId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface WorkHistoryService {
  list(actor: Actor, input: WorkHistoryInput): Promise<unknown>;
}

interface CursorValue {
  maidProfileId: string;
  scope: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function cursorScope(actor: Actor, input: WorkHistoryInput): string {
  return [actor.profileId.toLowerCase(), input.weekStart, input.maidProfileId?.toLowerCase() ?? ''].join('|');
}

function decodeCursor(value: string | undefined, expectedScope: string): CursorValue | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.maidProfileId !== 'string' || !uuidPattern.test(parsed.maidProfileId) || parsed.scope !== expectedScope) {
      throw new Error();
    }
    return { maidProfileId: parsed.maidProfileId.toLowerCase(), scope: expectedScope };
  } catch {
    throw new AppError(400, 'INVALID_WORK_HISTORY_CURSOR', '업무 기록 cursor가 올바르지 않습니다.');
  }
}

function encodeCursor(value: unknown, scope: string): string | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw databaseError(null);
  const maidProfileId = (value as Record<string, unknown>).maidProfileId;
  if (typeof maidProfileId !== 'string' || !uuidPattern.test(maidProfileId)) throw databaseError(null);
  return Buffer.from(JSON.stringify({ maidProfileId: maidProfileId.toLowerCase(), scope })).toString('base64url');
}

function databaseError(error: { message?: string } | null): AppError {
  const code = error?.message;
  if (code === 'WORK_HISTORY_MAID_SCOPE_REQUIRED') {
    return new AppError(403, code, '메이드는 본인 업무 기록만 조회할 수 있습니다.');
  }
  if (code === 'WORK_HISTORY_ACCESS_REQUIRED' || code === 'ACTIVE_SESSION_REQUIRED') {
    return new AppError(403, code, '업무 기록 조회 권한이 필요합니다.');
  }
  if (code === 'INVALID_WORK_HISTORY_QUERY' || code === 'WORK_HISTORY_MAID_NOT_FOUND') {
    return new AppError(400, code, '업무 기록 조회 조건이 올바르지 않습니다.');
  }
  return new AppError(500, 'WORK_HISTORY_QUERY_FAILED', '업무 기록을 조회하지 못했습니다.');
}

export class SupabaseWorkHistoryService implements WorkHistoryService {
  constructor(private readonly clients: SupabaseClients) {}

  async list(actor: Actor, input: WorkHistoryInput): Promise<unknown> {
    if (actor.role !== 'admin' && actor.role !== 'maid') {
      throw new AppError(403, 'WORK_HISTORY_ACCESS_REQUIRED', '업무 기록 조회 권한이 필요합니다.');
    }
    const scope = cursorScope(actor, input);
    const cursor = decodeCursor(input.cursor, scope);
    const { data, error } = await this.clients.admin.rpc('list_work_history', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId(actor),
      p_week_start: input.weekStart,
      p_maid_profile_id: input.maidProfileId ?? null,
      p_limit: input.limit ?? 50,
      p_cursor_maid_profile_id: cursor?.maidProfileId ?? null
    });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) throw databaseError(error);
    const page = data as Record<string, unknown>;
    if (!Array.isArray(page.items) || !page.summary || typeof page.summary !== 'object') throw databaseError(null);
    return { ...page, nextCursor: encodeCursor(page.nextCursor, scope) };
  }
}
