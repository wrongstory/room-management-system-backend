import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { EdgeError, requireDeveloper } from "./runtime.ts";

export const expectedMigrationName = "assignment_core";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedAuditParameters = new Set([
  "actorProfileId",
  "cursor",
  "eventType",
  "from",
  "limit",
  "to",
]);
const allowedActivityParameters = new Set([
  "actorProfileId",
  "category",
  "cursor",
  "eventType",
  "from",
  "limit",
  "outcome",
  "role",
  "to",
]);
const activityRoles = new Set(["developer", "admin", "maid"]);
const activityCategories = new Set([
  "auth",
  "authorization",
  "sensitive_access",
]);
const activityEventTypes = new Set([
  "auth.login_succeeded",
  "auth.login_failed",
  "authorization.denied",
  "sensitive.read",
]);
const activityOutcomes = new Set(["succeeded", "failed", "denied"]);
const secretConfigurationAllowlist = [
  "ACCOUNT_PHONE_PEPPER",
  "RESERVATION_PII_KEY_BASE64",
  "RESERVATION_PII_KEY_VERSION",
  "RESERVATION_PII_KEYRING_JSON",
  "RESERVATION_GUEST_NAME_PEPPER",
  "RESERVATION_SCHEDULER_ACTOR_PROFILE_ID",
  "SCHEDULER_INVOKE_SECRET",
  "CORS_ORIGINS",
] as const;

interface AuditRow {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  actor_profile_id: string | null;
  actor_display_name: string | null;
  effective_at: string;
  recorded_at: string;
  reason_code: string | null;
  summary: Record<string, unknown>;
}

interface AuditCursor {
  recordedAt: string;
  id: string;
}

interface ActivityRow {
  id: string;
  category: string;
  event_type: string;
  outcome: string;
  actor_profile_id: string | null;
  actor_role: string | null;
  source: string;
  resource_type: string | null;
  resource_id: string | null;
  reason_code: string | null;
  request_id: string | null;
  occurred_at: string;
  recorded_at: string;
  summary: Record<string, unknown>;
}

interface DiagnosticLimitRow {
  allowed: boolean;
  retry_after_seconds: number;
  remaining: number;
}

function projectionError(error: { message?: string } | null): never {
  const message = error?.message ?? "";
  if (message.includes("DEVELOPER_REQUIRED")) {
    throw new EdgeError(
      403,
      "DEVELOPER_REQUIRED",
      "최상위 개발자만 접근할 수 있습니다.",
    );
  }
  if (
    message.includes("INVALID_AUDIT_QUERY") ||
    message.includes("INVALID_ACTIVITY_QUERY") ||
    message.includes("INVALID_EXPECTED_MIGRATION") ||
    message.includes("INVALID_DIAGNOSTIC_LIMIT")
  ) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "운영 상태 조회 조건이 올바르지 않습니다.",
    );
  }
  throw new EdgeError(
    500,
    "DEVELOPER_PROJECTION_FAILED",
    "운영 상태를 조회하지 못했습니다.",
  );
}

async function rpcJson(
  clients: EdgeClients,
  name: string,
  parameters: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await clients.admin.rpc(name, parameters);
  if (error || !data || Array.isArray(data) || typeof data !== "object") {
    projectionError(error);
  }
  return data as Record<string, unknown>;
}

function schedulerActorId(): string | null {
  const value =
    Deno.env.get("RESERVATION_SCHEDULER_ACTOR_PROFILE_ID")?.trim() ??
      "";
  return uuidPattern.test(value) ? value : null;
}

function projectReference(): string {
  const url = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  try {
    const hostname = new URL(url).hostname;
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      return "local";
    }
    const match = hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return match?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function developerRuntimeStatus(): Record<string, unknown> {
  const configuredEnvironment = Deno.env.get("RUNTIME_ENVIRONMENT")?.trim();
  const environment = configuredEnvironment === "production" ||
      configuredEnvironment === "recovery" || configuredEnvironment === "local"
    ? configuredEnvironment
    : "unknown";

  return {
    adapter: "supabase-edge",
    environment,
    projectRef: projectReference(),
    runtime: {
      name: "deno",
      version: Deno.version.deno,
    },
    source: {
      apiVersion: "0.2.0",
      expectedMigration: expectedMigrationName,
      fastifyRollbackBaseline: "available",
    },
    configuration: Object.fromEntries(
      secretConfigurationAllowlist.map((name) => [
        name,
        { configured: Boolean(Deno.env.get(name)?.trim()) },
      ]),
    ),
    checkedAt: new Date().toISOString(),
  };
}

export async function developerDatabaseStatus(
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  requireDeveloper(actor);
  const database = await rpcJson(clients, "get_developer_database_status", {
    p_actor_profile_id: actor.profileId,
    p_expected_migration_name: expectedMigrationName,
  });
  const runtime = developerRuntimeStatus();
  return {
    ...database,
    environment: runtime.environment,
    projectRef: runtime.projectRef,
  };
}

export async function developerSchedulerStatus(
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  requireDeveloper(actor);
  const database = await rpcJson(clients, "get_developer_scheduler_status", {
    p_actor_profile_id: actor.profileId,
    p_scheduler_actor_profile_id: schedulerActorId(),
  });
  const invokeSecretConfigured = Boolean(
    Deno.env.get("SCHEDULER_INVOKE_SECRET")?.trim(),
  );
  return {
    ...database,
    status: invokeSecretConfigured ? database.status : "not_configured",
    invokeSecretConfigured,
  };
}

export async function developerOverview(
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  requireDeveloper(actor);
  const [overview, database, scheduler] = await Promise.all([
    rpcJson(clients, "get_developer_overview", {
      p_actor_profile_id: actor.profileId,
    }),
    developerDatabaseStatus(clients, actor),
    developerSchedulerStatus(clients, actor),
  ]);
  return {
    ...overview,
    runtime: developerRuntimeStatus(),
    database,
    scheduler,
  };
}

function decodeCursor(value: string): AuditCursor {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - normalized.length % 4) % 4);
    const parsed = JSON.parse(atob(`${normalized}${padding}`)) as {
      recordedAt?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.recordedAt !== "string" ||
      Number.isNaN(Date.parse(parsed.recordedAt)) ||
      typeof parsed.id !== "string" || !uuidPattern.test(parsed.id)
    ) {
      throw new Error("invalid cursor");
    }
    return { recordedAt: parsed.recordedAt, id: parsed.id };
  } catch {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "감사 조회 cursor가 올바르지 않습니다.",
    );
  }
}

function encodeCursor(cursor: AuditCursor): string {
  return btoa(JSON.stringify(cursor))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function optionalDate(value: string | null, field: string): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      `${field} 시각이 올바르지 않습니다.`,
    );
  }
  return date.toISOString();
}

function auditQuery(request: Request): {
  actorProfileId: string | null;
  before: AuditCursor | null;
  eventTypes: string[] | null;
  from: string | null;
  limit: number;
  to: string | null;
} {
  const parameters = new URL(request.url).searchParams;
  for (const name of parameters.keys()) {
    if (!allowedAuditParameters.has(name)) {
      throw new EdgeError(
        400,
        "VALIDATION_ERROR",
        "허용되지 않은 감사 조회 조건입니다.",
      );
    }
  }
  const limitValue = parameters.get("limit") ?? "50";
  if (!/^\d{1,3}$/.test(limitValue)) {
    throw new EdgeError(400, "VALIDATION_ERROR", "limit이 올바르지 않습니다.");
  }
  const limit = Number(limitValue);
  if (limit < 1 || limit > 100) {
    throw new EdgeError(400, "VALIDATION_ERROR", "limit은 1~100입니다.");
  }
  const actorProfileId = parameters.get("actorProfileId");
  if (actorProfileId && !uuidPattern.test(actorProfileId)) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "actorProfileId가 올바르지 않습니다.",
    );
  }
  const eventTypes = parameters.getAll("eventType");
  if (eventTypes.length > 27 || eventTypes.some((value) => value.length > 80)) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "eventType 조회 조건이 올바르지 않습니다.",
    );
  }
  return {
    actorProfileId,
    before: parameters.get("cursor")
      ? decodeCursor(parameters.get("cursor") as string)
      : null,
    eventTypes: eventTypes.length > 0 ? eventTypes : null,
    from: optionalDate(parameters.get("from"), "from"),
    limit,
    to: optionalDate(parameters.get("to"), "to"),
  };
}

function selectedValues(
  parameters: URLSearchParams,
  name: string,
  allowed: Set<string>,
): string[] | null {
  const values = parameters.getAll(name);
  if (values.length === 0) {
    return null;
  }
  if (
    values.length > allowed.size || values.some((value) => !allowed.has(value))
  ) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      `${name} 조회 조건이 올바르지 않습니다.`,
    );
  }
  return values;
}

function activityQuery(request: Request): {
  actorProfileId: string | null;
  before: AuditCursor | null;
  categories: string[] | null;
  eventTypes: string[] | null;
  from: string | null;
  limit: number;
  outcomes: string[] | null;
  role: string | null;
  to: string | null;
} {
  const parameters = new URL(request.url).searchParams;
  for (const name of parameters.keys()) {
    if (!allowedActivityParameters.has(name)) {
      throw new EdgeError(
        400,
        "VALIDATION_ERROR",
        "허용되지 않은 활동 로그 조회 조건입니다.",
      );
    }
  }
  const limitValue = parameters.get("limit") ?? "50";
  if (!/^\d{1,3}$/.test(limitValue)) {
    throw new EdgeError(400, "VALIDATION_ERROR", "limit이 올바르지 않습니다.");
  }
  const limit = Number(limitValue);
  if (limit < 1 || limit > 100) {
    throw new EdgeError(400, "VALIDATION_ERROR", "limit은 1~100입니다.");
  }
  const actorProfileId = parameters.get("actorProfileId");
  if (actorProfileId && !uuidPattern.test(actorProfileId)) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "actorProfileId가 올바르지 않습니다.",
    );
  }
  const role = parameters.get("role");
  if (role && !activityRoles.has(role)) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "role 조회 조건이 올바르지 않습니다.",
    );
  }
  const from = optionalDate(parameters.get("from"), "from");
  const to = optionalDate(parameters.get("to"), "to");
  if (
    from && to && Date.parse(to) - Date.parse(from) > 31 * 24 * 60 * 60 * 1000
  ) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "조회 기간은 최대 31일입니다.",
    );
  }
  return {
    actorProfileId,
    before: parameters.get("cursor")
      ? decodeCursor(parameters.get("cursor") as string)
      : null,
    categories: selectedValues(parameters, "category", activityCategories),
    eventTypes: selectedValues(parameters, "eventType", activityEventTypes),
    from,
    limit,
    outcomes: selectedValues(parameters, "outcome", activityOutcomes),
    role,
    to,
  };
}

export function toDeveloperAuditEvent(row: AuditRow): Record<string, unknown> {
  return {
    id: row.id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorProfileId: row.actor_profile_id,
    actorDisplayName: row.actor_display_name,
    effectiveAt: row.effective_at,
    recordedAt: row.recorded_at,
    reasonCode: row.reason_code,
    summary: row.summary,
  };
}

export async function developerAuditEvents(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  requireDeveloper(actor);
  const query = auditQuery(request);
  const { data, error } = await clients.admin.rpc(
    "list_developer_audit_events",
    {
      p_actor_profile_id: actor.profileId,
      p_event_types: query.eventTypes,
      p_filter_actor_profile_id: query.actorProfileId,
      p_from: query.from,
      p_to: query.to,
      p_before_recorded_at: query.before?.recordedAt ?? null,
      p_before_id: query.before?.id ?? null,
      p_limit: query.limit,
    },
  );
  if (error || !Array.isArray(data)) {
    projectionError(error);
  }
  const rows = data as AuditRow[];
  const last = rows.at(-1);
  return {
    events: rows.map(toDeveloperAuditEvent),
    nextCursor: rows.length === query.limit && last
      ? encodeCursor({ recordedAt: last.recorded_at, id: last.id })
      : null,
  };
}

export function toDeveloperActivityEvent(
  row: ActivityRow,
): Record<string, unknown> {
  return {
    id: row.id,
    category: row.category,
    eventType: row.event_type,
    outcome: row.outcome,
    actorProfileId: row.actor_profile_id,
    actorRole: row.actor_role,
    source: row.source,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    reasonCode: row.reason_code,
    requestId: row.request_id,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    summary: row.summary,
  };
}

export async function developerActivityEvents(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  requireDeveloper(actor);
  const query = activityQuery(request);
  const { data, error } = await clients.admin.rpc(
    "list_developer_activity_events",
    {
      p_actor_profile_id: actor.profileId,
      p_filter_actor_profile_id: query.actorProfileId,
      p_role: query.role,
      p_categories: query.categories,
      p_event_types: query.eventTypes,
      p_outcomes: query.outcomes,
      p_from: query.from,
      p_to: query.to,
      p_before_recorded_at: query.before?.recordedAt ?? null,
      p_before_id: query.before?.id ?? null,
      p_limit: query.limit,
    },
  );
  if (error || !Array.isArray(data)) {
    projectionError(error);
  }
  const rows = data as ActivityRow[];
  const last = rows.at(-1);
  return {
    events: rows.map(toDeveloperActivityEvent),
    nextCursor: rows.length === query.limit && last
      ? encodeCursor({ recordedAt: last.recorded_at, id: last.id })
      : null,
  };
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("DIAGNOSTIC_TIMEOUT")),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function diagnosticResult(
  id: string,
  result: PromiseSettledResult<Record<string, unknown>>,
): Record<string, unknown> {
  if (result.status === "fulfilled") {
    return { id, status: "passed", detail: result.value };
  }
  return {
    id,
    status: result.reason instanceof Error &&
        result.reason.message === "DIAGNOSTIC_TIMEOUT"
      ? "timed_out"
      : "failed",
    errorCode: result.reason instanceof EdgeError
      ? result.reason.code
      : "DIAGNOSTIC_FAILED",
  };
}

function invalidDiagnosticBody(): never {
  throw new EdgeError(
    400,
    "VALIDATION_ERROR",
    "진단 API는 요청 본문을 받지 않습니다.",
  );
}

export async function assertEmptyDiagnosticRequestBody(
  request: Request,
): Promise<void> {
  const contentLength = request.headers.get("content-length")?.trim();
  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > 0)
  ) {
    invalidDiagnosticBody();
  }
  if (request.body === null) {
    return;
  }

  const reader = request.body.getReader();
  let hasBodyChunk = false;
  let streamEnded = false;
  try {
    for (let emptyChunks = 0; emptyChunks < 8; emptyChunks += 1) {
      const chunk = await reader.read();
      if (chunk.done) {
        streamEnded = true;
        break;
      }
      if ((chunk.value?.byteLength ?? 0) > 0) {
        hasBodyChunk = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (hasBodyChunk || !streamEnded) {
    invalidDiagnosticBody();
  }
}

export async function runDeveloperDiagnostics(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  requireDeveloper(actor);
  await assertEmptyDiagnosticRequestBody(request);

  const { data: limitData, error: limitError } = await clients.admin.rpc(
    "consume_developer_diagnostic_limit",
    { p_actor_profile_id: actor.profileId, p_limit: 10, p_window_seconds: 60 },
  );
  const limit = Array.isArray(limitData)
    ? limitData[0] as DiagnosticLimitRow | undefined
    : undefined;
  if (limitError || !limit) {
    projectionError(limitError);
  }
  if (!limit.allowed) {
    throw new EdgeError(
      429,
      "DIAGNOSTICS_RATE_LIMITED",
      "진단 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      { "retry-after": String(Math.max(1, limit.retry_after_seconds)) },
    );
  }

  const checks = await Promise.allSettled([
    withTimeout(developerDatabaseStatus(clients, actor), 3_000),
    withTimeout(developerSchedulerStatus(clients, actor), 3_000),
  ]);
  return {
    status: checks.every((result) => result.status === "fulfilled")
      ? "passed"
      : "degraded",
    checks: [
      { id: "auth-session", status: "passed" },
      {
        id: "edge-runtime",
        status: "passed",
        detail: developerRuntimeStatus(),
      },
      diagnosticResult("database", checks[0]),
      diagnosticResult("scheduler", checks[1]),
    ],
    checkedAt: new Date().toISOString(),
  };
}
