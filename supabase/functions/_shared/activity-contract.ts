export type ActivitySource =
  | "edge.auth.login"
  | "edge.authorization.accounts"
  | "edge.authorization.developer"
  | "edge.authorization.availability"
  | "edge.authorization.reservations"
  | "edge.authorization.rooms"
  | "edge.sensitive.reservation_guest_name";

export type AuthorizationSource = Extract<
  ActivitySource,
  `edge.authorization.${string}`
>;

export type AuthorizationDeniedCode =
  | "ACCOUNT_MANAGER_REQUIRED"
  | "ADMIN_REQUIRED"
  | "AVAILABILITY_ACCESS_REQUIRED"
  | "DEVELOPER_REQUIRED"
  | "MAID_REQUIRED"
  | "PASSWORD_CHANGE_REQUIRED";

const authorizationDeniedCodes = new Set<AuthorizationDeniedCode>([
  "ACCOUNT_MANAGER_REQUIRED",
  "ADMIN_REQUIRED",
  "AVAILABILITY_ACCESS_REQUIRED",
  "DEVELOPER_REQUIRED",
  "MAID_REQUIRED",
  "PASSWORD_CHANGE_REQUIRED",
]);

export function isAuthorizationDeniedCode(
  code: string,
): code is AuthorizationDeniedCode {
  return authorizationDeniedCodes.has(code as AuthorizationDeniedCode);
}

// 원문 route를 저장하지 않고 코드에 고정된 capability category로만 변환한다.
// #52/#53은 이 mapping과 recordAuthorizationDenied()를 그대로 재사용한다.
export function authorizationSourceForPath(
  path: string,
): AuthorizationSource | null {
  if (path === "/v1/accounts" || /^\/v1\/accounts\/[^/]+\/.+$/.test(path)) {
    return "edge.authorization.accounts";
  }
  if (path.startsWith("/v1/developer/")) {
    return "edge.authorization.developer";
  }
  if (path.startsWith("/v1/availability")) {
    return "edge.authorization.availability";
  }
  if (path.startsWith("/v1/reservations")) {
    return "edge.authorization.reservations";
  }
  if (path.startsWith("/v1/rooms")) {
    return "edge.authorization.rooms";
  }
  return null;
}
