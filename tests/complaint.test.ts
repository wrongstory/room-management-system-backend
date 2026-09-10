import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/actor.js";
import { AppError } from "../src/lib/app-error.js";
import {
  ComplaintCursorCodec,
  complaintCursorScope,
} from "../src/modules/complaints/complaint-cursor.js";
import { createComplaintRoutes } from "../src/modules/complaints/complaint.routes.js";
import {
  SupabaseComplaintService,
  type ComplaintService,
  complaintDatabaseError,
} from "../src/modules/complaints/complaint.service.js";

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const secret = "complaint-cursor-test-secret-at-least-32-bytes";
const admin: Actor = {
  authUserId: id(101),
  profileId: id(1),
  displayName: "admin",
  role: "admin",
  mustChangePassword: false,
  accessToken: "token",
};
const maid: Actor = { ...admin, profileId: id(2), role: "maid" };
const projection = {
  id: id(10),
  roomId: id(11),
  cleaningTargetId: id(12),
  cleaningAttemptId: id(13),
  submissionId: id(14),
  inspectionDecisionId: id(15),
  originalEarningId: id(16),
  maidProfileId: id(2),
  category: "cleanliness_general",
  status: "received",
  version: 1,
  currentDecisionId: null,
  firstDecidedAt: null,
  responseDeadline: null,
  receivedAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  currentDecision: null,
  maidResponse: null,
};

describe("complaint service and cursor", () => {
  it("binds list cursors to actor and exact range", () => {
    const codec = new ComplaintCursorCodec(secret);
    const scope = complaintCursorScope(admin, {
      kind: "list",
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-10T00:00:00Z",
    });
    const cursor = codec.encode(scope, {
      receivedAt: "2026-09-09T00:00:00Z",
      complaintId: id(10),
    });
    expect(codec.decode(cursor, scope)).toEqual({
      receivedAt: "2026-09-09T00:00:00Z",
      complaintId: id(10),
    });
    expect(() => codec.decode(`${cursor.slice(0, -1)}a`, scope)).toThrowError(
      expect.objectContaining({ code: "COMPLAINT_CURSOR_INVALID" }),
    );
    expect(() =>
      codec.decode(
        cursor,
        complaintCursorScope(maid, {
          kind: "list",
          from: "2026-09-01T00:00:00Z",
          to: "2026-09-10T00:00:00Z",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "COMPLAINT_CURSOR_INVALID" }),
    );
  });
  it("uses actor-bound CAS, idempotency and canonical request hash", async () => {
    const rpc = vi.fn(async () => ({ data: projection, error: null }));
    const service = new SupabaseComplaintService(
      { admin: { rpc } } as never,
      secret,
    );
    await service.create(admin, {
      originalEarningId: id(16),
      category: "cleanliness_general",
      expectedVersion: 0,
      idempotencyKey: "complaint-create-1",
    });
    expect(rpc).toHaveBeenCalledWith(
      "create_complaint_case",
      expect.objectContaining({
        p_actor_profile_id: id(1),
        p_original_earning_id: id(16),
        p_expected_version: 0,
        p_idempotency_key: "complaint-create-1",
        p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });
  it("maps stable errors and redacts unknown database detail", () => {
    expect(
      complaintDatabaseError({ message: "STALE_VERSION: internal" }).code,
    ).toBe("STALE_VERSION");
    expect(complaintDatabaseError({ message: "secret raw SQL" })).toMatchObject(
      {
        code: "COMPLAINT_COMMAND_FAILED",
        message: "컴플레인 정보를 처리하지 못했습니다.",
      },
    );
  });
});

async function appFor(role: Actor["role"] = "admin") {
  const calls: string[] = [];
  const service: ComplaintService = {
    async list() {
      calls.push("list");
      return { complaints: [], nextCursor: null };
    },
    async detail() {
      calls.push("detail");
      return projection;
    },
    async history() {
      calls.push("history");
      return { events: [], nextCursor: null };
    },
    async create() {
      calls.push("create");
      return projection;
    },
    async review() {
      calls.push("review");
      return projection;
    },
    async decide() {
      calls.push("decide");
      return projection;
    },
    async respond() {
      calls.push("respond");
      return projection;
    },
    async correct() {
      calls.push("correct");
      return projection;
    },
    async close() {
      calls.push("close");
      return projection;
    },
  };
  const app = Fastify();
  app.decorateRequest("actor");
  app.decorate("authenticate", async (req) => {
    req.actor = { ...admin, role };
  });
  app.decorate("requirePasswordChanged", async () => {});
  app.decorate("requireAdmin", async (req) => {
    if (req.actor.role !== "admin")
      throw new AppError(403, "ADMIN_REQUIRED", "admin");
  });
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(error instanceof AppError ? error.statusCode : 400)
      .send({
        error: {
          code: error instanceof AppError ? error.code : "VALIDATION_ERROR",
        },
      }),
  );
  await app.register(createComplaintRoutes(service), { prefix: "/v1/complaints" });
  return { app, calls };
}

describe("complaint Fastify contract", () => {
  it("exposes exact bounded list and all lifecycle routes", async () => {
    const { app, calls } = await appFor();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/complaints?from=2026-09-01T00%3A00%3A00Z&to=2026-09-10T00%3A00%3A00Z&limit=100",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/complaints/${id(10)}/history?limit=50`,
        })
      ).statusCode,
    ).toBe(200);
    for (const [path, payload] of [
      ["review", { expectedVersion: 1 }],
      [
        "decision",
        {
          expectedVersion: 2,
          finding: "confirmed",
          penaltyScore: 0,
          reworkRequired: true,
        },
      ],
      [
        "corrections",
        {
          expectedVersion: 3,
          finding: "false",
          penaltyScore: 10,
          reworkRequired: false,
        },
      ],
      ["close", { expectedVersion: 4 }],
    ] as const)
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/complaints/${id(10)}/${path}`,
            headers: { "idempotency-key": `complaint-${path}` },
            payload,
          })
        ).statusCode,
      ).toBe(200);
    expect(calls).toEqual([
      "list",
      "history",
      "review",
      "decide",
      "correct",
      "close",
    ]);
    await app.close();
  });
  it("rejects query aliases, free text, penalty overflow, and reopen", async () => {
    const { app, calls } = await appFor();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/complaints?from=2026-09-01T00%3A00%3A00Z&to=2026-09-10T00%3A00%3A00Z&limit=50&limit=49",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/complaints/${id(10)}/review`,
          headers: { "idempotency-key": "complaint-zero-version" },
          payload: { expectedVersion: 0 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/complaints",
          headers: { "idempotency-key": "complaint-invalid" },
          payload: {
            originalEarningId: id(16),
            category: "customer said room dirty",
            expectedVersion: 0,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/complaints/${id(10)}/decision`,
          headers: { "idempotency-key": "complaint-penalty" },
          payload: {
            expectedVersion: 2,
            finding: "confirmed",
            penaltyScore: 11,
            reworkRequired: true,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/complaints/${id(10)}/reopen`,
          headers: { "idempotency-key": "complaint-reopen" },
          payload: { expectedVersion: 5 },
        })
      ).statusCode,
    ).toBe(404);
    expect(calls).toEqual([]);
    await app.close();
  });
  it("keeps admin commands unavailable to maid and supports exact self response shape", async () => {
    const { app, calls } = await appFor("maid");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/complaints/${id(10)}/review`,
          headers: { "idempotency-key": "complaint-review" },
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/complaints/${id(10)}/response`,
          headers: { "idempotency-key": "complaint-appeal" },
          payload: {
            expectedVersion: 3,
            responseType: "appealed",
            appealReasonCode: "timeline_mismatch",
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/complaints/${id(10)}/response`,
          headers: { "idempotency-key": "complaint-free" },
          payload: {
            expectedVersion: 3,
            responseType: "appealed",
            appealReasonCode: "free text",
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(calls).toEqual(["respond"]);
    await app.close();
  });
});
