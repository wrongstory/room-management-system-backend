import { describe, expect, it } from "vitest";
import {
  optimizeAssignmentPreview,
  PREVIEW_LIMITS,
  type PreviewSnapshot,
  type PreviewTarget,
} from "../supabase/functions/_shared/assignment-preview-core.js";

const time = (h: string) => `2037-01-05T${h}:00+09:00`;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}
function target(
  id: string,
  values: Partial<PreviewTarget> = {},
): PreviewTarget {
  return {
    cleaningTargetId: id,
    roomId: `room-${id}`,
    roomNumber: "601",
    roomTypeCode: "standard",
    elevatorZone: "A",
    feeSnapshot: 30000,
    availableFrom: time("10:00"),
    dueAt: time("18:00"),
    serviceDate: "2037-01-05",
    status: "unassigned",
    assignmentVersion: 1,
    source: "manual_room_request",
    cleaningKind: "additional",
    domainIdentity: { sourceId: id, roomReservations: [] },
    blockedReason: null,
    recleanMaidProfileId: null,
    currentAssignment: null,
    activeAttempt: null,
    ...values,
  };
}
function snapshot(targets: PreviewTarget[] = []): PreviewSnapshot {
  return {
    serviceDate: "2037-01-05",
    planningAt: time("09:00"),
    durationPolicy: {
      version: 1,
      status: "confirmed",
      standardMinutes: 30,
      premiumMinutes: 60,
      oceanPremiumMinutes: 50,
      oceanFamilyMinutes: 80,
    },
    maids: ["a", "b"].map((id) => ({
      maidProfileId: id,
      maidDisplayName: id,
      role: "maid",
      status: "active",
      availabilityVersion: 4,
      available: true,
    })),
    targets,
  };
}
function fixed(
  id: string,
  maid: string,
  sequence = 1,
  values: Partial<PreviewTarget> = {},
): PreviewTarget {
  const t = target(id, { status: "draft_assigned", ...values });
  return {
    ...t,
    currentAssignment: {
      assignmentId: `assignment-${id}`,
      maidProfileId: maid,
      sequenceNumber: sequence,
      revision: 1,
      serviceDate: t.serviceDate,
      availableFrom: t.availableFrom,
      dueAt: t.dueAt,
      targetAssignmentVersion: t.assignmentVersion,
    },
  };
}
describe("assignment preview pure optimizer", () => {
  it("has no duration fallback including existing demo room/template input", async () => {
    const s = {
      ...snapshot([target("1")]),
      durationPolicy: null,
      defaultDurationMinutes: 55,
      templateSnapshot: { durationMinutes: 60 },
    };
    const before = JSON.stringify(s);
    await expect(optimizeAssignmentPreview(s, "seed")).rejects.toMatchObject({
      code: "ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED",
    });
    expect(JSON.stringify(s)).toBe(before);
  });
  it("preserves its entire input and canonical fingerprint excludes seed and array ordering", async () => {
    const s = snapshot([target("2"), target("1")]), before = JSON.stringify(s);
    const a = await optimizeAssignmentPreview(s, "one"),
      b = await optimizeAssignmentPreview({
        ...s,
        targets: [...s.targets].reverse(),
        maids: [...s.maids].reverse(),
      }, "two");
    expect(a.inputFingerprint).toBe(b.inputFingerprint);
    expect(JSON.stringify(s)).toBe(before);
    expect(a.objectiveScore).toEqual(b.objectiveScore);
    expect(
      (await optimizeAssignmentPreview({
        ...s,
        targets: [target("2"), target("1", { assignmentVersion: 2 })],
      }, "one")).inputFingerprint,
    ).not.toBe(a.inputFingerprint);
  });
  it("maximizes count before balancing fees, replacing long-first greedy with feasible short jobs", async () => {
    const s = snapshot([
      target("long", {
        roomTypeCode: "premium",
        dueAt: time("11:00"),
        feeSnapshot: 60000,
      }),
      target("short1", { dueAt: time("11:00") }),
      target("short2", { dueAt: time("11:00") }),
    ]);
    s.maids = s.maids.slice(0, 1);
    const r = await optimizeAssignmentPreview(s, "a");
    expect(r.objectiveScore.completedTargetCount).toBe(2);
    expect(r.proposedAssignments.map((x) => x.cleaningTargetId).sort()).toEqual(
      ["short1", "short2"],
    );
  });
  it("counts fixed fee load in fairness and never proposes fixed assignments", async () => {
    const r = await optimizeAssignmentPreview(
      snapshot([
        fixed("old", "a", 1, { feeSnapshot: 90000 }),
        target("new1"),
        target("new2"),
      ]),
      "seed",
    );
    expect(r.proposedAssignments.map((x) => x.maidProfileId)).toEqual([
      "b",
      "b",
    ]);
    expect(r.fixedAssignments[0]?.maidProfileId).toBe("a");
    expect(r.objectiveScore.feeSpread).toBe(30000);
  });
  it("fixed time consumes capacity and new sequences append after max fixed sequence", async () => {
    const s = snapshot([
      fixed("fixed", "a", 3, {
        availableFrom: time("10:00"),
        dueAt: time("11:00"),
        roomTypeCode: "premium",
      }),
      target("new", { dueAt: time("10:30") }),
    ]);
    s.maids = s.maids.slice(0, 1);
    expect((await optimizeAssignmentPreview(s, "s")).proposedAssignments)
      .toHaveLength(0);
    s.targets[1] = target("new", { dueAt: time("12:00") });
    expect(
      (await optimizeAssignmentPreview(s, "s")).proposedAssignments[0]
        ?.proposedSequenceNumber,
    ).toBe(4);
  });
  it("preserves notified and ongoing/cross-day execution instead of inferring remaining work", async () => {
    const old = fixed("old", "a", 1, { status: "notified" });
    old.activeAttempt = {
      attemptId: "attempt",
      maidProfileId: "a",
      status: "in_progress",
      startedAt: time("10:00"),
      endedAt: null,
    };
    const r = await optimizeAssignmentPreview(
      snapshot([old, target("new")]),
      "s",
    );
    expect(r.proposedAssignments[0]?.maidProfileId).toBe("b");
    expect(r.fixedAssignments).toHaveLength(1);
  });
  it("reclean can only belong to original available maid", async () => {
    const s = snapshot([
      target("reclean", {
        source: "inspection_reclean",
        cleaningKind: "reclean",
        recleanMaidProfileId: "a",
        feeSnapshot: 0,
      }),
    ]);
    expect(
      (await optimizeAssignmentPreview(s, "s")).proposedAssignments[0]
        ?.maidProfileId,
    ).toBe("a");
    required(s.maids[0]).available = false;
    const r = await optimizeAssignmentPreview(s, "s");
    expect(r.proposedAssignments).toHaveLength(0);
    expect(r.remainingUnassignedTargets[0]?.reason).toBe(
      "RECLEAN_MAID_UNAVAILABLE",
    );
  });
  it.each(["inactive", "upload_only", "departed"])(
    "excludes %s maid",
    async (status) => {
      const s = snapshot([target("one")]);
      required(s.maids[0]).status = status;
      expect(
        (await optimizeAssignmentPreview(s, "s")).proposedAssignments[0]
          ?.maidProfileId,
      ).toBe("b");
    },
  );
  it("excludes missing submitted availability and non-maid roles", async () => {
    const s = snapshot([target("one")]);
    required(s.maids[0]).availabilityVersion = null;
    required(s.maids[1]).role = "admin";
    expect((await optimizeAssignmentPreview(s, "s")).proposedAssignments)
      .toHaveLength(0);
  });
  it("honors availableFrom and dueAt without inventing a null deadline", async () => {
    const s = snapshot([
      target("late", { availableFrom: time("17:45"), dueAt: time("18:00") }),
      target("null", { dueAt: null, availableFrom: time("22:00") }),
    ]);
    const r = await optimizeAssignmentPreview(s, "s");
    expect(r.proposedAssignments.map((x) => x.cleaningTargetId)).toEqual([
      "null",
    ]);
    expect(r.proposedAssignments[0]?.dueAt).toBeNull();
    const cross = await optimizeAssignmentPreview(
      snapshot([
        target("cross", { dueAt: null, availableFrom: time("23:45") }),
      ]),
      "s",
    );
    expect(cross.proposedAssignments).toHaveLength(0);
  });
  it("zone then room proximity only break equal fee scores", async () => {
    const s = snapshot([
      fixed("a-fixed", "a", 1, { elevatorZone: "A", roomNumber: "601" }),
      fixed("b-fixed", "b", 1, { elevatorZone: "B", roomNumber: "650" }),
      target("new", { elevatorZone: "A", roomNumber: "602" }),
    ]);
    expect(
      (await optimizeAssignmentPreview(s, "s")).proposedAssignments[0]
        ?.maidProfileId,
    ).toBe("a");
    s.targets[1] = fixed("b-fixed", "b", 1, {
      elevatorZone: "A",
      roomNumber: "650",
    });
    expect(
      (await optimizeAssignmentPreview(s, "s")).proposedAssignments[0]
        ?.maidProfileId,
    ).toBe("a");
  });
  it("seed only changes final exact ties; same snapshot+seed is reproducible", async () => {
    const s = snapshot([target("new")]),
      results = await Promise.all(
        Array.from(
          { length: 12 },
          (_, i) => optimizeAssignmentPreview(s, `seed-${i}`),
        ),
      );
    expect(
      new Set(results.map((r) => r.proposedAssignments[0]?.maidProfileId)).size,
    ).toBe(2);
    for (const r of results) {
      expect(r.objectiveScore).toEqual(required(results[0]).objectiveScore);
    }
    expect(await optimizeAssignmentPreview(s, "seed-0")).toEqual(results[0]);
  });
  it("returns exact target and availability versions with integer deviation", async () => {
    const r = await optimizeAssignmentPreview(
      snapshot([target("one", { assignmentVersion: 23 })]),
      "s",
    );
    expect(r.proposedAssignments[0]?.expectedAssignmentVersion).toBe(23);
    expect(r.proposedAssignments[0]?.expectedAvailabilityVersion).toBe(4);
    expect(r.objectiveScore.feeDeviation).toBe("1800000000");
  });
  it("keeps domain-invalid targets blocked and validates malformed snapshot", async () => {
    expect(
      (await optimizeAssignmentPreview(
        snapshot([target("bad", { blockedReason: "STAYOVER_NOT_ACTIVE" })]),
        "s",
      )).blockedTargets[0]?.reason,
    ).toBe("STAYOVER_NOT_ACTIVE");
    await expect(
      optimizeAssignmentPreview(
        snapshot([target("bad", { feeSnapshot: NaN })]),
        "s",
      ),
    ).rejects.toMatchObject({ code: "ASSIGNMENT_PREVIEW_SNAPSHOT_INVALID" });
    await expect(optimizeAssignmentPreview(snapshot(), "bad seed")).rejects
      .toMatchObject({ code: "INVALID_PREVIEW_SEED" });
  });
  it("fails closed on resource limits instead of returning partial decision-ready results", async () => {
    await expect(
      optimizeAssignmentPreview(
        snapshot(
          Array.from(
            { length: PREVIEW_LIMITS.targets + 1 },
            (_, i) => target(`${i}`),
          ),
        ),
        "s",
      ),
    ).rejects.toMatchObject({ code: "ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED" });
  });
  it("handles full 121-room/20-maid board inside bounded evaluation budget", async () => {
    const s = snapshot(
      Array.from(
        { length: 121 },
        (_, i) => target(`${i}`, { dueAt: null, roomNumber: String(600 + i) }),
      ),
    );
    s.maids = Array.from(
      { length: 20 },
      (_, i) => ({ ...required(s.maids[0]), maidProfileId: `m${i}` }),
    );
    const result = await optimizeAssignmentPreview(s, "load");
    expect(result.objectiveScore.completedTargetCount).toBe(121);
  });
  it("does not simulate past start and includes overdue fixed unstarted work", async () => {
    const s = snapshot([
      fixed("old", "a", 1, { dueAt: time("18:00") }),
      target("new", { dueAt: time("12:30") }),
    ]);
    s.maids = s.maids.slice(0, 1);
    s.planningAt = time("12:00");
    expect((await optimizeAssignmentPreview(s, "s")).proposedAssignments)
      .toHaveLength(0);
    s.targets = [target("past", { dueAt: time("11:00") })];
    expect((await optimizeAssignmentPreview(s, "s")).proposedAssignments)
      .toHaveLength(0);
  });
  it("validates actual delayed additional execution interval against reservation occupancy", async () => {
    const s = snapshot([
      fixed("old", "a", 1, {
        availableFrom: time("11:00"),
        dueAt: time("12:00"),
        roomTypeCode: "premium",
      }),
      target("new", {
        availableFrom: time("11:00"),
        dueAt: null,
        domainIdentity: {
          roomReservations: [{
            status: "active",
            checkInAt: time("12:00"),
            checkOutAt: time("16:00"),
            actualCheckInAt: null,
            actualCheckoutAt: null,
          }],
        },
      }),
    ]);
    s.maids = s.maids.slice(0, 1);
    expect((await optimizeAssignmentPreview(s, "s")).proposedAssignments)
      .toHaveLength(0);
  });
  it("preserves unknown type as blocked and confines unknown fixed capacity to its maid", async () => {
    const s = snapshot([
      fixed("old", "a", 1, { roomTypeCode: "unknown" }),
      target("bad", { roomTypeCode: "unknown" }),
      target("good"),
    ]);
    const r = await optimizeAssignmentPreview(s, "s");
    expect(r.fixedAssignments[0]?.durationMinutes).toBeNull();
    expect(r.blockedTargets[0]?.reason).toBe("ROOM_TYPE_DURATION_UNAVAILABLE");
    expect(r.proposedAssignments[0]?.maidProfileId).toBe("b");
  });
  it("future scheduled assignment does not consume today's capacity", async () => {
    const f = fixed("tomorrow", "a", 1, {
      serviceDate: "2037-01-06",
      availableFrom: "2037-01-06T10:00:00+09:00",
      dueAt: "2037-01-06T12:00:00+09:00",
    });
    f.activeAttempt = {
      attemptId: "later",
      maidProfileId: "a",
      status: "scheduled",
      startedAt: null,
      endedAt: null,
    };
    const s = snapshot([f, target("today")]);
    s.maids = s.maids.slice(0, 1);
    const r = await optimizeAssignmentPreview(s, "s");
    expect(r.fixedAssignments).toHaveLength(0);
    expect(r.proposedAssignments).toHaveLength(1);
  });
  it("historical inactive profiles do not exhaust candidate workforce limit", async () => {
    const s = snapshot([target("new")]);
    s.maids.push(
      ...Array.from(
        { length: 300 },
        (_, i) => ({
          ...required(s.maids[0]),
          maidProfileId: `inactive${i}`,
          status: "departed",
        }),
      ),
    );
    expect((await optimizeAssignmentPreview(s, "s")).proposedAssignments)
      .toHaveLength(1);
  });
  it("uses deviation before route when completed count and fee spread tie", async () => {
    const s = snapshot([
      fixed("fa", "a", 1, { feeSnapshot: 0, elevatorZone: "A" }),
      fixed("fb", "b", 1, { feeSnapshot: 0, elevatorZone: "A" }),
      fixed("fc", "c", 1, { feeSnapshot: 2000, elevatorZone: "B" }),
      fixed("fd", "d", 1, { feeSnapshot: 4000, elevatorZone: "B" }),
      target("new", { feeSnapshot: 1000, elevatorZone: "B" }),
    ]);
    s.maids = ["a", "b", "c", "d"].map((id) => ({
      ...required(s.maids[0]),
      maidProfileId: id,
    }));
    const r = await optimizeAssignmentPreview(s, "s");
    expect(["a", "b"]).toContain(r.proposedAssignments[0]?.maidProfileId);
    expect(r.objectiveScore.feeSpread).toBe(4000);
    expect(r.objectiveScore.feeDeviation).toBe("140000000");
  });
  it("blocks fixed additional work whose actual delayed interval collides", async () => {
    const s = snapshot([
      fixed("old", "a", 1, {
        availableFrom: time("11:00"),
        dueAt: null,
        domainIdentity: {
          roomReservations: [{
            status: "active",
            checkInAt: time("12:00"),
            checkOutAt: time("16:00"),
            actualCheckInAt: null,
            actualCheckoutAt: null,
          }],
        },
      }),
      target("new"),
    ]);
    s.planningAt = time("12:00");
    s.maids = s.maids.slice(0, 1);
    expect((await optimizeAssignmentPreview(s, "s")).proposedAssignments)
      .toHaveLength(0);
  });
});
