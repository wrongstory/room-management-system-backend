import { idempotencyKey, readJsonBody } from "./account-api.ts";
import {
  AssignmentPreviewError,
  optimizeAssignmentPreview,
} from "./assignment-preview-core.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requireBusinessAdmin,
  requirePasswordChanged,
} from "./runtime.ts";

const durationKeys = [
  "standardMinutes",
  "premiumMinutes",
  "oceanPremiumMinutes",
  "oceanFamilyMinutes",
] as const;

function adminOnly(actor: EdgeActor) {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
}

function invalid(code = "VALIDATION_ERROR"): never {
  throw new EdgeError(
    400,
    code,
    "요청 날짜와 허용된 입력 필드를 확인해 주세요.",
  );
}

export function previewServiceDate(value: unknown, now = new Date()): string {
  if (
    typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) invalid("ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED");
  const today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(
    0,
    10,
  );
  const tomorrow = new Date(now.getTime() + 33 * 3600000).toISOString().slice(
    0,
    10,
  );
  if (value !== today && value !== tomorrow) {
    invalid("ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED");
  }
  return value;
}

// preview는 read-only snapshot과 순수 계산만 수행한다. receipt/audit를 생성하지 않는다.
export async function previewAssignments(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  adminOnly(actor);
  const body = await readJsonBody(request);
  if (
    Object.keys(body).some((key) =>
      !["serviceDate", "previewSeed"].includes(key)
    )
  ) invalid();
  const serviceDate = previewServiceDate(body.serviceDate);
  const seed = body.previewSeed === undefined
    ? crypto.randomUUID()
    : body.previewSeed;
  if (typeof seed !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(seed)) {
    invalid();
  }
  const { data, error } = await clients.admin.rpc(
    "get_assignment_preview_snapshot",
    {
      p_actor_profile_id: actor.profileId,
      p_service_date: serviceDate,
    },
  );
  const unconfirmed = () => ({
    serviceDate,
    previewSeed: seed,
    decisionReady: false as const,
    durationPolicyStatus: "unconfirmed" as const,
    proposedAssignments: [],
    error: {
      code: "ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED",
      message: "청소시간 정책을 먼저 확정해야 합니다.",
    },
  });
  if (error?.message === "ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED") {
    return unconfirmed();
  }
  if (error || !data) throw previewDatabaseError(error);
  try {
    return await optimizeAssignmentPreview(data, seed);
  } catch (error) {
    if (error instanceof AssignmentPreviewError) {
      if (error.code === "ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED") {
        return unconfirmed();
      }
      throw previewDatabaseError({ message: error.code });
    }
    throw previewDatabaseError(null);
  }
}

// config 확정은 preview와 분리된 audit/receipt/CAS mutation이다.
export async function assignmentDurationPolicy(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  adminOnly(actor);
  if (new URL(request.url).search) invalid();
  if (request.method === "GET") {
    const { data, error } = await clients.admin.rpc(
      "get_assignment_duration_policy",
      { p_actor_profile_id: actor.profileId },
    );
    if (error) throw previewDatabaseError(error);
    return durationProjection(data);
  }
  const body = await readJsonBody(request);
  const keys = ["expectedVersion", ...durationKeys];
  if (
    Object.keys(body).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(body, key))
  ) invalid("INVALID_ASSIGNMENT_DURATION_POLICY");
  for (const key of keys) {
    if (
      !Number.isSafeInteger(body[key]) ||
      (body[key] as number) < (key === "expectedVersion" ? 0 : 1) ||
      (key !== "expectedVersion" && (body[key] as number) > 2147483647)
    ) invalid("INVALID_ASSIGNMENT_DURATION_POLICY");
  }
  const payload = {
    p_actor_profile_id: actor.profileId,
    p_expected_version: body.expectedVersion,
    p_standard_minutes: body.standardMinutes,
    p_premium_minutes: body.premiumMinutes,
    p_ocean_premium_minutes: body.oceanPremiumMinutes,
    p_ocean_family_minutes: body.oceanFamilyMinutes,
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        command: "assignment.duration_policy_confirmed",
        ...payload,
      }),
    ),
  );
  const hash = [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const { data, error } = await clients.admin.rpc(
    "confirm_assignment_duration_policy",
    {
      ...payload,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: hash,
    },
  );
  if (error || !data) throw previewDatabaseError(error);
  return durationProjection(data);
}

function durationProjection(value: unknown) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw previewDatabaseError(null);
  }
  const row = value as Record<string, unknown>;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    standardMinutes: row.standardMinutes,
    premiumMinutes: row.premiumMinutes,
    oceanPremiumMinutes: row.oceanPremiumMinutes,
    oceanFamilyMinutes: row.oceanFamilyMinutes,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
  };
}

export function previewDatabaseError(
  error: { message?: string } | null,
): EdgeError {
  const statuses: Record<string, number> = {
    ADMIN_REQUIRED: 403,
    PROFILE_INACTIVE: 403,
    PASSWORD_CHANGE_REQUIRED: 403,
    ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED: 400,
    INVALID_ASSIGNMENT_DURATION_POLICY: 400,
    ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED: 409,
    ASSIGNMENT_DURATION_POLICY_VERSION_CONFLICT: 409,
    IDEMPOTENCY_KEY_CONFLICT: 409,
    IDEMPOTENCY_CONFLICT: 409,
    IDEMPOTENCY_KEY_REUSED: 409,
    ACTIVE_ACCOUNT_REQUIRED: 403,
    ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED: 422,
  };
  const code = error?.message;
  return code && Object.hasOwn(statuses, code)
    ? new EdgeError(
      statuses[code],
      code,
      "배정 미리보기 조건 또는 확정 설정을 확인해 주세요.",
    )
    : new EdgeError(
      500,
      "ASSIGNMENT_PREVIEW_FAILED",
      "배정 미리보기를 처리하지 못했습니다.",
    );
}
