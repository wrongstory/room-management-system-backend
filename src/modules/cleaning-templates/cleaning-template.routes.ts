import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CleaningTemplateService } from './cleaning-template.service.js';

const roomTypeCodeSchema = z.enum(['standard', 'premium', 'oceanPremium', 'oceanFamily']);
const slotKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const slotSchema = z.object({
  slotKey: slotKeySchema,
  displayOrder: z.number().int().min(0).max(99),
  required: z.boolean(),
  label: boundedText(80),
  description: boundedText(200).optional(),
  section: boundedText(80).optional(),
  instanceKey: slotKeySchema.optional()
}).strict();
const listQuerySchema = z.object({ cleaningKind: z.literal('checkout') }).strict();
const publishSchema = z.object({
  roomTypeCode: roomTypeCodeSchema,
  cleaningKind: z.literal('checkout'),
  expectedVersion: z.number().int().min(0).max(2_147_483_647),
  durationMinutes: z.number().int().positive().max(10_080).nullable().optional(),
  slots: z.array(slotSchema).min(1).max(100)
}).strict().superRefine((input, context) => {
  const keys = new Set<string>();
  const orders = new Set<number>();
  for (const slot of input.slots) {
    if (keys.has(slot.slotKey)) {
      context.addIssue({ code: 'custom', path: ['slots'], message: 'slotKey가 중복되었습니다.' });
    }
    if (orders.has(slot.displayOrder)) {
      context.addIssue({ code: 'custom', path: ['slots'], message: 'displayOrder가 중복되었습니다.' });
    }
    keys.add(slot.slotKey);
    orders.add(slot.displayOrder);
  }
  if (orders.size > 0 && (Math.min(...orders) !== 0 || Math.max(...orders) !== orders.size - 1)) {
    context.addIssue({ code: 'custom', path: ['slots'], message: 'displayOrder는 0부터 연속이어야 합니다.' });
  }
  const expectedCount = { standard: 10, premium: 11, oceanPremium: 13, oceanFamily: 15 }[
    input.roomTypeCode
  ];
  if (input.slots.length !== expectedCount) {
    context.addIssue({ code: 'custom', path: ['slots'], message: '객실 유형별 슬롯 수가 올바르지 않습니다.' });
  }
  if (input.slots.filter((slot) => slot.required).length !== expectedCount - 1) {
    context.addIssue({ code: 'custom', path: ['slots'], message: '필수 슬롯 수가 올바르지 않습니다.' });
  }
  if (input.slots.filter((slot) => slot.slotKey === 'tv-on' && slot.required).length !== 1) {
    context.addIssue({ code: 'custom', path: ['slots'], message: '필수 tv-on 슬롯이 정확히 하나 필요합니다.' });
  }
});

function idempotencyKey(request: FastifyRequest): string {
  return z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/)
    .parse(request.headers['idempotency-key']);
}

export function createCleaningTemplateRoutes(service: CleaningTemplateService): FastifyPluginAsync {
  return async (app) => {
    const adminPreHandler = [app.authenticate, app.requirePasswordChanged, app.requireAdmin];
    app.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    app.get('/', { preHandler: adminPreHandler }, async (request) => {
      listQuerySchema.parse(request.query);
      return { templates: await service.listCheckout(request.actor) };
    });

    app.post('/', { preHandler: adminPreHandler }, async (request, reply) => {
      const input = publishSchema.parse(request.body);
      const template = await service.publishCheckout(request.actor, {
        ...input,
        durationMinutes: input.durationMinutes ?? null,
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send({ template });
    });
  };
}
