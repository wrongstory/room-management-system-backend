import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { bearerToken, EdgeError, requiredEnv } from "./runtime.ts";

type AppRole = "developer" | "admin" | "maid";
type ManagedRole = Exclude<AppRole, "developer">;
type AccountStatus =
  | "active"
  | "deactivation_pending"
  | "upload_only"
  | "inactive"
  | "departed";

interface ProfileRow {
  id: string;
  auth_user_id: string;
  display_name: string;
  display_name_normalized: string;
  login_id: string;
  login_id_normalized: string;
  role: AppRole;
  status: AccountStatus;
  phone_last_four: string | null;
  phone_lookup_hash: string | null;
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

interface Account {
  id: string;
  displayName: string;
  loginId: string;
  role: AppRole;
  status: AccountStatus;
  phoneLastFour: string | null;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

const accountColumns = [
  "id",
  "auth_user_id",
  "display_name",
  "display_name_normalized",
  "login_id",
  "login_id_normalized",
  "role",
  "status",
  "phone_last_four",
  "phone_lookup_hash",
  "must_change_password",
  "failed_login_count",
  "locked_until",
  "created_at",
  "updated_at",
].join(",");

const personalNumericPassword = /^\d{6,72}$/;
const personalStrongPassword =
  /^(?=.{10,72}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])[\x20-\x7e]+$/;
const temporaryPassword = /^\d{4}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idempotencyPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const reasonCodePattern = /^[A-Z0-9_]{2,80}$/;

function invalidRequest(message: string): never {
  throw new EdgeError(400, "VALIDATION_ERROR", message);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    invalidRequest("JSON 객체 요청 본문이 필요합니다.");
  }
  return value as Record<string, unknown>;
}

function stringField(
  body: Record<string, unknown>,
  name: string,
  minimum: number,
  maximum: number,
): string {
  const value = body[name];
  if (typeof value !== "string") {
    invalidRequest(`${name} 문자열이 필요합니다.`);
  }
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    invalidRequest(`${name} 길이가 허용 범위를 벗어났습니다.`);
  }
  return normalized;
}

export async function readJsonBody(
  request: Request,
  maximumBytes = 16_384,
): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximumBytes) {
    throw new EdgeError(413, "REQUEST_TOO_LARGE", "요청 본문이 너무 큽니다.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new EdgeError(413, "REQUEST_TOO_LARGE", "요청 본문이 너무 큽니다.");
  }
  try {
    return asObject(JSON.parse(raw));
  } catch {
    invalidRequest("올바른 JSON 요청 본문이 필요합니다.");
  }
}

export function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!idempotencyPattern.test(value)) {
    invalidRequest("유효한 Idempotency-Key 헤더가 필요합니다.");
  }
  return value;
}

export function profileIdFromPath(path: string, suffix: string): string | null {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = path.match(
    new RegExp(`^/v1/accounts/([^/]+)/${escapedSuffix}$`),
  );
  if (!match?.[1] || !uuidPattern.test(match[1])) {
    return null;
  }
  return match[1];
}

export function normalizeLoginId(loginId: string): string {
  return loginId.normalize("NFKC").trim().toLocaleLowerCase("ko-KR");
}

function normalizeDisplayName(value: string): {
  displayName: string;
  normalized: string;
} {
  const displayName = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (displayName.length < 2 || displayName.length > 40) {
    invalidRequest("displayName 길이가 허용 범위를 벗어났습니다.");
  }
  return {
    displayName,
    normalized: displayName.toLocaleLowerCase("ko-KR"),
  };
}

function normalizeKoreanMobile(value: string): {
  canonical: string;
  lastFour: string;
} {
  const digits = value.replace(/\D/g, "");
  const domestic = digits.startsWith("82") ? `0${digits.slice(2)}` : digits;
  if (!/^010\d{8}$/.test(domestic)) {
    throw new EdgeError(
      400,
      "INVALID_PHONE",
      "휴대전화 번호를 010으로 시작하는 11자리로 입력해 주세요.",
    );
  }
  return { canonical: `+82${domestic.slice(1)}`, lastFour: domestic.slice(-4) };
}

function isPersonalPassword(value: string): boolean {
  return personalNumericPassword.test(value) ||
    personalStrongPassword.test(value);
}

function isLoginPassword(value: string): boolean {
  return temporaryPassword.test(value) || isPersonalPassword(value);
}

function toSupabaseAuthPassword(value: string): string {
  return temporaryPassword.test(value) ? `tmp:${value}` : value;
}

function syntheticEmail(profileId: string): string {
  return `user-${profileId}@auth.castletheart.invalid`;
}

async function hmacHex(key: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(value),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

/** 계정 command의 재시도 payload를 동일하게 식별하는 canonical SHA-256이다. */
async function requestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toAccount(row: ProfileRow): Account {
  return {
    id: row.id,
    displayName: row.display_name,
    loginId: row.login_id,
    role: row.role,
    status: row.status,
    phoneLastFour: row.phone_last_four,
    mustChangePassword: row.must_change_password,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureAccountManager(actor: EdgeActor): void {
  if (actor.role !== "developer" && actor.role !== "admin") {
    throw new EdgeError(
      403,
      "ACCOUNT_MANAGER_REQUIRED",
      "계정 관리 권한이 필요합니다.",
    );
  }
  if (actor.mustChangePassword) {
    throw new EdgeError(
      403,
      "PASSWORD_CHANGE_REQUIRED",
      "계속하려면 먼저 임시 비밀번호를 변경해 주세요.",
    );
  }
}

function databaseError(
  error: { code?: string; message?: string } | null,
): EdgeError {
  const message = error?.message ?? "";
  const mappings: Array<[string, number, string, string]> = [
    [
      "LAST_ACTIVE_ADMIN_REQUIRED",
      409,
      "LAST_ACTIVE_ADMIN_REQUIRED",
      "마지막 활성 관리자 계정은 변경할 수 없습니다.",
    ],
    [
      "ACCOUNT_MUST_BE_INACTIVE_BEFORE_DEPARTURE",
      409,
      "ACCOUNT_MUST_BE_INACTIVE",
      "퇴사 처리 전에 계정을 먼저 비활성화해 주세요.",
    ],
    [
      "DEPARTED_ACCOUNT_IMMUTABLE",
      409,
      "DEPARTED_ACCOUNT_IMMUTABLE",
      "퇴사 처리된 계정은 변경할 수 없습니다.",
    ],
    [
      "ACCOUNT_NOT_FOUND_OR_DEPARTED",
      404,
      "ACCOUNT_NOT_FOUND",
      "계정을 찾을 수 없습니다.",
    ],
    ["ACCOUNT_NOT_FOUND", 404, "ACCOUNT_NOT_FOUND", "계정을 찾을 수 없습니다."],
    [
      "DEVELOPER_ACCOUNT_PROTECTED",
      403,
      "DEVELOPER_ACCOUNT_PROTECTED",
      "최상위 개발자 계정은 이 작업으로 변경할 수 없습니다.",
    ],
    [
      "ACTIVE_ACCOUNT_MANAGER_REQUIRED",
      403,
      "ACCOUNT_MANAGER_REQUIRED",
      "활성 계정 관리자 권한이 필요합니다.",
    ],
    [
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "이미 다른 요청에 사용한 Idempotency-Key입니다.",
    ],
    [
      "DEACTIVATION_MUST_BE_FINISHED",
      409,
      "DEACTIVATION_MUST_BE_FINISHED",
      "제한된 계정 비활성화를 먼저 종결해야 합니다.",
    ],
  ];
  for (const [needle, status, code, userMessage] of mappings) {
    if (message.includes(needle)) {
      return new EdgeError(status, code, userMessage);
    }
  }
  if (error?.code === "23505" && message.includes("phone_lookup_hash")) {
    return new EdgeError(
      409,
      "PHONE_ALREADY_REGISTERED",
      "이미 등록된 휴대전화 번호입니다. 기존 계정을 복구해 주세요.",
    );
  }
  if (error?.code === "23505") {
    return new EdgeError(
      409,
      "LOGIN_ID_CONFLICT",
      "로그인 아이디를 만들 수 없습니다. 이름을 확인해 주세요.",
    );
  }
  return new EdgeError(
    500,
    "ACCOUNT_COMMAND_FAILED",
    "계정 변경을 완료하지 못했습니다.",
  );
}

async function getProfile(
  clients: EdgeClients,
  column: "id" | "auth_user_id",
  value: string,
): Promise<ProfileRow> {
  const { data, error } = await clients.admin
    .from("profiles")
    .select(accountColumns)
    .eq(column, value)
    .single();
  if (error || !data) {
    throw new EdgeError(404, "ACCOUNT_NOT_FOUND", "계정을 찾을 수 없습니다.");
  }
  return data as unknown as ProfileRow;
}

async function replayAccountProfile(
  clients: EdgeClients,
  actorProfileId: string,
  commandType: string,
  key: string,
  hash: string,
): Promise<ProfileRow | null> {
  const { data, error } = await clients.admin.rpc("replay_account_command", {
    p_actor_profile_id: actorProfileId,
    p_command_type: commandType,
    p_idempotency_key: key,
    p_request_hash: hash,
  });
  if (error) {
    throw databaseError(error);
  }
  if (typeof data !== "string") {
    return null;
  }
  return getProfile(clients, "id", data);
}

function validGatewayAddress(value: string | null): string | null {
  const normalized = value?.trim().toLocaleLowerCase("en-US") ?? "";
  if (
    normalized.length < 2 || normalized.length > 64 ||
    !/^[0-9a-f:.]+$/.test(normalized) ||
    (!normalized.includes(".") && !normalized.includes(":"))
  ) {
    return null;
  }
  return normalized;
}

function trustedClientAddress(request: Request): string {
  // Hosted Supabase attaches Cloudflare/gateway client address metadata. The
  // platform value wins over all caller-controlled fallback headers.
  const cloudflare = validGatewayAddress(
    request.headers.get("cf-connecting-ip"),
  );
  if (cloudflare) {
    return `cf:${cloudflare}`;
  }

  let requestHostname = "";
  try {
    requestHostname = new URL(request.url).hostname.toLocaleLowerCase(
      "en-US",
    );
  } catch {
    // The runtime configuration validator reports malformed URLs separately.
  }
  if (
    requestHostname.endsWith(".supabase.co") ||
    requestHostname.endsWith(".supabase.in")
  ) {
    throw new EdgeError(
      503,
      "LOGIN_CLIENT_ID_UNAVAILABLE",
      "로그인 요청의 보호 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    );
  }

  // The remaining headers are accepted only for local/self-hosted gateways,
  // whose reverse proxy must overwrite them with its peer address.
  const realIp = validGatewayAddress(request.headers.get("x-real-ip"));
  if (realIp) {
    return `gateway:${realIp}`;
  }

  // Local/self-hosted gateways append their peer address to X-Forwarded-For.
  // Read from the right so a caller-prepended value cannot select its bucket.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",") ?? [];
  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    const address = validGatewayAddress(forwarded[index] ?? null);
    if (address) {
      return `forwarded:${address}`;
    }
  }
  const hostname = new URL(request.url).hostname.toLocaleLowerCase("en-US");
  if (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  ) {
    return "local-development";
  }
  throw new EdgeError(
    503,
    "LOGIN_CLIENT_ID_UNAVAILABLE",
    "로그인 요청의 보호 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  );
}

function assertIdempotentAccountCreation(
  existing: Pick<
    ProfileRow,
    "display_name_normalized" | "role" | "phone_lookup_hash"
  >,
  requested: {
    displayNameNormalized: string;
    role: ManagedRole;
    phoneLookupHash: string;
  },
): void {
  if (
    existing.display_name_normalized !== requested.displayNameNormalized ||
    existing.role !== requested.role ||
    existing.phone_lookup_hash !== requested.phoneLookupHash
  ) {
    throw new EdgeError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "이미 다른 요청에 사용한 Idempotency-Key입니다.",
    );
  }
}

async function consumeLoginRateLimit(
  request: Request,
  clients: EdgeClients,
  normalizedLoginId: string,
): Promise<void> {
  const pepper = requiredEnv("ACCOUNT_PHONE_PEPPER");
  const [clientKeyHash, loginKeyHash, globalKeyHash] = await Promise.all([
    hmacHex(
      pepper,
      `edge-login-rate-limit:client:v1:${trustedClientAddress(request)}`,
    ),
    hmacHex(
      pepper,
      `edge-login-rate-limit:${normalizedLoginId}`,
    ),
    hmacHex(pepper, "edge-login-rate-limit:global-emergency:v1"),
  ]);
  const { data, error } = await clients.admin.rpc("consume_login_rate_limits", {
    p_client_key_hash: clientKeyHash,
    p_login_key_hash: loginKeyHash,
    p_global_key_hash: globalKeyHash,
    p_client_limit: 30,
    p_login_limit: 10,
    p_global_limit: 600,
    p_window_seconds: 60,
  });
  if (error || !Array.isArray(data) || !data[0]) {
    throw new EdgeError(
      503,
      "LOGIN_RATE_LIMIT_UNAVAILABLE",
      "로그인 보호 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    );
  }
  const result = data[0] as {
    allowed?: unknown;
    retry_after_seconds?: unknown;
  };
  if (result.allowed !== true) {
    const retryAfter = typeof result.retry_after_seconds === "number"
      ? Math.max(1, Math.min(3600, Math.ceil(result.retry_after_seconds)))
      : 60;
    throw new EdgeError(
      429,
      "LOGIN_RATE_LIMITED",
      "로그인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      { "retry-after": String(retryAfter) },
    );
  }
}

export async function login(
  request: Request,
  clients: EdgeClients,
): Promise<Record<string, unknown>> {
  const body = await readJsonBody(request);
  const loginId = stringField(body, "loginId", 1, 80);
  const passwordValue = body.password;
  if (typeof passwordValue !== "string" || !isLoginPassword(passwordValue)) {
    invalidRequest(
      "임시 비밀번호 4자리 또는 허용된 개인 비밀번호를 입력해 주세요.",
    );
  }
  const password = passwordValue as string;
  const alias = normalizeLoginId(loginId);
  await consumeLoginRateLimit(request, clients, alias);

  const { data: aliasRow, error: aliasError } = await clients.admin
    .from("login_aliases")
    .select("profile_id")
    .eq("alias_normalized", alias)
    .eq("active", true)
    .maybeSingle();
  if (aliasError) {
    throw new EdgeError(
      500,
      "AUTH_LOOKUP_FAILED",
      "로그인 정보를 확인하지 못했습니다.",
    );
  }
  if (!aliasRow) {
    throw new EdgeError(
      401,
      "INVALID_CREDENTIALS",
      "아이디 또는 로그인 비밀번호가 올바르지 않습니다.",
    );
  }

  const profile = await getProfile(clients, "id", aliasRow.profile_id);
  if (profile.status !== "active") {
    throw new EdgeError(
      403,
      "ACCOUNT_INACTIVE",
      "현재 사용할 수 없는 계정입니다.",
    );
  }
  if (profile.locked_until && Date.parse(profile.locked_until) > Date.now()) {
    throw new EdgeError(
      423,
      "ACCOUNT_LOCKED",
      "로그인 실패가 반복되어 계정이 잠겼습니다. 잠시 후 다시 시도해 주세요.",
    );
  }

  const { data, error } = await clients.publicClient.auth.signInWithPassword({
    email: syntheticEmail(profile.id),
    password: toSupabaseAuthPassword(password),
  });
  if (error || !data.session) {
    await clients.admin.rpc("record_login_failure", {
      p_profile_id: profile.id,
    });
    throw new EdgeError(
      401,
      "INVALID_CREDENTIALS",
      "아이디 또는 로그인 비밀번호가 올바르지 않습니다.",
    );
  }

  const { data: retiredAliasCount, error: successError } = await clients.admin
    .rpc(
      "record_login_success",
      { p_profile_id: profile.id, p_login_alias_normalized: alias },
    );
  if (successError) {
    await clients.admin.auth.admin.signOut(data.session.access_token, "local");
    throw new EdgeError(
      500,
      "LOGIN_STATE_UPDATE_FAILED",
      "로그인 상태를 갱신하지 못했습니다.",
    );
  }
  if (typeof retiredAliasCount === "number" && retiredAliasCount > 0) {
    await clients.admin.auth.admin.signOut(data.session.access_token, "others");
  }

  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresIn: data.session.expires_in,
    user: {
      authUserId: profile.auth_user_id,
      profileId: profile.id,
      displayName: profile.display_name,
      role: profile.role,
      mustChangePassword: profile.must_change_password,
    },
  };
}

export async function changePassword(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<void> {
  const body = await readJsonBody(request);
  const current = body.currentPassword;
  const next = body.newPassword;
  if (typeof current !== "string" || !isLoginPassword(current)) {
    invalidRequest("현재 비밀번호 형식이 올바르지 않습니다.");
  }
  if (typeof next !== "string" || !isPersonalPassword(next)) {
    invalidRequest("새 비밀번호는 허용된 개인 비밀번호 형식이어야 합니다.");
  }
  if (current === next) {
    invalidRequest("새 비밀번호는 현재 비밀번호와 달라야 합니다.");
  }

  const { data: verification, error: verificationError } = await clients
    .publicClient.auth.signInWithPassword({
      email: syntheticEmail(actor.profileId),
      password: toSupabaseAuthPassword(current),
    });
  if (verificationError || !verification.session) {
    throw new EdgeError(
      401,
      "INVALID_CURRENT_PASSWORD",
      "현재 비밀번호가 올바르지 않습니다.",
    );
  }

  const { error: updateError } = await clients.admin.auth.admin.updateUserById(
    actor.authUserId,
    { password: toSupabaseAuthPassword(next) },
  );
  if (updateError) {
    await clients.admin.auth.admin.signOut(
      verification.session.access_token,
      "local",
    );
    throw new EdgeError(
      502,
      "AUTH_PASSWORD_CHANGE_FAILED",
      "비밀번호를 변경하지 못했습니다.",
    );
  }

  await clients.admin.auth.admin.signOut(bearerToken(request), "others");
  const { error } = await clients.admin.rpc("complete_password_change", {
    p_actor_profile_id: actor.profileId,
    p_idempotency_key: idempotencyKey(request),
  });
  if (error) {
    const { error: rollbackError } = await clients.admin.auth.admin
      .updateUserById(
        actor.authUserId,
        { password: toSupabaseAuthPassword(current) },
      );
    if (rollbackError) {
      throw new EdgeError(
        500,
        "PASSWORD_STATE_INCONSISTENT",
        "비밀번호 상태를 복구하지 못했습니다. 관리자에게 비밀번호 초기화를 요청해 주세요.",
      );
    }
    throw new EdgeError(
      500,
      "PASSWORD_STATE_UPDATE_FAILED",
      "비밀번호 변경 상태를 저장하지 못했습니다.",
    );
  }
}

export async function listAccounts(
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Account[]> {
  ensureAccountManager(actor);
  const { data, error } = await clients.admin
    .from("profiles")
    .select(accountColumns)
    .order("created_at", { ascending: true });
  if (error) {
    throw databaseError(error);
  }
  return (data as unknown as ProfileRow[]).map(toAccount);
}

export async function createAccount(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<{ account: Account; temporaryPassword: string }> {
  ensureAccountManager(actor);
  const body = await readJsonBody(request);
  const name = normalizeDisplayName(stringField(body, "displayName", 2, 40));
  const roleValue = body.role;
  if (roleValue !== "admin" && roleValue !== "maid") {
    invalidRequest("role은 admin 또는 maid여야 합니다.");
  }
  const role = roleValue as ManagedRole;
  const phone = normalizeKoreanMobile(stringField(body, "phone", 10, 30));
  const phoneHash = await hmacHex(
    requiredEnv("ACCOUNT_PHONE_PEPPER"),
    phone.canonical,
  );
  const key = idempotencyKey(request);
  const fingerprint = {
    displayNameNormalized: name.normalized,
    role,
    phoneLookupHash: phoneHash,
  };
  const hash = await requestHash({
    actorProfileId: actor.profileId,
    command: "account.create",
    ...fingerprint,
  });
  const existing = await replayAccountProfile(
    clients,
    actor.profileId,
    "account.create",
    key,
    hash,
  );
  if (existing) {
    assertIdempotentAccountCreation(existing, fingerprint);
    return {
      account: toAccount(existing),
      temporaryPassword: existing.phone_last_four ?? phone.lastFour,
    };
  }

  const profileId = crypto.randomUUID();
  const { data: authData, error: authError } = await clients.admin.auth.admin
    .createUser({
      id: profileId,
      email: syntheticEmail(profileId),
      password: toSupabaseAuthPassword(phone.lastFour),
      email_confirm: true,
      app_metadata: { profile_id: profileId, role },
    });
  if (authError || !authData.user) {
    throw new EdgeError(
      502,
      "AUTH_USER_CREATE_FAILED",
      "인증 계정을 만들지 못했습니다.",
    );
  }

  let profileCommandCompleted = false;
  try {
    const { data, error } = await clients.admin.rpc("create_account_profile", {
      p_profile_id: profileId,
      p_auth_user_id: authData.user.id,
      p_actor_profile_id: actor.profileId,
      p_display_name: name.displayName,
      p_display_name_normalized: name.normalized,
      p_role: role,
      p_phone_last_four: phone.lastFour,
      p_phone_lookup_hash: phoneHash,
      p_idempotency_key: key,
      p_request_hash: hash,
    });
    if (error || !data) {
      throw databaseError(error);
    }
    profileCommandCompleted = true;
    const row = data as unknown as ProfileRow;
    assertIdempotentAccountCreation(row, fingerprint);
    if (row.id !== profileId) {
      const { error: cleanupError } = await clients.admin.auth.admin.deleteUser(
        profileId,
      );
      if (cleanupError) {
        throw new EdgeError(
          502,
          "ACCOUNT_AUTH_STATE_INCONSISTENT",
          "중복 Auth 계정을 정리하지 못했습니다. 운영자 확인이 필요합니다.",
        );
      }
    }
    return {
      account: toAccount(row),
      temporaryPassword: row.phone_last_four ?? phone.lastFour,
    };
  } catch (error) {
    if (profileCommandCompleted) {
      throw error;
    }
    const { error: cleanupError } = await clients.admin.auth.admin.deleteUser(
      profileId,
    );
    if (cleanupError) {
      throw new EdgeError(
        502,
        "ACCOUNT_AUTH_STATE_INCONSISTENT",
        "프로필 생성 실패 후 Auth 계정을 정리하지 못했습니다. 운영자 확인이 필요합니다.",
      );
    }
    throw error;
  }
}

export async function changeAccountRole(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  targetProfileId: string,
): Promise<Account> {
  ensureAccountManager(actor);
  const body = await readJsonBody(request);
  if (body.role !== "admin" && body.role !== "maid") {
    invalidRequest("role은 admin 또는 maid여야 합니다.");
  }
  const role = body.role as ManagedRole;
  const key = idempotencyKey(request);
  const hash = await requestHash({
    actorProfileId: actor.profileId,
    command: "account.role.change",
    role,
    targetProfileId,
  });
  const before = await getProfile(clients, "id", targetProfileId);
  if (before.role === "developer") {
    throw new EdgeError(
      403,
      "DEVELOPER_ACCOUNT_PROTECTED",
      "최상위 개발자 역할은 변경할 수 없습니다.",
    );
  }
  const { error: authError } = await clients.admin.auth.admin.updateUserById(
    before.auth_user_id,
    { app_metadata: { profile_id: before.id, role } },
  );
  if (authError) {
    throw new EdgeError(
      502,
      "AUTH_USER_UPDATE_FAILED",
      "인증 계정 역할을 변경하지 못했습니다.",
    );
  }
  const { data, error } = await clients.admin.rpc("change_account_role", {
    p_actor_profile_id: actor.profileId,
    p_target_profile_id: targetProfileId,
    p_role: role,
    p_idempotency_key: key,
    p_request_hash: hash,
  });
  if (error || !data) {
    const { error: rollbackError } = await clients.admin.auth.admin
      .updateUserById(
        before.auth_user_id,
        {
          app_metadata: { profile_id: before.id, role: before.role },
        },
      );
    if (rollbackError) {
      throw new EdgeError(
        502,
        "ACCOUNT_AUTH_STATE_INCONSISTENT",
        "역할 변경 실패 후 Auth 역할을 복구하지 못했습니다. 운영자 확인이 필요합니다.",
      );
    }
    throw databaseError(error);
  }
  return toAccount(data as unknown as ProfileRow);
}

export async function changeAccountStatus(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  targetProfileId: string,
): Promise<Account> {
  ensureAccountManager(actor);
  const body = await readJsonBody(request);
  if (
    body.status !== "active" && body.status !== "inactive" &&
    body.status !== "departed"
  ) {
    invalidRequest("status는 active, inactive 또는 departed여야 합니다.");
  }
  const reasonCode = stringField(body, "reasonCode", 2, 80);
  if (!reasonCodePattern.test(reasonCode)) {
    invalidRequest("reasonCode 형식이 올바르지 않습니다.");
  }
  const key = idempotencyKey(request);
  const hash = await requestHash({
    actorProfileId: actor.profileId,
    command: "account.status.change",
    reasonCode,
    status: body.status,
    targetProfileId,
  });
  const before = await getProfile(clients, "id", targetProfileId);
  if (before.role === "developer") {
    throw new EdgeError(
      403,
      "DEVELOPER_ACCOUNT_PROTECTED",
      "최상위 개발자 상태는 변경할 수 없습니다.",
    );
  }
  const { data, error } = await clients.admin.rpc("change_account_status", {
    p_actor_profile_id: actor.profileId,
    p_target_profile_id: targetProfileId,
    p_status: body.status,
    p_reason_code: reasonCode,
    p_idempotency_key: key,
    p_request_hash: hash,
  });
  if (error || !data) {
    throw databaseError(error);
  }
  const row = data as unknown as ProfileRow;
  const { error: authError } = await clients.admin.auth.admin.updateUserById(
    before.auth_user_id,
    { ban_duration: row.status === "active" ? "none" : "876000h" },
  );
  if (authError) {
    throw new EdgeError(
      502,
      "ACCOUNT_AUTH_STATE_INCONSISTENT",
      "DB 계정 상태는 변경됐지만 Auth 동기화에 실패했습니다. 동일한 Idempotency-Key로 다시 시도해 주세요.",
    );
  }
  return toAccount(row);
}

async function runAccountRpc(
  clients: EdgeClients,
  name: string,
  parameters: Record<string, string>,
): Promise<Account> {
  const { data, error } = await clients.admin.rpc(name, parameters);
  if (error || !data) {
    throw databaseError(error);
  }
  return toAccount(data as unknown as ProfileRow);
}

export async function unlockAccount(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  targetProfileId: string,
): Promise<Account> {
  ensureAccountManager(actor);
  const before = await getProfile(clients, "id", targetProfileId);
  if (before.role === "developer") {
    throw new EdgeError(
      403,
      "DEVELOPER_ACCOUNT_PROTECTED",
      "최상위 개발자 잠금은 일반 계정 명령으로 해제할 수 없습니다.",
    );
  }
  const key = idempotencyKey(request);
  return runAccountRpc(clients, "unlock_account", {
    p_actor_profile_id: actor.profileId,
    p_target_profile_id: targetProfileId,
    p_idempotency_key: key,
    p_request_hash: await requestHash({
      actorProfileId: actor.profileId,
      command: "account.unlock",
      targetProfileId,
    }),
  });
}

export async function resetAccountPassword(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  targetProfileId: string,
): Promise<Account> {
  ensureAccountManager(actor);
  const before = await getProfile(clients, "id", targetProfileId);
  if (before.role === "developer") {
    throw new EdgeError(
      403,
      "DEVELOPER_ACCOUNT_PROTECTED",
      "최상위 개발자 비밀번호는 본인만 변경할 수 있습니다.",
    );
  }
  const key = idempotencyKey(request);
  const { data, error } = await clients.admin.rpc(
    "prepare_account_password_reset",
    {
      p_actor_profile_id: actor.profileId,
      p_target_profile_id: targetProfileId,
      p_idempotency_key: key,
      p_request_hash: await requestHash({
        actorProfileId: actor.profileId,
        command: "account.password.reset",
        targetProfileId,
      }),
    },
  );
  if (error || !data) {
    throw databaseError(error);
  }
  const row = data as unknown as ProfileRow;
  if (!row.phone_last_four) {
    throw new EdgeError(
      409,
      "PHONE_REQUIRED_FOR_RESET",
      "등록된 휴대전화 번호가 없어 초기화할 수 없습니다.",
    );
  }
  const { error: authError } = await clients.admin.auth.admin.updateUserById(
    row.auth_user_id,
    { password: toSupabaseAuthPassword(row.phone_last_four) },
  );
  if (authError) {
    throw new EdgeError(
      502,
      "AUTH_PASSWORD_RESET_FAILED",
      "인증 비밀번호를 초기화하지 못했습니다. 다시 시도해 주세요.",
    );
  }
  return toAccount(row);
}
