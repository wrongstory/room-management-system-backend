import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import { requestHash } from '../../lib/command.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import { z } from 'zod';

export type CheckoutRoomTypeCode = 'standard' | 'premium' | 'oceanPremium' | 'oceanFamily';

export interface CleaningTemplateSlot {
  slotKey: string;
  displayOrder: number;
  required: boolean;
  label: string;
  description?: string | undefined;
  section?: string | undefined;
  instanceKey?: string | undefined;
}

export interface PublishedCleaningTemplate {
  id: string;
  version: number;
  status: 'published';
  durationMinutes: number;
  slots: CleaningTemplateSlot[];
  publishedAt: string;
  createdAt: string;
}

export interface CleaningTemplateRoomType {
  roomTypeCode: CheckoutRoomTypeCode;
  roomTypeName: string;
  cleaningKind: 'checkout';
  configured: boolean;
  expectedVersion: number;
  currentPublished: PublishedCleaningTemplate | null;
}

export interface CheckoutCleaningTemplateCatalog {
  cleaningKind: 'checkout';
  roomTypes: CleaningTemplateRoomType[];
}

export interface PublishCheckoutCleaningTemplateInput {
  roomTypeCode: CheckoutRoomTypeCode;
  cleaningKind: 'checkout';
  expectedVersion: number;
  durationMinutes: number;
  slots: CleaningTemplateSlot[];
  idempotencyKey: string;
}

export interface CleaningTemplateService {
  listCheckout(actor: Actor): Promise<CheckoutCleaningTemplateCatalog>;
  publishCheckout(
    actor: Actor,
    input: PublishCheckoutCleaningTemplateInput
  ): Promise<PublishedCleaningTemplate>;
}

const roomTypeCodeSchema = z.enum(['standard', 'premium', 'oceanPremium', 'oceanFamily']);
const expectedSlotCounts: Record<CheckoutRoomTypeCode, number> = {
  standard: 10,
  premium: 11,
  oceanPremium: 13,
  oceanFamily: 15
};
const slotSchema = z.object({
  slotKey: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  displayOrder: z.number().int().min(0).max(99),
  required: z.boolean(),
  label: z.string().min(1).max(80),
  description: z.string().min(1).max(200).optional(),
  section: z.string().min(1).max(80).optional(),
  instanceKey: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/).optional()
}).strict();
const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isStrictRfc3339(value: string): boolean {
  const match = timestampPattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) && hour <= 23 && minute <= 59 &&
    second <= 59 && offsetHour <= 23 && offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value));
}

const timestampSchema = z.string().refine(isStrictRfc3339);
const publishedTemplateSchema = z.object({
  id: z.uuid(),
  version: z.number().int().min(7).max(2_147_483_647),
  status: z.literal('published'),
  durationMinutes: z.number().int().min(1).max(10_080),
  slots: z.array(slotSchema).min(10).max(15),
  publishedAt: timestampSchema,
  createdAt: timestampSchema
}).strict().superRefine((template, context) => {
  if (![10, 11, 13, 15].includes(template.slots.length) ||
    template.slots.some((slot, index) => slot.displayOrder !== index ||
      slot.label.trim() !== slot.label || slot.description?.trim() !== slot.description ||
      slot.section?.trim() !== slot.section) ||
    new Set(template.slots.map((slot) => slot.slotKey)).size !== template.slots.length ||
    template.slots.filter((slot) => slot.required).length !== template.slots.length - 1 ||
    template.slots.filter((slot) => slot.slotKey === 'tv-on' && slot.required).length !== 1) {
    context.addIssue({ code: 'custom', message: 'invalid published template slots' });
  }
});
const roomTypeSchema = z.object({
  roomTypeCode: roomTypeCodeSchema,
  roomTypeName: z.string().min(1),
  cleaningKind: z.literal('checkout'),
  configured: z.boolean(),
  expectedVersion: z.number().int().min(0).max(2_147_483_647),
  currentPublished: publishedTemplateSchema.nullable()
}).strict().superRefine((room, context) => {
  if (room.configured !== (room.currentPublished !== null) ||
    room.expectedVersion !== (room.currentPublished?.version ?? 0) ||
    (room.currentPublished !== null &&
      room.currentPublished.slots.length !== expectedSlotCounts[room.roomTypeCode])) {
    context.addIssue({ code: 'custom', message: 'inconsistent template projection' });
  }
});
const catalogSchema = z.object({
  cleaningKind: z.literal('checkout'),
  roomTypes: z.array(roomTypeSchema).length(4)
}).strict().superRefine((catalog, context) => {
  const expected = roomTypeCodeSchema.options;
  if (catalog.roomTypes.some((room, index) => room.roomTypeCode !== expected[index])) {
    context.addIssue({ code: 'custom', message: 'invalid room type catalog order' });
  }
});

function parseDatabaseResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw templateError(null);
  return result.data;
}

function parsePublishedTemplate(
  data: unknown,
  roomTypeCode: CheckoutRoomTypeCode
): PublishedCleaningTemplate {
  const template = parseDatabaseResponse(publishedTemplateSchema, data);
  if (template.slots.length !== expectedSlotCounts[roomTypeCode]) throw templateError(null);
  return template;
}

function ensureAdmin(actor: Actor): void {
  if (actor.role !== 'admin') {
    throw new AppError(403, 'ADMIN_REQUIRED', '관리자만 청소 템플릿을 관리할 수 있습니다.');
  }
}

function sessionId(accessToken: string): string {
  try {
    const encoded = accessToken.split('.')[1];
    if (!encoded) throw new Error('missing JWT payload');
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      session_id?: unknown;
    };
    if (
      typeof claims.session_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        claims.session_id
      )
    ) {
      throw new Error('invalid session id');
    }
    return claims.session_id;
  } catch {
    throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.');
  }
}

function templateError(error: { message?: string } | null): AppError {
  const code = error?.message ?? '';
  if (code === 'SESSION_REVOKED') {
    return new AppError(401, code, '로그인이 만료되었습니다. 다시 로그인해 주세요.');
  }
  if (['ADMIN_REQUIRED', 'ACTIVE_ACCOUNT_REQUIRED', 'PASSWORD_CHANGE_REQUIRED'].includes(code)) {
    return new AppError(403, code, '현재 계정으로 청소 템플릿을 관리할 수 없습니다.');
  }
  if (
    ['INVALID_CLEANING_TEMPLATE', 'INVALID_CLEANING_TEMPLATE_SLOTS'].includes(code)
  ) {
    return new AppError(400, code, '청소 템플릿 입력값과 사진 슬롯을 확인해 주세요.');
  }
  if (
    ['CLEANING_TEMPLATE_VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_KEY_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(code)
  ) {
    return new AppError(409, code, '최신 템플릿을 다시 확인한 뒤 요청해 주세요.');
  }
  return new AppError(500, 'CLEANING_TEMPLATE_COMMAND_FAILED', '청소 템플릿 요청을 완료하지 못했습니다.');
}

function normalizedSlots(slots: CleaningTemplateSlot[]): CleaningTemplateSlot[] {
  return [...slots]
    .sort((left, right) => left.displayOrder - right.displayOrder || left.slotKey.localeCompare(right.slotKey))
    .map((slot) => ({
      slotKey: slot.slotKey,
      displayOrder: slot.displayOrder,
      required: slot.required,
      label: slot.label,
      ...(slot.description !== undefined ? { description: slot.description } : {}),
      ...(slot.section !== undefined ? { section: slot.section } : {}),
      ...(slot.instanceKey !== undefined ? { instanceKey: slot.instanceKey } : {})
    }));
}

export class SupabaseCleaningTemplateService implements CleaningTemplateService {
  constructor(private readonly clients: SupabaseClients) {}

  async listCheckout(actor: Actor): Promise<CheckoutCleaningTemplateCatalog> {
    ensureAdmin(actor);
    const { data, error } = await this.clients.admin.rpc('list_checkout_cleaning_templates', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId(actor.accessToken)
    });
    if (error || !data) throw templateError(error);
    return parseDatabaseResponse(catalogSchema, data);
  }

  async publishCheckout(
    actor: Actor,
    input: PublishCheckoutCleaningTemplateInput
  ): Promise<PublishedCleaningTemplate> {
    ensureAdmin(actor);
    const slots = normalizedSlots(input.slots);
    const fingerprint = {
      command: 'cleaning_template.publish_checkout',
      roomTypeCode: input.roomTypeCode,
      cleaningKind: input.cleaningKind,
      expectedVersion: input.expectedVersion,
      durationMinutes: input.durationMinutes,
      slots
    };
    const { data, error } = await this.clients.admin.rpc('publish_checkout_cleaning_template', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId(actor.accessToken),
      p_room_type_code: input.roomTypeCode,
      p_expected_version: input.expectedVersion,
      p_duration_minutes: input.durationMinutes,
      p_slots: slots,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) throw templateError(error);
    return parsePublishedTemplate(data, input.roomTypeCode);
  }
}
