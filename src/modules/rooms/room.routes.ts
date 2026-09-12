import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RoomService } from './room.service.js';

const roomIdSchema = z.object({ roomId: z.uuid() });
const blockIdSchema = z.object({ roomId: z.uuid(), blockId: z.uuid() });
const issueIdSchema = z.object({ roomId: z.uuid(), issueId: z.uuid() });
const reasonCodeSchema = z.string().trim().min(2).max(80).regex(/^[A-Z0-9_]+$/);
const expectedVersionSchema = z.number().int().positive();

const masterDataSchema = z.object({
  roomTypeId: z.uuid(),
  elevatorZone: z.enum(['A', 'B', 'C']).nullable(),
  dataStatus: z.enum(['verified', 'verification_required']),
  dataStatusReason: z.string().trim().min(2).max(200).nullable().optional(),
  expectedVersion: expectedVersionSchema,
  reasonCode: reasonCodeSchema
});

const createBlockSchema = z.object({
  expectedRoomVersion: expectedVersionSchema,
  reasonCode: reasonCodeSchema,
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional()
});

const operationDecisionSchema = z.object({
  expectedRoomVersion: expectedVersionSchema,
  reasonCode: reasonCodeSchema
});

const candleSchema = operationDecisionSchema.extend({
  count: z.number().int().nonnegative(),
  physicallyVerified: z.boolean().default(false)
});

const issueSchema = operationDecisionSchema.extend({
  category: z.string().trim().min(2).max(80).regex(/^[A-Z0-9_]+$/),
  severity: z.enum(['info', 'warning', 'critical']),
  blocksGuestAssignment: z.boolean(),
  description: z.string().trim().max(500).optional()
});

const pinSyncSchema = operationDecisionSchema.extend({
  syncStatus: z.enum(['verified', 'mismatch', 'unconfigured']),
  pinVersion: z.number().int().positive().nullable().optional()
});

const pinWorkBinding = {
  assignmentId: z.uuid().optional(),
  attemptId: z.uuid().optional()
};
const preparePinChangeSchema = z.object({
  pinDigits: z.string().regex(/^[0-9]{4,8}$/),
  expectedPinVersion: z.number().int().nonnegative(),
  reasonCode: z.enum(['ADMIN_INITIAL_PIN', 'ADMIN_PHYSICAL_CHANGE', 'MAID_CLEANING_CHANGE', 'ACTUAL_PIN_REENTRY']),
  ...pinWorkBinding,
  accessLeaseId: z.uuid().optional()
}).strict();
const pinLeaseParamsSchema = z.object({ roomId: z.uuid(), leaseId: z.uuid() });
const confirmPinChangeSchema = z.object({ expectedPinVersion: z.number().int().nonnegative() }).strict();
const revealPinSchema = z.object({
  ...pinWorkBinding,
  accessLeaseId: z.uuid().optional()
}).strict();

function idempotencyKey(request: FastifyRequest): string {
  return z.string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .parse(request.headers['idempotency-key']);
}

export function createRoomRoutes(roomService: RoomService): FastifyPluginAsync {
  return async (app) => {
    const authenticated = [app.authenticate, app.requirePasswordChanged];
    const admin = [...authenticated, app.requireAdmin];

    app.get('/', { preHandler: admin }, async (request) => ({
      rooms: await roomService.list(request.actor)
    }));

    app.get('/:roomId', { preHandler: admin }, async (request) => {
      const { roomId } = roomIdSchema.parse(request.params);
      return { room: await roomService.get(request.actor, roomId) };
    });

    app.patch('/:roomId/master-data', { preHandler: admin }, async (request) => {
      const { roomId } = roomIdSchema.parse(request.params);
      const input = masterDataSchema.parse(request.body);
      return {
        room: await roomService.changeMasterData(request.actor, {
          roomId,
          roomTypeId: input.roomTypeId,
          elevatorZone: input.elevatorZone,
          dataStatus: input.dataStatus,
          expectedVersion: input.expectedVersion,
          reasonCode: input.reasonCode,
          ...(input.dataStatusReason !== undefined
            ? { dataStatusReason: input.dataStatusReason }
            : {}),
          idempotencyKey: idempotencyKey(request)
        })
      };
    });

    app.post('/:roomId/operation-blocks', { preHandler: admin }, async (request, reply) => {
      const { roomId } = roomIdSchema.parse(request.params);
      const input = createBlockSchema.parse(request.body);
      const operation = await roomService.mutateOperation(request.actor, {
        roomId,
        action: 'create_block',
        expectedRoomVersion: input.expectedRoomVersion,
        reasonCode: input.reasonCode,
        payload: { startsAt: input.startsAt, endsAt: input.endsAt },
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send({ operation });
    });

    app.post('/:roomId/operation-blocks/:blockId/release', { preHandler: admin }, async (request) => {
      const { roomId, blockId } = blockIdSchema.parse(request.params);
      const input = operationDecisionSchema.parse(request.body);
      return {
        operation: await roomService.mutateOperation(request.actor, {
          roomId,
          action: 'release_block',
          expectedRoomVersion: input.expectedRoomVersion,
          reasonCode: input.reasonCode,
          payload: { entityId: blockId },
          idempotencyKey: idempotencyKey(request)
        })
      };
    });

    app.post('/:roomId/candles', { preHandler: admin }, async (request, reply) => {
      const { roomId } = roomIdSchema.parse(request.params);
      const input = candleSchema.parse(request.body);
      const operation = await roomService.mutateOperation(request.actor, {
        roomId,
        action: 'set_candle_count',
        expectedRoomVersion: input.expectedRoomVersion,
        reasonCode: input.reasonCode,
        payload: { count: input.count, physicallyVerified: input.physicallyVerified },
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send({ operation });
    });

    app.post('/:roomId/issues', { preHandler: admin }, async (request, reply) => {
      const { roomId } = roomIdSchema.parse(request.params);
      const input = issueSchema.parse(request.body);
      const operation = await roomService.mutateOperation(request.actor, {
        roomId,
        action: 'report_issue',
        expectedRoomVersion: input.expectedRoomVersion,
        reasonCode: input.reasonCode,
        payload: {
          category: input.category,
          severity: input.severity,
          blocksGuestAssignment: input.blocksGuestAssignment,
          description: input.description
        },
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send({ operation });
    });

    app.post('/:roomId/issues/:issueId/resolve', { preHandler: admin }, async (request) => {
      const { roomId, issueId } = issueIdSchema.parse(request.params);
      const input = operationDecisionSchema.parse(request.body);
      return {
        operation: await roomService.mutateOperation(request.actor, {
          roomId,
          action: 'resolve_issue',
          expectedRoomVersion: input.expectedRoomVersion,
          reasonCode: input.reasonCode,
          payload: { entityId: issueId },
          idempotencyKey: idempotencyKey(request)
        })
      };
    });

    app.post('/:roomId/pin-sync-events', { preHandler: admin }, async (request, reply) => {
      const { roomId } = roomIdSchema.parse(request.params);
      const input = pinSyncSchema.parse(request.body);
      const operation = await roomService.mutateOperation(request.actor, {
        roomId,
        action: 'record_pin_sync',
        expectedRoomVersion: input.expectedRoomVersion,
        reasonCode: input.reasonCode,
        payload: { syncStatus: input.syncStatus, pinVersion: input.pinVersion },
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send({ operation });
    });

    app.post('/:roomId/pin-changes/prepare', { preHandler: authenticated }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { roomId } = roomIdSchema.parse(request.params);
      const input = preparePinChangeSchema.parse(request.body);
      const change = await roomService.preparePinChange(request.actor, {
        roomId, pinDigits: input.pinDigits, expectedPinVersion: input.expectedPinVersion,
        reasonCode: input.reasonCode,
        ...(input.assignmentId === undefined ? {} : { assignmentId: input.assignmentId }),
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        ...(input.accessLeaseId === undefined ? {} : { accessLeaseId: input.accessLeaseId }),
        idempotencyKey: idempotencyKey(request)
      });
      return reply.header('Cache-Control', 'no-store').code(201).send({ change });
    });

    app.post('/:roomId/pin-changes/:leaseId/confirm', { preHandler: authenticated }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { roomId, leaseId } = pinLeaseParamsSchema.parse(request.params);
      const input = confirmPinChangeSchema.parse(request.body);
      const change = await roomService.confirmPinChange(request.actor, {
        roomId, leaseId, expectedPinVersion: input.expectedPinVersion, idempotencyKey: idempotencyKey(request)
      });
      return reply.header('Cache-Control', 'no-store').send({ change });
    });

    app.post('/:roomId/pin-changes/:leaseId/rollback', { preHandler: authenticated }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { roomId, leaseId } = pinLeaseParamsSchema.parse(request.params);
      const input = confirmPinChangeSchema.parse(request.body);
      const change = await roomService.rollbackPinChange(request.actor, {
        roomId, leaseId, expectedPinVersion: input.expectedPinVersion, idempotencyKey: idempotencyKey(request)
      });
      return reply.header('Cache-Control', 'no-store').send({ change });
    });

    app.post('/:roomId/pin/reveal', { preHandler: authenticated }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { roomId } = roomIdSchema.parse(request.params);
      const input = revealPinSchema.parse(request.body);
      const pin = await roomService.revealPin(request.actor, {
        roomId,
        ...(input.assignmentId === undefined ? {} : { assignmentId: input.assignmentId }),
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        ...(input.accessLeaseId === undefined ? {} : { accessLeaseId: input.accessLeaseId })
      });
      return reply.header('Cache-Control', 'no-store').send({ pin });
    });
  };
}
