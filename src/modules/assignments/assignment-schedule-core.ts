/** Read-only schedule facts. Never use these display fields as command authority. */
export interface AssignmentScheduleSnapshot {
  capturedAt: string;
  scheduleRevision: number;
  scheduleReasonCode: string;
  sourceReservationVersion: number | null;
  plannedCheckoutAt: string | null;
  actualCheckoutAt: string | null;
  plannedRoomDepartureAt: string | null;
  actualRoomDepartureAt: string | null;
  nextCheckInAt: string | null;
  nextRoomArrivalAt: string | null;
  nextArrivalKind: "check_in" | "room_move" | null;
  isEarlyCheckIn: boolean | null;
  isLateCheckout: boolean | null;
  isScheduleUpdated: boolean;
}
export interface AssignmentCurrentDeparture {
  evaluatedAt: string;
  actualCheckoutAt: string | null;
  actualRoomDepartureAt: string | null;
}
export interface AssignmentScheduleRead {
  planningDate?: string;
  scheduleSnapshot: AssignmentScheduleSnapshot | null;
  currentDeparture: AssignmentCurrentDeparture | null;
}
export class AssignmentScheduleReadError extends Error {
  constructor() {
    super("ASSIGNMENT_SCHEDULE_READ_INVALID");
  }
}
const timePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssignmentScheduleReadError();
  }
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new AssignmentScheduleReadError();
  }
}
function time(value: unknown): string {
  if (
    typeof value !== "string" || !timePattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new AssignmentScheduleReadError();
  }
  // Date.parse normalizes invalid dates and overflowing hours. Do not accept
  // normalized calendar facts as an actual recorded instant.
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!parts) throw new AssignmentScheduleReadError();
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  if (
    year === undefined || month === undefined || day === undefined ||
    hour === undefined ||
    minute === undefined || second === undefined || month < 1 || month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 ||
    minute > 59 || second > 59
  ) {
    throw new AssignmentScheduleReadError();
  }
  return value;
}
function nullableTime(value: unknown): string | null {
  return value === null ? null : time(value);
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new AssignmentScheduleReadError();
  }
  return value as number;
}
function nullableBoolean(value: unknown): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  throw new AssignmentScheduleReadError();
}
const snapshotKeys = [
  "capturedAt",
  "scheduleRevision",
  "scheduleReasonCode",
  "sourceReservationVersion",
  "plannedCheckoutAt",
  "actualCheckoutAt",
  "plannedRoomDepartureAt",
  "actualRoomDepartureAt",
  "nextCheckInAt",
  "nextRoomArrivalAt",
  "nextArrivalKind",
  "isEarlyCheckIn",
  "isLateCheckout",
  "isScheduleUpdated",
];
function snapshot(value: unknown): AssignmentScheduleSnapshot | null {
  if (value === null) return null;
  const row = record(value);
  exactKeys(row, snapshotKeys);
  if (
    typeof row.scheduleReasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,79}$/.test(row.scheduleReasonCode) ||
    ![null, "check_in", "room_move"].includes(row.nextArrivalKind as never) ||
    typeof row.isScheduleUpdated !== "boolean"
  ) throw new AssignmentScheduleReadError();
  return {
    capturedAt: time(row.capturedAt),
    scheduleRevision: positive(row.scheduleRevision),
    scheduleReasonCode: row.scheduleReasonCode,
    sourceReservationVersion: row.sourceReservationVersion === null
      ? null
      : positive(row.sourceReservationVersion),
    plannedCheckoutAt: nullableTime(row.plannedCheckoutAt),
    actualCheckoutAt: nullableTime(row.actualCheckoutAt),
    plannedRoomDepartureAt: nullableTime(row.plannedRoomDepartureAt),
    actualRoomDepartureAt: nullableTime(row.actualRoomDepartureAt),
    nextCheckInAt: nullableTime(row.nextCheckInAt),
    nextRoomArrivalAt: nullableTime(row.nextRoomArrivalAt),
    nextArrivalKind: row
      .nextArrivalKind as AssignmentScheduleSnapshot["nextArrivalKind"],
    isEarlyCheckIn: nullableBoolean(row.isEarlyCheckIn),
    isLateCheckout: nullableBoolean(row.isLateCheckout),
    isScheduleUpdated: row.isScheduleUpdated,
  };
}
function departure(value: unknown): AssignmentCurrentDeparture | null {
  if (value === null) return null;
  const row = record(value);
  exactKeys(row, ["evaluatedAt", "actualCheckoutAt", "actualRoomDepartureAt"]);
  const result = {
    evaluatedAt: time(row.evaluatedAt),
    actualCheckoutAt: nullableTime(row.actualCheckoutAt),
    actualRoomDepartureAt: nullableTime(row.actualRoomDepartureAt),
  };
  if (
    [result.actualCheckoutAt, result.actualRoomDepartureAt].some((at) =>
      at !== null && Date.parse(at) > Date.parse(result.evaluatedAt)
    )
  ) throw new AssignmentScheduleReadError();
  return result;
}
/** All-or-nothing exact-ID response, including null legacy facts. Never silently
 * lose rows on a truncated RPC result or forward internal lineage/PII fields. */
export function parseAssignmentScheduleReads(
  value: unknown,
  assignmentIds: string[],
  includeCurrent: boolean,
): Map<string, AssignmentScheduleRead> {
  if (
    !Array.isArray(value) || value.length !== assignmentIds.length ||
    assignmentIds.length < 1 || assignmentIds.length > 100 ||
    new Set(assignmentIds).size !== assignmentIds.length
  ) {
    throw new AssignmentScheduleReadError();
  }
  const ids = new Set(assignmentIds),
    result = new Map<string, AssignmentScheduleRead>();
  for (const item of value) {
    const row = record(item);
    exactKeys(row, [
      "assignmentId",
      "scheduleSnapshot",
      "currentDeparture",
      ...(Object.hasOwn(row, "planningDate") ? ["planningDate"] : []),
    ]);
    if (
      Object.hasOwn(row, "planningDate") &&
      (typeof row.planningDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(row.planningDate) ||
        !Number.isFinite(Date.parse(row.planningDate)) ||
        new Date(row.planningDate).toISOString().slice(0, 10) !==
          row.planningDate)
    ) {
      throw new AssignmentScheduleReadError();
    }
    if (
      typeof row.assignmentId !== "string" || !ids.has(row.assignmentId) ||
      result.has(row.assignmentId) ||
      (!includeCurrent && row.currentDeparture !== null)
    ) throw new AssignmentScheduleReadError();
    result.set(row.assignmentId, {
      ...(Object.hasOwn(row, "planningDate")
        ? { planningDate: row.planningDate as string }
        : {}),
      scheduleSnapshot: snapshot(row.scheduleSnapshot),
      currentDeparture: departure(row.currentDeparture),
    });
  }
  return result;
}
