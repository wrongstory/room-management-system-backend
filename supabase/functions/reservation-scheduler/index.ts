import {
  createEdgeClients,
  EdgeError,
  errorResponse,
  jsonResponse,
  requestId,
} from "../_shared/runtime.ts";

async function matchesSecret(
  provided: string,
  expected: string,
): Promise<boolean> {
  if (provided.length < 32 || expected.length < 32) {
    return false;
  }
  const encoder = new TextEncoder();
  const message = encoder.encode("room-management-scheduler-invocation");
  const candidateKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(provided),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(expected),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = await crypto.subtle.sign("HMAC", candidateKey, message);
  return crypto.subtle.verify("HMAC", expectedKey, signature, message);
}

async function requestHash(): Promise<string> {
  const value = new TextEncoder().encode(
    '{"command":"reservation.process_due_transitions"}',
  );
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
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

Deno.serve(async (request) => {
  const id = requestId(request);
  try {
    if (request.method !== "POST") {
      throw new EdgeError(405, "METHOD_NOT_ALLOWED", "POST 요청만 허용합니다.");
    }
    const expectedSecret = requiredEnv("SCHEDULER_INVOKE_SECRET");
    const providedSecret = request.headers.get("x-scheduler-secret") ?? "";
    if (!await matchesSecret(providedSecret, expectedSecret)) {
      throw new EdgeError(
        401,
        "INVALID_SCHEDULER_SECRET",
        "scheduler 인증을 확인할 수 없습니다.",
      );
    }

    const actorProfileId = requiredEnv(
      "RESERVATION_SCHEDULER_ACTOR_PROFILE_ID",
    );
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(actorProfileId)
    ) {
      throw new EdgeError(
        503,
        "INVALID_SCHEDULER_ACTOR",
        "scheduler 관리자 설정이 올바르지 않습니다.",
      );
    }
    const payload = await request.json().catch(() => ({})) as {
      scheduledAt?: unknown;
    };
    const scheduledAt = typeof payload.scheduledAt === "string"
      ? new Date(payload.scheduledAt)
      : new Date();
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new EdgeError(
        400,
        "INVALID_SCHEDULE_TIME",
        "scheduler 실행 시각이 올바르지 않습니다.",
      );
    }
    const bucket = scheduledAt.toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const clients = createEdgeClients();
    const { data, error } = await clients.admin.rpc(
      "process_due_reservation_transitions",
      {
        p_actor_profile_id: actorProfileId,
        p_as_of: new Date().toISOString(),
        p_idempotency_key: `reservation-scheduler-${bucket}`,
        p_request_hash: await requestHash(),
      },
    );
    if (error || !data) {
      console.error("Reservation scheduler RPC failed", {
        requestId: id,
        code: error?.code,
      });
      throw new EdgeError(
        500,
        "RESERVATION_SCHEDULER_FAILED",
        "예약 전이 scheduler를 실행하지 못했습니다.",
      );
    }

    return jsonResponse({ transitions: data });
  } catch (error) {
    return errorResponse(error, id, {});
  }
});
