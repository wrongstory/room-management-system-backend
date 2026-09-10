export type ActivitySource =
  | "edge.auth.login"
  | "edge.authorization.accounts"
  | "edge.authorization.developer"
  | "edge.authorization.availability"
  | "edge.authorization.assignments"
  | "edge.authorization.attempts"
  | "edge.authorization.complaints"
  | "edge.authorization.photos"
  | "edge.authorization.payroll"
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
  | "ASSIGNMENT_ACCESS_REQUIRED"
  | "ATTEMPT_ACCESS_REQUIRED"
  | "CAPABILITY_ACCESS_REQUIRED"
  | "COMPLAINT_ACCESS_REQUIRED"
  | "AVAILABILITY_ACCESS_REQUIRED"
  | "DEVELOPER_REQUIRED"
  | "MAID_REQUIRED"
  | "PHOTO_ACCESS_REQUIRED"
  | "BOMB_REPORT_ACCESS_REQUIRED"
  | "SUBMISSION_ACCESS_REQUIRED"
  | "PAYROLL_ACCESS_REQUIRED"
  | "PASSWORD_CHANGE_REQUIRED";

const authorizationDeniedCodes = new Set<AuthorizationDeniedCode>([
  "ACCOUNT_MANAGER_REQUIRED",
  "ADMIN_REQUIRED",
  "ASSIGNMENT_ACCESS_REQUIRED",
  "ATTEMPT_ACCESS_REQUIRED",
  "CAPABILITY_ACCESS_REQUIRED",
  "COMPLAINT_ACCESS_REQUIRED",
  "AVAILABILITY_ACCESS_REQUIRED",
  "DEVELOPER_REQUIRED",
  "MAID_REQUIRED",
  "PHOTO_ACCESS_REQUIRED",
  "BOMB_REPORT_ACCESS_REQUIRED",
  "SUBMISSION_ACCESS_REQUIRED",
  "PAYROLL_ACCESS_REQUIRED",
  "PASSWORD_CHANGE_REQUIRED",
]);

export function isAuthorizationDeniedCode(
  code: string,
): code is AuthorizationDeniedCode {
  return authorizationDeniedCodes.has(code as AuthorizationDeniedCode);
}

// 원문 route를 저장하지 않고 코드에 고정된 capability category로만 변환한다.
// 업무 API는 이 mapping과 recordAuthorizationDenied()를 공통 권한거부 계약으로 사용한다.
export function authorizationSourceForPath(
  path: string,
): AuthorizationSource | null {
  if (
    /^\/v1\/attempts\/[^/]+\/photo-slots(?:\/[^/]+\/upload)?$/.test(path) ||
    /^\/v1\/photo-uploads\/[^/]+$/.test(path) ||
    /^\/v1\/photos\/[^/]+\/content$/.test(path)
  ) {
    return "edge.authorization.photos";
  }
  if (path === "/v1/inspections" || path.startsWith("/v1/inspections/")) {
    return "edge.authorization.attempts";
  }
  if (path === "/v1/accounts" || /^\/v1\/accounts\/[^/]+\/.+$/.test(path)) {
    return "edge.authorization.accounts";
  }
  if (path.startsWith("/v1/developer/")) {
    return "edge.authorization.developer";
  }
  if (path.startsWith("/v1/availability")) {
    return "edge.authorization.availability";
  }
  if (
    path.startsWith("/v1/assignments") ||
    path.startsWith("/v1/assignment-preview/") ||
    path.startsWith("/v1/assignment-change-requests")
  ) {
    return "edge.authorization.assignments";
  }
  if (path.startsWith("/v1/reservations")) {
    return "edge.authorization.reservations";
  }
  if (path === "/v1/payroll" || path === "/v1/payroll/start") {
    return "edge.authorization.payroll";
  }
  if (path === "/v1/complaints" || path.startsWith("/v1/complaints/")) {
    return "edge.authorization.complaints";
  }
  if (
    path.startsWith("/v1/attempts/") ||
    path.startsWith("/v1/limited/attempts/") ||
    path === "/v1/offline-events" || path.startsWith("/v1/offline-quarantines")
  ) {
    return "edge.authorization.attempts";
  }
  if (path.startsWith("/v1/rooms")) {
    return "edge.authorization.rooms";
  }
  return null;
}
