import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import {
  NOTIFICATION_PAGE_DEFAULT,
  NotificationCursorCodec,
  notificationCursorScope
} from './notification-cursor.js';

export interface NotificationListInput {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface NotificationService {
  list(actor: Actor, input: NotificationListInput): Promise<unknown>;
  markRead(actor: Actor, notificationId: string): Promise<unknown>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function databaseError(error: { message?: string } | null): AppError {
  const message = error?.message ?? '';
  const mappings: Array<[string, number, string, string]> = [
    ['NOTIFICATION_NOT_FOUND', 404, 'NOTIFICATION_NOT_FOUND', '알림을 찾을 수 없습니다.'],
    ['NOTIFICATION_ACCESS_REQUIRED', 403, 'NOTIFICATION_ACCESS_REQUIRED', '알림함 접근 권한이 필요합니다.'],
    ['NOTIFICATION_PAGE_LIMIT_INVALID', 400, 'VALIDATION_ERROR', 'limit을 확인해 주세요.'],
    ['INVALID_NOTIFICATION_CURSOR', 400, 'INVALID_NOTIFICATION_CURSOR', '알림 cursor가 올바르지 않습니다.']
  ];
  for (const [needle, status, code, korean] of mappings) {
    if (message.includes(needle)) return new AppError(status, code, korean);
  }
  return new AppError(500, 'NOTIFICATION_QUERY_FAILED', '알림 정보를 처리하지 못했습니다.');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw databaseError(null);
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw databaseError(null);
  return value;
}
function uuid(value: unknown): string {
  const parsed = text(value);
  if (!uuidPattern.test(parsed)) throw databaseError(null);
  return parsed.toLowerCase();
}
function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}
function timestamp(value: unknown): string {
  const parsed = text(value);
  if (!timestampPattern.test(parsed) || !Number.isFinite(Date.parse(parsed))) throw databaseError(null);
  return parsed;
}
function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw databaseError(null);
  return value;
}

export function notificationProjection(value: unknown): Record<string, unknown> {
  const row = object(value);
  return {
    id: uuid(row.id),
    category: text(row.category),
    title: text(row.title),
    body: text(row.body),
    roomId: nullableUuid(row.roomId),
    cleaningTargetId: nullableUuid(row.cleaningTargetId),
    requiresAction: boolean(row.requiresAction),
    readAt: nullableTimestamp(row.readAt),
    resolvedAt: nullableTimestamp(row.resolvedAt),
    occurredAt: timestamp(row.occurredAt)
  };
}

function sessionId(actor: Actor): string {
  try {
    const payload = actor.accessToken.split('.')[1];
    const value = payload
      ? (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { session_id?: unknown }).session_id
      : null;
    if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error('invalid session');
    return value.toLowerCase();
  } catch {
    throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.');
  }
}

function reader(actor: Actor): void {
  if (actor.role !== 'admin' && actor.role !== 'maid') {
    throw new AppError(403, 'NOTIFICATION_ACCESS_REQUIRED', '알림함 접근 권한이 필요합니다.');
  }
}

export class SupabaseNotificationService implements NotificationService {
  private readonly cursor: NotificationCursorCodec;

  constructor(private readonly clients: SupabaseClients, cursorSecret: string) {
    this.cursor = new NotificationCursorCodec(cursorSecret);
  }

  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.clients.admin.rpc(name, args);
    if (error || data === null) throw databaseError(error);
    return data;
  }

  async list(actor: Actor, input: NotificationListInput): Promise<unknown> {
    reader(actor);
    const scope = notificationCursorScope(actor);
    const after = input.cursor ? this.cursor.decode(input.cursor, scope) : null;
    const page = object(await this.rpc('list_notifications_page', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId(actor),
      p_after_occurred_at: after?.occurredAt ?? null,
      p_after_id: after?.id ?? null,
      p_limit: input.limit ?? NOTIFICATION_PAGE_DEFAULT
    }));
    if (!Array.isArray(page.notifications)) throw databaseError(null);
    const notifications = page.notifications.map(notificationProjection);
    const hasMore = boolean(page.hasMore);
    const lastOccurredAt = nullableTimestamp(page.lastOccurredAt);
    const lastId = nullableUuid(page.lastId);
    if (hasMore && (!lastOccurredAt || !lastId)) throw databaseError(null);
    return {
      notifications,
      nextCursor: hasMore
        ? this.cursor.encode(scope, { occurredAt: lastOccurredAt as string, id: lastId as string })
        : null
    };
  }

  async markRead(actor: Actor, notificationId: string): Promise<unknown> {
    reader(actor);
    return notificationProjection(await this.rpc('mark_notification_read', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId(actor),
      p_notification_id: notificationId
    }));
  }
}
