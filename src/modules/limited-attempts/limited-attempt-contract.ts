// Pure public DTO validation shared by Fastify and Edge. Never hydrates current room data.
export const LIMITED_DISCOVERY_MAX = 1000;
export const capabilityActions = {
  finish_current: ["complete_field_work"],
  upload_submit: ["upload_evidence", "validate_evidence", "submit"],
  evidence_upload: ["upload_evidence", "validate_evidence"],
} as const;
type Kind = keyof typeof capabilityActions;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface LimitedDiscoveryItem {
  attemptId: string;
  assignmentId: string;
  assignmentRevision: number;
  executionVersion: number;
  status: string;
  kind: Kind;
  allowedActions: string[];
  issuedAt: string;
  expiresAt: string;
}
export interface LimitedDiscovery {
  profileStatus: "active" | "deactivation_pending" | "upload_only";
  evaluatedAt: string;
  items: LimitedDiscoveryItem[];
}
export function malformed(): never {
  throw new Error("INVALID_LIMITED_PROJECTION");
}
export function dtoObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed();
  return value as Record<string, unknown>;
}
export function dtoUuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) malformed();
  return value;
}
export function dtoVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    malformed();
  }
  return value;
}
// SQL uses microsecond timestamptz. Preserve its precision at the inclusive/exclusive boundary.
export function dtoInstant(value: unknown): bigint {
  if (typeof value !== "string") malformed();
  const match =
    /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,6}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
      .exec(value);
  const day = value.slice(0, 10);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  if (
    !match || !Number.isFinite(midnight) ||
    new Date(midnight).toISOString().slice(0, 10) !== day
  ) malformed();
  const millis = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(millis)) malformed();
  return BigInt(millis) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
export function dtoCapability(row: Record<string, unknown>) {
  if (
    typeof row.kind !== "string" || !Object.hasOwn(capabilityActions, row.kind)
  ) malformed();
  const kind = row.kind as Kind;
  const actions = capabilityActions[kind];
  if (
    !Array.isArray(row.allowedActions) ||
    row.allowedActions.length !== actions.length ||
    row.allowedActions.some((action, index) => action !== actions[index])
  ) malformed();
  const issued = dtoInstant(row.issuedAt), expires = dtoInstant(row.expiresAt);
  const max = BigInt(kind === "finish_current" ? 2 : 24) * 3600n * 1000000n;
  if (expires <= issued || expires - issued > max) malformed();
  return {
    kind,
    allowedActions: [...actions],
    issuedAt: row.issuedAt as string,
    expiresAt: row.expiresAt as string,
  };
}
export function projectLimitedDiscovery(value: unknown): LimitedDiscovery {
  const row = dtoObject(value);
  const profileStatus = row.profileStatus;
  if (
    typeof profileStatus !== "string" ||
    !["active", "deactivation_pending", "upload_only"].includes(
      profileStatus,
    ) ||
    !Array.isArray(row.items) || row.items.length > LIMITED_DISCOVERY_MAX
  ) malformed();
  const evaluated = dtoInstant(row.evaluatedAt);
  let previous = "";
  const items = row.items.map((value) => {
    const item = dtoObject(value), attemptId = dtoUuid(item.attemptId);
    const key = attemptId.toLowerCase();
    if (key <= previous) malformed();
    previous = key;
    const cap = dtoCapability(item);
    if (
      dtoInstant(cap.issuedAt) > evaluated ||
      dtoInstant(cap.expiresAt) <= evaluated
    ) malformed();
    if (typeof item.status !== "string") malformed();
    const valid = cap.kind === "finish_current"
      ? profileStatus === "deactivation_pending" &&
        item.status === "in_progress"
      : cap.kind === "upload_submit"
      ? profileStatus === "upload_only" &&
        ["field_completed", "upload_pending"].includes(item.status)
      : ["active", "upload_only"].includes(profileStatus) &&
        item.status === "interrupted";
    if (!valid) malformed();
    return {
      attemptId,
      assignmentId: dtoUuid(item.assignmentId),
      assignmentRevision: dtoVersion(item.assignmentRevision),
      executionVersion: dtoVersion(item.executionVersion),
      status: item.status as string,
      ...cap,
    };
  });
  return {
    profileStatus: profileStatus as LimitedDiscovery["profileStatus"],
    evaluatedAt: row.evaluatedAt as string,
    items,
  };
}

export function projectLimitedAttempt(value: unknown, profileId: string) {
  const row = dtoObject(value),
    raw = dtoObject(row.attempt),
    grant = dtoObject(row.capability);
  if (
    typeof row.profileStatus !== "string" ||
    !["active", "deactivation_pending", "upload_only"].includes(
      row.profileStatus,
    ) ||
    raw.maidProfileId !== profileId ||
    typeof raw.status !== "string" ||
    ![
      "scheduled",
      "in_progress",
      "field_completed",
      "upload_pending",
      "submitted",
      "approved",
      "rejected",
      "interrupted",
      "superseded",
    ].includes(raw.status)
  ) malformed();
  const attempt = {
    attemptId: dtoUuid(raw.attemptId),
    cleaningTargetId: dtoUuid(raw.cleaningTargetId),
    assignmentId: dtoUuid(raw.assignmentId),
    maidProfileId: dtoUuid(raw.maidProfileId),
    assignmentRevision: dtoVersion(raw.assignmentRevision),
    executionVersion: dtoVersion(raw.executionVersion),
    status: raw.status as string,
    startedAt: raw.startedAt as string | null,
    fieldCompletedAt: raw.fieldCompletedAt as string | null,
    endedAt: raw.endedAt as string | null,
    effectiveAt: raw.effectiveAt as string,
    recordedAt: raw.recordedAt as string,
  };
  for (
    const time of [attempt.startedAt, attempt.fieldCompletedAt, attempt.endedAt]
  ) if (time !== null) dtoInstant(time);
  dtoInstant(attempt.effectiveAt);
  dtoInstant(attempt.recordedAt);
  if (
    grant.attemptId !== attempt.attemptId ||
    grant.assignmentId !== attempt.assignmentId ||
    grant.assignmentRevision !== attempt.assignmentRevision
  ) malformed();
  if (grant.revokedAt !== null) dtoInstant(grant.revokedAt);
  return {
    attempt,
    capability: {
      capabilityId: dtoUuid(grant.capabilityId),
      attemptId: attempt.attemptId,
      assignmentId: attempt.assignmentId,
      assignmentRevision: attempt.assignmentRevision,
      ...dtoCapability(grant),
      revokedAt: grant.revokedAt as string | null,
    },
    profileStatus: row.profileStatus as LimitedDiscovery["profileStatus"],
  };
}
