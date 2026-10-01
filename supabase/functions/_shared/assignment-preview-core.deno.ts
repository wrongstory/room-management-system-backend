import {
  optimizeAssignmentPreview,
  type PreviewTarget,
} from "./assignment-preview-core.ts";

Deno.test("preview core works without duration policy", async () => {
  const result = await optimizeAssignmentPreview({
    serviceDate: "2037-01-05",
    planningAt: "2037-01-05T09:00:00+09:00",
    durationPolicy: null,
    maids: [],
    targets: [],
  }, "test");
  if (
    !result.decisionReady || result.durationPolicy !== null ||
    result.durationPolicyStatus !== "retired" || result.durationPolicyRequired
  ) throw new Error("Retired duration policy contract failure");
});

Deno.test("overdue planning preserves original date slots and uses today's availability", async () => {
  const makeTarget = (id: string, serviceDate: string): PreviewTarget => ({
    cleaningTargetId: id,
    roomId: `room-${id}`,
    roomNumber: "601",
    roomTypeCode: "standard",
    elevatorZone: "A",
    feeSnapshot: 30000,
    availableFrom: `${serviceDate}T10:00:00+09:00`,
    dueAt: `${serviceDate}T18:00:00+09:00`,
    serviceDate,
    status: "unassigned",
    assignmentVersion: 1,
    source: "manual_room_request",
    cleaningKind: "additional",
    domainIdentity: null,
    blockedReason: null,
    recleanMaidProfileId: null,
    currentAssignment: null,
    activeAttempt: null,
  });
  const old = makeTarget("old", "2037-01-04");
  const current = makeTarget("today", "2037-01-05");
  for (const t of [old, current]) {
    t.status = "draft_assigned";
    t.currentAssignment = {
      assignmentId: `assignment-${t.cleaningTargetId}`,
      maidProfileId: "maid",
      sequenceNumber: 1,
      revision: 1,
      serviceDate: t.serviceDate,
      availableFrom: t.availableFrom,
      dueAt: t.dueAt,
      targetAssignmentVersion: 1,
    };
  }
  const unassigned = makeTarget("unassigned-old", "2037-01-03");
  const snapshot = {
    serviceDate: "2037-01-05",
    planningAt: "2037-01-04T15:00:00Z",
    maids: [{
      maidProfileId: "maid",
      maidDisplayName: "maid",
      role: "maid",
      status: "active",
      availabilityVersion: 4,
      available: true,
    }],
    targets: [old, current, unassigned],
  };
  const before = JSON.stringify(snapshot);
  const r = await optimizeAssignmentPreview(snapshot, "cross-day");
  if (
    r.fixedAssignments.length !== 2 || r.proposedAssignments.length !== 1 ||
    r.proposedAssignments[0]?.serviceDate !== "2037-01-03" ||
    r.proposedAssignments[0]?.proposedSequenceNumber !== 2 ||
    JSON.stringify(snapshot) !== before
  ) throw new Error("Cross-day snapshot changed or lost");
  const occupied = await optimizeAssignmentPreview({
    ...snapshot,
    sequenceReservations: [{
      maidProfileId: "maid",
      serviceDate: "2037-01-03",
      maxSequenceNumber: 9,
    }],
  }, "occupied");
  if (
    occupied.proposedAssignments[0]?.proposedSequenceNumber !== 10 ||
    occupied.proposedAssignments[0]?.serviceDate !== "2037-01-03" ||
    occupied.inputFingerprint === r.inputFingerprint ||
    JSON.stringify(occupied.objectiveScore) !==
      JSON.stringify(r.objectiveScore) ||
    "sequenceReservations" in occupied || JSON.stringify(snapshot) !== before
  ) {
    throw new Error(
      "Terminal occupancy leaked, changed fee load or lost original slot",
    );
  }
  const exhausted = await optimizeAssignmentPreview({
    ...snapshot,
    sequenceReservations: [{
      maidProfileId: "maid",
      serviceDate: "2037-01-03",
      maxSequenceNumber: 2147483647,
    }],
  }, "exhausted");
  if (
    exhausted.proposedAssignments.length !== 0 ||
    exhausted.remainingUnassignedTargets[0]?.cleaningTargetId !==
      "unassigned-old"
  ) throw new Error("Exhausted sequence integer wrapped or lost candidate");
  const tomorrow = await optimizeAssignmentPreview({
    ...snapshot,
    serviceDate: "2037-01-06",
  }, "tomorrow");
  if (
    tomorrow.proposedAssignments.length !== 0 ||
    tomorrow.blockedTargets[0]?.reason !== "SERVICE_DATE_MISMATCH"
  ) {
    throw new Error("Past candidate moved to tomorrow");
  }
  const unavailable = await optimizeAssignmentPreview({
    ...snapshot,
    maids: snapshot.maids.map((m) => ({ ...m, available: false })),
  }, "unavailable");
  if (unavailable.proposedAssignments.length !== 0) {
    throw new Error("Today's availability ignored");
  }
});
Deno.test("preview core canonical fingerprint and seed reproducibility are runtime neutral", async () => {
  const snapshot = {
    serviceDate: "2037-01-05",
    planningAt: "2037-01-05T09:00:00+09:00",
    durationPolicy: {
      version: 1,
      status: "confirmed",
      standardMinutes: 30,
      premiumMinutes: 40,
      oceanPremiumMinutes: 50,
      oceanFamilyMinutes: 60,
    },
    maids: [],
    targets: [],
  };
  const first = await optimizeAssignmentPreview(snapshot, "seed"),
    second = await optimizeAssignmentPreview(snapshot, "seed");
  if (
    JSON.stringify(first) !== JSON.stringify(second) || !first.decisionReady ||
    first.inputFingerprint.length !== 64
  ) throw new Error("Preview reproducibility failure");
});

Deno.test("historical duration policy does not affect preview fingerprint", async () => {
  const base = {
    serviceDate: "2037-01-05",
    planningAt: "2037-01-05T09:00:00+09:00",
    maids: [],
    targets: [],
  };
  const withoutPolicy = await optimizeAssignmentPreview(base, "a");
  const withPolicy = await optimizeAssignmentPreview({
    ...base,
    durationPolicy: {
      version: 99,
      status: "confirmed",
      standardMinutes: 1,
      premiumMinutes: 2,
      oceanPremiumMinutes: 3,
      oceanFamilyMinutes: 4,
    },
  }, "b");
  if (withoutPolicy.inputFingerprint !== withPolicy.inputFingerprint) {
    throw new Error("Historical policy influenced preview fingerprint");
  }
});
