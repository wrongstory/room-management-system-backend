import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { zeroPreviewSnapshot } from "./fixtures/assignment-preview.js";
import {
  optimizeAssignmentPreview,
  PREVIEW_LIMITS,
  type PreviewSnapshot,
  type PreviewTarget,
} from "../src/modules/assignments/assignment-preview-core.js";

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
  it("preserves the phase 4B2 pre-diagnostics response and fingerprint golden", async () => {
    // Independently captured by executing git-show 744662c, not regenerated
    // from this implementation. That source canonically includes empty
    // sequenceReservations; preserve it instead of changing the hash contract
    // to satisfy the older #320 fixture. Historical dev e19f81f golden:
    // fingerprint bd06869b18017666b32fbcc35c626ae87e2969096d41ee5ab8cfdd039d37d065
    // response d27a759354fca83ebec6c7d054646f71f8e418fbb7e5589e55db72d3691d9310
    const { diagnostics, ...result } = await optimizeAssignmentPreview(
      zeroPreviewSnapshot("2037-01-05"), "golden",
    );
    const legacy = {
      ...result,
      remainingUnassignedTargets: result.remainingUnassignedTargets.map(
        ({ reasonCodes, ...row }) => {
          expect(reasonCodes).toEqual(["AVAILABILITY_NOT_SUBMITTED"]);
          return row;
        },
      ),
    };
    expect(diagnostics.eligibleMaidCount).toBe(0);
    expect(result.inputFingerprint).toBe("286d4660765b262d2a4e73a81c86abc00d7feb867069efcc081398a62aca4f78");
    expect(createHash("sha256").update(JSON.stringify(legacy)).digest("hex"))
      .toBe("21e014465b16def4dd25f03820133bf6aca2facdd667bf7eb1b129f21df9a933");
  });

  it.each([
    ["NO_ACTIVE_MAID", { status: "inactive" }, [0, 0, 0]],
    ["AVAILABILITY_NOT_SUBMITTED", { availabilityVersion: null }, [2, 0, 0]],
    ["NO_AVAILABLE_MAID", { available: false }, [2, 2, 0]],
  ])(
    "explains 0 proposed / 12 remaining / 0 blocked: %s",
    async (reason, overrides, counts) => {
      const s = snapshot(
        Array.from({ length: 12 }, (_, i) => target(String(i))),
      );
      s.maids = s.maids.map((m) => ({ ...m, ...overrides }));
      const before = JSON.stringify(s);
      const r = await optimizeAssignmentPreview(s, "diagnostics");
      expect(r.proposedAssignments).toEqual([]);
      expect(r.blockedTargets).toEqual([]);
      expect(r.remainingUnassignedTargets).toHaveLength(12);
      for (const row of r.remainingUnassignedTargets) {
        expect(row).toMatchObject({
          reason: "NO_ELIGIBLE_MAID",
          reasonCodes: [reason],
        });
      }
      expect(r.diagnostics).toEqual({
        evaluatedAt: s.planningAt,
        activeMaidCount: counts[0],
        submittedAvailabilityMaidCount: counts[1],
        availableMaidCount: counts[2],
        fixedExcludedMaidCount: 0,
        eligibleMaidCount: 0,
        fixedExclusions: [],
      });
      expect(JSON.stringify(s)).toBe(before);
    },
  );

  it("distinguishes all fixed exclusions, partial exclusions and reclean ownership", async () => {
    const s = snapshot([
      fixed("fixed-a", "a", 1, { blockedReason: "private-source-sentinel" }),
      fixed("fixed-b", "b", 1, { blockedReason: "SOURCE_STALE" }),
      ...Array.from({ length: 12 }, (_, i) => target(String(i))),
    ]);
    const r = await optimizeAssignmentPreview(s, "all-fixed");
    expect(r.proposedAssignments).toHaveLength(0);
    expect(r.blockedTargets).toHaveLength(0);
    expect(r.remainingUnassignedTargets).toHaveLength(12);
    expect(
      r.remainingUnassignedTargets.every((t) =>
        t.reasonCodes.join() === "FIXED_ASSIGNMENT_CONFLICT"
      ),
    ).toBe(true);
    expect(r.diagnostics).toMatchObject({
      availableMaidCount: 2,
      fixedExcludedMaidCount: 2,
      eligibleMaidCount: 0,
    });
    expect(r.diagnostics.fixedExclusions).toEqual(["a", "b"].map((id) => ({
      maidProfileId: id,
      cleaningTargetId: `fixed-${id}`,
      reasonCodes: ["FIXED_SOURCE_BLOCKED"],
    })));
    expect(JSON.stringify(r)).not.toContain("private-source-sentinel");
    required(s.targets.find((t) => t.cleaningTargetId === "fixed-b"))
      .blockedReason = null;
    s.targets.push(target("reclean", {
      source: "inspection_reclean",
      cleaningKind: "reclean",
      recleanMaidProfileId: "a",
    }));
    const partial = await optimizeAssignmentPreview(s, "partial");
    expect(partial.proposedAssignments).toHaveLength(12);
    expect(partial.proposedAssignments.every((t) => t.maidProfileId === "b"))
      .toBe(true);
    expect(partial.remainingUnassignedTargets).toEqual([{
      cleaningTargetId: "reclean",
      reason: "NO_ELIGIBLE_MAID",
      reasonCodes: ["RECLEAN_MAID_FIXED_ASSIGNMENT_CONFLICT"],
    }]);
    expect(partial.diagnostics.eligibleMaidCount).toBe(1);
    required(s.maids[0]).available = false;
    const missingOwner = await optimizeAssignmentPreview(s, "missing-owner");
    expect(missingOwner.remainingUnassignedTargets[0]).toMatchObject({
      reason: "RECLEAN_MAID_UNAVAILABLE",
      reasonCodes: ["RECLEAN_MAID_UNAVAILABLE"],
    });
  });

  it("classifies fixed revision, sequence, schedule, date and attempt conflicts", async () => {
    // A conflict requires the same original date as well as the same sequence.
    const first = fixed("first", "a", 1, { serviceDate: "2037-01-04" });
    const second = fixed("second", "a");
    const assignment = required(second.currentAssignment ?? undefined);
    assignment.serviceDate = "2037-01-04";
    assignment.targetAssignmentVersion = 2;
    assignment.availableFrom = null;
    second.activeAttempt = {
      attemptId: "attempt",
      maidProfileId: "b",
      status: "submitted",
      startedAt: null,
      endedAt: null,
    };
    const r = await optimizeAssignmentPreview(
      snapshot([first, second, target("new")]),
      "fixed",
    );
    expect(r.diagnostics.fixedExclusions).toEqual([{
      maidProfileId: "a",
      cleaningTargetId: "second",
      reasonCodes: [
        "FIXED_SEQUENCE_CONFLICT",
        "FIXED_SERVICE_DATE_MISMATCH",
        "FIXED_ASSIGNMENT_VERSION_MISMATCH",
        "FIXED_SCHEDULE_MISMATCH",
        "FIXED_ATTEMPT_OWNER_MISMATCH",
        "FIXED_ATTEMPT_WORKFLOW_UNRESOLVED",
      ],
    }]);
    expect(r.proposedAssignments[0]?.maidProfileId).toBe("b");
  });

  it("works without a policy and ignores historical/demo duration inputs", async () => {
    const s = {
      ...snapshot([target("1")]),
      durationPolicy: null,
      defaultDurationMinutes: 55,
      templateSnapshot: { durationMinutes: 60 },
    };
    const before = JSON.stringify(s);
    const withoutPolicy = await optimizeAssignmentPreview(s, "seed");
    const withHistoricalPolicy = await optimizeAssignmentPreview(
      snapshot([target("1")]),
      "other-seed",
    );
    expect(withoutPolicy).toMatchObject({
      decisionReady: true,
      durationPolicy: null,
      durationPolicyStatus: "retired",
      durationPolicyRequired: false,
    });
    expect(withoutPolicy.proposedAssignments[0]?.durationMinutes).toBeNull();
    expect(withoutPolicy.inputFingerprint).toBe(
      withHistoricalPolicy.inputFingerprint,
    );
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
  it("maximizes assignable count without estimated-time capacity", async () => {
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
    expect(r.objectiveScore.completedTargetCount).toBe(3);
    expect(r.proposedAssignments.map((x) => x.cleaningTargetId).sort()).toEqual(
      ["long", "short1", "short2"],
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
  it("fixed work does not fabricate capacity and new sequences append after it", async () => {
    const s = snapshot([
      fixed("fixed", "a", 3, {
        availableFrom: time("10:00"),
        dueAt: time("11:00"),
        roomTypeCode: "premium",
      }),
      target("new", { dueAt: time("10:30") }),
    ]);
    s.maids = s.maids.slice(0, 1);
    expect(
      (await optimizeAssignmentPreview(s, "s")).proposedAssignments[0]
        ?.proposedSequenceNumber,
    ).toBe(4);
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
  it("offers follow-up work after an in-progress assignment without changing the running work", async () => {
    const ongoing = fixed("ongoing", "a", 3, { status: "in_progress" });
    ongoing.activeAttempt = {
      attemptId: "running-attempt",
      maidProfileId: "a",
      status: "in_progress",
      startedAt: time("10:00"),
      endedAt: null,
    };
    const s = snapshot([ongoing, target("later", { availableFrom: time("11:00") })]);
    s.maids = s.maids.slice(0, 1);
    const before = JSON.stringify(s);
    const r = await optimizeAssignmentPreview(s, "follow-up");
    expect(r.fixedAssignments).toMatchObject([{
      cleaningTargetId: "ongoing",
      maidProfileId: "a",
      proposedSequenceNumber: 3,
    }]);
    expect(r.proposedAssignments).toMatchObject([{
      cleaningTargetId: "later",
      maidProfileId: "a",
      proposedSequenceNumber: 4,
    }]);
    expect(r.remainingUnassignedTargets).toEqual([]);
    expect(JSON.stringify(s)).toBe(before);
  });
  it("keeps an overdue running assignment fixed without excluding its maid from later plans", async () => {
    const ongoing = fixed("ongoing", "a", 2, {
      status: "in_progress",
      dueAt: time("11:00"),
      blockedReason: "ASSIGNMENT_WINDOW_EXPIRED",
    });
    ongoing.activeAttempt = {
      attemptId: "running-attempt",
      maidProfileId: "a",
      status: "in_progress",
      startedAt: time("10:00"),
      endedAt: null,
    };
    const s = snapshot([ongoing, target("later", { dueAt: null })]);
    s.planningAt = time("12:00");
    s.maids = s.maids.slice(0, 1);
    const r = await optimizeAssignmentPreview(s, "overdue-follow-up");
    expect(r.fixedAssignments).toMatchObject([{
      cleaningTargetId: "ongoing", proposedSequenceNumber: 2,
    }]);
    expect(r.proposedAssignments).toMatchObject([{
      cleaningTargetId: "later", maidProfileId: "a", proposedSequenceNumber: 3,
    }]);
  });
  it("accepts overdue targets on today's board without rewriting their original dates or schedules", async () => {
    const old = target("overdue", {
      serviceDate: "2037-01-04",
      availableFrom: "2037-01-04T10:00:00+09:00",
      dueAt: "2037-01-04T18:00:00+09:00",
    });
    const s = snapshot([old]);
    const before = JSON.stringify(s);
    const r = await optimizeAssignmentPreview(s, "old-target");
    expect(r.serviceDate).toBe("2037-01-05");
    expect(r.proposedAssignments).toMatchObject([{
      cleaningTargetId: "overdue", serviceDate: "2037-01-04",
      availableFrom: old.availableFrom, dueAt: old.dueAt,
      expectedAvailabilityVersion: 4,
    }]);
    expect(r.blockedTargets).toEqual([]);
    expect(JSON.stringify(s)).toBe(before);
    required(s.maids[0]).available = false;
    required(s.maids[1]).availabilityVersion = null;
    expect((await optimizeAssignmentPreview(s, "unavailable")).proposedAssignments)
      .toEqual([]);
  });
  it("uses the KST planning date and does not move past or future work onto tomorrow's board", async () => {
    const old = target("overdue", { serviceDate: "2037-01-04" });
    const future = target("future", { serviceDate: "2037-01-06" });
    const s = snapshot([old, future]);
    s.planningAt = "2037-01-04T15:00:00Z";
    const todayResult = await optimizeAssignmentPreview(s, "kst-boundary");
    expect(todayResult.proposedAssignments.map((r) => r.cleaningTargetId))
      .toEqual(["overdue"]);
    expect(todayResult.blockedTargets).toEqual([{
      cleaningTargetId: "future", reason: "SERVICE_DATE_MISMATCH",
    }]);
    s.serviceDate = "2037-01-06";
    const tomorrowResult = await optimizeAssignmentPreview(s, "tomorrow");
    expect(tomorrowResult.proposedAssignments.map((r) => r.cleaningTargetId))
      .toEqual(["future"]);
    expect(tomorrowResult.blockedTargets).toEqual([{
      cleaningTargetId: "overdue", reason: "SERVICE_DATE_MISMATCH",
    }]);
    expect(tomorrowResult.diagnostics).toMatchObject({
      evaluatedAt: s.planningAt, eligibleMaidCount: 2, fixedExclusions: [],
    });
    expect(tomorrowResult.remainingUnassignedTargets).toEqual([]);
  });
  it("preserves cross-day fixed sequence slots and appends plans without renumbering history", async () => {
    const old = fixed("old", "a", 1, {
      serviceDate: "2037-01-04", status: "notified",
      availableFrom: "2037-01-04T10:00:00+09:00",
      dueAt: "2037-01-04T18:00:00+09:00",
    });
    old.activeAttempt = {
      attemptId: "old-running", maidProfileId: "a", status: "in_progress",
      startedAt: "2037-01-04T10:00:00+09:00", endedAt: null,
    };
    const s = snapshot([old, fixed("today", "a", 1), target("new")]);
    s.maids = s.maids.slice(0, 1);
    const before = JSON.stringify(s);
    const r = await optimizeAssignmentPreview(s, "cross-day");
    expect(r.fixedAssignments).toMatchObject([
      { cleaningTargetId: "old", serviceDate: "2037-01-04", proposedSequenceNumber: 1 },
      { cleaningTargetId: "today", serviceDate: "2037-01-05", proposedSequenceNumber: 1 },
    ]);
    expect(r.proposedAssignments).toMatchObject([{
      cleaningTargetId: "new", maidProfileId: "a", proposedSequenceNumber: 2,
    }]);
    expect(r.diagnostics).toMatchObject({
      availableMaidCount: 1, fixedExcludedMaidCount: 0, eligibleMaidCount: 1,
      fixedExclusions: [],
    });
    expect(r.maidSummaries).toMatchObject([{ fixedCount: 2, proposedCount: 1, totalFee: 90000 }]);
    expect(JSON.stringify(s)).toBe(before);
    const shuffled = await optimizeAssignmentPreview({ ...s, targets: [...s.targets].reverse() }, "other-seed");
    expect(shuffled).toEqual({ ...r, previewSeed: "other-seed" });
  });
  it("still blocks duplicate fixed slots within a date and mismatched original snapshots", async () => {
    const s = snapshot([fixed("first", "a", 1), fixed("duplicate", "a", 1), target("new")]);
    s.maids = s.maids.slice(0, 1);
    const duplicate = await optimizeAssignmentPreview(s, "duplicate");
    expect(duplicate.proposedAssignments).toEqual([]);
    expect(duplicate.diagnostics.fixedExclusions).toEqual([{
      maidProfileId: "a", cleaningTargetId: "first",
      reasonCodes: ["FIXED_SEQUENCE_CONFLICT"],
    }]);
    expect(duplicate.remainingUnassignedTargets).toEqual([{
      cleaningTargetId: "new", reason: "NO_ELIGIBLE_MAID",
      reasonCodes: ["FIXED_ASSIGNMENT_CONFLICT"],
    }]);
    const stale = fixed("stale", "a", 1, { serviceDate: "2037-01-04" });
    required(stale.currentAssignment ?? undefined).serviceDate = "2037-01-05";
    s.targets = [stale, target("new")];
    const staleDate = await optimizeAssignmentPreview(s, "stale-date");
    expect(staleDate.proposedAssignments).toEqual([]);
    expect(staleDate.diagnostics.fixedExclusions).toEqual([{
      maidProfileId: "a", cleaningTargetId: "stale",
      reasonCodes: ["FIXED_SERVICE_DATE_MISMATCH"],
    }]);
    s.targets = [fixed("blocked", "a", 1, { blockedReason: "PREVIOUS_ROOM_WORKFLOW_ACTIVE" }), target("new")];
    const blockedSource = await optimizeAssignmentPreview(s, "blocked-source");
    expect(blockedSource.proposedAssignments).toEqual([]);
    expect(blockedSource.diagnostics.fixedExclusions).toEqual([{
      maidProfileId: "a", cleaningTargetId: "blocked",
      reasonCodes: ["FIXED_SOURCE_BLOCKED"],
    }]);
  });
  it("reserves terminal current sequence slots independently for original service dates", async () => {
    const s = snapshot([
      fixed("old-fixed", "a", 1, { serviceDate: "2037-01-04" }),
      target("old-new", { serviceDate: "2037-01-04" }),
      target("today-new"),
      target("today-more"),
    ]);
    s.maids = s.maids.slice(0, 1);
    s.sequenceReservations = [
      { maidProfileId: "a", serviceDate: "2037-01-04", maxSequenceNumber: 7 },
      { maidProfileId: "a", serviceDate: "2037-01-05", maxSequenceNumber: 2 },
    ];
    const before = JSON.stringify(s);
    const r = await optimizeAssignmentPreview(s, "reserved");
    expect(
      r.proposedAssignments.find((row) => row.cleaningTargetId === "old-new"),
    )
      .toMatchObject({ serviceDate: "2037-01-04", proposedSequenceNumber: 8 });
    expect(
      r.proposedAssignments.filter((row) => row.serviceDate === "2037-01-05")
        .map((row) => row.proposedSequenceNumber).sort(),
    ).toEqual([3, 4]);
    expect(r.fixedAssignments[0]?.proposedSequenceNumber).toBe(1);
    expect(r.diagnostics.fixedExclusions).toEqual([]);
    expect(r.diagnostics.eligibleMaidCount).toBe(1);
    expect(r.maidSummaries[0]?.totalFee).toBe(120000);
    expect(JSON.stringify(s)).toBe(before);
    expect(r).not.toHaveProperty("sequenceReservations");
  });
  it("fingerprints occupancy changes canonically without adding terminal fee load", async () => {
    const s = snapshot([
      target("old", { serviceDate: "2037-01-04" }),
      target("new"),
    ]);
    s.sequenceReservations = [
      { maidProfileId: "a", serviceDate: "2037-01-04", maxSequenceNumber: 10 },
      { maidProfileId: "b", serviceDate: "2037-01-05", maxSequenceNumber: 20 },
    ];
    const r = await optimizeAssignmentPreview(s, "reserved");
    const reversed = await optimizeAssignmentPreview({
      ...s,
      maids: [...s.maids].reverse(),
      targets: [...s.targets].reverse(),
      sequenceReservations: [...s.sequenceReservations].reverse(),
    }, "other");
    expect(reversed).toEqual({ ...r, previewSeed: "other" });
    const changed = await optimizeAssignmentPreview({
      ...s,
      sequenceReservations: [
        { ...required(s.sequenceReservations[0]), maxSequenceNumber: 11 },
        required(s.sequenceReservations[1]),
      ],
    }, "reserved");
    expect(changed.inputFingerprint).not.toBe(r.inputFingerprint);
    expect(changed.objectiveScore).toEqual(r.objectiveScore);
    expect(changed.maidSummaries).toEqual(r.maidSummaries);
    expect(
      (await optimizeAssignmentPreview(
        { ...s, sequenceReservations: [] },
        "reserved",
      )).objectiveScore,
    )
      .toEqual(r.objectiveScore);
  });
  it("normalizes missing legacy occupancy without changing its calculation", async () => {
    const s = snapshot([target("new")]);
    const legacy = await optimizeAssignmentPreview(s, "same");
    expect(
      await optimizeAssignmentPreview(
        { ...s, sequenceReservations: [] },
        "same",
      ),
    )
      .toEqual(legacy);
    expect(legacy.proposedAssignments[0]?.proposedSequenceNumber).toBe(1);
  });
  it("does not let occupancy renumber a higher fixed sequence", async () => {
    const s = snapshot([fixed("fixed", "a", 8), target("new")]);
    s.maids = s.maids.slice(0, 1);
    s.sequenceReservations = [{
      maidProfileId: "a",
      serviceDate: s.serviceDate,
      maxSequenceNumber: 3,
    }];
    const r = await optimizeAssignmentPreview(s, "fixed-high");
    expect(r.proposedAssignments[0]?.proposedSequenceNumber).toBe(9);
    expect(r.fixedAssignments[0]?.proposedSequenceNumber).toBe(8);
  });
  it("avoids exhausted PostgreSQL integer slots without wrapping or blocking other dates or maids", async () => {
    const s = snapshot([
      target("old", { serviceDate: "2037-01-04" }),
      target("new"),
    ]);
    s.sequenceReservations = [{
      maidProfileId: "a",
      serviceDate: "2037-01-04",
      maxSequenceNumber: 2147483647,
    }];
    const r = await optimizeAssignmentPreview(s, "exhausted");
    expect(
      r.proposedAssignments.find((row) => row.cleaningTargetId === "old")
        ?.maidProfileId,
    ).toBe("b");
    s.maids = s.maids.slice(0, 1);
    const only = await optimizeAssignmentPreview(s, "only-a");
    expect(only.proposedAssignments).toMatchObject([{
      cleaningTargetId: "new",
      proposedSequenceNumber: 1,
    }]);
    expect(only.remainingUnassignedTargets).toEqual([{
      cleaningTargetId: "old",
      reason: "NO_ELIGIBLE_MAID",
      reasonCodes: ["NO_FEASIBLE_ASSIGNMENT"],
    }]);
    expect(only.diagnostics).toMatchObject({
      fixedExcludedMaidCount: 0, eligibleMaidCount: 1, fixedExclusions: [],
    });
    s.sequenceReservations = [{
      maidProfileId: "a",
      serviceDate: "2037-01-04",
      maxSequenceNumber: 2147483646,
    }];
    const last = await optimizeAssignmentPreview(s, "last-int");
    expect(
      last.proposedAssignments.find((row) => row.cleaningTargetId === "old")
        ?.proposedSequenceNumber,
    )
      .toBe(2147483647);
  });
  it.each([
    null,
    {},
    [{
      maidProfileId: "unknown",
      serviceDate: "2037-01-05",
      maxSequenceNumber: 1,
    }],
    [{ maidProfileId: "a", serviceDate: "2037-02-30", maxSequenceNumber: 1 }],
    [{ maidProfileId: "a", serviceDate: "2037-01-06", maxSequenceNumber: 1 }],
    ...[0, -1, 1.5, NaN, 2147483648, "1"].map((
      maxSequenceNumber,
    ) => [{
      maidProfileId: "a",
      serviceDate: "2037-01-05",
      maxSequenceNumber,
    }]),
    [
      { maidProfileId: "a", serviceDate: "2037-01-05", maxSequenceNumber: 1 },
      { maidProfileId: "a", serviceDate: "2037-01-05", maxSequenceNumber: 2 },
    ],
  ])(
    "rejects malformed or duplicate sequence occupancy %j",
    async (sequenceReservations) => {
      await expect(
        optimizeAssignmentPreview({
          ...snapshot([target("new")]),
          sequenceReservations,
        }, "invalid"),
      )
        .rejects.toMatchObject({ code: "ASSIGNMENT_PREVIEW_SNAPSHOT_INVALID" });
    },
  );
  it("fails closed beyond 1000 occupied maid/date groups without dropping slots", async () => {
    const s = snapshot(Array.from({ length: 10 }, (_, i) =>
      target(`old-${i}`, {
        serviceDate: new Date(Date.UTC(2036, 11, 26 + i)).toISOString().slice(
          0,
          10,
        ),
      })));
    const prototype = required(s.maids[0]);
    s.maids = Array.from({ length: 100 }, (_, i) => ({
      ...prototype,
      maidProfileId: `maid-${i}`,
      available: i === 0,
    }));
    s.sequenceReservations = s.maids.flatMap((maid) =>
      s.targets.map((t) => ({
        maidProfileId: maid.maidProfileId,
        serviceDate: t.serviceDate,
        maxSequenceNumber: 5,
      }))
    );
    expect((await optimizeAssignmentPreview(s, "at-limit")).proposedAssignments)
      .toHaveLength(10);
    await expect(
      optimizeAssignmentPreview({
        ...s,
        sequenceReservations: [
          ...s.sequenceReservations,
          required(s.sequenceReservations[0]),
        ],
      }, "above-limit"),
    ).rejects.toMatchObject({ code: "ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED" });
  });
  it("does not offer follow-up work when an active attempt no longer matches its fixed assignment", async () => {
    const stale = fixed("stale", "a", 1, { status: "in_progress" });
    stale.activeAttempt = {
      attemptId: "other-owner-attempt",
      maidProfileId: "b",
      status: "in_progress",
      startedAt: time("10:00"),
      endedAt: null,
    };
    const s = snapshot([stale, target("later")]);
    s.maids = s.maids.slice(0, 1);
    const r = await optimizeAssignmentPreview(s, "owner-check");
    expect(r.proposedAssignments).toEqual([]);
    expect(r.diagnostics.fixedExclusions).toEqual([{
      maidProfileId: "a", cleaningTargetId: "stale",
      reasonCodes: ["FIXED_ATTEMPT_OWNER_MISMATCH"],
    }]);
    expect(r.remainingUnassignedTargets).toEqual([{
      cleaningTargetId: "later",
      reason: "NO_ELIGIBLE_MAID",
      reasonCodes: ["FIXED_ASSIGNMENT_CONFLICT"],
    }]);
  });
  it("rejects a running attempt without immutable assignment provenance instead of diagnosing a fabricated fixed row", async () => {
    const orphan = target("orphan", {
      status: "in_progress",
      activeAttempt: {
        attemptId: "orphan-attempt", maidProfileId: "a", status: "in_progress",
        startedAt: time("10:00"), endedAt: null,
      },
    });
    await expect(optimizeAssignmentPreview(snapshot([orphan]), "orphan"))
      .rejects.toMatchObject({ code: "ASSIGNMENT_PREVIEW_SNAPSHOT_INVALID" });
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
  it("preserves explicit windows without fabricating duration or day-end", async () => {
    const s = snapshot([
      target("late", { availableFrom: time("17:45"), dueAt: time("18:00") }),
      target("null", { dueAt: null, availableFrom: time("22:00") }),
    ]);
    const r = await optimizeAssignmentPreview(s, "s");
    expect(r.proposedAssignments.map((x) => x.cleaningTargetId).sort()).toEqual([
      "late",
      "null",
    ]);
    expect(r.proposedAssignments.find((x) => x.cleaningTargetId === "null")?.dueAt).toBeNull();
    const cross = await optimizeAssignmentPreview(
      snapshot([
        target("cross", { dueAt: null, availableFrom: time("23:45") }),
      ]),
      "s",
    );
    expect(cross.proposedAssignments).toHaveLength(1);
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
  it("uses a deterministic final tie-break independent of seed", async () => {
    const s = snapshot([target("new")]),
      results = await Promise.all(
        Array.from(
          { length: 12 },
          (_, i) => optimizeAssignmentPreview(s, `seed-${i}`),
        ),
      );
    expect(
      new Set(results.map((r) => r.proposedAssignments[0]?.maidProfileId)).size,
    ).toBe(1);
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
  it("does not simulate duration or reject an otherwise valid overdue candidate", async () => {
    const s = snapshot([
      fixed("old", "a", 1, { dueAt: time("18:00") }),
      target("new", { dueAt: time("12:30") }),
    ]);
    s.maids = s.maids.slice(0, 1);
    s.planningAt = time("12:00");
    expect((await optimizeAssignmentPreview(s, "s")).proposedAssignments)
      .toHaveLength(1);
    s.targets = [target("past", { dueAt: time("11:00") })];
    const overdue = await optimizeAssignmentPreview(s, "s");
    expect(overdue.proposedAssignments).toMatchObject([{
      cleaningTargetId: "past", availableFrom: time("10:00"), dueAt: time("11:00"),
    }]);
    expect(overdue.blockedTargets).toEqual([]);
    s.targets = [target("boundary", { dueAt: s.planningAt })];
    expect((await optimizeAssignmentPreview(s, "s")).proposedAssignments)
      .toHaveLength(1);
    s.targets = [target("invalid", { dueAt: time("10:00") })];
    expect((await optimizeAssignmentPreview(s, "s")).blockedTargets)
      .toEqual([{ cleaningTargetId: "invalid", reason: "ASSIGNMENT_PREVIEW_INVALID_SCHEDULE" }]);
    s.targets = [target("occupied", { dueAt: time("11:00"), blockedReason: "ASSIGNMENT_PREVIEW_SOURCE_INVALID" })];
    expect((await optimizeAssignmentPreview(s, "s")).proposedAssignments)
      .toHaveLength(0);
  });
  it("does not infer an interval for open-deadline reservation occupancy", async () => {
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
      .toHaveLength(1);
  });
  it("does not require a room type duration", async () => {
    const s = snapshot([
      fixed("old", "a", 1, { roomTypeCode: "unknown" }),
      target("bad", { roomTypeCode: "unknown" }),
      target("good"),
    ]);
    const r = await optimizeAssignmentPreview(s, "s");
    expect(r.fixedAssignments[0]?.durationMinutes).toBeNull();
    expect(r.blockedTargets).toHaveLength(0);
    expect(r.proposedAssignments).toHaveLength(2);
    expect(r.proposedAssignments.every((row) => row.durationMinutes === null)).toBe(true);
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
    expect(r.diagnostics.fixedExclusions).toEqual([]);
    expect(r.diagnostics.eligibleMaidCount).toBe(1);
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
  it("does not block a maid using a fabricated delayed interval", async () => {
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
      .toHaveLength(1);
  });
});
