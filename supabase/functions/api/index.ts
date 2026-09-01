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
  developerActivityEvents,
  developerAuditEvents,
  developerDatabaseStatus,
  developerOverview,
  developerRuntimeStatus,
  developerSchedulerStatus,
  runDeveloperDiagnostics,
} from "../_shared/developer-api.ts";
import {
  authorizationSourceForPath,
  isAuthorizationDeniedCode,
} from "../_shared/activity-contract.ts";
import { recordAuthorizationDenied } from "../_shared/activity-api.ts";
import { openApiResponse, swaggerUiResponse } from "../_shared/openapi.ts";
import {
  cancelManualCleaningRequest,
  cancelReservation,
  changeReservation,
  cleaningTargetIdFromPath,
  createManualCleaningRequest,
  createReservation,
  getReservation,
  listReservations,
  manualCheckoutReservation,
  processReservationTransitions,
  reservationIdFromPath,
} from "../_shared/reservation-api.ts";
import {
  changeRoomMasterData,
  createRoomOperationBlock,
  getRoom,
  listRooms,
  recordRoomPinSync,
  releaseRoomOperationBlock,
  reportRoomIssue,
  resolveRoomIssue,
  roomPathIds,
  setRoomCandleCount,
} from "../_shared/room-api.ts";
import {
  authenticate,
  cors,
  createEdgeClients,
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  errorResponse,
  jsonResponse,
  requestId,
  requireDeveloper,
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
  let clients: EdgeClients | undefined;
  let actor: EdgeActor | undefined;
  let path = "/";
  try {
    corsHeaders = cors(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    path = routePath(request.url);
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

    clients = createEdgeClients();
    if (request.method === "POST" && path === "/v1/auth/login") {
      return jsonResponse(await login(request, clients), 200, corsHeaders);
    }

    actor = await authenticate(request, clients);
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
    if (request.method === "GET" && path === "/v1/developer/activity-events") {
      requireDeveloper(actor);
      return jsonResponse(
        await developerActivityEvents(request, clients, actor),
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

    if (request.method === "GET" && path === "/v1/reservations") {
      return jsonResponse(
        { reservations: await listReservations(request, clients, actor) },
        200,
        corsHeaders,
      );
    }
    if (request.method === "POST" && path === "/v1/reservations") {
      return jsonResponse(
        { reservation: await createReservation(request, clients, actor) },
        201,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path === "/v1/reservations/cleaning-requests"
    ) {
      return jsonResponse(
        {
          cleaningRequest: await createManualCleaningRequest(
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
      request.method === "POST" &&
      path.startsWith("/v1/reservations/cleaning-requests/") &&
      path.endsWith("/cancel")
    ) {
      return jsonResponse(
        {
          cleaningRequest: await cancelManualCleaningRequest(
            request,
            clients,
            actor,
            cleaningTargetIdFromPath(path),
          ),
        },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path === "/v1/reservations/transitions/process"
    ) {
      return jsonResponse(
        {
          transitions: await processReservationTransitions(
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
      path.startsWith("/v1/reservations/") &&
      path.endsWith("/manual-checkout")
    ) {
      return jsonResponse(
        {
          reservation: await manualCheckoutReservation(
            request,
            clients,
            actor,
            reservationIdFromPath(path, "manual-checkout"),
          ),
        },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path.startsWith("/v1/reservations/") &&
      path.endsWith("/cancel")
    ) {
      return jsonResponse(
        {
          reservation: await cancelReservation(
            request,
            clients,
            actor,
            reservationIdFromPath(path, "cancel"),
          ),
        },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "PATCH" &&
      path.startsWith("/v1/reservations/")
    ) {
      return jsonResponse(
        {
          reservation: await changeReservation(
            request,
            clients,
            actor,
            reservationIdFromPath(path),
          ),
        },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "GET" &&
      path.startsWith("/v1/reservations/")
    ) {
      return jsonResponse(
        {
          reservation: await getReservation(
            clients,
            actor,
            reservationIdFromPath(path),
          ),
        },
        200,
        corsHeaders,
      );
    }

    if (request.method === "GET" && path === "/v1/rooms") {
      return jsonResponse(
        { rooms: await listRooms(clients, actor) },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "PATCH" &&
      path.startsWith("/v1/rooms/") && path.endsWith("/master-data")
    ) {
      const { roomId } = roomPathIds(path);
      return jsonResponse(
        { room: await changeRoomMasterData(request, clients, actor, roomId) },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path.startsWith("/v1/rooms/") && path.endsWith("/operation-blocks")
    ) {
      const { roomId } = roomPathIds(path);
      return jsonResponse(
        {
          operation: await createRoomOperationBlock(
            request,
            clients,
            actor,
            roomId,
          ),
        },
        201,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path.startsWith("/v1/rooms/") && path.endsWith("/release")
    ) {
      const { roomId, blockId } = roomPathIds(path);
      if (!blockId) {
        throw new EdgeError(
          400,
          "VALIDATION_ERROR",
          "객실 차단 경로가 올바르지 않습니다.",
        );
      }
      return jsonResponse(
        {
          operation: await releaseRoomOperationBlock(
            request,
            clients,
            actor,
            roomId,
            blockId,
          ),
        },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path.startsWith("/v1/rooms/") && path.endsWith("/candles")
    ) {
      const { roomId } = roomPathIds(path);
      return jsonResponse(
        {
          operation: await setRoomCandleCount(request, clients, actor, roomId),
        },
        201,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path.startsWith("/v1/rooms/") && path.endsWith("/issues")
    ) {
      const { roomId } = roomPathIds(path);
      return jsonResponse(
        { operation: await reportRoomIssue(request, clients, actor, roomId) },
        201,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path.startsWith("/v1/rooms/") && path.endsWith("/resolve")
    ) {
      const { roomId, issueId } = roomPathIds(path);
      if (!issueId) {
        throw new EdgeError(
          400,
          "VALIDATION_ERROR",
          "객실 이슈 경로가 올바르지 않습니다.",
        );
      }
      return jsonResponse(
        {
          operation: await resolveRoomIssue(
            request,
            clients,
            actor,
            roomId,
            issueId,
          ),
        },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path.startsWith("/v1/rooms/") && path.endsWith("/pin-sync-events")
    ) {
      const { roomId } = roomPathIds(path);
      return jsonResponse(
        { operation: await recordRoomPinSync(request, clients, actor, roomId) },
        201,
        corsHeaders,
      );
    }
    if (request.method === "GET" && path.startsWith("/v1/rooms/")) {
      const { roomId } = roomPathIds(path);
      return jsonResponse(
        { room: await getRoom(clients, actor, roomId) },
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
    let responseError = error;
    const source = authorizationSourceForPath(path);
    if (
      error instanceof EdgeError && actor && clients && source &&
      isAuthorizationDeniedCode(error.code)
    ) {
      try {
        await recordAuthorizationDenied(clients, actor, source, error.code);
      } catch (activityError) {
        responseError = activityError;
      }
    }
    return errorResponse(responseError, id, corsHeaders);
  }
});
