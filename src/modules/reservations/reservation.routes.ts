import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import { normalizeGuestName } from './guest-name-crypto.js';
import type { ReservationService } from './reservation.service.js';

const reservationIdSchema = z.object({ reservationId: z.uuid() });
const targetIdSchema = z.object({ targetId: z.uuid() });
const listQuerySchema = z.object({ roomId: z.uuid().optional() });
const timestampSchema = z.string().datetime({ offset: true });
const reasonCodeSchema = z.string().trim().min(2).max(80).regex(/^[A-Z0-9_]+$/);

const createSchema = z.object({
  roomId: z.uuid(),
  checkInAt: timestampSchema,
  checkOutAt: timestampSchema,
  guestCount: z.number().int().positive(),
  guestName: z.string().nullable().optional(),
  expectedRoomVersion: z.number().int().positive()
});

const changeSchema = z.object({
  roomId: z.uuid(),
  checkInAt: timestampSchema,
  checkOutAt: timestampSchema,
  guestCount: z.number().int().positive(),
  guestName: z.string().nullable().optional(),
  expectedVersion: z.number().int().positive(),
  reasonCode: reasonCodeSchema
});

const mutationSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reasonCode: reasonCodeSchema
});

const manualCleaningRequestSchema = z.object({
  roomId: z.uuid(),
  reservationId: z.uuid().nullable().optional(),
  cleaningKind: z.enum(['stayover', 'additional']),
  serviceDate: z.iso.date(),
  availableFrom: timestampSchema,
  dueAt: timestampSchema.nullable().optional(),
  expectedRoomVersion: z.number().int().positive(),
  reasonCode: reasonCodeSchema
}).superRefine((input, context) => {
  if (input.cleaningKind === 'stayover' && !input.reservationId) {
    context.addIssue({
      code: 'custom',
      path: ['reservationId'],
      message: '연박 청소 요청에는 예약 ID가 필요합니다.'
    });
  }
});

const cancelCleaningRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reasonCode: reasonCodeSchema
});

function idempotencyKey(request: FastifyRequest): string {
  return z.string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .parse(request.headers['idempotency-key']);
}

function manualTransitionIdempotencyKey(request: FastifyRequest): string {
  const key = idempotencyKey(request);
  if (key.startsWith('reservation-scheduler-')) {
    throw new AppError(
      400,
      'RESERVED_IDEMPOTENCY_KEY',
      'reservation-scheduler- 접두사는 예약 scheduler 전용입니다.'
    );
  }
  return key;
}

export function createReservationRoutes(service: ReservationService): FastifyPluginAsync {
  return async (app) => {
    const adminPreHandler = [app.authenticate, app.requirePasswordChanged, app.requireAdmin];

    app.get('/', { preHandler: adminPreHandler }, async (request) => {
      const { roomId } = listQuerySchema.parse(request.query);
      return { reservations: await service.list(request.actor, roomId) };
    });

    app.post('/cleaning-requests', { preHandler: adminPreHandler }, async (request, reply) => {
      const input = manualCleaningRequestSchema.parse(request.body);
      const cleaningRequest = await service.createManualCleaningRequest(request.actor, {
        roomId: input.roomId,
        cleaningKind: input.cleaningKind,
        serviceDate: input.serviceDate,
        availableFrom: input.availableFrom,
        expectedRoomVersion: input.expectedRoomVersion,
        reasonCode: input.reasonCode,
        ...(input.reservationId !== undefined ? { reservationId: input.reservationId } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send({ cleaningRequest });
    });

    app.post(
      '/cleaning-requests/:targetId/cancel',
      { preHandler: adminPreHandler },
      async (request) => {
        const { targetId } = targetIdSchema.parse(request.params);
        const input = cancelCleaningRequestSchema.parse(request.body);
        return {
          cleaningRequest: await service.cancelManualCleaningRequest(request.actor, {
            targetId,
            ...input,
            idempotencyKey: idempotencyKey(request)
          })
        };
      }
    );

    app.get('/:reservationId', { preHandler: adminPreHandler }, async (request) => {
      const { reservationId } = reservationIdSchema.parse(request.params);
      return { reservation: await service.get(request.actor, reservationId) };
    });

    app.post('/', { preHandler: adminPreHandler }, async (request, reply) => {
      const input = createSchema.parse(request.body);
      const guestName = typeof input.guestName === 'string'
        ? normalizeGuestName(input.guestName)
        : input.guestName;
      const reservation = await service.create(request.actor, {
        roomId: input.roomId,
        checkInAt: input.checkInAt,
        checkOutAt: input.checkOutAt,
        guestCount: input.guestCount,
        expectedRoomVersion: input.expectedRoomVersion,
        ...(guestName !== undefined ? { guestName } : {}),
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send({ reservation });
    });

    app.post('/transitions/process', { preHandler: adminPreHandler }, async (request) => {
      return {
        transitions: await service.processDue(request.actor, manualTransitionIdempotencyKey(request))
      };
    });

    app.patch('/:reservationId', { preHandler: adminPreHandler }, async (request) => {
      const { reservationId } = reservationIdSchema.parse(request.params);
      const input = changeSchema.parse(request.body);
      const guestName = typeof input.guestName === 'string'
        ? normalizeGuestName(input.guestName)
        : input.guestName;
      return {
        reservation: await service.change(request.actor, {
          reservationId,
          roomId: input.roomId,
          checkInAt: input.checkInAt,
          checkOutAt: input.checkOutAt,
          guestCount: input.guestCount,
          expectedVersion: input.expectedVersion,
          reasonCode: input.reasonCode,
          ...(guestName !== undefined ? { guestName } : {}),
          idempotencyKey: idempotencyKey(request)
        })
      };
    });

    app.post('/:reservationId/cancel', { preHandler: adminPreHandler }, async (request) => {
      const { reservationId } = reservationIdSchema.parse(request.params);
      const input = mutationSchema.parse(request.body);
      return {
        reservation: await service.cancel(request.actor, {
          reservationId,
          ...input,
          idempotencyKey: idempotencyKey(request)
        })
      };
    });

    app.post('/:reservationId/manual-checkout', { preHandler: adminPreHandler }, async (request) => {
      const { reservationId } = reservationIdSchema.parse(request.params);
      const input = mutationSchema.parse(request.body);
      return {
        reservation: await service.manualCheckout(request.actor, {
          reservationId,
          ...input,
          idempotencyKey: idempotencyKey(request)
        })
      };
    });
  };
}
