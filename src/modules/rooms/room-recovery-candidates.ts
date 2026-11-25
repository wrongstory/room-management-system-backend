interface LiveRoom {
  id: string;
  roomNumber: string;
  evaluatedAt: string;
  projectionMode: string;
  displayStatusOverride: string | null;
  readinessStatus: string;
  readinessReasonCodes: string[];
  arrival:
    | { checkInReady: boolean | null; reasonCodes: string[] | null }
    | null;
}

export function roomRecoveryCandidates(rooms: LiveRoom[]) {
  const evaluatedAt = rooms[0]?.evaluatedAt ?? new Date().toISOString();
  const candidates = [];
  const seen = new Set<string>();
  for (const room of rooms) {
    if (
      room.projectionMode !== "LIVE" || !room.id || !room.roomNumber ||
      !Number.isFinite(Date.parse(room.evaluatedAt)) ||
      room.evaluatedAt !== evaluatedAt ||
      typeof room.displayStatusOverride === "undefined" ||
      !["READY", "CLEANING_REQUIRED", "CHECKIN_BLOCKED"].includes(
        room.readinessStatus,
      ) ||
      !Array.isArray(room.readinessReasonCodes) || seen.has(room.id)
    ) {
      throw new Error("Invalid live room projection");
    }
    seen.add(room.id);
    if (
      room.displayStatusOverride === "READY" &&
      room.readinessStatus !== "READY" &&
      (room.readinessReasonCodes.includes("CLEANING_REQUIRED") ||
        (room.arrival?.checkInReady === false &&
          room.arrival.reasonCodes?.includes("CLEANING_REQUIRED")))
    ) {
      candidates.push({
        roomId: room.id,
        roomNumber: room.roomNumber,
        displayStatus: "READY",
        readinessStatus: room.readinessStatus,
        reasonCodes: ["CLEANING_REQUIRED"],
        recommendedAction: "PREVIEW_READY_CORRECTION",
      });
    }
  }
  return { evaluatedAt, candidates };
}
