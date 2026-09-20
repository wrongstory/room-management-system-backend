/** I/O 없는 배정 초안 계산기. Fastify와 Edge가 같은 구현을 공유한다. */
export class AssignmentPreviewError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export const PREVIEW_LIMITS = {
  targets: 242,
  candidates: 121,
  maids: 1000,
  candidateMaids: 20,
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
}
interface Score {
  count: number;
  spread: number;
  deviation: bigint;
  zones: number;
  distance: number;
}
type Board = PreviewTarget[][];
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
  expectedAvailabilityVersion: number | null;
  feeSnapshot: number;
  durationMinutes: number | null;
  availableFrom: string;
  dueAt: string | null;
}
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
  remainingUnassignedTargets: { cleaningTargetId: string; reason: string }[];
  blockedTargets: { cleaningTargetId: string; reason: string }[];
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
        sequenceNumber: integer(a.sequenceNumber, 1, 1000000),
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
  return {
    serviceDate: date(s.serviceDate),
    planningAt: timestamp(s.planningAt),
    durationPolicy: null,
    durationPolicyStatus: "retired",
    durationPolicyRequired: false,
    maids,
    targets,
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
      (a.currentAssignment?.sequenceNumber ?? 0) -
        (b.currentAssignment?.sequenceNumber ?? 0) ||
      a.cleaningTargetId.localeCompare(b.cleaningTargetId)
    )
  );
  const unavailable = new Set<number>();
  for (let i = 0; i < maids.length; i++) {
    const rows = required(fixedByMaid[i]), seen = new Set<number>();
    for (const t of rows) {
      const a = t.currentAssignment;
      if (
        !a || seen.has(a.sequenceNumber) ||
        t.serviceDate !== snapshot.serviceDate ||
        a.serviceDate !== snapshot.serviceDate ||
        a.targetAssignmentVersion !== t.assignmentVersion ||
        a.availableFrom === null ||
        Date.parse(a.availableFrom) !== Date.parse(t.availableFrom) ||
        a.dueAt !== t.dueAt || t.blockedReason ||
        (t.activeAttempt && t.activeAttempt.status !== "scheduled")
      ) unavailable.add(i);
      if (a) seen.add(a.sequenceNumber);
    }
  }
  const candidates = snapshot.targets.filter((t) => {
    if (t.currentAssignment || t.activeAttempt) return false;
    const reason = t.blockedReason ??
      (t.serviceDate !== snapshot.serviceDate
        ? "SERVICE_DATE_MISMATCH"
        : t.status !== "unassigned"
        ? "TARGET_NOT_UNASSIGNED"
        : Date.parse(t.availableFrom) >= Date.parse(t.dueAt ?? "9999-12-31")
        ? "ASSIGNMENT_PREVIEW_INVALID_SCHEDULE"
        : t.dueAt !== null &&
            Date.parse(t.dueAt) <= Date.parse(snapshot.planningAt)
        ? "ASSIGNMENT_WINDOW_EXPIRED"
        : (t.cleaningKind === "reclean" || t.source === "inspection_reclean") &&
            (!t.recleanMaidProfileId || t.cleaningKind !== "reclean" ||
              t.source !== "inspection_reclean")
        ? "RECLEAN_MAID_REQUIRED"
        : null);
    if (reason) {
      blocked.push({ cleaningTargetId: t.cleaningTargetId, reason });
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
  function row(
    t: PreviewTarget,
    maidId: string,
    sequence: number,
  ): PreviewAssignmentRow {
    const m = snapshot.maids.find((x) => x.maidProfileId === maidId);
    return {
      cleaningTargetId: t.cleaningTargetId,
      roomId: t.roomId,
      roomNumber: t.roomNumber,
      roomTypeCode: t.roomTypeCode,
      elevatorZone: t.elevatorZone,
      maidProfileId: maidId,
      maidDisplayName: m?.maidDisplayName ?? "",
      proposedSequenceNumber: sequence,
      serviceDate: t.serviceDate,
      expectedAssignmentVersion: t.assignmentVersion,
      expectedAvailabilityVersion: m?.availabilityVersion ?? null,
      feeSnapshot: t.feeSnapshot,
      durationMinutes: null,
      availableFrom: t.availableFrom,
      dueAt: t.dueAt,
    };
  }
  const proposed = best.flatMap((rows, i) => {
    const start = Math.max(
      0,
      ...required(fixedByMaid[i]).map((t) =>
        t.currentAssignment?.sequenceNumber ?? 0
      ),
    );
    return rows.map((t, j) =>
      row(t, required(maids[i]).maidProfileId, start + j + 1)
    );
  });
  const chosen = new Set(proposed.map((t) => t.cleaningTargetId));
  const remaining = candidates.filter((t) => !chosen.has(t.cleaningTargetId))
    .map((t) => ({
      cleaningTargetId: t.cleaningTargetId,
      reason: t.recleanMaidProfileId &&
          !maids.some((m) => m.maidProfileId === t.recleanMaidProfileId)
        ? "RECLEAN_MAID_UNAVAILABLE"
        : "NO_ELIGIBLE_MAID",
    }));
  return {
    serviceDate: snapshot.serviceDate,
    previewSeed,
    durationPolicy: null,
    durationPolicyStatus: "retired",
    durationPolicyRequired: false,
    decisionReady: true,
    inputFingerprint: await sha(canonical(snapshot)),
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
