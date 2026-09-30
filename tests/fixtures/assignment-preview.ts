/** Synthetic shared Fastify/Edge regression for #320; no operational data. */
export function zeroPreviewSnapshot(serviceDate: string) {
  return {
    serviceDate,
    planningAt: `${serviceDate}T09:00:00+09:00`,
    maids: [{
      maidProfileId: "20000000-0000-4000-8000-000000000002",
      maidDisplayName: "합성 메이드",
      role: "maid",
      status: "active",
      availabilityVersion: null,
      available: false,
    }],
    targets: Array.from({ length: 12 }, (_, i) => ({
      cleaningTargetId: `30000000-0000-4000-8000-${
        String(i + 1).padStart(12, "0")
      }`,
      roomId: `40000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      roomNumber: String(601 + i),
      roomTypeCode: "standard",
      elevatorZone: "A",
      feeSnapshot: 30000,
      availableFrom: `${serviceDate}T10:00:00+09:00`,
      dueAt: null,
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
    })),
  };
}
