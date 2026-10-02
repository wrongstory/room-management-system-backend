/** I/O 없는 배정 초안 계산기. Fastify와 Edge가 같은 구현을 공유한다. */
export class AssignmentPreviewError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Safe, snapshot-only display metadata. It is never command authority. */
export interface AssignmentReadMetadata {
  cleaningKind: string | null;
  sourceKind: string | null;
  roomTypeCode: string | null;
  roomTypeName: string | null;
  elevatorZone: string | null;
  roomTypeSnapshot: {
    code: string | null;
    name: string | null;
    elevatorZone: string | null;
  } | null;
  feeSnapshot: number | null;
  originalServiceDate: string | null;
  effectiveServiceDate: string | null;
  rolloverCount: number | null;
  rolloverReason: "ROLLED_OVER_UNASSIGNED" | "ROLLED_OVER_NOT_STARTED" | null;
  canCancel: boolean;
  cancelReasonCode: CancelReasonCode | null;
}
export type CancelReasonCode =
  | "NOT_MANUAL_CLEANING_REQUEST"
  | "CLEANING_REQUEST_CANCEL_CONFLICT"
  | "ASSIGNMENT_NOT_CURRENT"
  | "ADMIN_REQUIRED"
  | "CAPABILITY_UNAVAILABLE";
export class AssignmentReadMetadataError extends Error {}
const cancelReasons = new Set<CancelReasonCode>([
  "NOT_MANUAL_CLEANING_REQUEST",
  "CLEANING_REQUEST_CANCEL_CONFLICT",
  "ASSIGNMENT_NOT_CURRENT",
  "ADMIN_REQUIRED",
  "CAPABILITY_UNAVAILABLE",
]);
const readMetadataKeys = [
  "cleaningKind",
  "sourceKind",
  "roomTypeCode",
  "roomTypeName",
  "elevatorZone",
  "roomTypeSnapshot",
  "feeSnapshot",
  "originalServiceDate",
  "effectiveServiceDate",
  "rolloverCount",
  "rolloverReason",
  "canCancel",
  "cancelReasonCode",
] as const;
const previewMetadataKeys = readMetadataKeys.filter((key) =>
  !["cleaningKind", "roomTypeCode", "elevatorZone", "feeSnapshot"].includes(key)
);
function metadataInvalid(): never {
  throw new AssignmentReadMetadataError("ASSIGNMENT_READ_METADATA_INVALID");
}
function metadataText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.length) {
    metadataInvalid();
  }
  return value;
}
function metadataDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    metadataInvalid();
  }
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  ) {
    metadataInvalid();
  }
  return value;
}
export function parseRoomTypeSnapshot(
  value: unknown,
): AssignmentReadMetadata["roomTypeSnapshot"] {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    metadataInvalid();
  }
  const row = value as Record<string, unknown>;
  // Match the SQL stored-snapshot projection: absent, empty and ill-typed
  // optional attributes are unknown, never catalog defaults. Preserve actual
  // strings without inventing a display limit absent from the stored contract.
  const storedText = (attribute: unknown) =>
    typeof attribute === "string" && attribute.length > 0
      ? metadataText(attribute)
      : null;
  return {
    code: storedText(row.code),
    name: storedText(row.name),
    elevatorZone: storedText(row.elevatorZone),
  };
}
function parseCanonicalRoomTypeSnapshot(
  value: unknown,
): AssignmentReadMetadata["roomTypeSnapshot"] {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    metadataInvalid();
  }
  const row = value as Record<string, unknown>;
  if (
    !["code", "name", "elevatorZone"].every((key) => Object.hasOwn(row, key))
  ) {
    metadataInvalid();
  }
  // Fresh metadata is canonical nullable text. Do not let historical raw
  // normalization conceal corruption of a supplied new response/receipt.
  return {
    code: metadataText(row.code),
    name: metadataText(row.name),
    elevatorZone: metadataText(row.elevatorZone),
  };
}
/** Legacy receipts are not enriched from live tables. Partial new packs are invalid. */
export function parseAssignmentReadMetadata(
  row: Record<string, unknown>,
  preview = false,
): AssignmentReadMetadata {
  const keys = preview ? previewMetadataKeys : readMetadataKeys;
  if (!keys.some((key) => Object.hasOwn(row, key))) {
    return {
      cleaningKind: preview ? metadataText(row.cleaningKind) : null,
      sourceKind: preview ? metadataText(row.source) : null,
      roomTypeCode: null,
      roomTypeName: null,
      elevatorZone: null,
      roomTypeSnapshot: null,
      feeSnapshot: preview ? row.feeSnapshot as number : null,
      originalServiceDate: null,
      effectiveServiceDate: null,
      rolloverCount: null,
      rolloverReason: null,
      canCancel: false,
      cancelReasonCode: "CAPABILITY_UNAVAILABLE",
    };
  }
  if (!keys.every((key) => Object.hasOwn(row, key))) metadataInvalid();
  const room = parseCanonicalRoomTypeSnapshot(row.roomTypeSnapshot);
  const roomTypeCode = metadataText(row.roomTypeCode),
    roomTypeName = metadataText(row.roomTypeName),
    elevatorZone = metadataText(row.elevatorZone);
  if (
    roomTypeName !== (room?.name ?? null) ||
    (!preview &&
      (roomTypeCode !== (room?.code ?? null) ||
        elevatorZone !== (room?.elevatorZone ?? null)))
  ) metadataInvalid();
  const fee = row.feeSnapshot,
    count = row.rolloverCount,
    reason = row.rolloverReason;
  if (fee !== null && (!Number.isSafeInteger(fee) || (fee as number) < 0)) {
    metadataInvalid();
  }
  if (
    count !== null && (!Number.isSafeInteger(count) || (count as number) < 0)
  ) metadataInvalid();
  if (
    (reason !== null && reason !== "ROLLED_OVER_UNASSIGNED" &&
      reason !== "ROLLED_OVER_NOT_STARTED") ||
    ((count === null || count === 0) && reason !== null) ||
    (typeof count === "number" && count > 0 && reason === null) ||
    typeof row.canCancel !== "boolean" ||
    (row.canCancel
      ? row.cancelReasonCode !== null
      : !cancelReasons.has(row.cancelReasonCode as CancelReasonCode))
  ) metadataInvalid();
  const sourceKind = metadataText(row.sourceKind);
  if (preview && sourceKind !== row.source) metadataInvalid();
  return {
    cleaningKind: metadataText(row.cleaningKind),
    sourceKind,
    roomTypeCode: room?.code ?? null,
    roomTypeName,
    elevatorZone: room?.elevatorZone ?? null,
    roomTypeSnapshot: room,
    feeSnapshot: fee as number | null,
    originalServiceDate: metadataDate(row.originalServiceDate),
    effectiveServiceDate: metadataDate(row.effectiveServiceDate),
    rolloverCount: count as number | null,
    rolloverReason: reason as AssignmentReadMetadata["rolloverReason"],
    canCancel: row.canCancel,
    cancelReasonCode: row.cancelReasonCode as CancelReasonCode | null,
  };
}
/** Mirrors #348's unstarted-current-assignment guard, without PIN history. */
export function assignmentCancellationCapability(
  role: string,
  isCurrent: boolean,
  source: unknown,
  status: unknown,
  attempts: Array<{ status: unknown; started_at?: unknown }>,
): Pick<AssignmentReadMetadata, "canCancel" | "cancelReasonCode"> {
  const denied = (cancelReasonCode: CancelReasonCode) => ({
    canCancel: false,
    cancelReasonCode,
  });
  if (role !== "admin") return denied("ADMIN_REQUIRED");
  if (!isCurrent) return denied("ASSIGNMENT_NOT_CURRENT");
  if (source === null || source === undefined) {
    return denied("CAPABILITY_UNAVAILABLE");
  }
  if (!["manual_room_request", "stayover_request"].includes(source as string)) {
    return denied("NOT_MANUAL_CLEANING_REQUEST");
  }
  if (
    !["unassigned", "draft_assigned", "notified"].includes(status as string)
  ) {
    return denied("CLEANING_REQUEST_CANCEL_CONFLICT");
  }
  for (const attempt of attempts) {
    if (attempt.status === "superseded") continue;
    if (
      typeof attempt.status !== "string" ||
      !Object.hasOwn(attempt, "started_at")
    ) {
      return denied("CAPABILITY_UNAVAILABLE");
    }
    if (attempt.started_at !== null || attempt.status !== "scheduled") {
      return denied("CLEANING_REQUEST_CANCEL_CONFLICT");
    }
  }
  return { canCancel: true, cancelReasonCode: null };
}

export const PREVIEW_LIMITS = {
  targets: 242,
  candidates: 121,
  maids: 1000,
  candidateMaids: 20,
  sequenceReservations: 1000,
  evaluations: 100000,
  passes: 3,
} as const;
type RoomType =
  | "standard"
  | "premium"
  | "oceanPremium"
  | "oceanFamily"
  | "unknown";
export interface PreviewPolicy {
  version: number;
  status: "confirmed";
  standardMinutes: number;
  premiumMinutes: number;
  oceanPremiumMinutes: number;
  oceanFamilyMinutes: number;
}
export interface PreviewMaid {
  maidProfileId: string;
  maidDisplayName: string;
  role: string;
  status: string;
  availabilityVersion: number | null;
  available: boolean;
}
interface CurrentAssignment {
  assignmentId: string;
  maidProfileId: string;
  sequenceNumber: number;
  revision: number;
  serviceDate: string;
  availableFrom: string | null;
  dueAt: string | null;
  targetAssignmentVersion: number;
}
export interface PreviewTarget {
  cleaningTargetId: string;
  roomId: string;
  roomNumber: string;
  roomTypeCode: RoomType;
  elevatorZone: string;
  feeSnapshot: number;
  availableFrom: string;
  dueAt: string | null;
  serviceDate: string;
  status: string;
  assignmentVersion: number;
  source: string;
  cleaningKind: string;
  readMetadata?: AssignmentReadMetadata;
  domainIdentity: unknown;
  blockedReason: string | null;
  recleanMaidProfileId: string | null;
  currentAssignment: CurrentAssignment | null;
  activeAttempt: {
    attemptId: string;
    maidProfileId: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
  } | null;
}
export interface PreviewSnapshot {
  serviceDate: string;
  planningAt: string;
  /** @deprecated Historical input is accepted but never used for preview decisions. */
  durationPolicy?: PreviewPolicy | null;
  durationPolicyStatus?: "retired";
  durationPolicyRequired?: false;
  maids: PreviewMaid[];
  targets: PreviewTarget[];
  /** Internal DB occupancy, including terminal targets; never returned publicly. */
  sequenceReservations?: {
    maidProfileId: string;
    serviceDate: string;
    maxSequenceNumber: number;
  }[];
}
const MAX_SEQUENCE_NUMBER = 2147483647;
interface Score {
  count: number;
  spread: number;
  deviation: bigint;
  zones: number;
  distance: number;
}
type Board = PreviewTarget[][];
export type FixedExclusionReason =
  | "FIXED_SEQUENCE_CONFLICT"
  | "FIXED_SERVICE_DATE_MISMATCH"
  | "FIXED_ASSIGNMENT_VERSION_MISMATCH"
  | "FIXED_SCHEDULE_MISMATCH"
  | "FIXED_SOURCE_BLOCKED"
  | "FIXED_ATTEMPT_OWNER_MISMATCH"
  | "FIXED_ATTEMPT_WORKFLOW_UNRESOLVED";
export type RemainingReason =
  | "NO_ACTIVE_MAID"
  | "AVAILABILITY_NOT_SUBMITTED"
  | "NO_AVAILABLE_MAID"
  | "FIXED_ASSIGNMENT_CONFLICT"
  | "RECLEAN_MAID_UNAVAILABLE"
  | "RECLEAN_MAID_FIXED_ASSIGNMENT_CONFLICT"
  | "NO_FEASIBLE_ASSIGNMENT";
export interface PreviewAssignmentRow {
  cleaningTargetId: string;
  roomId: string;
  roomNumber: string;
  roomTypeCode: string;
  elevatorZone: string;
  maidProfileId: string;
  maidDisplayName: string;
  proposedSequenceNumber: number;
  serviceDate: string;
  expectedAssignmentVersion: number;
  targetAssignmentVersion: number;
  expectedAvailabilityVersion: number | null;
  feeSnapshot: number;
  durationMinutes: number | null;
  availableFrom: string;
  dueAt: string | null;
  cleaningKind: string | null;
  sourceKind: string | null;
  roomTypeName: string | null;
  roomTypeSnapshot: AssignmentReadMetadata["roomTypeSnapshot"];
  originalServiceDate: string | null;
  effectiveServiceDate: string | null;
  rolloverCount: number | null;
  rolloverReason: AssignmentReadMetadata["rolloverReason"];
  canCancel: boolean;
  cancelReasonCode: CancelReasonCode | null;
}
export type PreviewTargetMetadata = Omit<
  PreviewAssignmentRow,
  | "maidProfileId"
  | "maidDisplayName"
  | "proposedSequenceNumber"
  | "expectedAvailabilityVersion"
>;
export interface AssignmentPreviewResult {
  serviceDate: string;
  previewSeed: string;
  durationPolicy: null;
  durationPolicyStatus: "retired";
  durationPolicyRequired: false;
  decisionReady: true;
  inputFingerprint: string;
  fixedAssignments: PreviewAssignmentRow[];
  proposedAssignments: PreviewAssignmentRow[];
  remainingUnassignedTargets: (PreviewTargetMetadata & {
    cleaningTargetId: string;
    reason: string;
    reasonCodes: RemainingReason[];
  })[];
  blockedTargets: (PreviewTargetMetadata & { reason: string })[];
  diagnostics: {
    evaluatedAt: string;
    activeMaidCount: number;
    submittedAvailabilityMaidCount: number;
    availableMaidCount: number;
    fixedExcludedMaidCount: number;
    eligibleMaidCount: number;
    fixedExclusions: {
      maidProfileId: string;
      cleaningTargetId: string;
      reasonCodes: FixedExclusionReason[];
    }[];
  };
  maidSummaries: {
    maidProfileId: string;
    totalFee: number;
    fixedCount: number;
    proposedCount: number;
  }[];
  objectiveScore: {
    completedTargetCount: number;
    feeSpread: number;
    feeDeviation: string;
    routeScore: { zoneChanges: number; roomDistance: number };
  };
}

function invalid(): never {
  throw new AssignmentPreviewError("ASSIGNMENT_PREVIEW_SNAPSHOT_INVALID");
}
function limited(): never {
  throw new AssignmentPreviewError("ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED");
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) invalid();
  return value;
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) invalid();
  return v as Record<string, unknown>;
}
function str(v: unknown, max = 100): string {
  if (typeof v !== "string" || !v.length || v.length > max) invalid();
  return v;
}
function integer(v: unknown, min = 0, max = 1000000): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    invalid();
  }
  return v;
}
function nullableString(v: unknown): string | null {
  return v == null ? null : str(v);
}
function timestamp(v: unknown): string {
  const s = str(v);
  if (!Number.isFinite(Date.parse(s)) || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s)) {
    invalid();
  }
  return s;
}
function date(v: unknown): string {
  const s = str(v), value = Date.parse(`${s}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(value) ||
    new Date(value).toISOString().slice(0, 10) !== s
  ) invalid();
  return s;
}
function canonical(v: unknown, depth = 0): string {
  if (depth > 8) invalid();
  if (v === null || typeof v === "boolean" || typeof v === "number") {
    return JSON.stringify(v);
  }
  if (typeof v === "string") {
    if (v.length > 1000) invalid();
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    if (v.length > 1000) limited();
    return `[${v.map((x) => canonical(x, depth + 1)).join(",")}]`;
  }
  const r = record(v), keys = Object.keys(r).sort();
  if (keys.length > 100) invalid();
  return `{${
    keys.map((k) => `${JSON.stringify(k)}:${canonical(r[k], depth + 1)}`).join(
      ",",
    )
  }}`;
}
async function sha(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
function parseSnapshot(input: unknown): PreviewSnapshot {
  const s = record(input);
  if (!Array.isArray(s.targets) || !Array.isArray(s.maids)) invalid();
  if (
    s.targets.length > PREVIEW_LIMITS.targets ||
    s.maids.length > PREVIEW_LIMITS.maids
  ) limited();
  // Historical policy payloads remain wire-compatible, but deliberately do not
  // participate in validation, fingerprinting, ordering, or feasibility.
  const maids = s.maids.map((value): PreviewMaid => {
    const m = record(value);
    if (typeof m.available !== "boolean") invalid();
    return {
      maidProfileId: str(m.maidProfileId),
      maidDisplayName: str(m.maidDisplayName),
      role: str(m.role),
      status: str(m.status),
      availabilityVersion: m.availabilityVersion == null
        ? null
        : integer(m.availabilityVersion, 1, Number.MAX_SAFE_INTEGER),
      available: m.available,
    };
  }).sort((a, b) => a.maidProfileId.localeCompare(b.maidProfileId));
  const targets = s.targets.map((value): PreviewTarget => {
    const t = record(value),
      suppliedType = t.roomTypeCode == null ? "unknown" : str(t.roomTypeCode),
      rt = ["standard", "premium", "oceanPremium", "oceanFamily"].includes(
          suppliedType,
        )
        ? suppliedType
        : "unknown";
    let assignment: CurrentAssignment | null = null,
      attempt: PreviewTarget["activeAttempt"] = null;
    if (t.currentAssignment != null) {
      const a = record(t.currentAssignment);
      assignment = {
        assignmentId: str(a.assignmentId),
        maidProfileId: str(a.maidProfileId),
        sequenceNumber: integer(a.sequenceNumber, 1, MAX_SEQUENCE_NUMBER),
        revision: integer(a.revision, 1, Number.MAX_SAFE_INTEGER),
        serviceDate: date(a.serviceDate),
        availableFrom: a.availableFrom == null
          ? null
          : timestamp(a.availableFrom),
        dueAt: a.dueAt == null ? null : timestamp(a.dueAt),
        targetAssignmentVersion: integer(
          a.targetAssignmentVersion,
          1,
          Number.MAX_SAFE_INTEGER,
        ),
      };
    }
    if (t.activeAttempt != null) {
      const a = record(t.activeAttempt);
      attempt = {
        attemptId: str(a.attemptId),
        maidProfileId: str(a.maidProfileId),
        status: str(a.status),
        startedAt: a.startedAt == null ? null : timestamp(a.startedAt),
        endedAt: a.endedAt == null ? null : timestamp(a.endedAt),
      };
    }
    // 현재 실행 workload에 담당/순서 정본이 없으면 임의 sequence 0을 만들지 않는다.
    if (attempt !== null && assignment === null) invalid();
    const domainIdentity = t.domainIdentity ?? null;
    canonical(domainIdentity);
    let readMetadata: AssignmentReadMetadata;
    try {
      readMetadata = parseAssignmentReadMetadata(t, true);
    } catch {
      invalid();
    }
    return {
      cleaningTargetId: str(t.cleaningTargetId),
      roomId: str(t.roomId),
      roomNumber: str(t.roomNumber),
      roomTypeCode: rt as RoomType,
      elevatorZone: str(t.elevatorZone),
      feeSnapshot: integer(t.feeSnapshot),
      availableFrom: timestamp(t.availableFrom),
      dueAt: t.dueAt == null ? null : timestamp(t.dueAt),
      serviceDate: date(t.serviceDate),
      status: str(t.status),
      assignmentVersion: integer(
        t.assignmentVersion,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      source: str(t.source),
      cleaningKind: str(t.cleaningKind),
      readMetadata,
      domainIdentity,
      blockedReason: nullableString(t.blockedReason),
      recleanMaidProfileId: nullableString(t.recleanMaidProfileId),
      currentAssignment: assignment,
      activeAttempt: attempt,
    };
  }).sort((a, b) => a.cleaningTargetId.localeCompare(b.cleaningTargetId));
  if (
    new Set(maids.map((m) => m.maidProfileId)).size !== maids.length ||
    new Set(targets.map((t) => t.cleaningTargetId)).size !== targets.length
  ) invalid();
  const rawReservations = s.sequenceReservations === undefined
    ? []
    : s.sequenceReservations;
  if (!Array.isArray(rawReservations)) invalid();
  if (rawReservations.length > PREVIEW_LIMITS.sequenceReservations) limited();
  const maidIds = new Set(maids.map((m) => m.maidProfileId));
  const targetDates = new Set(targets.map((t) => t.serviceDate));
  const reservationKeys = new Set<string>();
  const sequenceReservations = rawReservations.map((value) => {
    const r = record(value);
    const maidProfileId = str(r.maidProfileId),
      serviceDate = date(r.serviceDate);
    const key = JSON.stringify([maidProfileId, serviceDate]);
    if (
      !maidIds.has(maidProfileId) || !targetDates.has(serviceDate) ||
      reservationKeys.has(key)
    ) invalid();
    reservationKeys.add(key);
    return {
      maidProfileId,
      serviceDate,
      maxSequenceNumber: integer(r.maxSequenceNumber, 1, MAX_SEQUENCE_NUMBER),
    };
  }).sort((a, b) =>
    a.maidProfileId.localeCompare(b.maidProfileId) ||
    a.serviceDate.localeCompare(b.serviceDate)
  );
  return {
    serviceDate: date(s.serviceDate),
    planningAt: timestamp(s.planningAt),
    durationPolicy: null,
    durationPolicyStatus: "retired",
    durationPolicyRequired: false,
    maids,
    targets,
    sequenceReservations,
  };
}

/** 금액 편차는 평균의 부동소수점 오차 없이 Σ(n*fee - Σfee)^2 정수로 비교한다. */
function compare(a: Score, b: Score): number {
  if (a.count !== b.count) return b.count - a.count;
  if (a.spread !== b.spread) return a.spread - b.spread;
  if (a.deviation !== b.deviation) return a.deviation < b.deviation ? -1 : 1;
  return a.zones - b.zones || a.distance - b.distance;
}
function boardKey(board: Board): string {
  return JSON.stringify(
    board.map((rows) => rows.map((t) => t.cleaningTargetId)),
  );
}
function clone(board: Board): Board {
  return board.map((rows) => [...rows]);
}
/** 有界 heuristic: deterministic 4-start greedy + 3 improvement passes. 전역 최적성 보증은 하지 않는다. */
export async function optimizeAssignmentPreview(
  input: unknown,
  previewSeed: string,
): Promise<AssignmentPreviewResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(previewSeed)) {
    throw new AssignmentPreviewError("INVALID_PREVIEW_SEED");
  }
  const snapshot = parseSnapshot(input);
  // Planning availability belongs to the requested day, not to the immutable
  // service date of an overdue target. Only today's board accepts past targets.
  const today = new Date(Date.parse(snapshot.planningAt) + 9 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const candidateDateAllowed = (serviceDate: string) =>
    serviceDate === snapshot.serviceDate ||
    (snapshot.serviceDate === today && serviceDate < snapshot.serviceDate);
  const maids = snapshot.maids.filter((m) =>
    m.role === "maid" && m.status === "active" && m.available &&
    m.availabilityVersion !== null
  );
  if (maids.length > PREVIEW_LIMITS.candidateMaids) limited();
  const fixed = snapshot.targets.filter((t) =>
    (t.currentAssignment !== null || t.activeAttempt !== null) &&
    !(t.serviceDate > snapshot.serviceDate &&
      t.activeAttempt?.status === "scheduled")
  );
  const blocked: AssignmentPreviewResult["blockedTargets"] = [];
  const fixedByMaid = maids.map((m) =>
    fixed.filter((t) =>
      (t.currentAssignment?.maidProfileId ?? t.activeAttempt?.maidProfileId) ===
        m.maidProfileId
    ).sort((a, b) =>
      a.serviceDate.localeCompare(b.serviceDate) ||
      (a.currentAssignment?.sequenceNumber ?? 0) -
        (b.currentAssignment?.sequenceNumber ?? 0) ||
      a.cleaningTargetId.localeCompare(b.cleaningTargetId)
    )
  );
  const unavailable = new Set<number>();
  const fixedExclusions:
    AssignmentPreviewResult["diagnostics"]["fixedExclusions"] = [];
  for (let i = 0; i < maids.length; i++) {
    const rows = required(fixedByMaid[i]), seen = new Set<string>();
    for (const t of rows) {
      const a = t.currentAssignment;
      // parseSnapshot rejects attempts without assignment provenance. Do not
      // fabricate a sequence/owner or turn that invalid snapshot into diagnostics.
      if (a === null) invalid();
      const slot = `${a.serviceDate}:${a.sequenceNumber}`;
      const reasons: FixedExclusionReason[] = [];
      if (seen.has(slot)) reasons.push("FIXED_SEQUENCE_CONFLICT");
      if (
        t.serviceDate > snapshot.serviceDate ||
        a.serviceDate !== t.serviceDate
      ) {
        reasons.push("FIXED_SERVICE_DATE_MISMATCH");
      }
      if (a.targetAssignmentVersion !== t.assignmentVersion) {
        reasons.push("FIXED_ASSIGNMENT_VERSION_MISMATCH");
      }
      if (
        a.availableFrom === null ||
        Date.parse(a.availableFrom) !== Date.parse(t.availableFrom) ||
        a.dueAt !== t.dueAt
      ) reasons.push("FIXED_SCHEDULE_MISMATCH");
      if (
        t.blockedReason && !(t.activeAttempt?.status === "in_progress" &&
          t.blockedReason === "ASSIGNMENT_WINDOW_EXPIRED")
      ) {
        // Never echo an unbounded/private source payload as a new diagnostic.
        reasons.push("FIXED_SOURCE_BLOCKED");
      }
      if (t.activeAttempt !== null) {
        if (t.activeAttempt.maidProfileId !== a.maidProfileId) {
          reasons.push("FIXED_ATTEMPT_OWNER_MISMATCH");
        }
        // A running attempt remains fixed work; follow-up plans append after its sequence.
        if (!["scheduled", "in_progress"].includes(t.activeAttempt.status)) {
          reasons.push("FIXED_ATTEMPT_WORKFLOW_UNRESOLVED");
        }
      }
      if (reasons.length) {
        unavailable.add(i);
        fixedExclusions.push({
          maidProfileId: required(maids[i]).maidProfileId,
          cleaningTargetId: t.cleaningTargetId,
          reasonCodes: reasons,
        });
      }
      seen.add(slot);
    }
  }
  const candidates = snapshot.targets.filter((t) => {
    if (t.currentAssignment || t.activeAttempt) return false;
    const reason = t.blockedReason ??
      (!candidateDateAllowed(t.serviceDate)
        ? "SERVICE_DATE_MISMATCH"
        : t.status !== "unassigned"
        ? "TARGET_NOT_UNASSIGNED"
        : Date.parse(t.availableFrom) >= Date.parse(t.dueAt ?? "9999-12-31")
        ? "ASSIGNMENT_PREVIEW_INVALID_SCHEDULE"
        : (t.cleaningKind === "reclean" || t.source === "inspection_reclean") &&
            (!t.recleanMaidProfileId || t.cleaningKind !== "reclean" ||
              t.source !== "inspection_reclean")
        ? "RECLEAN_MAID_REQUIRED"
        : null);
    if (reason) {
      blocked.push({ ...targetMetadata(t), reason });
      return false;
    }
    return true;
  });
  if (candidates.length > PREVIEW_LIMITS.candidates) limited();
  let evaluations = 0;
  const roomNumbers = new Map(
    snapshot.targets.map(
      (t) => [t.cleaningTargetId, Number(t.roomNumber)],
    ),
  );
  const fixedFees = fixedByMaid.map((rows) =>
    rows.reduce((sum, t) => sum + t.feeSnapshot, 0)
  );
  const reservedSequences = new Map(
    (snapshot.sequenceReservations ?? []).map((r) => [
      JSON.stringify([r.maidProfileId, r.serviceDate]),
      r.maxSequenceNumber,
    ]),
  );
  const fixedSequenceStarts = fixedByMaid.map((rows) =>
    Math.max(0, ...rows.map((t) => t.currentAssignment?.sequenceNumber ?? 0))
  );
  // Keep historical fixed numbers. Occupancy belongs to each immutable date,
  // and terminal current assignments still hold their database UNIQUE slots.
  function proposedSequences(
    rows: PreviewTarget[],
    maidIndex: number,
  ): number[] | null {
    const nextByDate = new Map<string, number>();
    const maidId = required(maids[maidIndex]).maidProfileId;
    const result: number[] = [];
    for (const t of rows) {
      const last = nextByDate.get(t.serviceDate) ?? Math.max(
        required(fixedSequenceStarts[maidIndex]),
        reservedSequences.get(JSON.stringify([maidId, t.serviceDate])) ?? 0,
      );
      if (last >= MAX_SEQUENCE_NUMBER) return null;
      nextByDate.set(t.serviceDate, last + 1);
      result.push(last + 1);
    }
    return result;
  }
  const routeDelta = (prev: PreviewTarget, t: PreviewTarget) => {
    const p = required(roomNumbers.get(prev.cleaningTargetId)),
      n = required(roomNumbers.get(t.cleaningTargetId));
    if (!Number.isSafeInteger(p) || !Number.isSafeInteger(n)) invalid();
    return {
      zones: prev.elevatorZone === t.elevatorZone ? 0 : 1,
      distance: Math.abs(n - p),
    };
  };
  const fixedRoute = fixedByMaid.map((rows) =>
    rows.slice(1).reduce((r, t, j) => {
      const d = routeDelta(required(rows[j]), t);
      return { zones: r.zones + d.zones, distance: r.distance + d.distance };
    }, { zones: 0, distance: 0 })
  );
  function evaluate(board: Board): Score | null {
    if (++evaluations > PREVIEW_LIMITS.evaluations) limited();
    const fees: number[] = [];
    let count = 0, zones = 0, distance = 0;
    for (let i = 0; i < maids.length; i++) {
      const newRows = required(board[i]);
      if (newRows.length && unavailable.has(i)) return null;
      if (proposedSequences(newRows, i) === null) return null;
      if (
        newRows.some((t) =>
          t.recleanMaidProfileId !== null &&
          t.recleanMaidProfileId !== required(maids[i]).maidProfileId
        )
      ) return null;
      let fee = required(fixedFees[i]),
        prev = required(fixedByMaid[i]).at(-1);
      zones += required(fixedRoute[i]).zones;
      distance += required(fixedRoute[i]).distance;
      for (const t of newRows) {
        fee += t.feeSnapshot;
        if (prev) {
          const delta = routeDelta(prev, t);
          zones += delta.zones;
          distance += delta.distance;
        }
        prev = t;
      }
      fees.push(fee);
      count += newRows.length;
    }
    const total = fees.reduce((sum, x) => sum + BigInt(x), 0n),
      n = BigInt(fees.length);
    return {
      count,
      spread: fees.length ? Math.max(...fees) - Math.min(...fees) : 0,
      deviation: fees.reduce(
        (sum, x) => sum + (n * BigInt(x) - total) ** 2n,
        0n,
      ),
      zones,
      distance,
    };
  }
  const empty = (): Board => maids.map(() => []);
  let best = empty(), bestScore = required(evaluate(best));
  function remember(board: Board, score: Score) {
    const c = compare(score, bestScore);
    if (c < 0 || (c === 0 && boardKey(board) < boardKey(best))) {
      best = board;
      bestScore = score;
    }
  }
  const orders = [
    [...candidates].sort((a, b) =>
      Number(b.recleanMaidProfileId !== null) -
        Number(a.recleanMaidProfileId !== null) ||
      Date.parse(a.dueAt ?? "9999-01-01") -
        Date.parse(b.dueAt ?? "9999-01-01") ||
      Date.parse(a.availableFrom) - Date.parse(b.availableFrom) ||
      a.cleaningTargetId.localeCompare(b.cleaningTargetId)
    ),
    [...candidates].sort((a, b) =>
      Date.parse(a.dueAt ?? "9999-01-01") -
        Date.parse(b.dueAt ?? "9999-01-01") ||
      a.cleaningTargetId.localeCompare(b.cleaningTargetId)
    ),
    [...candidates].sort((a, b) =>
      Number(b.recleanMaidProfileId !== null) -
        Number(a.recleanMaidProfileId !== null) ||
      a.cleaningTargetId.localeCompare(b.cleaningTargetId)
    ),
    [...candidates].sort((a, b) =>
      Date.parse(a.availableFrom) - Date.parse(b.availableFrom) ||
      a.cleaningTargetId.localeCompare(b.cleaningTargetId)
    ),
  ];
  for (const order of orders) {
    let board = empty();
    for (const t of order) {
      let next = board, score = required(evaluate(board));
      for (let i = 0; i < maids.length; i++) {
        const proposal = clone(board);
        required(proposal[i]).push(t);
        const s = evaluate(proposal);
        if (s && compare(s, score) < 0) {
          next = proposal;
          score = s;
        }
      }
      board = next;
    }
    remember(board, required(evaluate(board)));
  }
  for (let pass = 0; pass < PREVIEW_LIMITS.passes; pass++) {
    const before = boardKey(best),
      base = best,
      used = new Set(base.flat().map((t) => t.cleaningTargetId));
    const tryBoard = (b: Board) => {
      const score = evaluate(b);
      if (score) remember(b, score);
    };
    for (const t of candidates.filter((t) => !used.has(t.cleaningTargetId))) {
      for (let i = 0; i < maids.length; i++) {
        const b = clone(base);
        required(b[i]).push(t);
        tryBoard(b);
      }
    }
    for (let i = 0; i < maids.length; i++) {
      for (let j = 0; j < required(base[i]).length; j++) {
        for (let k = 0; k < maids.length; k++) {
          const b = clone(base), t = required(required(b[i]).splice(j, 1)[0]);
          required(b[k]).push(t);
          tryBoard(b);
        }
        if (j + 1 < required(base[i]).length) {
          const b = clone(base);
          const rows = required(b[i]);
          [rows[j], rows[j + 1]] = [required(rows[j + 1]), required(rows[j])];
          tryBoard(b);
        }
        for (let k = i + 1; k < maids.length; k++) {
          for (let l = 0; l < required(base[k]).length; l++) {
            const b = clone(base);
            const left = required(b[i]), right = required(b[k]);
            [left[j], right[l]] = [required(right[l]), required(left[j])];
            tryBoard(b);
          }
        }
        for (
          const t of candidates.filter((t) => !used.has(t.cleaningTargetId))
        ) {
          const b = clone(base);
          required(b[i])[j] = t;
          tryBoard(b);
        }
      }
    }
    if (boardKey(best) === before) break;
  }
  // previewSeed는 응답 상관관계 호환 필드일 뿐 결정 입력이 아니다.
  function targetMetadata(t: PreviewTarget): PreviewTargetMetadata {
    const metadata = required(t.readMetadata);
    return {
      ...metadata,
      cleaningTargetId: t.cleaningTargetId,
      roomId: t.roomId,
      roomNumber: t.roomNumber,
      roomTypeCode: t.roomTypeCode,
      elevatorZone: t.elevatorZone,
      feeSnapshot: t.feeSnapshot,
      durationMinutes: null,
      serviceDate: t.serviceDate,
      expectedAssignmentVersion: t.assignmentVersion,
      targetAssignmentVersion: t.assignmentVersion,
      availableFrom: t.availableFrom,
      dueAt: t.dueAt,
    };
  }
  function row(
    t: PreviewTarget,
    maidId: string,
    sequence: number,
  ): PreviewAssignmentRow {
    const m = snapshot.maids.find((x) => x.maidProfileId === maidId);
    return {
      ...targetMetadata(t),
      maidProfileId: maidId,
      maidDisplayName: m?.maidDisplayName ?? "",
      proposedSequenceNumber: sequence,
      expectedAvailabilityVersion: m?.availabilityVersion ?? null,
    };
  }
  const proposed = best.flatMap((rows, i) => {
    const sequences = required(proposedSequences(rows, i));
    return rows.map((t, j) =>
      row(t, required(maids[i]).maidProfileId, required(sequences[j]))
    );
  });
  const chosen = new Set(proposed.map((t) => t.cleaningTargetId));
  const activeMaids = snapshot.maids.filter((m) =>
    m.role === "maid" && m.status === "active"
  );
  const submittedCount =
    activeMaids.filter((m) => m.availabilityVersion !== null).length;
  function remainingReason(t: PreviewTarget): RemainingReason {
    if (t.recleanMaidProfileId !== null) {
      const owner = maids.findIndex((m) =>
        m.maidProfileId === t.recleanMaidProfileId
      );
      if (owner === -1) return "RECLEAN_MAID_UNAVAILABLE";
      if (unavailable.has(owner)) {
        return "RECLEAN_MAID_FIXED_ASSIGNMENT_CONFLICT";
      }
    }
    if (!activeMaids.length) return "NO_ACTIVE_MAID";
    if (!submittedCount) return "AVAILABILITY_NOT_SUBMITTED";
    if (!maids.length) return "NO_AVAILABLE_MAID";
    if (unavailable.size === maids.length) return "FIXED_ASSIGNMENT_CONFLICT";
    return "NO_FEASIBLE_ASSIGNMENT";
  }
  const remaining = candidates.filter((t) => !chosen.has(t.cleaningTargetId))
    .map((t) => ({
      ...targetMetadata(t),
      reason: t.recleanMaidProfileId &&
          !maids.some((m) => m.maidProfileId === t.recleanMaidProfileId)
        ? "RECLEAN_MAID_UNAVAILABLE"
        : "NO_ELIGIBLE_MAID",
      reasonCodes: [remainingReason(t)],
    }));
  return {
    serviceDate: snapshot.serviceDate,
    previewSeed,
    durationPolicy: null,
    durationPolicyStatus: "retired",
    durationPolicyRequired: false,
    decisionReady: true,
    // Display-only additions do not change the established planning fingerprint.
    inputFingerprint: await sha(canonical({
      ...snapshot,
      targets: snapshot.targets.map(({ readMetadata: _metadata, ...target }) =>
        target
      ),
    })),
    fixedAssignments: fixed.map((t) =>
      row(
        t,
        t.currentAssignment?.maidProfileId ??
          required(t.activeAttempt).maidProfileId,
        t.currentAssignment?.sequenceNumber ?? 0,
      )
    ),
    proposedAssignments: proposed,
    remainingUnassignedTargets: remaining,
    blockedTargets: blocked,
    diagnostics: {
      evaluatedAt: snapshot.planningAt,
      activeMaidCount: activeMaids.length,
      submittedAvailabilityMaidCount: submittedCount,
      availableMaidCount: maids.length,
      fixedExcludedMaidCount: unavailable.size,
      eligibleMaidCount: maids.length - unavailable.size,
      fixedExclusions,
    },
    maidSummaries: maids.map((m, i) => ({
      maidProfileId: m.maidProfileId,
      totalFee: [...required(fixedByMaid[i]), ...required(best[i])].reduce(
        (sum, t) => sum + t.feeSnapshot,
        0,
      ),
      fixedCount: required(fixedByMaid[i]).length,
      proposedCount: required(best[i]).length,
    })),
    objectiveScore: {
      completedTargetCount: bestScore.count,
      feeSpread: bestScore.spread,
      feeDeviation: bestScore.deviation.toString(),
      routeScore: {
        zoneChanges: bestScore.zones,
        roomDistance: bestScore.distance,
      },
    },
  };
}
