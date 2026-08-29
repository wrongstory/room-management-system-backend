import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface EdgeActor {
  authUserId: string;
  profileId: string;
  displayName: string;
  role: "developer" | "admin" | "maid";
  mustChangePassword: boolean;
}

interface ProfileRow {
  id: string;
  auth_user_id: string;
  display_name: string;
  role: "developer" | "admin" | "maid";
  status: string;
  must_change_password: boolean;
}

export class EdgeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EdgeError";
  }
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new EdgeError(
      503,
      "RUNTIME_NOT_CONFIGURED",
      `${name} 환경값이 필요합니다.`,
    );
  }
  return value;
}

export function createEdgeClients(): {
  admin: SupabaseClient;
  publicClient: SupabaseClient;
} {
  const url = requiredEnv("SUPABASE_URL");
  const anonKey = requiredEnv("SUPABASE_ANON_KEY");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const auth = {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  } as const;

  return {
    admin: createClient(url, serviceRoleKey, { auth }),
    publicClient: createClient(url, anonKey, { auth }),
  };
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new EdgeError(401, "MISSING_ACCESS_TOKEN", "로그인이 필요합니다.");
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    throw new EdgeError(401, "MISSING_ACCESS_TOKEN", "로그인이 필요합니다.");
  }
  return token;
}

function sessionId(accessToken: string): string | null {
  try {
    const encoded = accessToken.split(".")[1];
    if (!encoded) {
      return null;
    }
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - normalized.length % 4) % 4);
    const claims = JSON.parse(atob(`${normalized}${padding}`)) as {
      session_id?: unknown;
    };
    return typeof claims.session_id === "string" ? claims.session_id : null;
  } catch {
    return null;
  }
}

export async function authenticate(
  request: Request,
  clients: ReturnType<typeof createEdgeClients>,
): Promise<EdgeActor> {
  const accessToken = bearerToken(request);
  const { data: userData, error: userError } = await clients.publicClient.auth
    .getUser(accessToken);
  if (userError || !userData.user) {
    throw new EdgeError(401, "INVALID_ACCESS_TOKEN", "로그인이 필요합니다.");
  }

  const { data, error } = await clients.admin
    .from("profiles")
    .select("id,auth_user_id,display_name,role,status,must_change_password")
    .eq("auth_user_id", userData.user.id)
    .single();
  if (error || !data) {
    throw new EdgeError(
      401,
      "PROFILE_NOT_FOUND",
      "계정 프로필을 찾을 수 없습니다.",
    );
  }
  const profile = data as ProfileRow;
  if (profile.status !== "active") {
    throw new EdgeError(
      403,
      "ACCOUNT_INACTIVE",
      "현재 사용할 수 없는 계정입니다.",
    );
  }

  const activeSessionId = sessionId(accessToken);
  if (!activeSessionId) {
    throw new EdgeError(401, "INVALID_ACCESS_TOKEN", "로그인이 필요합니다.");
  }
  const { data: isActiveSession, error: sessionError } = await clients.admin
    .rpc(
      "is_active_auth_session",
      { p_auth_user_id: userData.user.id, p_session_id: activeSessionId },
    );
  if (sessionError || isActiveSession !== true) {
    throw new EdgeError(
      401,
      "SESSION_REVOKED",
      "로그인이 만료되었습니다. 다시 로그인해 주세요.",
    );
  }

  return {
    authUserId: profile.auth_user_id,
    profileId: profile.id,
    displayName: profile.display_name,
    role: profile.role,
    mustChangePassword: profile.must_change_password,
  };
}

export function requestId(request: Request): string {
  return request.headers.get("x-request-id")?.slice(0, 128) ||
    crypto.randomUUID();
}

export function requireBusinessAdmin(actor: EdgeActor): void {
  if (actor.role !== "admin") {
    throw new EdgeError(
      403,
      "ADMIN_REQUIRED",
      "관리자만 접근할 수 있습니다.",
    );
  }
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(
  error: unknown,
  id: string,
  corsHeaders: Record<string, string>,
): Response {
  if (error instanceof EdgeError) {
    return jsonResponse(
      { error: { code: error.code, message: error.message }, requestId: id },
      error.status,
      corsHeaders,
    );
  }
  console.error("Unhandled Edge Function error", { requestId: id });
  return jsonResponse(
    {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "서버 오류가 발생했습니다.",
      },
      requestId: id,
    },
    500,
    corsHeaders,
  );
}

export function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) {
    return {};
  }
  const allowed = (Deno.env.get("CORS_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) {
    throw new EdgeError(
      403,
      "ORIGIN_NOT_ALLOWED",
      "허용되지 않은 Origin입니다.",
    );
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers":
      "authorization,apikey,content-type,idempotency-key,x-request-id",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}
