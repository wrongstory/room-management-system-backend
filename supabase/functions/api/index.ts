import {
  availabilityDecisionRequestId,
  decideAvailabilityChange,
  listAvailability,
  listAvailabilityCandidates,
  listAvailabilityChangeRequests,
  requestAvailabilityChange,
  submitAvailability,
} from "../_shared/availability-api.ts";
import {
  changeAccountRole,
  changeAccountStatus,
  changePassword,
  createAccount,
  listAccounts,
  login,
  profileIdFromPath,
  resetAccountPassword,
  unlockAccount,
} from "../_shared/account-api.ts";
import {
  developerAuditEvents,
  developerDatabaseStatus,
  developerOverview,
  developerRuntimeStatus,
  developerSchedulerStatus,
  runDeveloperDiagnostics,
} from "../_shared/developer-api.ts";
import { openApiResponse, swaggerUiResponse } from "../_shared/openapi.ts";
import { toRoomProjections } from "../_shared/room-api.ts";
import {
  authenticate,
  cors,
  createEdgeClients,
  EdgeError,
  errorResponse,
  jsonResponse,
  requestId,
  requireBusinessAdmin,
  requireDeveloper,
  requirePasswordChanged,
} from "../_shared/runtime.ts";

function routePath(url: string): string {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const functionIndex = segments.lastIndexOf("api");
  if (functionIndex < 0) {
    return "/";
  }
  return `/${segments.slice(functionIndex + 1).join("/")}`;
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let corsHeaders: Record<string, string> = {};
  try {
    corsHeaders = cors(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const path = routePath(request.url);
    if (request.method === "GET" && path === "/health") {
      return jsonResponse(
        {
          status: "ok",
          service: "room-management-system-edge-api",
          timestamp: new Date().toISOString(),
        },
        200,
        corsHeaders,
      );
    }

    if (request.method === "GET" && path === "/openapi.json") {
      return openApiResponse(corsHeaders);
    }
    if (request.method === "GET" && path === "/docs") {
      return swaggerUiResponse(corsHeaders);
    }

    const clients = createEdgeClients();
    if (request.method === "POST" && path === "/v1/auth/login") {
      return jsonResponse(await login(request, clients), 200, corsHeaders);
    }

    const actor = await authenticate(request, clients);
    if (request.method === "GET" && path === "/v1/auth/me") {
      return jsonResponse({ user: actor }, 200, corsHeaders);
    }
    if (request.method === "POST" && path === "/v1/auth/password") {
      await changePassword(request, clients, actor);
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store", ...corsHeaders },
      });
    }

    if (request.method === "GET" && path === "/v1/accounts") {
      return jsonResponse(
        { accounts: await listAccounts(clients, actor) },
        200,
        corsHeaders,
      );
    }
    if (request.method === "POST" && path === "/v1/accounts") {
      return jsonResponse(
        await createAccount(request, clients, actor),
        201,
        corsHeaders,
      );
    }

    const roleProfileId = profileIdFromPath(path, "role");
    if (request.method === "PATCH" && roleProfileId) {
      return jsonResponse(
        {
          account: await changeAccountRole(
            request,
            clients,
            actor,
            roleProfileId,
          ),
        },
        200,
        corsHeaders,
      );
    }
    const statusProfileId = profileIdFromPath(path, "status");
    if (request.method === "PATCH" && statusProfileId) {
      return jsonResponse(
        {
          account: await changeAccountStatus(
            request,
            clients,
            actor,
            statusProfileId,
          ),
        },
        200,
        corsHeaders,
      );
    }
    const unlockProfileId = profileIdFromPath(path, "unlock");
    if (request.method === "POST" && unlockProfileId) {
      return jsonResponse(
        {
          account: await unlockAccount(
            request,
            clients,
            actor,
            unlockProfileId,
          ),
        },
        200,
        corsHeaders,
      );
    }
    const resetProfileId = profileIdFromPath(path, "password-reset");
    if (request.method === "POST" && resetProfileId) {
      return jsonResponse(
        {
          account: await resetAccountPassword(
            request,
            clients,
            actor,
            resetProfileId,
          ),
        },
        200,
        corsHeaders,
      );
    }

    if (request.method === "GET" && path === "/v1/developer/overview") {
      requireDeveloper(actor);
      return jsonResponse(
        { overview: await developerOverview(clients, actor) },
        200,
        corsHeaders,
      );
    }
    if (request.method === "GET" && path === "/v1/developer/runtime-status") {
      requireDeveloper(actor);
      return jsonResponse(
        { runtime: developerRuntimeStatus() },
        200,
        corsHeaders,
      );
    }
    if (request.method === "GET" && path === "/v1/developer/database-status") {
      requireDeveloper(actor);
      return jsonResponse(
        { database: await developerDatabaseStatus(clients, actor) },
        200,
        corsHeaders,
      );
    }
    if (request.method === "GET" && path === "/v1/developer/scheduler-status") {
      requireDeveloper(actor);
      return jsonResponse(
        { scheduler: await developerSchedulerStatus(clients, actor) },
        200,
        corsHeaders,
      );
    }
    if (request.method === "GET" && path === "/v1/developer/audit-events") {
      requireDeveloper(actor);
      return jsonResponse(
        await developerAuditEvents(request, clients, actor),
        200,
        corsHeaders,
      );
    }
    if (request.method === "POST" && path === "/v1/developer/diagnostics") {
      requireDeveloper(actor);
      return jsonResponse(
        { diagnostics: await runDeveloperDiagnostics(request, clients, actor) },
        200,
        corsHeaders,
      );
    }

    if (request.method === "GET" && path === "/v1/availability") {
      return jsonResponse(
        { availability: await listAvailability(request, clients, actor) },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path === "/v1/availability/submissions"
    ) {
      return jsonResponse(
        { availability: await submitAvailability(request, clients, actor) },
        201,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path === "/v1/availability/change-requests"
    ) {
      return jsonResponse(
        {
          changeRequest: await requestAvailabilityChange(
            request,
            clients,
            actor,
          ),
        },
        201,
        corsHeaders,
      );
    }
    if (
      request.method === "GET" &&
      path === "/v1/availability/change-requests"
    ) {
      return jsonResponse(
        {
          changeRequests: await listAvailabilityChangeRequests(
            request,
            clients,
            actor,
          ),
        },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path.startsWith("/v1/availability/change-requests/") &&
      path.endsWith("/decision")
    ) {
      const changeRequestId = availabilityDecisionRequestId(path);
      return jsonResponse(
        {
          changeRequest: await decideAvailabilityChange(
            request,
            clients,
            actor,
            changeRequestId,
          ),
        },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "GET" &&
      path === "/v1/availability/candidates"
    ) {
      return jsonResponse(
        {
          candidates: await listAvailabilityCandidates(
            request,
            clients,
            actor,
          ),
        },
        200,
        corsHeaders,
      );
    }

    if (request.method === "GET" && path === "/v1/rooms") {
      requirePasswordChanged(actor);
      requireBusinessAdmin(actor);
      const { data, error } = await clients.admin.rpc(
        "get_room_operational_projection",
        {
          p_actor_profile_id: actor.profileId,
          p_room_id: null,
        },
      );
      if (error) {
        throw new EdgeError(
          500,
          "ROOM_COMMAND_FAILED",
          "객실 정보를 처리하지 못했습니다.",
        );
      }
      return jsonResponse(
        { rooms: toRoomProjections(data) },
        200,
        corsHeaders,
      );
    }

    throw new EdgeError(
      404,
      "ROUTE_NOT_FOUND",
      "요청한 API 경로를 찾을 수 없습니다.",
    );
  } catch (error) {
    return errorResponse(error, id, corsHeaders);
  }
});
