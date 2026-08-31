import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";
import type {
  ActivitySource,
  AuthorizationDeniedCode,
  AuthorizationSource,
} from "./activity-contract.ts";

type LoginFailureCode =
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_INACTIVE"
  | "ACCOUNT_LOCKED";

async function recordKnownActorActivity(
  clients: EdgeClients,
  actor: Pick<EdgeActor, "profileId">,
  eventType:
    | "auth.login_succeeded"
    | "auth.login_failed"
    | "authorization.denied"
    | "sensitive.read",
  outcome: "succeeded" | "failed" | "denied",
  source: ActivitySource,
  requestId: string,
  reasonCode: LoginFailureCode | AuthorizationDeniedCode | null = null,
  resource: { type: "reservation"; id: string } | null = null,
): Promise<void> {
  const { error } = await clients.admin.rpc("record_actor_activity_event", {
    p_actor_profile_id: actor.profileId,
    p_event_type: eventType,
    p_outcome: outcome,
    p_source: source,
    p_request_id: requestId,
    p_reason_code: reasonCode,
    p_resource_type: resource?.type ?? null,
    p_resource_id: resource?.id ?? null,
    p_occurred_at: new Date().toISOString(),
  });
  if (error) {
    throw new EdgeError(
      503,
      "ACTIVITY_LOG_UNAVAILABLE",
      "보안 활동 기록을 저장하지 못해 요청을 처리할 수 없습니다.",
    );
  }
}

export async function recordLoginSucceeded(
  clients: EdgeClients,
  actor: Pick<EdgeActor, "profileId">,
  requestId: string,
): Promise<void> {
  await recordKnownActorActivity(
    clients,
    actor,
    "auth.login_succeeded",
    "succeeded",
    "edge.auth.login",
    requestId,
  );
}

export async function recordKnownLoginFailed(
  clients: EdgeClients,
  actor: Pick<EdgeActor, "profileId">,
  requestId: string,
  reasonCode: LoginFailureCode,
): Promise<void> {
  await recordKnownActorActivity(
    clients,
    actor,
    "auth.login_failed",
    "failed",
    "edge.auth.login",
    requestId,
    reasonCode,
  );
}

export async function recordUnknownLoginFailed(
  clients: EdgeClients,
): Promise<void> {
  const { error } = await clients.admin.rpc("record_unknown_login_failure", {
    p_occurred_at: new Date().toISOString(),
  });
  if (error) {
    throw new EdgeError(
      503,
      "ACTIVITY_LOG_UNAVAILABLE",
      "보안 활동 기록을 저장하지 못해 요청을 처리할 수 없습니다.",
    );
  }
}

export async function recordAuthorizationDenied(
  clients: EdgeClients,
  actor: EdgeActor,
  source: AuthorizationSource,
  requestId: string,
  reasonCode: AuthorizationDeniedCode,
): Promise<void> {
  await recordKnownActorActivity(
    clients,
    actor,
    "authorization.denied",
    "denied",
    source,
    requestId,
    reasonCode,
  );
}

// 예약 고객명처럼 실제 복호화된 민감값이 반환된 뒤에만 호출한다.
// 일반 rooms/availability list에는 사용하지 않는다.
export async function recordSensitiveReservationRead(
  clients: EdgeClients,
  actor: EdgeActor,
  requestId: string,
  reservationId: string,
): Promise<void> {
  await recordKnownActorActivity(
    clients,
    actor,
    "sensitive.read",
    "succeeded",
    "edge.sensitive.reservation_guest_name",
    requestId,
    null,
    { type: "reservation", id: reservationId },
  );
}
