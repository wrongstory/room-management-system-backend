import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import {
  ROOM_OPERATION_CURSOR_MAX_LENGTH,
  ROOM_OPERATION_PAGE_DEFAULT,
  ROOM_OPERATION_PAGE_MAX
} from './room-operation-cursor.js';
import type { RoomOperationPageInput } from './room.service.js';
import type { RoomService } from './room.service.js';

const roomIdSchema = z.object({ roomId: z.uuid() });
const blockIdSchema = z.object({ roomId: z.uuid(), blockId: z.uuid() });
const issueIdSchema = z.object({ roomId: z.uuid(), issueId: z.uuid() });
const reasonCodeSchema = z.string().trim().min(2).max(80).regex(/^[A-Z0-9_]+$/);
const expectedVersionSchema = z.number().int().positive();
const roomEventQuerySchema = z
  .object({
    limit: z.preprocess(
      (value) => value ?? '30',
      z.string().regex(/^(?:[1-9]|[1-4]\d|50)$/).transform(Number)
    )
  })
  .strict();

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

const occupancyCorrectionSchema = z.object({
  reservationId: z.uuid(),
  occupied: z.boolean(),
  effectiveAt: z.string().datetime({ offset: true }),
  expectedRoomVersion: expectedVersionSchema,
  reasonCode: reasonCodeSchema
}).strict();

const displayStatusOverrideSchema = z.object({
  targetStatus: z.enum([
    'BLOCKED',
    'OCCUPIED',
    'ARRIVAL_PENDING',
    'RESERVATION_PRESENT',
    'CLEANING_REQUIRED',
    'READY'
  ]).nullable(),
  expectedRoomVersion: expectedVersionSchema,
  reasonCode: reasonCodeSchema
}).strict();

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
const bootstrapPinsSchema = z.object({
  limit: z.number().int().min(1).max(25).default(20)
}).strict();
const confirmGeneratedPinSchema = z.object({
  expectedPinVersion: z.number().int().positive()
}).strict();
const developerRoomTypeParamsSchema = z.object({ roomTypeId: z.uuid() }).strict();
const developerCapacitySchema = z.object({
  baseOccupancy: z.number().int().positive(),
  maxOccupancy: z.number().int().positive(),
  expectedVersion: expectedVersionSchema
}).strict().refine(
  (input) => input.baseOccupancy <= input.maxOccupancy,
  { message: 'baseOccupancy는 maxOccupancy보다 클 수 없습니다.', path: ['baseOccupancy'] }
);
const developerCapacityCommitSchema = developerCapacitySchema.and(z.object({
  impactFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  reasonCode: z.literal('CAPACITY_POLICY_CHANGE')
}).strict());
const developerRoomCreateSchema = z.object({
  roomNumber: z.string().trim().regex(/^[0-9]{1,20}$/),
  roomTypeId: z.uuid(),
  expectedRoomTypeVersion: expectedVersionSchema,
  reasonCode: z.literal('ROOM_CATALOG_ADD')
}).strict();
const developerRoomDeactivationPreviewSchema = z.object({
  expectedVersion: expectedVersionSchema
}).strict();
const developerRoomDeactivationCommitSchema = developerRoomDeactivationPreviewSchema.extend({
  impactFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  reasonCode: z.literal('ROOM_CATALOG_REMOVE')
}).strict();

function idempotencyKey(request: FastifyRequest): string {
  return z.string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .parse(request.headers['idempotency-key']);
}

function roomOperationPageInput(
  request: FastifyRequest,
  expectedStatus: 'actionable' | 'open'
): RoomOperationPageInput {
  const raw = new URL(request.raw.url ?? '/', 'http://internal').searchParams;
  for (const key of raw.keys()) {
    if (!['status', 'limit', 'cursor'].includes(key) || raw.getAll(key).length !== 1) {
      throw new AppError(400, 'INVALID_ROOM_OPERATION_QUERY', '객실 운영 조회 조건이 올바르지 않습니다.');
    }
  }
  const rawStatus = raw.get('status') ?? expectedStatus;
  if (rawStatus !== expectedStatus) {
    throw new AppError(400, 'INVALID_ROOM_OPERATION_QUERY', '객실 운영 조회 조건이 올바르지 않습니다.');
  }
  const rawLimit = raw.get('limit') ?? String(ROOM_OPERATION_PAGE_DEFAULT);
  if (!/^[1-9]\d*$/.test(rawLimit)) {
    throw new AppError(400, 'ROOM_OPERATION_PAGE_LIMIT_INVALID', '객실 운영 page 크기가 올바르지 않습니다.');
  }
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > ROOM_OPERATION_PAGE_MAX) {
    throw new AppError(400, 'ROOM_OPERATION_PAGE_LIMIT_INVALID', '객실 운영 page 크기가 올바르지 않습니다.');
  }
  const cursor = raw.get('cursor');
  if (cursor !== null && (cursor.length < 1 || cursor.length > ROOM_OPERATION_CURSOR_MAX_LENGTH)) {
    throw new AppError(400, 'INVALID_ROOM_OPERATION_CURSOR', '객실 운영 cursor가 올바르지 않습니다.');
  }
  return { limit, cursor: cursor ?? undefined };
}

export function createRoomRoutes(roomService: RoomService): FastifyPluginAsync {
  return async (app) => {
    const authenticated = [app.authenticate, app.requirePasswordChanged];
    const admin = [...authenticated, app.requireAdmin];

    app.get('/', { preHandler: admin }, async (request) => ({
      rooms: await roomService.list(request.actor)
    }));

    app.post('/pins/bootstrap', { preHandler: admin }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const input = bootstrapPinsSchema.parse(request.body);
      const bootstrap = await roomService.bootstrapPins(request.actor, {
        limit: input.limit,
        idempotencyKey: idempotencyKey(request)
      });
      return reply.header('Cache-Control', 'no-store').send({ bootstrap });
    });

    app.post('/:roomId/pin/generated/confirm', { preHandler: admin }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { roomId } = roomIdSchema.parse(request.params);
      const input = confirmGeneratedPinSchema.parse(request.body);
      const confirmation = await roomService.confirmGeneratedPin(request.actor, {
        roomId,
        expectedPinVersion: input.expectedPinVersion,
        idempotencyKey: idempotencyKey(request)
      });
      return reply.header('Cache-Control', 'no-store').send({ confirmation });
    });

    app.get('/:roomId', { preHandler: admin }, async (request) => {
      const { roomId } = roomIdSchema.parse(request.params);
      return { room: await roomService.get(request.actor, roomId) };
    });

    app.get('/:roomId/events', { preHandler: admin }, async (request, reply) => {
      const { roomId } = roomIdSchema.parse(request.params);
      const { limit } = roomEventQuerySchema.parse(request.query);
      return reply
        .header('Cache-Control', 'no-store')
        .send(await roomService.listEvents(request.actor, roomId, limit));
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

    app.post('/:roomId/occupancy-corrections', { preHandler: admin }, async (request, reply) => {
      const { roomId } = roomIdSchema.parse(request.params);
      const input = occupancyCorrectionSchema.parse(request.body);
      const correction = await roomService.correctOccupancy(request.actor, {
        roomId,
        ...input,
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send({ correction });
    });

    app.post('/:roomId/display-status-overrides', { preHandler: admin }, async (request, reply) => {
      const { roomId } = roomIdSchema.parse(request.params);
      const input = displayStatusOverrideSchema.parse(request.body);
      const statusOverride = await roomService.overrideDisplayStatus(request.actor, {
        roomId,
        ...input,
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send({ statusOverride });
    });

    app.get('/:roomId/operation-blocks', { preHandler: admin }, async (request, reply) => {
      const { roomId } = roomIdSchema.parse(request.params);
      const input = roomOperationPageInput(request, 'actionable');
      return reply
        .header('Cache-Control', 'no-store')
        .send(await roomService.listOperationBlocks(request.actor, roomId, input));
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

    app.get('/:roomId/issues', { preHandler: admin }, async (request, reply) => {
      const { roomId } = roomIdSchema.parse(request.params);
      const input = roomOperationPageInput(request, 'open');
      return reply
        .header('Cache-Control', 'no-store')
        .send(await roomService.listIssues(request.actor, roomId, input));
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

export function createRoomTypeRoutes(roomService: RoomService): FastifyPluginAsync {
  return async (app) => {
    app.get('/', {
      preHandler: [app.authenticate, app.requirePasswordChanged, app.requireAdmin]
    }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { items: await roomService.listTypes(request.actor) };
    });
  };
}

export function createDeveloperRoomCatalogRoutes(roomService: RoomService): FastifyPluginAsync {
  return async (app) => {
    const developer = [app.authenticate, app.requirePasswordChanged, app.requireDeveloper];

    app.get('/room-catalog', { preHandler: developer }, async (request, reply) => {
      return reply.header('Cache-Control', 'no-store').send({
        catalog: await roomService.getDeveloperCatalog(request.actor)
      });
    });

    app.post('/room-types/:roomTypeId/capacity/preview', { preHandler: developer }, async (request, reply) => {
      const { roomTypeId } = developerRoomTypeParamsSchema.parse(request.params);
      const input = developerCapacitySchema.parse(request.body);
      return reply.header('Cache-Control', 'no-store').send({
        preview: await roomService.previewRoomTypeCapacity(request.actor, { roomTypeId, ...input })
      });
    });

    app.patch('/room-types/:roomTypeId/capacity', { preHandler: developer }, async (request, reply) => {
      const { roomTypeId } = developerRoomTypeParamsSchema.parse(request.params);
      const input = developerCapacityCommitSchema.parse(request.body);
      return reply.header('Cache-Control', 'no-store').send({
        change: await roomService.changeRoomTypeCapacity(request.actor, {
          roomTypeId,
          ...input,
          idempotencyKey: idempotencyKey(request)
        })
      });
    });

    app.post('/rooms', { preHandler: developer }, async (request, reply) => {
      const input = developerRoomCreateSchema.parse(request.body);
      return reply.code(201).header('Cache-Control', 'no-store').send({
        creation: await roomService.createDeveloperRoom(request.actor, {
          ...input,
          idempotencyKey: idempotencyKey(request)
        })
      });
    });

    app.post('/rooms/:roomId/deactivation/preview', { preHandler: developer }, async (request, reply) => {
      const { roomId } = roomIdSchema.parse(request.params);
      const input = developerRoomDeactivationPreviewSchema.parse(request.body);
      return reply.header('Cache-Control', 'no-store').send({
        preview: await roomService.previewRoomDeactivation(request.actor, { roomId, ...input })
      });
    });

    app.post('/rooms/:roomId/deactivate', { preHandler: developer }, async (request, reply) => {
      const { roomId } = roomIdSchema.parse(request.params);
      const input = developerRoomDeactivationCommitSchema.parse(request.body);
      return reply.header('Cache-Control', 'no-store').send({
        deactivation: await roomService.deactivateDeveloperRoom(request.actor, {
          roomId,
          ...input,
          idempotencyKey: idempotencyKey(request)
        })
      });
    });
  };
}
