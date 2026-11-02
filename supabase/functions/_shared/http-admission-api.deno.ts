import { handleApiRequest } from "../api/index.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";
import { recordUnknownLoginFailed } from "./activity-api.ts";
import type { AdmissionRpc } from "./http-admission.ts";

const id = "10000000-0000-4000-8000-000000000001";
const actor: EdgeActor = {
  profileId: id,
  authUserId: "10000000-0000-4000-8000-000000000002",
  displayName: "synthetic",
  role: "admin",
  mustChangePassword: false,
};
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function request(path = "/v1/reservations/transitions/process") {
  return new Request(`https://synthetic.invalid/api${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer h.${
        btoa(JSON.stringify({ session_id: id }))
      }.synthetic`,
      "idempotency-key": "synthetic-command-key",
      "content-type": "application/json",
    },
    body: "{}",
  });
}

for (const mode of ["OPEN", "INACTIVE", "REQUESTED", "UNKNOWN"]) {
  Deno.test(`#396 HTTP ${mode} observes authority before the exact transition RPC`, async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let effects = 0;
    const clients = {
      admin: {
        rpc: (name: string) => ({
          // biome-ignore lint/suspicious/noThenProperty: Models Supabase's lazy thenable, so the test catches I/O before admission.
          then(resolve: (value: unknown) => unknown) {
            assert(
              name === "process_due_reservation_transitions",
              "finite command",
            );
            effects++;
            return Promise.resolve(
              resolve({
                data: {
                  as_of: "2026-10-25T00:00:00Z",
                  checked_in_count: 0,
                  checked_out_count: 0,
                  blocked_check_in_count: 0,
                  purged_guest_name_count: 0,
                },
                error: null,
              }),
            );
          },
        }),
      },
    } as unknown as EdgeClients;
    const rpc: AdmissionRpc = async (name, args) => {
      calls.push([name, args]);
      return {
        error: null,
        data: name === "get_operation_admission_control"
          ? {
            mode,
            controlVersion: mode === "INACTIVE" ? null : "1",
            targetRef: mode === "INACTIVE" ? null : "synthetic-project",
          }
          : name === "acquire_operation_http_admission"
          ? {
            admissionId: id,
            controlVersion: "1",
            completionMode: "COMMAND_RECEIPT",
          }
          : { completed: true },
      };
    };
    const response = await handleApiRequest(request(), {
      createClients: () => clients,
      authenticateRequest: async () => actor,
      operationAdmissionConfig: {
        target: "synthetic-project",
        budgetMs: 10000,
      },
      operationAdmissionRpc: rpc,
    });
    assert(
      response.status === (["OPEN", "INACTIVE"].includes(mode) ? 200 : 503),
      `HTTP ${mode}`,
    );
    await response.body?.cancel();
    assert(
      effects === (["OPEN", "INACTIVE"].includes(mode) ? 1 : 0),
      "effects gated",
    );
    assert(
      calls.length === (mode === "OPEN" ? 3 : 1),
      "no fictional completion",
    );
    if (mode === "OPEN") {
      assert(
        calls[1][1].p_command_name ===
          "reservation.process_due_transitions.v66",
        "outer terminal receipt",
      );
      assert(
        typeof calls[1][1].p_request_hash === "string" &&
          /^[a-f0-9]{64}$/.test(calls[1][1].p_request_hash as string),
        "actual service hash",
      );
    }
    assert(
      clients.operationAdmission === undefined,
      "injected client remains request-independent",
    );
  });
}

Deno.test("#396 maintenance blocks sign-in before any provider call", async () => {
  const response = await handleApiRequest(request("/v1/auth/login"), {
    createClients: () => ({ admin: {} }) as EdgeClients,
    authenticateRequest: () =>
      Promise.reject(new Error("must not authenticate login")),
    operationAdmissionConfig: { target: "synthetic-project", budgetMs: 10000 },
    operationAdmissionRpc: async () => ({
      data: {
        mode: "REQUESTED",
        controlVersion: "1",
        targetRef: "synthetic-project",
      },
      error: null,
    }),
  });
  assert(response.status === 503, "no provider access");
  await response.body?.cancel();
});

for (const mode of ["OPEN", "INACTIVE", "REQUESTED"]) {
  Deno.test(`#396 ${mode} covers authentication-failure audit on a GET before any HTTP scope`, async () => {
    const calls: string[] = [];
    const response = await handleApiRequest(
      new Request("https://synthetic.invalid/api/v1/rooms"),
      {
        createClients: () =>
          ({
            admin: {
              rpc: () => {
                throw new Error("original audit must not execute separately");
              },
            },
          }) as unknown as EdgeClients,
        authenticateRequest: async (_request, clients) => {
          await recordUnknownLoginFailed(clients);
          throw new EdgeError(401, "INVALID_ACCESS_TOKEN", "synthetic");
        },
        operationAdmissionConfig: {
          target: "synthetic-project",
          budgetMs: 10000,
        },
        operationAdmissionRpc: async (name, args) => {
          calls.push(name);
          if (name === "get_operation_admission_control") {
            return {
              data: {
                mode,
                controlVersion: mode === "INACTIVE" ? null : "1",
                targetRef: mode === "INACTIVE" ? null : "synthetic-project",
              },
              error: null,
            };
          }
          assert(
            name === "execute_operation_atomic_rpc" &&
              args.p_rpc_name === "record_unknown_login_failure",
            "finite atomic audit",
          );
          return { data: { result: null }, error: null };
        },
      },
    );
    assert(
      response.status === (mode === "REQUESTED" ? 503 : 401),
      "audit gate preserves failure semantics",
    );
    const body = await response.json();
    assert(
      body.error.code ===
        (mode === "REQUESTED"
          ? "OPERATION_ATOMIC_RPC_UNAVAILABLE"
          : "INVALID_ACCESS_TOKEN"),
      "fixed safe error",
    );
    assert(
      calls.join(",") ===
        (mode === "REQUESTED"
          ? "get_operation_admission_control"
          : "get_operation_admission_control,execute_operation_atomic_rpc"),
      "no original effect or fictitious outer completion",
    );
  });
}

Deno.test("#396 notification read uses its atomic transaction without an opaque outer lease", async () => {
  const calls: string[] = [];
  const notice = {
    id,
    category: "assignment_changed",
    title: "synthetic",
    body: "synthetic",
    roomId: null,
    cleaningTargetId: null,
    deepLink: null,
    groupId: null,
    requiresAction: true,
    readAt: "2026-10-25T00:00:00Z",
    resolvedAt: null,
    occurredAt: "2026-10-24T00:00:00Z",
  };
  const response = await handleApiRequest(
    request(`/v1/notifications/${id}/read`),
    {
      createClients: () =>
        ({
          admin: {
            rpc: () => {
              throw new Error("original effect must not execute separately");
            },
          },
        }) as unknown as EdgeClients,
      authenticateRequest: async () => actor,
      operationAdmissionConfig: {
        target: "synthetic-project",
        budgetMs: 10000,
      },
      operationAdmissionRpc: async (name, args) => {
        calls.push(name);
        if (name === "get_operation_admission_control") {
          return {
            data: {
              mode: "OPEN",
              controlVersion: "1",
              targetRef: "synthetic-project",
            },
            error: null,
          };
        }
        assert(
          name === "execute_operation_atomic_rpc" &&
            args.p_rpc_name === "mark_notification_read",
          "finite read-state transaction",
        );
        return { data: { result: notice }, error: null };
      },
    },
  );
  assert(response.status === 200, "original read-state response");
  assert(
    (await response.json()).notification.readAt === notice.readAt,
    "projection preserved",
  );
  assert(
    calls.join(",") ===
      "get_operation_admission_control,execute_operation_atomic_rpc",
    "no opaque lease",
  );
});

const offlineResolutionReasons = {
  record_only: "OFFLINE_RECORD_ONLY",
  reject_effect: "OFFLINE_REJECT_EFFECT",
  correction_link: "OFFLINE_CORRECTION_APPROVED",
};
async function offlineResolutionAdmissionScenario(
  resolution: keyof typeof offlineResolutionReasons,
  mode = "OPEN",
  loseResponse = false,
  terminalMissing = false,
) {
  const quarantineId = "10000000-0000-4000-8000-000000000003";
  const body = {
    resolution,
    expectedExecutionVersion: resolution === "correction_link" ? 2 : null,
    reasonCode: offlineResolutionReasons[resolution],
  };
  const hashBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({
      actorProfileId: actor.profileId,
      action: "resolve_offline",
      input: { quarantineId, ...body },
    })),
  );
  const hash = [...new Uint8Array(hashBytes)].map((value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
  const calls: string[] = [];
  let effects = 0;
  let acquired = false;
  const clients = {
    admin: {
      rpc: (name: string, args: Record<string, unknown>) => ({
        // biome-ignore lint/suspicious/noThenProperty: Model the lazy Supabase builder used by the real Edge handler.
        then(
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ) {
          assert(acquired, "no offline effect before admission acquisition");
          assert(
            name === "resolve_offline_event_quarantine",
            "only the fixed business RPC",
          );
          assert(
            args.p_actor_profile_id === actor.profileId &&
              args.p_session_id === id &&
              args.p_quarantine_id === quarantineId &&
              args.p_resolution === resolution &&
              args.p_request_hash === hash &&
              args.p_idempotency_key === "synthetic-command-key" &&
              args.p_expected_execution_version ===
                body.expectedExecutionVersion &&
              args.p_reason_code === body.reasonCode,
            "real service hash and all eight actual arguments are preserved",
          );
          calls.push("effect");
          effects++;
          const result = {
            data: {
              quarantineId,
              resolution,
              attempt: resolution === "correction_link"
                ? {
                  attemptId: id,
                  cleaningTargetId: id,
                  assignmentId: id,
                  maidProfileId: id,
                  assignmentRevision: 1,
                  executionVersion: 3,
                  status: "field_completed",
                  startedAt: "2026-10-25T00:00:00Z",
                  fieldCompletedAt: "2026-10-25T00:30:00Z",
                  endedAt: "2026-10-25T00:30:00Z",
                  effectiveAt: "2026-10-25T00:30:00Z",
                  recordedAt: "2026-10-25T00:35:00Z",
                }
                : null,
              effectiveAt: "2026-10-25T00:30:00Z",
              recordedAt: "2026-10-25T00:35:00Z",
            },
            error: null,
          };
          return (loseResponse
            ? Promise.reject(new Error("synthetic offline response loss"))
            : Promise.resolve(result)).then(resolve, reject);
        },
      }),
    },
  } as unknown as EdgeClients;
  const initial = request(`/v1/offline-quarantines/${quarantineId}/resolve`);
  const response = await handleApiRequest(
    new Request(initial.url, {
      method: initial.method,
      headers: initial.headers,
      body: JSON.stringify(body),
    }),
    {
      createClients: () => clients,
      authenticateRequest: async () => actor,
      operationAdmissionConfig: {
        target: "synthetic-project",
        budgetMs: 10000,
      },
      operationAdmissionRpc: async (name, args) => {
        calls.push(name);
        if (name === "get_operation_admission_control") {
          return {
            data: { mode, controlVersion: "1", targetRef: "synthetic-project" },
            error: null,
          };
        }
        if (name === "acquire_operation_offline_resolution_admission") {
          assert(
            args.p_resolution === resolution && args.p_request_hash === hash &&
              args.p_idempotency_key === "synthetic-command-key",
            "acquisition binds the service canonical target/resolution hash",
          );
          acquired = true;
          return {
            data: {
              admissionId: id,
              controlVersion: "1",
              completionMode: "OFFLINE_RESOLUTION",
            },
            error: null,
          };
        }
        assert(
          name === "complete_operation_offline_resolution_admission" &&
            args.p_admission_id === id &&
            args.p_quarantine_id === quarantineId &&
            args.p_resolution === resolution &&
            args.p_actor === actor.profileId &&
            args.p_auth === actor.authUserId && args.p_session === id,
          "only the captured exact terminal is observed",
        );
        return terminalMissing
          ? { data: null, error: { code: "OPERATION_COMPLETION_UNVERIFIED" } }
          : { data: { completed: true }, error: null };
      },
    },
  );
  assert(
    response.status === (mode === "REQUESTED" ? 503 : loseResponse ? 500 : 200),
    "original HTTP outcome",
  );
  await response.body?.cancel();
  assert(effects === (mode === "REQUESTED" ? 0 : 1), "no effect retry");
  assert(
    calls.join(",") ===
      (mode === "REQUESTED"
        ? "get_operation_admission_control"
        : "get_operation_admission_control,acquire_operation_offline_resolution_admission,effect,complete_operation_offline_resolution_admission"),
    "fixed acquire/effect/observe sequence without generic or HTTP completion",
  );
}
for (
  const resolution of Object.keys(offlineResolutionReasons) as Array<
    keyof typeof offlineResolutionReasons
  >
) {
  Deno.test(`#396 real Edge offline ${resolution} binds its existing terminal`, async () => {
    await offlineResolutionAdmissionScenario(resolution);
  });
}
Deno.test("#396 real Edge offline REQUESTED never invokes the resolution", async () => {
  await offlineResolutionAdmissionScenario("record_only", "REQUESTED");
});
Deno.test("#396 real Edge offline response loss observes the same terminal without retry", async () => {
  await offlineResolutionAdmissionScenario("record_only", "OPEN", true);
});
Deno.test("#396 real Edge offline HTTP success cannot replace a missing terminal", async () => {
  await offlineResolutionAdmissionScenario("record_only", "OPEN", false, true);
});
