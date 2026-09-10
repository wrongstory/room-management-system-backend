import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  assertComplaintResponseSize,
  COMPLAINT_CURSOR_MAX_LENGTH,
  COMPLAINT_PAGE_MAX,
} from "./complaint-cursor.js";
import {
  COMPLAINT_APPEAL_REASONS,
  COMPLAINT_CATEGORIES,
  COMPLAINT_FINDINGS,
  type ComplaintService,
} from "./complaint.service.js";

const uuid = z.uuid();
const expected = z.int().min(1);
const params = z.object({ complaintId: uuid }).strict();
const timestamp = z.iso.datetime({ offset: true });
const limit = z.union([
  z.number().int().min(1).max(COMPLAINT_PAGE_MAX),
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .refine((v) => v <= COMPLAINT_PAGE_MAX),
]);
const list = z
  .object({
    from: timestamp,
    to: timestamp,
    limit: limit.optional(),
    cursor: z.string().min(1).max(COMPLAINT_CURSOR_MAX_LENGTH).optional(),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.to) > Date.parse(v.from) &&
      Date.parse(v.to) - Date.parse(v.from) <= 31 * 86400000,
    { message: "조회 기간은 31일 이내여야 합니다." },
  );
const history = z
  .object({
    limit: limit.optional(),
    cursor: z.string().min(1).max(COMPLAINT_CURSOR_MAX_LENGTH).optional(),
  })
  .strict();
const create = z
  .object({
    originalEarningId: uuid,
    category: z.enum(COMPLAINT_CATEGORIES),
    expectedVersion: z.literal(0),
  })
  .strict();
const command = z.object({ expectedVersion: expected }).strict();
const decision = z
  .object({
    expectedVersion: expected,
    finding: z.enum(COMPLAINT_FINDINGS),
    penaltyScore: z.int().min(0).max(10),
    reworkRequired: z.boolean(),
  })
  .strict();
const response = z.discriminatedUnion("responseType", [
  z
    .object({
      expectedVersion: expected,
      responseType: z.literal("acknowledged"),
    })
    .strict(),
  z
    .object({
      expectedVersion: expected,
      responseType: z.literal("appealed"),
      appealReasonCode: z.enum(COMPLAINT_APPEAL_REASONS),
    })
    .strict(),
]);
function key(request: FastifyRequest) {
  return z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .parse(request.headers["idempotency-key"]);
}
function exactQuery(request: FastifyRequest, allowed: readonly string[]) {
  const q = new URL(request.raw.url ?? "/", "http://internal").searchParams;
  for (const k of q.keys())
    if (!allowed.includes(k) || q.getAll(k).length !== 1)
      throw new z.ZodError([
        {
          code: "custom",
          path: [k],
          message: "허용되지 않거나 중복된 query 항목입니다.",
        },
      ]);
}
function send(body: unknown) {
  assertComplaintResponseSize(body);
  return body;
}
export function createComplaintRoutes(
  service: ComplaintService,
): FastifyPluginAsync {
  return async (app) => {
    const auth = [app.authenticate, app.requirePasswordChanged];
    const admin = [...auth, app.requireAdmin];
    app.get(
      "/",
      { preHandler: auth, prefixTrailingSlash: "no-slash" },
      async (req) => {
        exactQuery(req, ["from", "to", "limit", "cursor"]);
        return send(await service.list(req.actor, list.parse(req.query)));
      },
    );
    app.post("/", { preHandler: admin }, async (req, reply) => {
      exactQuery(req, []);
      const body = create.parse(req.body);
      return reply
        .code(201)
        .send(
          send({
            complaint: await service.create(req.actor, {
              ...body,
              idempotencyKey: key(req),
            }),
          }),
        );
    });
    app.get(
      "/:complaintId",
      { preHandler: auth },
      async (req) => {
        exactQuery(req, []);
        const { complaintId } = params.parse(req.params);
        return send({
          complaint: await service.detail(req.actor, complaintId),
        });
      },
    );
    app.get(
      "/:complaintId/history",
      { preHandler: auth },
      async (req) => {
        exactQuery(req, ["limit", "cursor"]);
        const { complaintId } = params.parse(req.params);
        return send(
          await service.history(req.actor, {
            complaintId,
            ...history.parse(req.query),
          }),
        );
      },
    );
    const adminCommand = (
      path: string,
      method: "review" | "close",
      status = 200,
    ) =>
      app.post(path, { preHandler: admin }, async (req, reply) => {
        exactQuery(req, []);
        const { complaintId } = params.parse(req.params);
        const body = command.parse(req.body);
        return reply
          .code(status)
          .send(
            send({
              complaint: await service[method](req.actor, {
                complaintId,
                ...body,
                idempotencyKey: key(req),
              }),
            }),
          );
      });
    adminCommand("/:complaintId/review", "review");
    adminCommand("/:complaintId/close", "close");
    app.post(
      "/:complaintId/decision",
      { preHandler: admin },
      async (req) => {
        exactQuery(req, []);
        const { complaintId } = params.parse(req.params);
        return send({
          complaint: await service.decide(req.actor, {
            complaintId,
            ...decision.parse(req.body),
            idempotencyKey: key(req),
          }),
        });
      },
    );
    app.post(
      "/:complaintId/response",
      { preHandler: auth },
      async (req) => {
        exactQuery(req, []);
        const { complaintId } = params.parse(req.params);
        return send({
          complaint: await service.respond(req.actor, {
            complaintId,
            ...response.parse(req.body),
            idempotencyKey: key(req),
          }),
        });
      },
    );
    app.post(
      "/:complaintId/corrections",
      { preHandler: admin },
      async (req) => {
        exactQuery(req, []);
        const { complaintId } = params.parse(req.params);
        return send({
          complaint: await service.correct(req.actor, {
            complaintId,
            ...decision.parse(req.body),
            idempotencyKey: key(req),
          }),
        });
      },
    );
  };
}
