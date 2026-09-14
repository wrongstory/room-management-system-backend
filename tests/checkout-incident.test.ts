import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/actor.js";
import { AppError } from "../src/lib/app-error.js";
import { createCheckoutIncidentRoutes } from "../src/modules/checkout-incidents/checkout-incident.routes.js";
import {
  type CheckoutIncidentService,
  checkoutIncidentDatabaseError,
  checkoutIncidentProjection,
  SupabaseCheckoutIncidentService,
} from "../src/modules/checkout-incidents/checkout-incident.service.js";

const id = (n: number) =>
  `f3320000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = id(900);
const accessToken = `e30.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString("base64url")}.signature`;
const maid: Actor = {
  authUserId: id(101),
  profileId: id(1),
  displayName: "신고 메이드",
  role: "maid",
  mustChangePassword: false,
  accessToken,
};
const admin: Actor = { ...maid, profileId: id(2), role: "admin" };
const incident = {
  incidentId: id(10),
  reservationId: id(11),
  roomId: id(12),
  cleaningTargetId: id(13),
  assignmentId: id(14),
  attemptId: id(15),
  reportedBy: id(1),
  reasonCode: "GUEST_STILL_PRESENT",
  status: "open",
  version: 1,
  impactFingerprint: "a".repeat(64),
  reportedAt: "2026-09-13T06:00:00Z",
};
const reportBody = {
  expectedExecutionVersion: 1,
  expectedAssignmentId: id(14),
  expectedAssignmentRevision: 2,
};
const decisionBody = {
  expectedVersion: 1,
  expectedImpactFingerprint: "a".repeat(64),
  decision: "CONFIRM_DEPARTED" as const,
  reasonCode: "GUEST_DEPARTURE_CONFIRMED",
  newCheckoutAt: null,
  reassignment: {
    maidProfileId: id(1),
    sequenceNumber: 1,
    serviceDate: "2026-09-13",
    availableFrom: "2026-09-13T06:00:00Z",
    dueAt: "2026-09-13T07:00:00Z",
  },
};

describe("checkout incident service", () => {
  it("binds canonical actor/session/CAS and hashes the exact report command", async () => {
    const rpc = vi.fn(async () => ({
      data: { ...incident, pinDigits: "1234", guestName: "비공개" },
      error: null,
    }));
    const service = new SupabaseCheckoutIncidentService({ admin: { rpc } } as never);
    const result = await service.report(
      { ...maid, profileId: maid.profileId.toUpperCase() },
      id(15).toUpperCase(),
      { ...reportBody, expectedAssignmentId: id(14).toUpperCase() },
      "checkout-report-1",
    );
    expect(rpc).toHaveBeenCalledWith("report_checkout_presence_incident", expect.objectContaining({
      p_actor_profile_id: id(1),
      p_session_id: sessionId,
      p_attempt_id: id(15),
      p_expected_assignment_id: id(14),
      p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(result).not.toHaveProperty("pinDigits");
    expect(JSON.stringify(result)).not.toContain("비공개");
  });

  it("projects only typed decision fields and fails closed on malformed rows", () => {
    const preciseReportedAt = "2028-02-29T06:10:00.123456789+09:00";
    expect(checkoutIncidentProjection({ ...incident, reportedAt: preciseReportedAt }))
      .toMatchObject({ reportedAt: preciseReportedAt });
    expect(checkoutIncidentProjection({
      ...incident,
      status: "resolved",
      version: 2,
      currentDecisionId: id(20),
      resolvedAt: "2026-09-13T06:10:00Z",
      decision: {
        decisionId: id(20),
        incidentId: id(10),
        incidentVersion: 1,
        decision: "FALSE_REPORT",
        reasonCode: "REPORT_FALSE_CONFIRMED",
        decidedBy: id(2),
        decidedAt: "2026-09-13T06:10:00Z",
        nextAssignmentId: id(21),
        requestHash: "private",
      },
      before_state: { raw: true },
    })).not.toHaveProperty("before_state");
    for (const reportedAt of [
      "2026-02-29T06:10:00Z",
      "2026-04-31T06:10:00Z",
      "2026-09-13T06:10Z",
      "2026-09-13T06:10:00",
      "2026-09-13T06:10:00z",
      "2026-09-13T06:10:00+24:00",
      "2026-09-13T06:10:00.Z",
    ]) {
      let error: unknown;
      try {
        checkoutIncidentProjection({ ...incident, reportedAt });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: "CHECKOUT_INCIDENT_COMMAND_FAILED",
        statusCode: 500,
      });
      expect((error as Error).message).not.toContain(reportedAt);
    }
  });

  it("maps stable domain errors and redacts unknown database detail", () => {
    expect(checkoutIncidentDatabaseError({ message: "CHECKOUT_INCIDENT_OPEN" }))
      .toMatchObject({ statusCode: 409, code: "CHECKOUT_INCIDENT_OPEN" });
    expect(checkoutIncidentDatabaseError({ message: "ASSIGNMENT_SCHEDULE_INVALID" }))
      .toMatchObject({ statusCode: 409, code: "ASSIGNMENT_SCHEDULE_INVALID" });
    expect(checkoutIncidentDatabaseError({ message: "raw PIN SQL token" }))
      .toMatchObject({ statusCode: 500, code: "CHECKOUT_INCIDENT_COMMAND_FAILED" });
    expect(checkoutIncidentDatabaseError({ message: "raw PIN SQL token" }).message)
      .not.toContain("PIN");
  });
});

async function appFor(role: Actor["role"] = "maid") {
  const calls: string[] = [];
  const decisions: unknown[] = [];
  const service: CheckoutIncidentService = {
    async report() {
      calls.push("report");
      return incident;
    },
    async get() {
      calls.push("get");
      return incident;
    },
    async decide(_actor, _incidentId, input) {
      calls.push("decide");
      decisions.push(input);
      return {
        ...incident,
        status: "resolved",
        version: 2,
        currentDecisionId: id(20),
      };
    },
  };
  const app = Fastify();
  app.decorateRequest("actor");
  app.decorate("authenticate", async (request) => {
    request.actor = { ...(role === "admin" ? admin : maid), role };
  });
  app.decorate("requirePasswordChanged", async () => {});
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error instanceof AppError ? error.statusCode : 400).send({
      error: { code: error instanceof AppError ? error.code : "VALIDATION_ERROR" },
    })
  );
  await app.register(createCheckoutIncidentRoutes(service));
  return { app, calls, decisions };
}

describe("checkout incident Fastify contract", () => {
  it("exposes exact maid report/detail routes with no-store and strict bodies", async () => {
    const { app, calls } = await appFor("maid");
    const report = await app.inject({
      method: "POST",
      url: `/v1/attempts/${id(15)}/checkout-not-completed`,
      headers: { "idempotency-key": "checkout-report-1" },
      payload: reportBody,
    });
    const detail = await app.inject({ method: "GET", url: `/v1/checkout-incidents/${id(10)}` });
    const alias = await app.inject({ method: "GET", url: `/v1/checkout-incidents/${id(10)}/decision` });
    const extra = await app.inject({
      method: "POST",
      url: `/v1/attempts/${id(15)}/checkout-not-completed`,
      headers: { "idempotency-key": "checkout-report-2" },
      payload: { ...reportBody, guestName: "비공개" },
    });
    expect(report.statusCode).toBe(201);
    expect(detail.statusCode).toBe(200);
    expect(report.headers["cache-control"]).toBe("no-store");
    expect(detail.headers["cache-control"]).toBe("no-store");
    expect(alias.statusCode).toBe(404);
    expect(extra.statusCode).toBe(400);
    expect(calls).toEqual(["report", "get"]);
    await app.close();
  });

  it("allows only business admin decisions and rejects developer visibility", async () => {
    const { app: adminApp, calls } = await appFor("admin");
    const decision = await adminApp.inject({
      method: "POST",
      url: `/v1/checkout-incidents/${id(10)}/decision`,
      headers: { "idempotency-key": "checkout-decision-1" },
      payload: decisionBody,
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual(["decide"]);
    await adminApp.close();

    const { app: maidApp } = await appFor("maid");
    expect((await maidApp.inject({
      method: "POST",
      url: `/v1/checkout-incidents/${id(10)}/decision`,
      headers: { "idempotency-key": "checkout-decision-2" },
      payload: decisionBody,
    })).json().error.code).toBe("ADMIN_REQUIRED");
    await maidApp.close();

    const { app: developerApp, calls: developerCalls } = await appFor("developer");
    const detail = await developerApp.inject({ method: "GET", url: `/v1/checkout-incidents/${id(10)}` });
    expect(detail.statusCode).toBe(403);
    expect(detail.json().error.code).toBe("CHECKOUT_INCIDENT_ACCESS_REQUIRED");
    expect(developerCalls).toEqual([]);
    await developerApp.close();
  });

  it("requires strict second-precision offset timestamps and preserves fractions", async () => {
    const { app, calls, decisions } = await appFor("admin");
    const precise = {
      ...decisionBody,
      decision: "EXTEND_CHECKOUT" as const,
      reasonCode: "GUEST_STILL_PRESENT_EXTENDED",
      newCheckoutAt: "2028-02-29T08:10:00.987654321+09:00",
      reassignment: {
        ...decisionBody.reassignment,
        serviceDate: "2028-02-29",
        availableFrom: "2028-02-29T06:10:00Z",
        dueAt: "2028-02-29T07:10:00.123456789+09:00",
      },
    };
    const valid = await app.inject({
      method: "POST",
      url: `/v1/checkout-incidents/${id(10)}/decision`,
      headers: { "idempotency-key": "checkout-time-valid" },
      payload: precise,
    });
    expect(valid.statusCode).toBe(200);
    expect(decisions).toEqual([precise]);

    for (const dueAt of [
      "2026-02-29T06:10:00Z",
      "2026-04-31T06:10:00Z",
      "2026-09-13T06:10Z",
      "2026-09-13T06:10:00",
      "2026-09-13T06:10:00z",
      "2026-09-13T06:10:00+24:00",
      "2026-09-13T06:10:60Z",
      "2026-09-13T06:10:00.Z",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/checkout-incidents/${id(10)}/decision`,
        headers: { "idempotency-key": "checkout-time-invalid" },
        payload: {
          ...decisionBody,
          reassignment: { ...decisionBody.reassignment, dueAt },
        },
      });
      expect(response.statusCode, dueAt).toBe(400);
      expect(response.json().error.code, dueAt).toBe("VALIDATION_ERROR");
    }
    expect(calls).toEqual(["decide"]);
    await app.close();
  });
});
