const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keys = [
  "expectedCurrentAssignmentId",
  "expectedAssignmentVersion",
  "expectedAttemptId",
  "expectedExecutionVersion",
];
function version(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function id(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
export function forceRecallArgs(
  body: unknown,
  target: string,
  actor: string,
  session: string,
) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  if (
    Object.keys(row).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(row, key)) ||
    !id(row.expectedCurrentAssignmentId) || !id(row.expectedAttemptId) ||
    !id(target) ||
    !version(row.expectedAssignmentVersion) ||
    !version(row.expectedExecutionVersion)
  ) return null;
  return {
    p_actor_profile_id: actor,
    p_session_id: session,
    p_cleaning_target_id: target.toLowerCase(),
    p_expected_assignment_id: row.expectedCurrentAssignmentId.toLowerCase(),
    p_expected_assignment_version: row.expectedAssignmentVersion,
    p_expected_attempt_id: row.expectedAttemptId.toLowerCase(),
    p_expected_execution_version: row.expectedExecutionVersion,
  };
}
export function recallProjection(
  data: unknown,
  args: NonNullable<ReturnType<typeof forceRecallArgs>>,
) {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  if (
    row.cleaningTargetId !== args.p_cleaning_target_id ||
    row.assignmentId !== args.p_expected_assignment_id ||
    row.attemptId !== args.p_expected_attempt_id || !id(row.reassignTargetId) ||
    !version(row.assignmentVersion) || row.status !== "unassigned"
  ) return null;
  return {
    cleaningTargetId: row.cleaningTargetId,
    assignmentId: row.assignmentId,
    attemptId: row.attemptId,
    reassignTargetId: row.reassignTargetId,
    assignmentVersion: row.assignmentVersion,
    status: row.status,
  };
}
export function recallFailure(message = ""): [number, string, string] {
  const failures: [number, string, string][] = [
    [
      409,
      "ASSIGNMENT_FORCE_RECALL_NOT_ALLOWED",
      "현장 완료 후 아직 제출하지 않은 배정만 회수할 수 있습니다.",
    ],
    [
      409,
      "ASSIGNMENT_VERSION_CONFLICT",
      "배정이 변경되었습니다. 새로 조회해 주세요.",
    ],
    [409, "IDEMPOTENCY_KEY_REUSED", "변경된 요청에는 새 요청 키가 필요합니다."],
    [403, "ADMIN_REQUIRED", "관리자만 강제 회수할 수 있습니다."],
    [403, "PASSWORD_CHANGE_REQUIRED", "비밀번호를 먼저 변경해 주세요."],
    [401, "SESSION_REVOKED", "다시 로그인해 주세요."],
    [401, "INVALID_ACCESS_TOKEN", "다시 로그인해 주세요."],
  ];
  return failures.find(([, code]) => message.includes(code)) ??
    [500, "ASSIGNMENT_FORCE_RECALL_FAILED", "배정을 회수하지 못했습니다."];
}
