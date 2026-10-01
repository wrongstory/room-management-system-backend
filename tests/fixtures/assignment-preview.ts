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

/** #308/#320 integration: historical dates/slots remain distinct on today's board. */
export function mixedDatePreviewSnapshot(serviceDate: string) {
  const base = zeroPreviewSnapshot(serviceDate);
  const past = new Date(Date.parse(`${serviceDate}T00:00:00Z`) - 86_400_000)
    .toISOString().slice(0, 10);
  const firstMaid = base.maids[0];
  if (!firstMaid) throw new Error("Synthetic fixture requires one maid");
  const maidId = firstMaid.maidProfileId;
  return {
    ...base,
    maids: base.maids.map((m) => ({
      ...m,
      availabilityVersion: 7,
      available: true,
    })),
    targets: base.targets.map((t, i) => {
      const originalDate = i === 0 || i === 2 ? past : serviceDate;
      const availableFrom = `${originalDate}T08:00:00+09:00`;
      const dueAt = `${originalDate}T08:30:00+09:00`;
      return {
        ...t,
        serviceDate: originalDate,
        availableFrom,
        dueAt,
        status: i < 2 ? "draft_assigned" : "unassigned",
        domainIdentity: { privateSentinel: "private-source-not-for-response" },
        currentAssignment: i < 2
          ? {
            assignmentId: `50000000-0000-4000-8000-${
              String(i + 1).padStart(12, "0")
            }`,
            maidProfileId: maidId,
            sequenceNumber: 1,
            revision: 1,
            serviceDate: originalDate,
            availableFrom,
            dueAt,
            targetAssignmentVersion: 1,
          }
          : null,
      };
    }),
    sequenceReservations: [
      { maidProfileId: maidId, serviceDate: past, maxSequenceNumber: 10 },
      { maidProfileId: maidId, serviceDate, maxSequenceNumber: 20 },
    ],
  };
}
