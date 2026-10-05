import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';

export const CHECKOUT_INCIDENT_PAGE_DEFAULT = 50;
export const CHECKOUT_INCIDENT_PAGE_MAX = 100;
export const CHECKOUT_INCIDENT_CURSOR_MAX_LENGTH = 1024;
export const CHECKOUT_INCIDENT_RESPONSE_MAX_BYTES = 128 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decisions = ['EXTEND_CHECKOUT', 'CONFIRM_DEPARTED', 'FALSE_REPORT'] as const;

export interface CheckoutIncidentListInput {
  roomId?: string | null | undefined;
  cleaningTargetId?: string | null | undefined;
  serviceDate?: string | null | undefined;
  limit?: number | undefined;
  cursor?: string | null | undefined;
}
export interface CheckoutIncidentListFilters {
  roomId: string | null;
  cleaningTargetId: string | null;
  serviceDate: string | null;
}
export interface CheckoutIncidentListQuery extends CheckoutIncidentListFilters {
  limit: number;
  cursor: string | null;
}
export interface CheckoutIncidentCursorScope extends CheckoutIncidentListFilters {
  actorProfileId: string;
  actorRole: 'admin';
  stream: 'checkout_presence_open';
  status: 'open';
  sort: 'reported_at_desc_id_desc';
}
export interface CheckoutIncidentCursorPosition {
  reportedAt: string;
  id: string;
}
export interface CheckoutIncidentListItem {
  incidentId: string;
  status: 'open';
  roomId: string;
  roomNumber: string;
  cleaningTargetId: string;
  assignmentId: string;
  attemptId: string;
  reportedAt: string;
  serviceDate: string;
  allowedDecisions: Array<(typeof decisions)[number]>;
}
export interface CheckoutIncidentListPage {
  items: CheckoutIncidentListItem[];
  nextCursor: string | null;
}

export function checkoutIncidentListValidationError(): AppError {
  return new AppError(400, 'VALIDATION_ERROR', '퇴실 미진행 사건 목록 조회 조건을 확인해 주세요.');
}
export function checkoutIncidentListProjectionError(): AppError {
  return new AppError(500, 'CHECKOUT_INCIDENT_COMMAND_FAILED', '퇴실 미진행 사건을 처리하지 못했습니다.');
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}
export function isCheckoutIncidentListDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}
export function isCheckoutIncidentListTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
    && isCheckoutIncidentListDate(value.slice(0, 10))
    && Number(value.slice(11, 13)) <= 23 && Number(value.slice(14, 16)) <= 59
    && Number(value.slice(17, 19)) <= 59;
}
function optionalUuid(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw checkoutIncidentListValidationError();
  return value.toLowerCase();
}
export function normalizeCheckoutIncidentListInput(input: CheckoutIncidentListInput): CheckoutIncidentListQuery {
  const row = record(input);
  if (!row || Object.keys(row).some((key) => !['roomId', 'cleaningTargetId', 'serviceDate', 'limit', 'cursor'].includes(key))) {
    throw checkoutIncidentListValidationError();
  }
  const limit = input.limit ?? CHECKOUT_INCIDENT_PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHECKOUT_INCIDENT_PAGE_MAX
    || (input.serviceDate != null && !isCheckoutIncidentListDate(input.serviceDate))
    || (input.cursor != null && (typeof input.cursor !== 'string' || !input.cursor
      || input.cursor.length > CHECKOUT_INCIDENT_CURSOR_MAX_LENGTH))) throw checkoutIncidentListValidationError();
  return { roomId: optionalUuid(input.roomId), cleaningTargetId: optionalUuid(input.cleaningTargetId),
    serviceDate: input.serviceDate ?? null, limit, cursor: input.cursor ?? null };
}
export function checkoutIncidentListQuery(params: URLSearchParams): CheckoutIncidentListQuery {
  const input: CheckoutIncidentListInput = {};
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (!['roomId', 'cleaningTargetId', 'serviceDate', 'limit', 'cursor'].includes(key) || seen.has(key) || !value) {
      throw checkoutIncidentListValidationError();
    }
    seen.add(key);
    if (key === 'limit') {
      if (!/^(?:[1-9]\d?|100)$/.test(value)) throw checkoutIncidentListValidationError();
      input.limit = Number(value);
    } else if (key === 'roomId') input.roomId = value;
    else if (key === 'cleaningTargetId') input.cleaningTargetId = value;
    else if (key === 'serviceDate') input.serviceDate = value;
    else input.cursor = value;
  }
  return normalizeCheckoutIncidentListInput(input);
}
export function checkoutIncidentCursorScope(
  actor: Pick<Actor, 'profileId' | 'role'>,
  filters: CheckoutIncidentListFilters
): CheckoutIncidentCursorScope {
  if (actor.role !== 'admin' || !uuidPattern.test(actor.profileId)) throw checkoutIncidentListValidationError();
  return { actorProfileId: actor.profileId.toLowerCase(), actorRole: 'admin', stream: 'checkout_presence_open',
    status: 'open', sort: 'reported_at_desc_id_desc', roomId: filters.roomId,
    cleaningTargetId: filters.cleaningTargetId, serviceDate: filters.serviceDate };
}
function validPosition(value: unknown): value is CheckoutIncidentCursorPosition {
  const row = record(value);
  return row !== null && exactKeys(row, ['reportedAt', 'id']) && isCheckoutIncidentListTimestamp(row.reportedAt)
    && typeof row.id === 'string' && uuidPattern.test(row.id) && row.id === row.id.toLowerCase();
}
export class CheckoutIncidentCursorCodec {
  private readonly secret: Buffer;
  constructor(secret: string | undefined) {
    if (typeof secret !== 'string' || secret.trim() !== secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw checkoutIncidentListProjectionError();
    }
    this.secret = Buffer.from(secret, 'utf8');
  }
  encode(scope: CheckoutIncidentCursorScope, after: CheckoutIncidentCursorPosition): string {
    if (!validPosition(after)) throw checkoutIncidentListProjectionError();
    const payload = Buffer.from(JSON.stringify({ v: 1, scope, after }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secret).update(payload, 'ascii').digest('base64url');
    const cursor = `${payload}.${signature}`;
    if (cursor.length > CHECKOUT_INCIDENT_CURSOR_MAX_LENGTH) throw checkoutIncidentListProjectionError();
    return cursor;
  }
  decode(cursor: string, expectedScope: CheckoutIncidentCursorScope): CheckoutIncidentCursorPosition {
    if (!cursor || cursor.length > CHECKOUT_INCIDENT_CURSOR_MAX_LENGTH) throw checkoutIncidentListValidationError();
    const parts = cursor.split('.');
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw checkoutIncidentListValidationError();
    const [payload = '', signatureEncoded = ''] = parts;
    const payloadBytes = Buffer.from(payload, 'base64url');
    const signature = Buffer.from(signatureEncoded, 'base64url');
    if (payloadBytes.toString('base64url') !== payload || signature.toString('base64url') !== signatureEncoded
      || signature.byteLength !== 32) throw checkoutIncidentListValidationError();
    const expectedSignature = createHmac('sha256', this.secret).update(payload, 'ascii').digest();
    if (!timingSafeEqual(signature, expectedSignature)) throw checkoutIncidentListValidationError();
    try {
      const parsed = record(JSON.parse(payloadBytes.toString('utf8')));
      const scope = record(parsed?.scope);
      if (!parsed || !exactKeys(parsed, ['v', 'scope', 'after']) || parsed.v !== 1 || !scope
        || !exactKeys(scope, ['actorProfileId', 'actorRole', 'stream', 'status', 'sort', 'roomId', 'cleaningTargetId', 'serviceDate'])
        || Object.keys(expectedScope).some((key) => scope[key] !== expectedScope[key as keyof CheckoutIncidentCursorScope])
        || !validPosition(parsed.after)) throw checkoutIncidentListValidationError();
      return { reportedAt: parsed.after.reportedAt, id: parsed.after.id };
    } catch { throw checkoutIncidentListValidationError(); }
  }
}
export function assertCheckoutIncidentListResponseSize(value: unknown): void {
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= CHECKOUT_INCIDENT_RESPONSE_MAX_BYTES) return;
  } catch { /* Malformed transport data is never returned. */ }
  throw checkoutIncidentListProjectionError();
}
function descendingAfter(row: CheckoutIncidentCursorPosition, previous: CheckoutIncidentCursorPosition): boolean {
  return row.reportedAt < previous.reportedAt || (row.reportedAt === previous.reportedAt && row.id < previous.id);
}
export function checkoutIncidentListProjection(
  value: unknown, query: CheckoutIncidentListQuery, after: CheckoutIncidentCursorPosition | null
): CheckoutIncidentListItem[] {
  assertCheckoutIncidentListResponseSize(value);
  const page = record(value);
  if (!page || !exactKeys(page, ['items']) || !Array.isArray(page.items) || page.items.length > query.limit + 1) {
    throw checkoutIncidentListProjectionError();
  }
  const ids = new Set<string>();
  let previous = after;
  return page.items.map((value) => {
    const row = record(value);
    const allowedDecisions = row?.allowedDecisions;
    if (!row || !exactKeys(row, ['incidentId', 'status', 'roomId', 'roomNumber', 'cleaningTargetId', 'assignmentId',
      'attemptId', 'reportedAt', 'serviceDate', 'allowedDecisions']) || row.status !== 'open'
      || typeof row.roomNumber !== 'string' || !row.roomNumber.trim() || !isCheckoutIncidentListTimestamp(row.reportedAt)
      || !isCheckoutIncidentListDate(row.serviceDate) || !Array.isArray(allowedDecisions)
      || allowedDecisions.length !== decisions.length || decisions.some((item, index) => allowedDecisions[index] !== item)) {
      throw checkoutIncidentListProjectionError();
    }
    const keys = ['incidentId', 'roomId', 'cleaningTargetId', 'assignmentId', 'attemptId'] as const;
    const projectedIds = Object.fromEntries(keys.map((key) => {
      const id = row[key];
      if (typeof id !== 'string' || !uuidPattern.test(id)) throw checkoutIncidentListProjectionError();
      return [key, id.toLowerCase()];
    })) as Record<(typeof keys)[number], string>;
    const position = { reportedAt: row.reportedAt, id: projectedIds.incidentId };
    if (ids.has(position.id) || (previous !== null && !descendingAfter(position, previous))
      || (query.roomId !== null && projectedIds.roomId !== query.roomId)
      || (query.cleaningTargetId !== null && projectedIds.cleaningTargetId !== query.cleaningTargetId)
      || (query.serviceDate !== null && row.serviceDate !== query.serviceDate)) throw checkoutIncidentListProjectionError();
    ids.add(position.id);
    previous = position;
    return { ...projectedIds, status: 'open', roomNumber: row.roomNumber, reportedAt: row.reportedAt,
      serviceDate: row.serviceDate, allowedDecisions: [...decisions] };
  });
}
