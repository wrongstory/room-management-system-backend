import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ReservationService } from './reservation.service.js';

const reservationIdSchema = z.object({ reservationId: z.uuid() });
const listQuerySchema = z.object({ roomId: z.uuid().optional() });
const timestampSchema = z.string().datetime({ offset: true });
const reasonCodeSchema = z.string().trim().min(2).max(80).regex(/^[A-Z0-9_]+$/);

const createSchema = z.object({
  roomId: z.uuid(),
  checkInAt: timestampSchema,
  checkOutAt: timestampSchema,
  guestCount: z.number().int().positive(),
  guestName: z.string().min(1).max(80).nullable().optional(),
  expectedRoomVersion: z.number().int().positive()
});

const changeSchema = z.object({
  roomId: z.uuid(),
  checkInAt: timestampSchema,
  checkOutAt: timestampSchema,
  guestCount: z.number().int().positive(),
  guestName: z.string().min(1).max(80).nullable().optional(),
  expectedVersion: z.number().int().positive(),
  reasonCode: reasonCodeSchema
});

const mutationSchema = z.object({
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

export function createReservationRoutes(service: ReservationService): FastifyPluginAsync {
  return async (app) => {
    const adminPreHandler = [app.authenticate, app.requirePasswordChanged, app.requireAdmin];

    app.get('/', { preHandler: adminPreHandler }, async (request) => {
      const { roomId } = listQuerySchema.parse(request.query);
      return { reservations: await service.list(request.actor, roomId) };
    });

    app.post('/', { preHandler: adminPreHandler }, async (request, reply) => {
      const input = createSchema.parse(request.body);
      const reservation = await service.create(request.actor, {
        roomId: input.roomId,
        checkInAt: input.checkInAt,
        checkOutAt: input.checkOutAt,
        guestCount: input.guestCount,
        expectedRoomVersion: input.expectedRoomVersion,
        ...(input.guestName !== undefined ? { guestName: input.guestName } : {}),
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send({ reservation });
    });

    app.post('/transitions/process', { preHandler: adminPreHandler }, async (request) => {
      return {
        transitions: await service.processDue(request.actor, idempotencyKey(request))
      };
    });

    app.patch('/:reservationId', { preHandler: adminPreHandler }, async (request) => {
      const { reservationId } = reservationIdSchema.parse(request.params);
      const input = changeSchema.parse(request.body);
      return {
        reservation: await service.change(request.actor, {
          reservationId,
          roomId: input.roomId,
          checkInAt: input.checkInAt,
          checkOutAt: input.checkOutAt,
          guestCount: input.guestCount,
          expectedVersion: input.expectedVersion,
          reasonCode: input.reasonCode,
          ...(input.guestName !== undefined ? { guestName: input.guestName } : {}),
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
