/** Internal service-only RPC contract, shared by Node and Edge. Never a JWT authority. */
export interface AuthContextProfile {
  id: string;
  auth_user_id: string;
  display_name: string;
  role: "developer" | "admin" | "maid";
  must_change_password: boolean;
}

const failures = {
  PROFILE_NOT_FOUND: {
    status: 401,
    message: "계정 프로필을 찾을 수 없습니다.",
  },
  ACCOUNT_INACTIVE: { status: 403, message: "현재 사용할 수 없는 계정입니다." },
  INVALID_ACCESS_TOKEN: { status: 401, message: "로그인이 필요합니다." },
  SESSION_REVOKED: {
    status: 401,
    message: "로그인이 만료되었습니다. 다시 로그인해 주세요.",
  },
  AUTH_CONTEXT_UNAVAILABLE: {
    status: 503,
    message: "로그인 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  },
} as const;
type FailureCode = keyof typeof failures;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseAuthContext(data: unknown, verifiedAuthUserId: string):
  | { profile: AuthContextProfile; failure?: never }
  | {
    profile?: never;
    failure: { code: FailureCode; status: number; message: string };
  } {
  const fail = (code: FailureCode) => ({
    failure: { code, ...failures[code] },
  });
  if (!record(data)) return fail("AUTH_CONTEXT_UNAVAILABLE");
  if (typeof data.code === "string" && Object.hasOwn(failures, data.code)) {
    return fail(data.code as FailureCode);
  }
  const p = data.profile;
  if (
    data.code !== "OK" || !record(p) ||
    typeof p.id !== "string" || !uuid.test(p.id) ||
    p.auth_user_id !== verifiedAuthUserId || !uuid.test(verifiedAuthUserId) ||
    typeof p.display_name !== "string" ||
    !["developer", "admin", "maid"].includes(p.role as string) ||
    typeof p.must_change_password !== "boolean"
  ) return fail("AUTH_CONTEXT_UNAVAILABLE");
  // Copy only the allowlisted fields, never forward an unexpected RPC payload.
  return {
    profile: {
      id: p.id,
      auth_user_id: verifiedAuthUserId,
      display_name: p.display_name,
      role: p.role as AuthContextProfile["role"],
      must_change_password: p.must_change_password,
    },
  };
}
