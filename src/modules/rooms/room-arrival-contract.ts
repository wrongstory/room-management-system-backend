/** Actual arrival is independent from legacy scheduled occupancy. */
export interface RoomArrival {
  status:
    | "NONE"
    | "SCHEDULED"
    | "CHECKIN_PENDING"
    | "CHECKED_IN"
    | "ROOM_MOVE_PENDING";
  checkInReady: boolean | null;
  reasonCodes: string[] | null;
  actualCheckInAt: string | null;
  recordedAt: string | null;
}

const statuses = new Set([
  "NONE",
  "SCHEDULED",
  "CHECKIN_PENDING",
  "CHECKED_IN",
  "ROOM_MOVE_PENDING",
]);
const reasons = new Set([
  "OCCUPIED",
  "RESERVATION_CURRENT",
  "CLEANING_REQUIRED",
  "CANDLE_PRESENT",
  "OPERATION_BLOCKED",
  "ROOM_ISSUE_BLOCKED",
  "DATA_UNCONFIRMED",
  "PIN_MISMATCH",
  "CHECKOUT_NOT_COMPLETED",
  "ROOM_INACTIVE",
]);
const timestamp = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === "string" && /T| /.test(value) &&
    Number.isFinite(Date.parse(value)));

export function parseRoomArrival(value: unknown): RoomArrival | null {
  // Historical projections and pre-upgrade fixture rows contain no actual facts.
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ROOM_ARRIVAL_INVALID");
  }
  const row = value as Record<string, unknown>;
  if (
    !statuses.has(String(row.status)) ||
    !(row.checkInReady === null || typeof row.checkInReady === "boolean") ||
    !(row.reasonCodes === null || (Array.isArray(row.reasonCodes) &&
      row.reasonCodes.every((code) =>
        typeof code === "string" && reasons.has(code)
      ))) ||
    !timestamp(row.actualCheckInAt) || !timestamp(row.recordedAt)
  ) throw new Error("ROOM_ARRIVAL_INVALID");
  const codes = row.reasonCodes as string[] | null;
  if (
    (row.checkInReady === null) !== (codes === null) ||
    (row.checkInReady !== null && row.checkInReady !== (codes?.length === 0)) ||
    (row.status === "CHECKED_IN" || row.status === "ROOM_MOVE_PENDING") !==
      (row.actualCheckInAt !== null) ||
    (row.status === "NONE") !== (row.recordedAt === null) ||
    (["NONE", "CHECKED_IN", "ROOM_MOVE_PENDING"].includes(String(row.status)) &&
      row.checkInReady !== null) ||
    (row.status === "CHECKIN_PENDING" && row.checkInReady === null)
  ) throw new Error("ROOM_ARRIVAL_INVALID");
  return {
    status: row.status as RoomArrival["status"],
    checkInReady: row.checkInReady as boolean | null,
    reasonCodes: codes === null ? null : [...codes],
    actualCheckInAt: row.actualCheckInAt,
    recordedAt: row.recordedAt,
  };
}
