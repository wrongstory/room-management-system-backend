import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DeveloperRoomCatalogService } from "./developer-room-catalog.service.js";

const querySchema = z.object({
  status: z.enum(["all", "active", "retired"]).default("all"),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.preprocess(
    (value) => value ?? "50",
    z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).transform(Number),
  ),
}).strict();
const createSchema = z.object({
  roomNumber: z.string().regex(/^[0-9]{1,8}$/),
  roomTypeId: z.uuid(),
  expectedRoomTypeVersion: z.number().int().positive(),
  elevatorZone: z.enum(["A", "B", "C"]).nullable(),
}).strict();
const retireSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reasonCode: z.string().min(2).max(80).regex(/^[A-Z0-9_]+$/),
}).strict();
const paramsSchema = z.object({ roomId: z.uuid() });
function idempotencyKey(request: FastifyRequest): string {
  return z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/).parse(
    request.headers["idempotency-key"],
  );
}
export function createDeveloperRoomCatalogRoutes(
  service: DeveloperRoomCatalogService,
): FastifyPluginAsync {
  return async (app) => {
    const developer = [
      app.authenticate,
      app.requirePasswordChanged,
      app.requireDeveloper,
    ];
    app.addHook("onSend", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    });
    app.get("/", { preHandler: developer }, async (request) => {
      const query = querySchema.parse(request.query);
      return service.list(
        request.actor,
        query.status,
        query.cursor ?? null,
        query.limit,
      );
    });
    app.post("/", { preHandler: developer }, async (request, reply) => {
      const input = createSchema.parse(request.body);
      return reply.code(201).send({
        room: await service.create(request.actor, {
          ...input,
          idempotencyKey: idempotencyKey(request),
        }),
      });
    });
    app.post("/:roomId/retire", { preHandler: developer }, async (request) => {
      const { roomId } = paramsSchema.parse(request.params);
      const input = retireSchema.parse(request.body);
      return {
        room: await service.retire(request.actor, {
          roomId,
          ...input,
          idempotencyKey: idempotencyKey(request),
        }),
      };
    });
  };
}
