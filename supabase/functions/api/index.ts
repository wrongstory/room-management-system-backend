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
import { recordAuthorizationDenied } from "../_shared/activity-api.ts";
import {
  authorizationSourceForPath,
  isAuthorizationDeniedCode,
} from "../_shared/activity-contract.ts";
import {
  assignmentCommitImpact,
  assignmentHistory,
  assignmentTargetIdFromPath,
  commitAssignments,
  listAssignmentChangeRequests,
  listAssignments,
  prestartCommand,
  prestartPath,
  saveAssignmentDraft,
} from "../_shared/assignment-api.ts";
import {
  assignmentDurationPolicy,
  previewAssignments,
} from "../_shared/assignment-preview-api.ts";
import {
  attemptCommandPath,
  currentAttempt,
  executeAttempt,
} from "../_shared/attempt-api.ts";
import {
  completeLimitedAttempt,
  getLimitedAttempt,
  lifecycleImpact,
  lifecyclePath,
  limitedAttemptPath,
  manageAttemptLifecycle,
} from "../_shared/attempt-lifecycle-api.ts";
import {
  getOfflineQuarantine,
  listOfflineQuarantines,
  quarantinePath,
  resolveOfflineQuarantine,
  startWithLease,
  startWithLeasePath,
  syncOfflineEvent,
} from "../_shared/attempt-offline-api.ts";
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
  checkoutIncidentPath,
  decideCheckoutIncident,
  getCheckoutIncident,
  reportCheckoutIncident,
} from "../_shared/checkout-incident-api.ts";
import { cleaningTemplates } from "../_shared/cleaning-template-api.ts";
import { listCleaningHistory } from "../_shared/cleaning-history-api.ts";
import { listWorkHistory } from "../_shared/work-history-api.ts";
import {
  complaintDetail,
  complaintHistory,
  complaintPath,
  createComplaint,
  listComplaints,
  mutateComplaint,
} from "../_shared/complaint-api.ts";
import { assertComplaintResponseSize } from "../_shared/complaint-cursor.ts";
import {
  createDeveloperRoom,
  developerActivityEvents,
  developerAuditEvents,
  developerDatabaseStatus,
  developerOverview,
  developerRuntimeStatus,
  developerSchedulerStatus,
  listDeveloperRoomCatalog,
  retireDeveloperRoom,
  runDeveloperDiagnostics,
} from "../_shared/developer-api.ts";
import {
  listNotifications,
  markNotificationRead,
  notificationReadPath,
} from "../_shared/notification-api.ts";
import { openApiResponse, swaggerUiResponse } from "../_shared/openapi.ts";
import {
  carryForwardPayroll,
  carryLatePayrollEarning,
  correctPayrollAdjustment,
  getPayrollCycle,
  listPayroll,
  listPayrollEntries,
  recordPayrollPaymentCheck,
  recordPayrollPaymentPaid,
  reopenPayrollPayment,
  reversePayrollSource,
  startPayroll,
} from "../_shared/payroll-api.ts";
import { assertPayrollResponseSize } from "../_shared/payroll-cursor.ts";
import { createPhotoService } from "../_shared/photo-api.ts";
import { PhotoError } from "../_shared/photo-binary.ts";
import {
  photoError,
  photoRoute,
  type PhotoService,
} from "../_shared/photo-service.ts";
import { PhotoUploadContractError } from "../_shared/photo-upload-contract.ts";
import {
  cancelManualCleaningRequest,
  cancelReservation,
  changeReservation,
  cleaningTargetIdFromPath,
  commitReservationRoomMove,
  createManualCleaningRequest,
  createReservation,
  getReservation,
  listReservations,
  manualCheckoutReservation,
  previewReservationBookability,
  previewReservationRoomMove,
  processReservationTransitions,
  reservationIdFromPath,
  reservationRoomMoveIdFromPath,
} from "../_shared/reservation-api.ts";
import {
  changeRoomMasterData,
  createRoomOperationBlock,
  getRoom,
  listRoomEvents,
  listRoomIssues,
  listRoomOperationBlocks,
  listRooms,
  listRoomTypes,
  recordRoomPinSync,
  releaseRoomOperationBlock,
  reportRoomIssue,
  resolveRoomIssue,
  roomDetailIdFromPath,
  roomPathIds,
  setRoomCandleCount,
} from "../_shared/room-api.ts";
import {
  bootstrapRoomPins,
  confirmGeneratedRoomPin,
  finishRoomPinChange,
  prepareRoomPinChange,
  revealRoomPin,
  roomPinPath,
} from "../_shared/room-pin-api.ts";
import {
  requestRoomPinSheetFullResync,
  roomPinSheetSyncStatus,
} from "../_shared/room-pin-sheet-operations-api.ts";
import {
  authenticate,
  authenticateLimitedAttempt,
  cors,
  createEdgeClients,
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  errorResponse,
  jsonResponse,
  requestId,
  requireDeveloper,
  requirePasswordChanged,
  verifiedRequestSessionId,
} from "../_shared/runtime.ts";
import {
  createSubmission,
  decideBombRoom,
  decideSubmission,
  getSubmission,
  listSubmissions,
  reportBombRoom,
  submissionPath,
} from "../_shared/submission-api.ts";
import {
  registerWebPushSubscription,
  retireWebPushSubscription,
  type WebPushCryptoConfig,
  webPushPublicConfig,
  webPushRetirePath,
} from "../_shared/web-push-subscription-api.ts";

function routePath(url: string): string {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const functionIndex = segments.lastIndexOf("api");
  if (functionIndex < 0) {
    return "/";
  }
  return `/${segments.slice(functionIndex + 1).join("/")}`;
}

export interface ApiHandlerDependencies {
  createClients: () => EdgeClients;
  authenticateRequest: (
    request: Request,
    clients: EdgeClients,
  ) => Promise<EdgeActor>;
  authenticateLimitedRequest?: typeof authenticateLimitedAttempt;
  photoService?: (clients: EdgeClients) => PhotoService;
  webPushCryptoConfig?: WebPushCryptoConfig;
}

const defaultDependencies: ApiHandlerDependencies = {
  createClients: createEdgeClients,
  authenticateRequest: authenticate,
};

export async function handleApiRequest(
  request: Request,
  dependencies: ApiHandlerDependencies = defaultDependencies,
): Promise<Response> {
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

    clients = dependencies.createClients();
    if (request.method === "POST" && path === "/v1/auth/login") {
      return jsonResponse(await login(request, clients), 200, corsHeaders);
    }

    const photo = photoRoute(request.method, path);
    if (photo) {
      if (!new URL(request.url).pathname.endsWith(path)) {
        throw new EdgeError(
          404,
          "ROUTE_NOT_FOUND",
          "요청한 API 경로를 찾을 수 없습니다.",
        );
      }
      const service = (dependencies.photoService ?? createPhotoService)(
        clients,
      );
      if (photo.kind === "content") {
        actor = await dependencies.authenticateRequest(request, clients);
        requirePasswordChanged(actor);
        const result = await service.content(request, {
          profileId: actor.profileId,
          sessionId: verifiedRequestSessionId(request),
          role: actor.role,
          profileStatus: "active",
        }, photo.photoId);
        for (const [key, value] of Object.entries(corsHeaders)) {
          result.headers.set(key, value);
        }
        return result;
      }
      const identity = await authenticateLimitedAttempt(request, clients);
      actor = identity.actor;
      const context = {
        profileId: actor.profileId,
        sessionId: identity.sessionId,
        role: actor.role,
        profileStatus: identity.profileStatus,
      };
      const result = photo.kind === "upload"
        ? await service.upload(
          request,
          context,
          photo.attemptId,
          photo.slotId,
          photo.photoItemId,
        )
        : photo.kind === "delete-item"
        ? await service.deleteItem(
          request,
          context,
          photo.attemptId,
          photo.slotId,
          photo.photoItemId,
        )
        : photo.kind === "slots"
        ? await service.slots(request, context, photo.attemptId)
        : await service.status(request, context, photo.operationId);
      return jsonResponse(result, 200, corsHeaders);
    }

    // 늦은 기록 수신은 수행 권한이 아니다. 이 단일 경로만 3-state identity를 검증한 뒤 DB에서 lease를 다시 검사한다.
    if (request.method === "POST" && path === "/v1/offline-events") {
      const identity = await authenticateLimitedAttempt(request, clients);
      actor = identity.actor;
      return jsonResponse(
        await syncOfflineEvent(request, clients, identity),
        200,
        corsHeaders,
      );
    }

    // 제한 capability는 정확히 이 두 경로만 사용한다. 일반 인증의 active-only 조건은 변경하지 않는다.
    const limited = limitedAttemptPath(path);
    if (
      limited && ((limited.action === "read" && request.method === "GET") ||
        (limited.action === "complete" && request.method === "POST"))
    ) {
      const identity = await authenticateLimitedAttempt(request, clients);
      actor = identity.actor;
      const result = limited.action === "read"
        ? await getLimitedAttempt(request, clients, identity, limited.attemptId)
        : await completeLimitedAttempt(
          request,
          clients,
          identity,
          limited.attemptId,
        );
      return jsonResponse(result, 200, corsHeaders);
    }

    // 제출은 upload_submit capability가 살아 있는 제한 상태 메이드도 허용한다.
    // bomb 신고/조회/검수는 계속 active-only 일반 인증 경계를 사용한다.
    const limitedSubmissionRoute = request.method === "POST"
      ? submissionPath(path)
      : null;
    if (limitedSubmissionRoute?.kind === "submit") {
      const identity = await (
        dependencies.authenticateLimitedRequest ?? authenticateLimitedAttempt
      )(request, clients);
      actor = identity.actor;
      return jsonResponse(
        {
          submission: await createSubmission(
            request,
            clients,
            actor,
            limitedSubmissionRoute.attemptId,
          ),
        },
        201,
        corsHeaders,
      );
    }

    actor = await dependencies.authenticateRequest(request, clients);
    if (request.method === "POST" && path === "/v1/rooms/pins/bootstrap") {
      const response = jsonResponse(
        {
          bootstrap: await bootstrapRoomPins(
            request,
            clients,
            actor,
            verifiedRequestSessionId(request),
          ),
        },
        200,
        corsHeaders,
      );
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    if (request.method === "GET" && path === "/v1/room-pin-sheet-sync/status") {
      return jsonResponse(
        { sync: await roomPinSheetSyncStatus(request, clients, actor) },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path === "/v1/room-pin-sheet-sync/full-resync"
    ) {
      return jsonResponse(
        { sync: await requestRoomPinSheetFullResync(request, clients, actor) },
        202,
        corsHeaders,
      );
    }
    const roomPinRoute = request.method === "POST" ? roomPinPath(path) : null;
    if (roomPinRoute) {
      const sessionId = verifiedRequestSessionId(request);
      const result = roomPinRoute.kind === "prepare"
        ? await prepareRoomPinChange(
          request,
          clients,
          actor,
          sessionId,
          roomPinRoute.roomId,
        )
        : roomPinRoute.kind === "reveal"
        ? await revealRoomPin(
          request,
          clients,
          actor,
          sessionId,
          roomPinRoute.roomId,
        )
        : roomPinRoute.kind === "generated-confirm"
        ? await confirmGeneratedRoomPin(
          request,
          clients,
          actor,
          sessionId,
          roomPinRoute.roomId,
        )
        : await finishRoomPinChange(
          request,
          clients,
          actor,
          sessionId,
          roomPinRoute,
        );
      const response = jsonResponse(
        roomPinRoute.kind === "reveal"
          ? { pin: result }
          : roomPinRoute.kind === "generated-confirm"
          ? { confirmation: result }
          : { change: result },
        roomPinRoute.kind === "prepare" ? 201 : 200,
        corsHeaders,
      );
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    const startLeaseId = request.method === "POST"
      ? startWithLeasePath(path)
      : null;
    if (startLeaseId) {
      return jsonResponse(
        await startWithLease(request, clients, actor, startLeaseId),
        200,
        corsHeaders,
      );
    }
    if (request.method === "GET" && path === "/v1/offline-quarantines") {
      return jsonResponse(
        await listOfflineQuarantines(request, clients, actor),
        200,
        corsHeaders,
      );
    }
    const quarantineRoute = quarantinePath(path);
    if (
      quarantineRoute &&
      ((!quarantineRoute.resolve && request.method === "GET") ||
        (quarantineRoute.resolve && request.method === "POST"))
    ) {
      return jsonResponse(
        quarantineRoute.resolve
          ? await resolveOfflineQuarantine(
            request,
            clients,
            actor,
            quarantineRoute.id,
          )
          : await getOfflineQuarantine(
            request,
            clients,
            actor,
            quarantineRoute.id,
          ),
        200,
        corsHeaders,
      );
    }
    if (request.method === "GET" && path === "/v1/attempts/lifecycle-impact") {
      return jsonResponse(
        await lifecycleImpact(request, clients, actor),
        200,
        corsHeaders,
      );
    }
    const lifecycleAttemptId = request.method === "POST"
      ? lifecyclePath(path)
      : null;
    if (lifecycleAttemptId) {
      return jsonResponse(
        await manageAttemptLifecycle(
          request,
          clients,
          actor,
          lifecycleAttemptId,
        ),
        200,
        corsHeaders,
      );
    }
    if (request.method === "POST" && path === "/v1/assignments/preview") {
      const preview = await previewAssignments(request, clients, actor);
      return jsonResponse(
        preview,
        preview.decisionReady ? 200 : 409,
        corsHeaders,
      );
    }
    if (
      (request.method === "GET" || request.method === "POST") &&
      path === "/v1/assignment-preview/duration-policy"
    ) {
      return jsonResponse(
        {
          durationPolicy: await assignmentDurationPolicy(
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
      (request.method === "GET" || request.method === "POST") &&
      path === "/v1/cleaning-templates"
    ) {
      const result = await cleaningTemplates(request, clients, actor);
      return jsonResponse(
        request.method === "GET" ? { templates: result } : { template: result },
        request.method === "GET" ? 200 : 201,
        corsHeaders,
      );
    }
    if (request.method === "GET" && path === "/v1/cleaning-history") {
      return jsonResponse(
        await listCleaningHistory(request, clients, actor),
        200,
        corsHeaders,
      );
    }
    if (request.method === "GET" && path === "/v1/work-history") {
      return jsonResponse(
        await listWorkHistory(request, clients, actor),
        200,
        corsHeaders,
      );
    }
    if (request.method === "GET" && path === "/v1/assignment-change-requests") {
      return jsonResponse(
        await listAssignmentChangeRequests(request, clients, actor),
        200,
        corsHeaders,
      );
    }
    if (request.method === "POST") {
      const prestart = prestartPath(path);
      if (prestart) {
        return jsonResponse(
          await prestartCommand(
            request,
            clients,
            actor,
            prestart.id,
            prestart.action,
          ),
          200,
          corsHeaders,
        );
      }
    }
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

    if (request.method === "GET" && path === "/v1/inspections") {
      return jsonResponse(
        { submissions: await listSubmissions(request, clients, actor) },
        200,
        corsHeaders,
      );
    }
    const submissionRoute = submissionPath(path);
    if (submissionRoute) {
      if (submissionRoute.kind === "report" && request.method === "POST") {
        return jsonResponse(
          {
            bombReport: await reportBombRoom(
              request,
              clients,
              actor,
              submissionRoute.attemptId,
            ),
          },
          201,
          corsHeaders,
        );
      }
      if (submissionRoute.kind === "submit" && request.method === "GET") {
        return jsonResponse(
          {
            submissions: await listSubmissions(
              request,
              clients,
              actor,
              submissionRoute.attemptId,
            ),
          },
          200,
          corsHeaders,
        );
      }
      if (submissionRoute.kind === "detail" && request.method === "GET") {
        return jsonResponse(
          {
            submission: await getSubmission(
              request,
              clients,
              actor,
              submissionRoute.submissionId,
            ),
          },
          200,
          corsHeaders,
        );
      }
      if (
        submissionRoute.kind === "bomb-decision" && request.method === "POST"
      ) {
        return jsonResponse(
          {
            bombDecision: await decideBombRoom(
              request,
              clients,
              actor,
              submissionRoute.submissionId,
            ),
          },
          200,
          corsHeaders,
        );
      }
      if (
        (submissionRoute.kind === "approve" ||
          submissionRoute.kind === "reject") && request.method === "POST"
      ) {
        return jsonResponse(
          {
            inspection: await decideSubmission(
              request,
              clients,
              actor,
              submissionRoute.submissionId,
              submissionRoute.kind,
            ),
          },
          200,
          corsHeaders,
        );
      }
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
    if (request.method === "GET" && path === "/v1/developer/rooms") {
      return jsonResponse(
        await listDeveloperRoomCatalog(request, clients, actor),
        200,
        { ...corsHeaders, "cache-control": "no-store" },
      );
    }
    if (request.method === "POST" && path === "/v1/developer/rooms") {
      return jsonResponse(
        { room: await createDeveloperRoom(request, clients, actor) },
        201,
        { ...corsHeaders, "cache-control": "no-store" },
      );
    }
    const developerRoomRetire = path.match(
      /^\/v1\/developer\/rooms\/([0-9a-fA-F-]{36})\/retire$/,
    );
    if (request.method === "POST" && developerRoomRetire) {
      return jsonResponse(
        {
          room: await retireDeveloperRoom(
            request,
            clients,
            actor,
            developerRoomRetire[1] ?? "",
          ),
        },
        200,
        { ...corsHeaders, "cache-control": "no-store" },
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

    if (request.method === "GET" && path === "/v1/attempts/current") {
      return jsonResponse(
        { attempt: await currentAttempt(request, clients, actor) },
        200,
        corsHeaders,
      );
    }
    if (request.method === "POST") {
      const incidentRoute = checkoutIncidentPath(path);
      if (incidentRoute?.kind === "report") {
        return jsonResponse(
          {
            incident: await reportCheckoutIncident(
              request,
              clients,
              actor,
              incidentRoute.id,
            ),
          },
          201,
          corsHeaders,
        );
      }
      const attemptRoute = attemptCommandPath(path);
      if (attemptRoute) {
        return jsonResponse(
          {
            attempt: await executeAttempt(
              request,
              clients,
              actor,
              attemptRoute.attemptId,
              attemptRoute.action,
            ),
          },
          200,
          corsHeaders,
        );
      }
    }
    const incidentRoute = checkoutIncidentPath(path);
    if (request.method === "GET" && incidentRoute?.kind === "detail") {
      return jsonResponse(
        {
          incident: await getCheckoutIncident(
            request,
            clients,
            actor,
            incidentRoute.id,
          ),
        },
        200,
        corsHeaders,
      );
    }
    if (request.method === "POST" && incidentRoute?.kind === "decision") {
      return jsonResponse(
        {
          incident: await decideCheckoutIncident(
            request,
            clients,
            actor,
            incidentRoute.id,
          ),
        },
        200,
        corsHeaders,
      );
    }

    if (request.method === "GET" && path === "/v1/assignments") {
      return jsonResponse(
        { assignments: await listAssignments(request, clients, actor) },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "GET" &&
      path === "/v1/assignments/commit-impact"
    ) {
      return jsonResponse(
        { impact: await assignmentCommitImpact(request, clients, actor) },
        200,
        corsHeaders,
      );
    }
    if (request.method === "POST" && path === "/v1/assignments/commit") {
      return jsonResponse(
        { result: await commitAssignments(request, clients, actor) },
        200,
        corsHeaders,
      );
    }
    if (request.method === "POST" && path === "/v1/assignments/drafts") {
      return jsonResponse(
        { assignment: await saveAssignmentDraft(request, clients, actor) },
        201,
        corsHeaders,
      );
    }
    if (
      request.method === "GET" &&
      /^\/v1\/assignments\/[^/]+\/history$/.test(path)
    ) {
      const cleaningTargetId = assignmentTargetIdFromPath(path);
      if (!cleaningTargetId) {
        throw new EdgeError(
          404,
          "ROUTE_NOT_FOUND",
          "요청한 API 경로를 찾을 수 없습니다.",
        );
      }
      return jsonResponse(
        {
          assignments: await assignmentHistory(
            request,
            clients,
            actor,
            cleaningTargetId,
          ),
        },
        200,
        corsHeaders,
      );
    }

    if (request.method === "GET" && path === "/v1/notifications") {
      return jsonResponse(
        await listNotifications(request, clients, actor),
        200,
        corsHeaders,
      );
    }
    const notificationId = request.method === "POST"
      ? notificationReadPath(path)
      : null;
    if (notificationId) {
      return jsonResponse(
        await markNotificationRead(request, clients, actor, notificationId),
        200,
        corsHeaders,
      );
    }

    if (request.method === "GET" && path === "/v1/push-subscriptions/config") {
      if ([...new URL(request.url).searchParams.keys()].length) {
        throw new EdgeError(
          400,
          "INVALID_WEB_PUSH_SUBSCRIPTION",
          "query 항목은 허용되지 않습니다.",
        );
      }
      return jsonResponse(
        await webPushPublicConfig(
          request,
          actor,
          dependencies.webPushCryptoConfig,
        ),
        200,
        { ...corsHeaders, "cache-control": "no-store" },
      );
    }
    if (request.method === "POST" && path === "/v1/push-subscriptions") {
      return jsonResponse(
        await registerWebPushSubscription(
          request,
          clients,
          actor,
          dependencies.webPushCryptoConfig,
        ),
        201,
        corsHeaders,
      );
    }
    const pushRetireId = request.method === "POST"
      ? webPushRetirePath(path)
      : null;
    if (pushRetireId) {
      return jsonResponse(
        await retireWebPushSubscription(request, clients, actor, pushRetireId),
        200,
        corsHeaders,
      );
    }

    if (request.method === "GET" && path === "/v1/payroll") {
      const response = await listPayroll(request, clients, actor);
      assertPayrollResponseSize(response);
      return jsonResponse(response, 200, corsHeaders);
    }
    if (request.method === "GET" && path === "/v1/payroll/entries") {
      const response = await listPayrollEntries(request, clients, actor);
      assertPayrollResponseSize(response);
      return jsonResponse(response, 200, corsHeaders);
    }
    const payrollCycleMatch = path.match(/^\/v1\/payroll\/([0-9A-Fa-f-]{36})$/);
    if (request.method === "GET" && payrollCycleMatch) {
      const response = {
        payroll: await getPayrollCycle(
          request,
          clients,
          actor,
          payrollCycleMatch[1] ?? "",
        ),
      };
      assertPayrollResponseSize(response);
      return jsonResponse(response, 200, corsHeaders);
    }
    if (request.method === "POST" && path === "/v1/payroll/start") {
      const response = { payroll: await startPayroll(request, clients, actor) };
      assertPayrollResponseSize(response);
      return jsonResponse(response, 200, corsHeaders);
    }
    if (
      request.method === "POST" &&
      path === "/v1/payroll/adjustments/corrections"
    ) {
      const response = {
        adjustment: await correctPayrollAdjustment(request, clients, actor),
      };
      assertPayrollResponseSize(response);
      return jsonResponse(response, 201, corsHeaders);
    }
    if (
      request.method === "POST" && path === "/v1/payroll/adjustments/reversals"
    ) {
      const response = {
        adjustment: await reversePayrollSource(request, clients, actor),
      };
      assertPayrollResponseSize(response);
      return jsonResponse(response, 201, corsHeaders);
    }
    if (request.method === "POST" && path === "/v1/payroll/carry-forward") {
      const response = {
        payroll: await carryForwardPayroll(request, clients, actor),
      };
      assertPayrollResponseSize(response);
      return jsonResponse(response, 200, corsHeaders);
    }
    const lateCarryMatch = path.match(
      /^\/v1\/payroll\/late-earnings\/([^/]+)\/carry$/,
    );
    if (request.method === "POST" && lateCarryMatch) {
      const response = {
        adjustment: await carryLatePayrollEarning(
          request,
          clients,
          actor,
          lateCarryMatch[1] ?? "",
        ),
      };
      assertPayrollResponseSize(response);
      return jsonResponse(response, 201, corsHeaders);
    }
    const paymentResultMatch = path.match(
      /^\/v1\/payroll\/payment-attempts\/([^/]+)\/(check|paid|reopen)$/,
    );
    if (request.method === "POST" && paymentResultMatch) {
      const attemptId = paymentResultMatch[1] ?? "";
      const action = paymentResultMatch[2];
      const paymentResult = action === "check"
        ? await recordPayrollPaymentCheck(request, clients, actor, attemptId)
        : action === "paid"
        ? await recordPayrollPaymentPaid(request, clients, actor, attemptId)
        : await reopenPayrollPayment(request, clients, actor, attemptId);
      const response = { paymentResult };
      assertPayrollResponseSize(response);
      return jsonResponse(response, 200, corsHeaders);
    }

    if (request.method === "GET" && path === "/v1/complaints") {
      const response = await listComplaints(request, clients, actor);
      assertComplaintResponseSize(response);
      return jsonResponse(response, 200, corsHeaders);
    }
    if (request.method === "POST" && path === "/v1/complaints") {
      const response = {
        complaint: await createComplaint(request, clients, actor),
      };
      assertComplaintResponseSize(response);
      return jsonResponse(response, 201, corsHeaders);
    }
    const complaintRoute = complaintPath(path);
    if (
      complaintRoute &&
      request.method === "GET" &&
      complaintRoute.kind === "detail"
    ) {
      const response = {
        complaint: await complaintDetail(
          clients,
          actor,
          complaintRoute.complaintId,
        ),
      };
      assertComplaintResponseSize(response);
      return jsonResponse(response, 200, corsHeaders);
    }
    if (
      complaintRoute &&
      request.method === "GET" &&
      complaintRoute.kind === "history"
    ) {
      const response = await complaintHistory(
        request,
        clients,
        actor,
        complaintRoute.complaintId,
      );
      assertComplaintResponseSize(response);
      return jsonResponse(response, 200, corsHeaders);
    }
    if (
      complaintRoute &&
      request.method === "POST" &&
      complaintRoute.kind !== "detail" &&
      complaintRoute.kind !== "history"
    ) {
      const mutation = await mutateComplaint(
        request,
        clients,
        actor,
        complaintRoute.complaintId,
        complaintRoute.kind,
      );
      const response = complaintRoute.kind === "rework"
        ? mutation
        : { complaint: mutation };
      assertComplaintResponseSize(response);
      return jsonResponse(
        response,
        complaintRoute.kind === "rework" ? 201 : 200,
        corsHeaders,
      );
    }

    if (request.method === "GET" && path === "/v1/reservations") {
      const result = await listReservations(request, clients, actor);
      return jsonResponse(
        Array.isArray(result) ? { reservations: result } : result,
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
      path === "/v1/reservations/bookability/preview"
    ) {
      return jsonResponse(
        {
          preview: await previewReservationBookability(
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
      path.endsWith("/room-change/preview")
    ) {
      return jsonResponse(
        {
          preview: await previewReservationRoomMove(
            request,
            clients,
            actor,
            reservationRoomMoveIdFromPath(path, "preview"),
          ),
        },
        200,
        corsHeaders,
      );
    }
    if (
      request.method === "POST" &&
      path.startsWith("/v1/reservations/") &&
      /^\/v1\/reservations\/[^/]+\/room-change$/.test(path)
    ) {
      return jsonResponse(
        {
          result: await commitReservationRoomMove(
            request,
            clients,
            actor,
            reservationRoomMoveIdFromPath(path, "commit"),
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

    if (request.method === "GET" && path === "/v1/room-types") {
      const response = jsonResponse(
        { items: await listRoomTypes(request, clients, actor) },
        200,
        corsHeaders,
      );
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    if (request.method === "GET" && path === "/v1/rooms") {
      return jsonResponse(
        { rooms: await listRooms(clients, actor) },
        200,
        corsHeaders,
      );
    }
    const operationBlocksReadMatch = request.method === "GET"
      ? /^\/v1\/rooms\/([^/]+)\/operation-blocks$/.exec(path)
      : null;
    if (operationBlocksReadMatch) {
      const params = new URL(request.url).searchParams;
      if (
        [...params.keys()].some((key) => key !== "status") ||
        (params.get("status") ?? "actionable") !== "actionable"
      ) {
        throw new EdgeError(
          400,
          "VALIDATION_ERROR",
          "status는 actionable만 사용할 수 있습니다.",
        );
      }
      const response = jsonResponse(
        await listRoomOperationBlocks(
          request,
          clients,
          actor,
          operationBlocksReadMatch[1],
        ),
        200,
        corsHeaders,
      );
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    const roomIssuesReadMatch = request.method === "GET"
      ? /^\/v1\/rooms\/([^/]+)\/issues$/.exec(path)
      : null;
    if (roomIssuesReadMatch) {
      const params = new URL(request.url).searchParams;
      if (
        [...params.keys()].some((key) => key !== "status") ||
        (params.get("status") ?? "open") !== "open"
      ) {
        throw new EdgeError(
          400,
          "VALIDATION_ERROR",
          "status는 open만 사용할 수 있습니다.",
        );
      }
      const response = jsonResponse(
        await listRoomIssues(
          request,
          clients,
          actor,
          roomIssuesReadMatch[1],
        ),
        200,
        corsHeaders,
      );
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    const roomEventsReadMatch = request.method === "GET"
      ? /^\/v1\/rooms\/([^/]+)\/events$/.exec(path)
      : null;
    if (roomEventsReadMatch) {
      const params = new URL(request.url).searchParams;
      const limitValues = params.getAll("limit");
      if (
        [...params.keys()].some((key) => key !== "limit") ||
        limitValues.length > 1
      ) {
        throw new EdgeError(
          400,
          "VALIDATION_ERROR",
          "limit 외의 query 또는 중복 limit은 사용할 수 없습니다.",
        );
      }
      const rawLimit = limitValues[0] ?? "30";
      if (!/^(?:[1-9]|[1-4]\d|50)$/.test(rawLimit)) {
        throw new EdgeError(
          400,
          "VALIDATION_ERROR",
          "limit은 1~50의 정수여야 합니다.",
        );
      }
      const limit = Number(rawLimit);
      const response = jsonResponse(
        await listRoomEvents(
          request,
          clients,
          actor,
          roomEventsReadMatch[1],
          limit,
        ),
        200,
        corsHeaders,
      );
      response.headers.set("Cache-Control", "no-store");
      return response;
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
    const roomDetailId = request.method === "GET"
      ? roomDetailIdFromPath(path)
      : null;
    if (roomDetailId) {
      return jsonResponse(
        { room: await getRoom(clients, actor, roomDetailId) },
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
    const safeError =
      error instanceof PhotoError || error instanceof PhotoUploadContractError
        ? photoError(error)
        : null;
    let responseError = safeError
      ? new EdgeError(
        safeError.statusCode,
        safeError.code,
        "사진 작업 조건을 확인해 주세요.",
      )
      : error;
    const source = authorizationSourceForPath(path);
    if (
      responseError instanceof EdgeError && actor && clients && source &&
      isAuthorizationDeniedCode(responseError.code)
    ) {
      try {
        await recordAuthorizationDenied(
          clients,
          actor,
          source,
          responseError.code,
        );
      } catch (activityError) {
        responseError = activityError;
      }
    }
    return errorResponse(responseError, id, corsHeaders);
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleApiRequest(request));
}
