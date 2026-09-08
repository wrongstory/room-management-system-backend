// Generated from supabase/functions/_shared/photo-upload-contract.ts. DO NOT EDIT.
/**
 * #83 플랫폼 중립 업로드 작업 계약. HTTP/Drive/파일 디코딩을 수행하지 않는다.
 * #84는 실제 bytes/hash/MIME/EXIF와 Auth/session을 검증한 뒤 이 입력을 만들고,
 * DB command는 현재 actor/attempt/slot/revision/capability/fence를 다시 검증한다.
 * `provider_succeeded` 또는 응답 유실은 `accepted`도 보상 삭제 허가도 아니다.
 */
export const PHOTO_UPLOAD_MAX_BYTES = 307200;
export const PHOTO_UPLOAD_COMMAND = "photo.upload";
export const photoUploadStatuses = [
  "reserved",
  "provider_succeeded",
  "reconciliation_pending",
  "accepted",
  "compensation_pending",
  "compensated",
] as const;
export type PhotoUploadStatus = typeof photoUploadStatuses[number];
export type PhotoMime = "image/jpeg" | "image/webp";

export class PhotoUploadContractError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PhotoUploadContractError";
  }
}
function invalid(): never {
  throw new PhotoUploadContractError(
    400,
    "VALIDATION_ERROR",
    "허용된 사진 작업 identity와 검증 메타데이터가 필요합니다.",
  );
}
function failed(): never {
  throw new PhotoUploadContractError(
    500,
    "PHOTO_UPLOAD_FAILED",
    "사진 업로드 작업을 확인하지 못했습니다.",
  );
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid();
  }
  return value as Record<string, unknown>;
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const row = object(value);
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key))
  ) invalid();
  return row;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid();
  return value.toLowerCase();
}
function integer(value: unknown, minimum: number): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum
  ) invalid();
  return value;
}
function time(value: unknown): bigint {
  if (typeof value !== "string") invalid();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
      .exec(value);
  if (!match || match[1] === "0000") invalid();
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${day}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day
  ) invalid();
  const ms = Date.parse(
    `${day}T${match[4]}:${match[5]}:${match[6]}${match[8]}`,
  );
  if (
    !Number.isFinite(ms) || new Date(ms).getUTCFullYear() < 1 ||
    new Date(ms).getUTCFullYear() > 9999
  ) invalid();
  return BigInt(ms) * 1000n + BigInt((match[7] ?? "").padEnd(6, "0"));
}

export interface PhotoUploadBeginInput {
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly targetSlotId: string;
  readonly expectedPhotoRevision: number;
  readonly sha256: string;
  readonly mime: PhotoMime;
  readonly sizeBytes: number;
}
/** client MIME/verified bit를 신뢰하는 함수가 아니다. server-validated metadata 전용. */
export function validatePhotoUploadBegin(
  input: unknown,
): PhotoUploadBeginInput {
  const row = exact(input, [
    "attemptId",
    "assignmentId",
    "assignmentRevision",
    "targetSlotId",
    "expectedPhotoRevision",
    "sha256",
    "mime",
    "sizeBytes",
  ]);
  if (
    typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) ||
    (row.mime !== "image/jpeg" && row.mime !== "image/webp")
  ) invalid();
  const sizeBytes = integer(row.sizeBytes, 1);
  if (
    sizeBytes > PHOTO_UPLOAD_MAX_BYTES ||
    integer(row.expectedPhotoRevision, 0) >= Number.MAX_SAFE_INTEGER
  ) invalid();
  return Object.freeze({
    attemptId: uuid(row.attemptId),
    assignmentId: uuid(row.assignmentId),
    assignmentRevision: integer(row.assignmentRevision, 1),
    targetSlotId: uuid(row.targetSlotId),
    expectedPhotoRevision: integer(row.expectedPhotoRevision, 0),
    sha256: row.sha256,
    mime: row.mime,
    sizeBytes,
  });
}
function canonical(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, value[key]]),
    ),
  );
}
async function digest(
  value: Readonly<Record<string, unknown>>,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
export interface PreparedPhotoUploadBegin {
  readonly command: typeof PHOTO_UPLOAD_COMMAND;
  readonly actorProfileId: string;
  readonly input: PhotoUploadBeginInput;
  readonly idempotencyKeyDigest: string;
  readonly requestHash: string;
}
/** raw key는 이 함수에서만 일시적으로 사용한다. 반환/RPC/audit에 원문을 넘기지 않는다. */
export async function preparePhotoUploadBegin(
  actorProfileId: unknown,
  input: unknown,
  rawIdempotencyKey: unknown,
): Promise<PreparedPhotoUploadBegin> {
  const actor = uuid(actorProfileId), parsed = validatePhotoUploadBegin(input);
  if (
    typeof rawIdempotencyKey !== "string" ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(rawIdempotencyKey)
  ) invalid();
  const scope = { actorProfileId: actor, command: PHOTO_UPLOAD_COMMAND };
  const [idempotencyKeyDigest, requestHash] = await Promise.all([
    digest({ ...scope, idempotencyKey: rawIdempotencyKey }),
    digest({ ...scope, ...parsed }),
  ]);
  // session/requestId/provider identity/처리 시각은 논리 요청 hash에 포함하지 않는다.
  return Object.freeze({
    command: PHOTO_UPLOAD_COMMAND,
    actorProfileId: actor,
    input: parsed,
    idempotencyKeyDigest,
    requestHash,
  });
}

/** #84 입구 admission에서도 동일 scope digest를 사용한다. bytes hash는 검증 후 별도 계산한다. */
export async function preparePhotoUploadKey(
  actorProfileId: unknown,
  rawIdempotencyKey: unknown,
): Promise<string> {
  const actor = uuid(actorProfileId);
  if (
    typeof rawIdempotencyKey !== "string" ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(rawIdempotencyKey)
  ) invalid();
  return digest({
    actorProfileId: actor,
    command: PHOTO_UPLOAD_COMMAND,
    idempotencyKey: rawIdempotencyKey,
  });
}

export type PhotoUploadOperationCommand =
  | { readonly command: "get"; readonly operationId: string }
  | {
    readonly command: "claim" | "reconcile";
    readonly operationId: string;
    readonly claimDigest: string;
  }
  | {
    readonly command: "finalize";
    readonly operationId: string;
    readonly leaseVersion: number;
    readonly claimDigest: string;
  };
export function validatePhotoUploadOperationCommand(
  command: "claim" | "get" | "finalize" | "reconcile",
  input: unknown,
): PhotoUploadOperationCommand {
  if (!["claim", "get", "finalize", "reconcile"].includes(command)) invalid();
  const row = exact(
    input,
    command === "get"
      ? ["operationId"]
      : command === "finalize"
      ? ["operationId", "leaseVersion", "claimDigest"]
      : ["operationId", "claimDigest"],
  );
  const operationId = uuid(row.operationId);
  if (command === "get") return Object.freeze({ command, operationId });
  const claimDigest = hash(row.claimDigest);
  return command === "finalize"
    ? Object.freeze({
      command,
      operationId,
      leaseVersion: integer(row.leaseVersion, 1),
      claimDigest,
    })
    : Object.freeze({ command, operationId, claimDigest });
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
/** server worker가 생성한 UUID만 사용한다. caller 입력/로그/공개 DTO로 전달하지 않는다. */
export async function createPhotoUploadClaim(
  operationId: unknown,
): Promise<{ readonly claimDigest: string }> {
  return Object.freeze({
    claimDigest: await digest({
      command: "photo.upload.claim",
      operationId: uuid(operationId),
      claimId: crypto.randomUUID(),
    }),
  });
}
/** worker-only 입력. 결과 projection과 달리 locator가 있으므로 로깅/HTTP 직렬화 금지. */
export function validatePhotoProviderSuccess(input: unknown) {
  const row = exact(input, [
    "operationId",
    "leaseVersion",
    "claimDigest",
    "providerLocator",
    "uploadedAt",
  ]);
  if (
    typeof row.providerLocator !== "string" ||
    !/^[A-Za-z0-9_-]{10,200}$/.test(row.providerLocator)
  ) invalid();
  time(row.uploadedAt);
  return Object.freeze({
    operationId: uuid(row.operationId),
    leaseVersion: integer(row.leaseVersion, 1),
    claimDigest: hash(row.claimDigest),
    providerLocator: row.providerLocator,
    uploadedAt: row.uploadedAt as string,
  });
}
export function validatePhotoCompensationSettlement(input: unknown) {
  const row = exact(input, [
    "operationId",
    "leaseVersion",
    "claimDigest",
    "outcome",
  ]);
  if (row.outcome !== "deleted" && row.outcome !== "not_found") invalid();
  return Object.freeze({
    operationId: uuid(row.operationId),
    leaseVersion: integer(row.leaseVersion, 1),
    claimDigest: hash(row.claimDigest),
    outcome: row.outcome,
  });
}

/** DB 전이의 순수 설명용 검증이다. CAS/claim/권한/외부 결과를 대신 검증하지 않는다. */
export function isPhotoUploadTransitionAllowed(
  from: PhotoUploadStatus,
  to: PhotoUploadStatus,
): boolean {
  if (
    !photoUploadStatuses.includes(from) || !photoUploadStatuses.includes(to)
  ) return false;
  if (from === to) return true;
  const next: Readonly<
    Record<PhotoUploadStatus, readonly PhotoUploadStatus[]>
  > = {
    reserved: ["provider_succeeded", "reconciliation_pending"],
    provider_succeeded: ["accepted", "compensation_pending"],
    reconciliation_pending: ["compensation_pending"],
    accepted: [],
    compensation_pending: ["compensated"],
    compensated: [],
  };
  return next[from].includes(to);
}

/** SQL의 공개 stable code만 매핑한다. details/hint/unknown message는 항상 버린다. */
export function photoUploadDatabaseError(
  error: unknown,
): PhotoUploadContractError {
  const code = error !== null && typeof error === "object" && "message" in error
    ? error.message
    : null;
  const statuses: Readonly<Record<string, number>> = {
    SESSION_REVOKED: 401,
    ADMIN_REQUIRED: 403,
    PASSWORD_CHANGE_REQUIRED: 403,
    CAPABILITY_ACCESS_REQUIRED: 403,
    PHOTO_ACCESS_REQUIRED: 403,
    PHOTO_UPLOAD_INVALID: 400,
    PHOTO_SLOT_INVALID: 400,
    PHOTO_OPERATION_INVALID: 400,
    PHOTO_PROVIDER_RESULT_INVALID: 400,
    PHOTO_COMPENSATION_INVALID: 400,
    PHOTO_UPLOAD_TIME_INVALID: 400,
    IDEMPOTENCY_KEY_REUSED: 409,
    ASSIGNMENT_VERSION_CONFLICT: 409,
    PHOTO_VERSION_CONFLICT: 409,
    PHOTO_UPLOAD_IN_FLIGHT: 409,
    PHOTO_UPLOAD_FENCE_CONFLICT: 409,
    PHOTO_PROVIDER_IDENTITY_CONFLICT: 409,
    PHOTO_OPERATION_TERMINAL: 409,
    PHOTO_OPERATION_ACCEPTED: 409,
    PHOTO_PROVIDER_RESULT_REQUIRED: 409,
    PHOTO_UPLOAD_LIMIT_EXCEEDED: 429,
    PHOTO_UPLOAD_RATE_LIMITED: 429,
    PHOTO_UPLOAD_LEASE_LIMIT: 429,
  };
  const status = typeof code === "string" && Object.hasOwn(statuses, code)
    ? statuses[code]
    : undefined;
  return status === undefined || typeof code !== "string"
    ? new PhotoUploadContractError(
      500,
      "PHOTO_UPLOAD_FAILED",
      "사진 업로드 작업을 확인하지 못했습니다.",
    )
    : new PhotoUploadContractError(
      status,
      code,
      "사진 업로드 작업 조건을 확인해 주세요.",
    );
}

export interface PhotoUploadOperationProjection {
  readonly operationId: string;
  /** 앱 자체 object UUID이며 Drive file ID/locator가 아니다. */
  readonly objectId: string;
  readonly attemptId: string;
  readonly targetSlotId: string;
  readonly status: PhotoUploadStatus;
  readonly leaseVersion: number;
  readonly leaseExpiresAt: string | null;
  readonly photoId: string | null;
  readonly photoVersion: number | null;
  readonly uploadedAt: string | null;
  readonly purgeAfter: string | null;
  readonly compensationAllowed: boolean;
}
/** 서버 command 응답 전용 allowlist. raw key/hash/locator/credential 추가 필드는 버린다. */
export function projectPhotoUploadOperation(
  value: unknown,
): PhotoUploadOperationProjection {
  try {
    const row = object(value);
    if (
      !photoUploadStatuses.includes(row.status as PhotoUploadStatus) ||
      typeof row.compensationAllowed !== "boolean"
    ) failed();
    const status = row.status as PhotoUploadStatus,
      leaseVersion = integer(row.leaseVersion, 0);
    const photoId = row.photoId === null ? null : uuid(row.photoId);
    const photoVersion = row.photoVersion === null
      ? null
      : integer(row.photoVersion, 1);
    if (
      (photoId === null) !== (photoVersion === null) ||
      (status === "accepted") !== (photoId !== null)
    ) failed();
    const uploaded = row.uploadedAt === null ? null : time(row.uploadedAt);
    const purge = row.purgeAfter === null ? null : time(row.purgeAfter);
    if (
      (uploaded === null) !== (purge === null) ||
      (uploaded !== null && purge !== uploaded + 604800000000n)
    ) failed();
    if (
      ["provider_succeeded", "accepted", "compensation_pending", "compensated"]
        .includes(status) && uploaded === null
    ) failed();
    if (row.leaseExpiresAt !== null) time(row.leaseExpiresAt);
    if (row.compensationAllowed && status !== "compensation_pending") failed();
    return Object.freeze({
      operationId: uuid(row.operationId),
      objectId: uuid(row.objectId),
      attemptId: uuid(row.attemptId),
      targetSlotId: uuid(row.targetSlotId),
      status,
      leaseVersion,
      leaseExpiresAt: row.leaseExpiresAt as string | null,
      photoId,
      photoVersion,
      uploadedAt: row.uploadedAt as string | null,
      purgeAfter: row.purgeAfter as string | null,
      compensationAllowed: row.compensationAllowed,
    });
  } catch {
    return failed();
  }
}

export type PhotoCompensationDecision =
  | "preserve_accepted"
  | "reconcile"
  | "candidate_deletion"
  | "already_compensated"
  | "stale_fence";
/**
 * DB reconciliation 응답을 해석할 뿐 삭제권한을 발급하지 않는다. worker는 실제 삭제 직전
 * 같은 operation/object/fence의 DB claim을 재검증해야 한다. timeout/null은 반드시 reconcile.
 */
export function decidePhotoCompensation(
  value: unknown,
  expectedLeaseVersion: unknown,
): PhotoCompensationDecision {
  const fence = integer(expectedLeaseVersion, 1);
  if (value === null || value === undefined) return "reconcile";
  const operation = projectPhotoUploadOperation(value);
  if (operation.status === "accepted") return "preserve_accepted";
  if (operation.status === "compensated") return "already_compensated";
  if (operation.leaseVersion !== fence) return "stale_fence";
  return operation.status === "compensation_pending" &&
      operation.compensationAllowed
    ? "candidate_deletion"
    : "reconcile";
}
