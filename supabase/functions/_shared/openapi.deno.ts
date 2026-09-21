import type { openApiDocument } from "./openapi.ts";
import { openApiResponse, swaggerUiResponse } from "./openapi.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
Deno.test("OpenAPI publishes the v0.5.0 developer room catalog candidate", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  assert(
    document.info.version === "0.5.0",
    "approved semantic contract version",
  );
});

Deno.test("developer room catalog OpenAPI exposes six developer-only safe operations", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  const operations = [
    document.paths["/v1/developer/room-catalog"].get,
    document.paths["/v1/developer/room-types/{roomTypeId}/capacity/preview"]
      .post,
    document.paths["/v1/developer/room-types/{roomTypeId}/capacity"].patch,
    document.paths["/v1/developer/rooms"].post,
    document.paths["/v1/developer/rooms/{roomId}/deactivation/preview"].post,
    document.paths["/v1/developer/rooms/{roomId}/deactivate"].post,
  ];
  assert(
    operations.every((operation) =>
      operation["x-required-roles"].join(",") === "developer"
    ),
    "all catalog operations are developer-only",
  );
  const roomType = document.components.schemas.RoomTypeCatalogItem;
  assert(
    roomType.required.includes("baseOccupancy") &&
      roomType.required.includes("maxOccupancy"),
    "admin catalog includes both occupancy fields",
  );
  const request =
    document.components.schemas.ReservationBookabilityStandardPreviewRequest;
  assert(
    request.required.includes("guestCount"),
    "bookability requires guestCount",
  );
});
Deno.test("payroll cycle resolver reuses the bounded payroll envelope", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  const operation = document.paths["/v1/payroll/{cycleId}"].get;
  assert(operation.operationId === "getPayrollCycle", "stable operation ID");
  assert(
    operation.responses["200"].content["application/json"].schema.$ref ===
      "#/components/schemas/PayrollCycleEnvelope",
    "bounded payroll envelope reused",
  );
});
Deno.test("room move OpenAPI publishes bounded 409 conflict recovery metadata", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  const preview = document.paths[
    "/v1/reservations/{reservationId}/room-change/preview"
  ].post;
  const commit = document.paths[
    "/v1/reservations/{reservationId}/room-change"
  ].post;
  const conflict = document.components.schemas.RoomChangeConflict;
  const outcome = document.components.schemas.ReservationRoomMoveOutcome;
  const errorCodes = document.components.schemas.ErrorCode.enum;
  const serialized = JSON.stringify(conflict);

  assert(
    preview.responses["409"].content["application/json"].schema.$ref ===
        "#/components/schemas/RoomChangeConflictEnvelope" &&
      commit.responses["409"].content["application/json"].schema.$ref ===
        "#/components/schemas/RoomChangeConflictEnvelope",
    "both room move commands use the dedicated conflict envelope",
  );
  assert(
    conflict.additionalProperties === false &&
      conflict.properties.reloadResources.uniqueItems === true &&
      conflict.properties.reloadResources.items.enum.join(",") ===
        "reservation,sourceRoom,targetRoom,roomMovePreview",
    "reload resources are an exact source-controlled allowlist",
  );
  assert(
    conflict.properties.latestVersions.additionalProperties === false &&
      errorCodes.includes("IDEMPOTENCY_KEY_REUSED") &&
      serialized.includes('"type":"null"') &&
      !serialized.includes("uuid") &&
      !serialized.includes("pin") &&
      !serialized.includes("requestHash"),
    "latest versions are nullable and sensitive metadata is absent",
  );
  assert(
    outcome.description.includes("effectiveAt") &&
      outcome.description.includes("stay.currentRoomId"),
    "move outcomes are evaluated at effectiveAt while current room is separate",
  );
});
Deno.test("photo OpenAPI collection operations retain raw body boundary, CAS and opaque projections", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  const upload =
    document.paths["/v1/attempts/{attemptId}/photo-slots/{slotId}/upload"].post;
  assert(
    upload.requestBody.content["image/jpeg"].schema["x-max-bytes"] === 307200 &&
      upload.requestBody.content["image/webp"].schema.maxLength === 307200,
    "raw300KiB both encodings",
  );
  assert(
    !Object.hasOwn(upload.requestBody.content, "multipart/form-data") &&
      !Object.hasOwn(upload.requestBody.content, "application/json"),
    "no multipart/base64",
  );
  assert(
    upload.parameters.filter((p) => p.in === "query").length === 3 &&
      upload["x-required-roles"].join() === "maid",
    "exact binding query and maid",
  );
  const collectionUpload = document.paths[
    "/v1/attempts/{attemptId}/photo-slots/{slotId}/photos/{photoItemId}/upload"
  ].post;
  const collectionDelete = document.paths[
    "/v1/attempts/{attemptId}/photo-slots/{slotId}/photos/{photoItemId}"
  ].delete;
  assert(
    collectionUpload.parameters.filter((p) => p.in === "query").length === 4 &&
      collectionDelete.parameters.filter((p) => p.in === "query").length ===
        4 &&
      collectionUpload["x-required-roles"].join() === "maid" &&
      collectionDelete["x-required-roles"].join() === "maid",
    "collection upload and delete require exact item and collection CAS",
  );
  assert(
    document.paths["/v1/photos/{photoId}/content"].get["x-required-roles"]
      .join() === "admin,maid",
    "developer original read denied",
  );
  const schemas = document.components.schemas;
  assert(
    upload.responses["408"].description.includes("PHOTO_BODY_TIMEOUT"),
    "bounded body timeout is documented",
  );
  assert(
    document.components.schemas.ErrorCode.enum.includes(
      "PHOTO_RETENTION_DELETE_PREPARED",
    ) &&
      upload.responses["409"].description.includes(
        "PHOTO_RETENTION_DELETE_PREPARED",
      ) &&
      document.paths["/v1/attempts/{attemptId}/submissions"].post.responses[
        "409"
      ].description.includes("PHOTO_RETENTION_DELETE_PREPARED") &&
      document.paths["/v1/inspections/{submissionId}/approve"].post.responses[
        "409"
      ].description.includes("PHOTO_RETENTION_DELETE_PREPARED"),
    "prepared purge barrier is one stable 409 across upload, submission and inspection",
  );
  assert(
    schemas.PhotoUploadResponse.allOf.some((value) =>
      "required" in value && value.required.includes("quotaWarning")
    ),
    "initial and retry upload warning is required",
  );
  assert(
    schemas.PhotoUploadOperation.properties.quotaWarning.type === "boolean",
    "quota warning only, no usage raw fields",
  );
  assert(
    schemas.AttemptPhotoSlots.properties.slots.maxItems === 100 &&
      schemas.PhotoUploadOperation.additionalProperties === false,
    "bounded metadata allowlist",
  );
  for (
    const key of [
      "providerFileId",
      "providerLocator",
      "sha256",
      "claimDigest",
      "sessionId",
      "oauthToken",
    ]
  ) {
    assert(
      !Object.hasOwn(schemas.PhotoUploadOperation.properties, key),
      "private fields absent",
    );
  }
  assert(
    schemas.AttemptPhotoSlots.properties.slots.items.properties.photoId.anyOf
      .some((x) => x.type === "null"),
    "limited cannot read original ID",
  );
  assert(
    Object.keys(document.paths).length === 128 &&
      Object.values(document.paths).flatMap((item) =>
          Object.keys(item).filter((method) =>
            ["get", "post", "put", "patch", "delete"].includes(method)
          )
        ).length === 138,
    "combined candidate contract 128/138",
  );
});

Deno.test("notification OpenAPI exposes only bounded own-inbox operations", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  const list = document.paths["/v1/notifications"].get;
  const read = document.paths["/v1/notifications/{notificationId}/read"].post;
  const schemas = document.components.schemas;
  assert(list.operationId === "listNotifications", "stable list operation");
  assert(read.operationId === "markNotificationRead", "stable read operation");
  assert(
    list.parameters.find((parameter) => parameter.name === "limit")?.schema
      .maximum === 100,
    "bounded limit",
  );
  assert(
    list["x-required-roles"].join() === "admin,maid" &&
      read["x-required-roles"].join() === "admin,maid",
    "admin and maid own inbox only",
  );
  for (
    const key of [
      "recipientProfileId",
      "dedupeKey",
      "groupKey",
      "actorProfileId",
      "sessionId",
    ]
  ) {
    assert(
      !Object.hasOwn(schemas.Notification.properties, key),
      `${key} stays private`,
    );
  }
  assert(
    !Object.hasOwn(read, "requestBody"),
    "read timestamp remains server-owned",
  );
});

Deno.test("Web Push OpenAPI exposes current public config and two strict secret-free own commands", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  const register = document.paths["/v1/push-subscriptions"].post;
  const config = document.paths["/v1/push-subscriptions/config"].get;
  const retire =
    document.paths["/v1/push-subscriptions/{subscriptionId}/retire"].post;
  assert(
    config.operationId === "getWebPushSubscriptionConfig" &&
      register.operationId === "registerWebPushSubscription" &&
      retire.operationId === "retireWebPushSubscription",
    "three stable operations",
  );
  assert(
    register["x-required-roles"].join() === "admin,maid" &&
      retire["x-required-roles"].join() === "admin,maid",
    "business self roles only",
  );
  assert(
    register.parameters.some((p) => p.name === "Idempotency-Key") &&
      retire.parameters.some((p) => p.name === "Idempotency-Key"),
    "both commands idempotent",
  );
  const projection = document.components.schemas.WebPushSubscription;
  for (
    const key of [
      "endpoint",
      "host",
      "path",
      "p256dh",
      "auth",
      "ciphertext",
      "nonce",
      "tag",
      "digest",
      "sessionId",
      "deviceId",
    ]
  ) {
    assert(
      !Object.hasOwn(projection.properties, key),
      `${key} remains private`,
    );
  }
  assert(
    register.responses["201"].headers["Cache-Control"].schema.const ===
      "no-store",
    "register no-store",
  );
});

Deno.test("payroll OpenAPI separates earnings and signed adjustments with strict command amounts", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  const list = document.paths["/v1/payroll"].get;
  const entries = document.paths["/v1/payroll/entries"].get;
  const start = document.paths["/v1/payroll/start"].post;
  const correction = document.paths["/v1/payroll/adjustments/corrections"].post;
  const reversal = document.paths["/v1/payroll/adjustments/reversals"].post;
  const carry = document.paths["/v1/payroll/carry-forward"].post;
  const lateCarry =
    document.paths["/v1/payroll/late-earnings/{earningId}/carry"].post;
  const paymentCheck =
    document.paths["/v1/payroll/payment-attempts/{attemptId}/check"].post;
  const paymentPaid =
    document.paths["/v1/payroll/payment-attempts/{attemptId}/paid"].post;
  const paymentReopen =
    document.paths["/v1/payroll/payment-attempts/{attemptId}/reopen"].post;
  const schemas = document.components.schemas;
  assert(
    list.operationId === "listPayrollCycles",
    "stable payroll list operation",
  );
  assert(
    start.operationId === "startPayrollCycle",
    "stable payroll start operation",
  );
  assert(
    entries.operationId === "listPayrollEntries" &&
      entries.parameters.find((parameter) => parameter.name === "limit")
          ?.schema.maximum === 50,
    "bounded payroll detail operation",
  );
  assert(
    list["x-required-roles"].join() === "admin,maid",
    "admin and self maid read",
  );
  assert(
    start["x-required-roles"].join() === "admin",
    "business admin starts payment",
  );
  assert(
    start.parameters.some((parameter) => parameter.name === "Idempotency-Key"),
    "payroll start requires idempotency",
  );
  assert(
    correction.operationId === "recordPayrollCorrection" &&
      reversal.operationId === "reversePayrollSource" &&
      carry.operationId === "carryForwardPayrollCycle" &&
      lateCarry.operationId === "carryLatePayrollEarning",
    "four #102 operations",
  );
  assert(
    paymentCheck.operationId === "recordPayrollPaymentCheck" &&
      paymentPaid.operationId === "recordPayrollPaymentPaid" &&
      paymentReopen.operationId === "reopenPayrollPaymentAttempt",
    "three exact #103 result operations",
  );
  assert(
    schemas.PayrollPaymentPaidRequest.additionalProperties === false &&
      !Object.hasOwn(schemas.PayrollPaymentPaidRequest.properties, "amount") &&
      !Object.hasOwn(schemas.PayrollPaymentPaidRequest.properties, "paidAt") &&
      schemas.PayrollPaymentResult.required.includes("lockedAmount") &&
      !Object.hasOwn(schemas.PayrollPaymentResult.properties, "paidAmount") &&
      schemas.PayrollPaymentPaidRequest.properties.paymentMethod.const ===
        "bank_transfer" &&
      paymentPaid.description.includes("provider HTTP를 호출하지 않습니다"),
    "full payment attestation keeps amount, clock and provider calls server-owned",
  );
  assert(
    schemas.PayrollStatus.enum.join() === "open,paying,check,paid",
    "payment enum is unchanged",
  );
  assert(
    schemas.ErrorCode.enum.includes("PAYROLL_PRIOR_LATE_EARNING_PENDING"),
    "prior late earning freeze conflict is public and stable",
  );
  assert(
    schemas.PayrollEntriesEnvelope.properties.entries.maxItems === 50 &&
      schemas.PayrollCycle.properties.items.maxItems === 10,
    "adjustment projections retain bounded contracts",
  );
  assert(
    schemas.PayrollStartRequest.additionalProperties === false &&
      !Object.hasOwn(schemas.PayrollStartRequest.properties, "amount") &&
      !Object.hasOwn(schemas.PayrollStartRequest.properties, "earningIds"),
    "server computes amount and earning set",
  );
  assert(
    schemas.PayrollCycle.required.includes("lateEarnings") &&
      schemas.PayrollCycle.required.includes("itemsNextCursor") &&
      schemas.PayrollCycle.required.includes("lateEarningsNextCursor") &&
      schemas.PayrollCycle.properties.items.maxItems === 10 &&
      schemas.PayrollCycle.properties.lateEarnings.maxItems === 10 &&
      schemas.PayrollListEnvelope.properties.payroll.maxItems === 10 &&
      schemas.PayrollEntriesEnvelope.properties.entries.maxItems === 50 &&
      schemas.PayrollCycle.properties.lockedAmount.description.includes(
        "다시 계산하지",
      ) &&
      schemas.PayrollCycle.properties.lateEarningAmount.description.includes(
        "분리",
      ),
    "locked snapshot and late earnings are distinct",
  );
  assert(
    list.description.includes("cycleId=null") &&
      start.description.includes("실제 송금 성공이 아닙니다") &&
      list.description.includes("128 KiB") &&
      entries.description.includes("actor 역할/ID"),
    "conceptual OPEN, bounded response and signed-scope semantics documented",
  );
});

Deno.test(
  "complaint OpenAPI fixes typed provenance, bounded history and evaluation-only penalty",
  async () => {
    const doc = (await openApiResponse({}).json()) as typeof openApiDocument;
    const complaintPaths = Object.keys(doc.paths).filter((path) =>
      path.startsWith("/v1/complaints")
    );
    const complaintApi = doc.paths as unknown as Record<
      string,
      Record<
        string,
        {
          parameters?: Array<{
            name: string;
            description?: string;
            schema: { minLength?: number };
          }>;
          responses: Record<
            string,
            { headers?: { "Cache-Control"?: { schema: { const: string } } } }
          >;
        }
      >
    >;
    assert(complaintPaths.length === 9, "nine exact complaint paths");
    assert(
      doc.paths["/v1/complaints"].post["x-required-roles"].join(",") ===
        "admin",
      "create admin only",
    );
    assert(
      doc.paths["/v1/complaints/{complaintId}/response"].post[
        "x-required-roles"
      ].join(",") === "maid",
      "response maid only",
    );
    assert(
      doc.paths["/v1/complaints/{complaintId}/rework"].post.operationId ===
          "materializeComplaintRework" &&
        doc.paths["/v1/complaints/{complaintId}/rework"].post[
            "x-required-roles"
          ].join(",") === "admin",
      "rework is an explicit admin command",
    );
    assert(
      doc.components.schemas.ComplaintCategory.enum.length === 8,
      "exact category allowlist",
    );
    for (
      const code of [
        "INVALID_COMPLAINT_REWORK",
        "COMPLAINT_COMPENSATION_AMOUNT_INVALID",
        "COMPLAINT_REWORK_MAID_UNAVAILABLE",
        "COMPLAINT_REWORK_WINDOW_UNAVAILABLE",
        "COMPLAINT_REWORK_NOT_CONFIRMED",
        "COMPLAINT_REWORK_ALREADY_MATERIALIZED",
        "COMPLAINT_REWORK_DECISION_STALE",
        "COMPLAINT_REWORK_PRESTART_FROZEN",
        "RECLEAN_TEMPLATE_NOT_CONFIGURED",
      ] as const
    ) {
      assert(
        doc.components.schemas.ErrorCode.enum.includes(code),
        `complaint error code is public: ${code}`,
      );
    }
    assert(
      doc.components.schemas.ComplaintDecision.properties.penaltyScore
            .maximum === 10 &&
        doc.components.schemas.ComplaintDecision.properties.penaltyScore
          .description.includes(
            "payroll",
          ),
      "bounded evaluation-only penalty",
    );
    assert(
      doc.components.schemas.ComplaintCreateRequest.additionalProperties ===
          false &&
        !(
          "customer" in doc.components.schemas.ComplaintCreateRequest.properties
        ),
      "no free-form customer payload",
    );
    assert(
      !complaintPaths.some((path) => path.includes("reopen")),
      "closed complaint has no reopen route",
    );
    for (
      const operation of [
        complaintApi["/v1/complaints"].get,
        complaintApi["/v1/complaints/{complaintId}/history"].get,
      ]
    ) {
      const cursor = operation.parameters?.find((parameter) =>
        parameter.name === "cursor"
      );
      assert(
        cursor?.schema.minLength === 1 &&
          cursor.description?.includes("INVALID_COMPLAINT_CURSOR"),
        "empty complaint cursors have one stable 400 contract",
      );
    }
    for (const path of complaintPaths) {
      for (const operation of Object.values(complaintApi[path])) {
        for (const response of Object.values(operation.responses)) {
          assert(
            response.headers?.["Cache-Control"]?.schema.const === "no-store",
            `complaint response must be no-store: ${path}`,
          );
        }
      }
    }
  },
);

Deno.test("submission inspection OpenAPI matches immutable payload and capability contracts", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  const schemas = document.components.schemas;
  const inspection = schemas.InspectionDecisionEnvelope.properties.inspection;
  assert(
    inspection.required.includes("recleanAssignmentId") &&
      inspection.properties.recleanAssignmentId.type.includes("null") &&
      inspection.properties.recleanAssignmentId.format === "uuid",
    "approve null and reject UUID reclean assignment both validate",
  );
  assert(
    schemas.CleaningSubmission.properties.bombReport.properties.memo
          .maxLength ===
        500 &&
      schemas.BombRoomReportRequest.properties.memo.maxLength === 500,
    "bomb memo request and admin response share the 500 character boundary",
  );
  const history = document.paths["/v1/attempts/{attemptId}/submissions"].get;
  const submit = document.paths["/v1/attempts/{attemptId}/submissions"].post;
  assert(
    history.description.includes("과거 immutable") &&
      submit.description.includes("upload_submit") &&
      submit.description.includes("deactivation_pending") &&
      submit.description.includes("제출 권한으로 확장되지") &&
      submit.description.includes("BOMB_REPORT_SEALED"),
    "Korean handoff states history, upload_only-only limited submit and immutable bomb seal",
  );
  const inspectionPaths = document.paths as unknown as Record<
    string,
    { post: { description: string } }
  >;
  for (const action of ["bomb-room-decision", "approve", "reject"]) {
    assert(
      inspectionPaths[`/v1/inspections/{submissionId}/${action}`].post
        .description.includes("STALE_VERSION"),
      `stale review code ${action}`,
    );
  }
});

Deno.test("offline lease contract has five exact operations, bounded ingest and safe permanent audit", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  assert(
    document.paths["/v1/attempts/{attemptId}/start-with-lease"]
      .post["x-required-roles"][0] === "maid",
    "online start exact maid",
  );
  assert(
    document.paths["/v1/offline-events"].post["x-required-roles"][0] === "maid",
    "authenticated own event",
  );
  assert(
    document.paths["/v1/offline-quarantines"].get["x-required-roles"][0] ===
        "admin" &&
      document.paths["/v1/offline-quarantines/{quarantineId}"]
          .get["x-required-roles"][0] === "admin" &&
      document.paths["/v1/offline-quarantines/{quarantineId}/resolve"]
          .post["x-required-roles"][0] === "admin",
    "only admin reviews quarantines",
  );
  const schema = document.components.schemas;
  assert(
    schema.OfflineCompletionRequest.additionalProperties === false &&
      schema.OfflineCompletionRequest.required.length === 5,
    "single completion no batch/action/PII",
  );
  assert(
    schema.OfflineWorkLease.properties.allowedActions.items.const ===
      "complete_field_work",
    "no offline start or PIN action",
  );
  assert(
    schema.OfflineQuarantinePage.properties.items.maxItems === 100,
    "bounded page",
  );
  assert(
    schema.OfflineResolutionRequest.oneOf.length === 3 &&
      schema.OfflineResolutionRequest.oneOf.every((branch) =>
        !Object.hasOwn(branch.properties, "correctedAt")
      ),
    "no free historical clock correction",
  );
  const safeSummary = {
    offlineQuarantineId: "10000000-0000-4000-8000-000000000001",
    resolution: "record_only",
  };
  assert(
    Object.keys(safeSummary).every((key) =>
      Object.hasOwn(
        schema.DeveloperAuditEvent.properties.summary.properties,
        key,
      )
    ),
    "all DB offline audit projection fields are declared",
  );
  assert(
    schema.DeveloperAuditEventType.enum.includes(
      "cleaning.offline_event_resolved",
    ),
    "audit event is generated",
  );
  for (
    const field of [
      "eventId",
      "occurredAt",
      "serverOffsetMs",
      "requestHash",
      "sessionId",
      "token",
      "requestBody",
    ]
  ) {
    assert(
      !Object.hasOwn(
        schema.DeveloperAuditEvent.properties.summary.properties,
        field,
      ),
      "client metadata excluded from permanent audit summary",
    );
  }
});

Deno.test("OpenAPI publishes bearer and idempotency contracts", async () => {
  const response = openApiResponse({});
  const document = await response.json() as typeof openApiDocument;
  const serialized = JSON.stringify(document);
  const assignments = document.paths["/v1/assignments"].get;
  const history =
    document.paths["/v1/assignments/{cleaningTargetId}/history"].get;
  assert(
    assignments.description.includes("본인에게 실제 통보된 revision") &&
      assignments.description.includes("미통보 draft") &&
      history.description.includes("superseded") &&
      history.description.includes("현재 target version은 공개하지 않습니다"),
    "maid visibility documents exact notified revisions, not target-wide history",
  );
  assert(
    document.components.schemas.Assignment.properties.targetAssignmentVersion
      .description.includes("maid는 본인 통보 revision에 고정된 version"),
    "history target version is a revision snapshot, not current reassignment state",
  );
  assert(
    document.components.schemas.Assignment.properties.roomId.type.includes(
      "null",
    ) &&
      document.components.schemas.Assignment.properties.roomNumber.type
        .includes("null") &&
      document.components.schemas.Assignment.properties.roomId.description
        .includes("현재 target 객실로 대체하지 않습니다"),
    "legacy unknown notification room snapshots are nullable, never current room fallbacks",
  );
  const card = document.components.schemas.AssignmentCard;
  for (
    const field of [
      "cleaningKind",
      "roomTypeCode",
      "roomTypeName",
      "elevatorZone",
      "feeSnapshot",
      "durationMinutes",
      "originalServiceDate",
      "rolloverCount",
      "rolloverReason",
      "targetStatus",
      "attemptStatus",
      "submissionStatus",
    ]
  ) {
    assert(
      (card.required as readonly string[]).includes(field),
      `assignment card requires ${field}`,
    );
  }
  assert(
    card.properties.durationMinutes.type.includes("null") &&
      card.properties.targetStatus.type.includes("null") &&
      card.properties.targetStatus.enum.filter((value) => value !== null)
          .join(",") ===
        "unassigned,draft_assigned,notified,in_progress,upload_pending,inspection_pending,approved,rejected,cancelled" &&
      JSON.stringify(assignments.responses["200"]).includes(
        "#/components/schemas/AssignmentCard",
      ) &&
      JSON.stringify(history.responses["200"]).includes(
        "#/components/schemas/AssignmentCard",
      ),
    "list and history publish the nullable assignment card snapshot",
  );

  assert(document.openapi === "3.1.1", "OpenAPI version must be 3.1.1");
  assert(serialized.includes('"bearerAuth"'), "bearerAuth must be documented");
  assert(
    serialized.includes('"Idempotency-Key"'),
    "Idempotency-Key must be documented",
  );
  assert(
    !serialized.includes("@auth.castletheart.invalid"),
    "internal Auth email leaked",
  );
  assert(
    !serialized.includes("SUPABASE_SERVICE_ROLE_KEY"),
    "service secret name leaked",
  );
  assert(
    !/010[- ]?\d{4}[- ]?\d{4}/.test(serialized),
    "phone number example leaked",
  );
  assert(
    serialized.includes('"#/components/schemas/ErrorCode"'),
    "error codes must generate a reusable frontend type",
  );
  assert(
    serialized.includes('"LOGIN_CLIENT_ID_UNAVAILABLE"'),
    "trusted client metadata failure must be documented",
  );
  const passwordChange = document.paths["/v1/auth/password"].post;
  assert(
    passwordChange.responses["429"] !== undefined &&
      passwordChange.responses["429"].headers?.["Retry-After"] !== undefined &&
      passwordChange.responses["503"] !== undefined &&
      passwordChange.description.includes("private effect version") &&
      passwordChange.description.includes("actor 단위 durable rate limit"),
    "password-change replay provenance and durable verification limit must be documented",
  );
  for (
    const code of [
      "PASSWORD_VERIFICATION_RATE_LIMITED",
      "PASSWORD_VERIFICATION_RATE_LIMIT_UNAVAILABLE",
      "PASSWORD_RESET_STATE_UPDATE_FAILED",
    ] as const
  ) {
    assert(
      (document.components.schemas.ErrorCode.enum as readonly string[])
        .includes(
          code,
        ),
      `password recovery error code is public: ${code}`,
    );
  }
  assert(
    serialized.includes('"#/components/schemas/RoomProjection"'),
    "room projection must not be an untyped object",
  );
  assert(
    serialized.includes('"#/components/schemas/DeveloperOverview"'),
    "developer overview needs a reusable generated type",
  );
  assert(
    serialized.includes('"/v1/developer/diagnostics"'),
    "developer diagnostics must be published",
  );
  assert(
    serialized.includes('"/v1/developer/activity-events"') &&
      serialized.includes('"#/components/schemas/DeveloperActivityPage"'),
    "developer security activity needs a reusable bounded contract",
  );
  assert(
    serialized.includes('"assignment.draft_saved"') &&
      serialized.includes('"assignment.notified"') &&
      serialized.includes('"assignment.attempt_activated"') &&
      serialized.includes('"assignment.rolled_over"'),
    "assignment audit events must be part of the developer allowlist",
  );
  const auditEventTypeParameter = document.paths["/v1/developer/audit-events"]
    .get.parameters.find((parameter) => parameter.name === "eventType");
  assert(
    auditEventTypeParameter?.schema.maxItems ===
      document.components.schemas.DeveloperAuditEventType.enum.length,
    "developer audit filter limit must match the current allowlist",
  );
  const auditSummary = document.components.schemas.DeveloperAuditEvent
    .properties.summary;
  assert(
    auditSummary.additionalProperties === false &&
      "cleaningTargetId" in auditSummary.properties &&
      "maidProfileId" in auditSummary.properties &&
      "serviceDate" in auditSummary.properties &&
      "sequenceNumber" in auditSummary.properties &&
      "revision" in auditSummary.properties &&
      "targetAssignmentVersion" in auditSummary.properties &&
      "attemptId" in auditSummary.properties &&
      "attemptNumber" in auditSummary.properties &&
      "assignmentRevision" in auditSummary.properties &&
      "rolloverFromDate" in auditSummary.properties &&
      "rolloverToDate" in auditSummary.properties &&
      "carryoverCount" in auditSummary.properties &&
      !("requestHash" in auditSummary.properties),
    "assignment audit summary must expose only approved projection fields",
  );
  for (
    const path of [
      "/v1/availability",
      "/v1/availability/submissions",
      "/v1/availability/change-requests",
      "/v1/availability/change-requests/{requestId}/decision",
      "/v1/availability/candidates",
      "/v1/assignments",
      "/v1/assignments/{cleaningTargetId}/history",
      "/v1/assignments/drafts",
      "/v1/assignments/commit-impact",
      "/v1/assignments/commit",
      "/v1/reservations",
      "/v1/reservations/bookability/preview",
      "/v1/reservations/{reservationId}",
      "/v1/reservations/{reservationId}/cancel",
      "/v1/reservations/{reservationId}/manual-checkout",
      "/v1/reservations/cleaning-requests",
      "/v1/reservations/cleaning-requests/{targetId}/cancel",
      "/v1/reservations/transitions/process",
      "/v1/rooms/{roomId}",
      "/v1/rooms/{roomId}/master-data",
      "/v1/rooms/{roomId}/operation-blocks",
      "/v1/rooms/{roomId}/operation-blocks/{blockId}/release",
      "/v1/rooms/{roomId}/candles",
      "/v1/rooms/{roomId}/issues",
      "/v1/rooms/{roomId}/events",
      "/v1/rooms/{roomId}/issues/{issueId}/resolve",
      "/v1/rooms/{roomId}/pin-sync-events",
    ]
  ) {
    assert(serialized.includes(`"${path}"`), `${path} must be published`);
  }
  assert(
    serialized.includes('"#/components/schemas/AvailabilityVersion"') &&
      serialized.includes(
        '"#/components/schemas/AvailabilityChangeRequest"',
      ),
    "availability codegen schemas must be reusable",
  );
  assert(
    serialized.includes('"#/components/schemas/Assignment"') &&
      serialized.includes('"#/components/schemas/AssignmentDraftRequest"') &&
      serialized.includes('"#/components/schemas/AssignmentCommitImpact"') &&
      serialized.includes('"#/components/schemas/AssignmentCommitRequest"') &&
      serialized.includes('"#/components/schemas/AssignmentCommitResult"'),
    "assignment codegen schemas must be reusable",
  );
  assert(
    serialized.includes('"#/components/schemas/RoomEventCategory"') &&
      serialized.includes('"eventKey"') &&
      serialized.includes('"actorProfileId"') &&
      serialized.includes('"actorDisplayName"') &&
      serialized.includes('"entityId"') &&
      serialized.includes('"^(?:[1-9]|[1-4][0-9]|50)$"'),
    "room event contract must publish stable identity, actor/entity fields, and canonical limit",
  );
  assert(
    serialized.includes('"ASSIGNMENT_VERSION_CONFLICT"') &&
      serialized.includes('"ASSIGNMENT_SEQUENCE_CONFLICT"') &&
      serialized.includes('"ASSIGNMENT_IMPACT_CHANGED"') &&
      serialized.includes('"ASSIGNMENT_AVAILABILITY_STALE"'),
    "assignment draft and commit concurrency errors must be documented",
  );
  assert(
    serialized.includes('"AVAILABILITY_WEEK_OUT_OF_RANGE"') &&
      serialized.includes('"PAST_AVAILABILITY_DATE_NOT_ALLOWED"') &&
      serialized.includes('"STALE_VERSION"'),
    "availability KST week, past-date, and CAS errors must be documented",
  );
  assert(
    serialized.includes('"#/components/schemas/ReservationDetail"') &&
      serialized.includes('"#/components/schemas/ManualCleaningRequest"'),
    "reservation and manual cleaning codegen schemas must be reusable",
  );
  const reservationSchema = document.components.schemas.Reservation;
  assert(
    !("guestName" in reservationSchema.properties) &&
      !("guestNameEncrypted" in reservationSchema.properties),
    "reservation list schema must not expose guest PII",
  );
  const reservationList = document.paths["/v1/reservations"].get;
  const reservationListResponse = reservationList.responses["200"] as {
    content: {
      "application/json": {
        schema: { oneOf: Array<{ $ref: string }> };
      };
    };
  };
  const legacyReservationList = document.components.schemas
    .ReservationListEnvelope;
  const reservationRangePage = document.components.schemas
    .ReservationRangePageEnvelope;
  const bookability = document.paths["/v1/reservations/bookability/preview"]
    .post;
  const bookabilityRequest = document.components.schemas
    .ReservationBookabilityPreviewRequest;
  const createRequest = document.components.schemas.ReservationCreateRequest;
  const changeRequest = document.components.schemas.ReservationChangeRequest;
  const bookabilityStandard = document.components.schemas
    .ReservationBookabilityStandardPreviewRequest;
  const bookabilityLongStay = document.components.schemas
    .ReservationBookabilityLongStayPreviewRequest;
  const createStandard = document.components.schemas
    .ReservationStandardCreateRequest;
  const createLongStay = document.components.schemas
    .ReservationLongStayCreateRequest;
  const changeStandard = document.components.schemas
    .ReservationStandardChangeRequest;
  const changeLongStay = document.components.schemas
    .ReservationLongStayChangeRequest;
  const bookabilityExample = bookability.requestBody.content["application/json"]
    .example;
  assert(
    reservationList.parameters.some((parameter: { name?: string }) =>
      parameter.name === "cursor"
    ) &&
      reservationListResponse.content["application/json"].schema.oneOf.map(
          (schema) => schema.$ref,
        ).join(",") ===
        "#/components/schemas/ReservationListEnvelope,#/components/schemas/ReservationRangePageEnvelope" &&
      !("maxItems" in legacyReservationList.properties.reservations) &&
      reservationRangePage.properties.reservations.maxItems === 50 &&
      reservationRangePage.required.join(",") ===
        "reservations,nextCursor,serverTime",
    "reservation list separates unbounded legacy and bounded range envelopes",
  );
  assert(
    bookability.operationId === "previewReservationBookability" &&
      bookability.requestBody.content["application/json"].schema.$ref ===
        "#/components/schemas/ReservationBookabilityPreviewRequest" &&
      bookabilityRequest.oneOf[0].$ref ===
        "#/components/schemas/ReservationBookabilityStandardPreviewRequest" &&
      bookabilityRequest.oneOf[1].$ref ===
        "#/components/schemas/ReservationBookabilityLongStayPreviewRequest" &&
      bookabilityStandard.properties.roomTypeIds.minItems === 0 &&
      bookabilityExample.reservationType === "standard" &&
      Array.isArray(bookabilityExample.roomTypeIds) &&
      bookabilityExample.roomTypeIds.length === 0 &&
      bookabilityExample.excludeReservationId === null &&
      bookabilityLongStay.properties.excludeReservationId.type.includes(
        "null",
      ) &&
      document.components.schemas.ReservationBookabilityCandidate.properties
        .intervalBookable.description.includes("PIN"),
    "reservation bookability publishes separate interval and readiness axes",
  );
  assert(
    createRequest.oneOf.length === 2 && changeRequest.oneOf.length === 2,
    "create and change publish discriminated reservation schedule variants",
  );
  for (
    const [standardSchema, longStaySchema] of [
      [bookabilityStandard, bookabilityLongStay],
      [createStandard, createLongStay],
      [changeStandard, changeLongStay],
    ] as const
  ) {
    assert(
      standardSchema.required.includes("reservationType") &&
        standardSchema.required.includes("checkOutAt") &&
        standardSchema.properties.reservationType.const === "standard" &&
        standardSchema.properties.checkOutAt.type === "string" &&
        longStaySchema.required.includes("reservationType") &&
        longStaySchema.required.includes("checkOutAt") &&
        longStaySchema.properties.reservationType.const === "long_stay" &&
        longStaySchema.properties.checkOutAt.type.includes("null"),
      "standard requires a timestamp while long_stay permits an explicit null end",
    );
  }
  for (
    const code of [
      "STANDARD_RESERVATION_REQUIRES_END",
      "RESERVATION_TYPE_IMMUTABLE",
      "RESERVATION_END_IMMUTABLE",
      "OPEN_ENDED_STAY_REQUIRES_END",
    ]
  ) {
    assert(
      (document.components.schemas.ErrorCode.enum as readonly string[])
        .includes(
          code,
        ),
      `${code} is a stable public error`,
    );
  }
  assert(
    !serialized.includes('"before_state"') &&
      !serialized.includes('"after_state"'),
    "raw audit state must not be part of the public contract",
  );
  for (
    const forbidden of [
      '"rawPin"',
      '"pinCode"',
      '"doorCode"',
      '"providerSecret"',
    ]
  ) {
    assert(
      !serialized.includes(forbidden),
      `${forbidden} must not be a schema field`,
    );
  }
  assert(
    response.headers.get("cache-control") === "public, max-age=300",
    "contract cache",
  );
});

Deno.test("attempt execution OpenAPI binds physical completion, strict CAS and safe audit contract", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  const start = document.paths["/v1/attempts/{attemptId}/start"].post;
  const complete =
    document.paths["/v1/attempts/{attemptId}/complete-field-work"].post;
  assert(
    start.operationId === "startCleaning" &&
      complete.operationId === "completeFieldWork",
    "stable operation IDs",
  );
  assert(
    start["x-required-roles"].join(",") === "maid" &&
      complete["x-required-roles"].join(",") === "maid",
    "maid only",
  );
  assert(
    complete.description.includes("사진은 선행조건이 아니며") &&
      complete.description.includes("room ready") &&
      complete.description.includes("client timestamp"),
    "physical completion not submission or client clock",
  );
  assert(
    document.components.schemas.AttemptExecutionRequest.additionalProperties ===
        false &&
      Object.keys(
          document.components.schemas.AttemptExecutionRequest.properties,
        ).length === 3,
    "strict CAS request",
  );
  assert(
    document.components.schemas.AttemptExecution.additionalProperties ===
        false &&
      !JSON.stringify(document.components.schemas.AttemptExecution.properties)
        .includes("snapshot"),
    "safe response DTO",
  );
  assert(
    document.components.schemas.DeveloperAuditEventType.enum.includes(
      "cleaning.attempt_started",
    ) &&
      document.components.schemas.DeveloperAuditEventType.enum.includes(
        "cleaning.field_completed",
      ),
    "audit events codegen",
  );
  assert(
    "executionVersion" in
      document.components.schemas.DeveloperAuditEvent.properties.summary
        .properties,
    "audit safe version",
  );
});

Deno.test("checkout presence incident OpenAPI keeps typed roles and safe developer audit projection", async () => {
  const doc = await openApiResponse({}).json() as typeof openApiDocument;
  assert(
    doc.paths["/v1/attempts/{attemptId}/checkout-not-completed"].post
      .operationId === "reportCheckoutNotCompleted",
    "maid report route",
  );
  assert(
    doc.paths["/v1/checkout-incidents/{incidentId}"].get.operationId ===
        "getCheckoutIncident" &&
      doc.paths["/v1/checkout-incidents/{incidentId}/decision"].post
          .operationId === "decideCheckoutIncident",
    "incident read and admin decision routes",
  );
  assert(
    doc.components.schemas.CheckoutIncident.required.includes(
      "impactFingerprint",
    ) &&
      doc.components.schemas.CheckoutIncidentDecisionRequest.required.includes(
        "expectedImpactFingerprint",
      ),
    "decision binds the server-computed impact fingerprint",
  );
  type TimestampSchema = {
    type?: string;
    format?: string;
    pattern?: string;
    anyOf?: readonly TimestampSchema[];
  };
  const reassignment = doc.components.schemas.CheckoutIncidentReassignment
    .properties as Record<string, TimestampSchema>;
  const decisionRequest = doc.components.schemas
    .CheckoutIncidentDecisionRequest.properties as Record<
      string,
      TimestampSchema
    >;
  const incident = doc.components.schemas.CheckoutIncident.properties as Record<
    string,
    TimestampSchema
  >;
  const decision = doc.components.schemas.CheckoutIncidentDecision
    .properties as Record<string, TimestampSchema>;
  const timestampSchemas = [
    reassignment.availableFrom,
    reassignment.dueAt,
    decisionRequest.newCheckoutAt.anyOf?.[0],
    incident.reportedAt,
    incident.resolvedAt.anyOf?.[0],
    decision.decidedAt,
    decision.newCheckoutAt,
  ];
  for (const schema of timestampSchemas) {
    assert(
      schema?.type === "string" && schema.format === "date-time" &&
        typeof schema.pattern === "string" &&
        new RegExp(schema.pattern).test(
          "2028-02-29T07:10:00.123456789+09:00",
        ) &&
        !new RegExp(schema.pattern).test("2028-02-29T07:10+09:00") &&
        !new RegExp(schema.pattern).test("2028-02-29T07:10:00+24:00"),
      "checkout timestamps require seconds and a bounded RFC3339 offset",
    );
  }
  assert(
    reassignment.serviceDate.format === "date" &&
      reassignment.serviceDate.pattern === undefined,
    "serviceDate remains a date-only field",
  );
  const auditTypes = doc.components.schemas.DeveloperAuditEventType.enum;
  assert(
    auditTypes.includes("checkout.presence_reported") &&
      auditTypes.includes("checkout.presence_decided"),
    "typed checkout events are operator-visible",
  );
  const summary = doc.components.schemas.DeveloperAuditEvent.properties.summary
    .properties;
  for (
    const field of [
      "incidentId",
      "reservationId",
      "roomId",
      "cleaningTargetId",
      "assignmentId",
      "attemptId",
      "decisionId",
      "checkoutDecision",
      "nextAssignmentId",
      "nextAttemptId",
      "version",
    ]
  ) {
    assert(field in summary, `checkout audit summary exposes ${field}`);
  }
  for (
    const forbidden of [
      "requestHash",
      "idempotencyKey",
      "before_state",
      "after_state",
      "pinDigits",
      "guestName",
      "phone",
      "sessionId",
      "token",
    ]
  ) {
    assert(!(forbidden in summary), `checkout audit omits ${forbidden}`);
  }
});

Deno.test("cleaning field-completed audit projection fits the full strict summary schema", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  const summarySchema =
    document.components.schemas.DeveloperAuditEvent.properties.summary;
  // list_developer_audit_events의 cleaning.field_completed safe projection 전체.
  // jsonb_strip_nulls 때문에 시작 이벤트의 미완료 시각은 null 대신 생략된다.
  const completedSummary = {
    attemptId: "10000000-0000-4000-8000-000000000001",
    cleaningTargetId: "10000000-0000-4000-8000-000000000002",
    assignmentId: "10000000-0000-4000-8000-000000000003",
    maidProfileId: "10000000-0000-4000-8000-000000000004",
    assignmentRevision: 2,
    executionVersion: 3,
    status: "field_completed",
    startedAt: "2026-09-08T01:00:00.000Z",
    fieldCompletedAt: "2026-09-08T02:00:00.000Z",
    endedAt: "2026-09-08T02:00:00.000Z",
  };
  const properties = summarySchema.properties as Record<string, {
    type?: string;
    format?: string;
    minimum?: number;
  }>;
  assert(summarySchema.additionalProperties === false, "strict summary");
  for (const [key, value] of Object.entries(completedSummary)) {
    const field = properties[key];
    assert(field !== undefined, `projected audit field ${key} is documented`);
    assert(
      field.type === "integer"
        ? Number.isInteger(value) &&
          Number(value) >= (field.minimum ?? Number.MIN_SAFE_INTEGER)
        : typeof value === field.type,
      `projected audit field ${key} matches its schema type`,
    );
    if (field.format === "date-time") {
      assert(
        typeof value === "string" && Number.isFinite(Date.parse(value)),
        `projected audit field ${key} is a timestamp`,
      );
    }
    if (field.format === "uuid") {
      assert(
        typeof value === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            .test(value),
        `projected audit field ${key} is a UUID`,
      );
    }
  }
  assert(
    !("required" in summarySchema) && properties.endedAt.type === "string" &&
      properties.endedAt.format === "date-time",
    "endedAt is optional, not nullable: DB strips nulls on start",
  );
  for (const privateField of ["requestHash", "before_state", "after_state"]) {
    assert(!(privateField in properties), `${privateField} remains excluded`);
  }
});

Deno.test("preview OpenAPI documents retired duration policy", async () => {
  const doc = await openApiResponse({}).json() as typeof openApiDocument;
  const operation = doc.paths["/v1/assignments/preview"].post;
  assert(
    operation["x-required-roles"].join(",") === "admin",
    "developer is not business admin",
  );
  assert(
    !("parameters" in operation),
    "pure preview requires no mutation idempotency key",
  );
  assert(
    doc.components.schemas.AssignmentPreviewRequest.additionalProperties ===
      false,
    "strict preview body",
  );
  assert(
    doc.components.schemas.AssignmentPreviewResult.properties.durationPolicy
          .type === "null" &&
      doc.components.schemas.AssignmentPreviewResult.properties
          .durationPolicyStatus.const === "retired" &&
      doc.components.schemas.AssignmentPreviewResult.properties
          .durationPolicyRequired.const === false,
    "preview needs no duration policy",
  );
  const durationRoute = doc.paths["/v1/assignment-preview/duration-policy"];
  assert(
    durationRoute.get.deprecated === true &&
      durationRoute.post.deprecated === true &&
      "410" in durationRoute.post.responses &&
      !("200" in durationRoute.post.responses) &&
      !("parameters" in durationRoute.post),
    "historical GET remains while mutation is retired",
  );
  assert(
    doc.components.schemas.DeveloperAuditEventType.enum.includes(
      "assignment.duration_policy_confirmed",
    ),
    "config audit generated enum",
  );
  assert(
    "policyVersion" in
      doc.components.schemas.DeveloperAuditEvent.properties.summary.properties,
    "safe config audit summary",
  );
});

Deno.test("cleaning template OpenAPI exposes strict checkout-only admin publication", async () => {
  const doc = await openApiResponse({}).json() as typeof openApiDocument;
  const route = doc.paths["/v1/cleaning-templates"];
  assert(
    route.get.operationId === "listCleaningTemplates",
    "stable list operation",
  );
  assert(
    route.post.operationId === "publishCleaningTemplate",
    "stable publish operation",
  );
  assert(
    route.get["x-required-roles"].join() === "admin" &&
      route.post["x-required-roles"].join() === "admin",
    "business admin only",
  );
  assert(
    route.post.parameters[0].name === "Idempotency-Key",
    "publish receipt required",
  );
  const schemas = doc.components.schemas;
  assert(
    schemas.PublishCleaningTemplateRequest.additionalProperties === false &&
      schemas.CleaningTemplateSlot.additionalProperties === false,
    "strict request and slots",
  );
  assert(
    schemas.PublishCleaningTemplateRequest.properties.slots.minItems === 9 &&
      schemas.PublishCleaningTemplateRequest.properties.slots.maxItems === 14 &&
      schemas.CheckoutCleaningTemplateV8Slot.allOf[1].required.includes(
        "maxPhotos",
      ) && schemas.CleaningTemplateSlot.properties.maxPhotos.maximum === 10,
    "v8 A-contract publishes bounded slot and photo counts",
  );
  assert(
    !(schemas.PublishCleaningTemplateRequest.required as readonly string[])
      .includes(
        "durationMinutes",
      ) &&
      schemas.PublishCleaningTemplateRequest.properties.durationMinutes
        .anyOf.some((item: { type?: string }) => item.type === "null") &&
      schemas.PublishedCleaningTemplate.properties.durationMinutes.anyOf.some(
        (item: { type?: string }) => item.type === "null",
      ),
    "template duration is optional/null and never inferred",
  );
  assert(
    schemas.CleaningTemplateCatalog.properties.roomTypes.minItems === 4 &&
      schemas.CleaningTemplateCatalog.properties.roomTypes.maxItems === 4,
    "all room types returned",
  );
  assert(
    schemas.DeveloperAuditEventType.enum.includes(
      "cleaning_template.published",
    ),
    "safe audit event enum",
  );
  const summary = schemas.DeveloperAuditEvent.properties.summary.properties;
  for (
    const field of [
      "roomTypeCode",
      "cleaningKind",
      "version",
      "durationMinutes",
      "slotCount",
    ]
  ) {
    assert(field in summary, `${field} safe summary field`);
  }
  for (
    const field of [
      "slots",
      "label",
      "description",
      "requestHash",
      "before_state",
      "after_state",
    ]
  ) {
    assert(!(field in summary), `${field} stays private from developer audit`);
  }
});

Deno.test("lifecycle OpenAPI separates admin CAS, limited session actions and future media contracts", async () => {
  const doc = await openApiResponse({}).json() as typeof openApiDocument;
  const impact = doc.paths["/v1/attempts/lifecycle-impact"].get;
  const manage = doc.paths["/v1/attempts/{attemptId}/lifecycle"].post;
  const read = doc.paths["/v1/limited/attempts/{attemptId}"].get;
  const complete =
    doc.paths["/v1/limited/attempts/{attemptId}/complete-field-work"].post;
  assert(
    impact["x-required-roles"].join(",") === "admin" &&
      manage["x-required-roles"].join(",") === "admin",
    "business admin lifecycle",
  );
  assert(
    read["x-required-roles"].join(",") === "maid" &&
      complete["x-required-roles"].join(",") === "maid",
    "limited maid only",
  );
  assert(
    read.description.includes("실행 endpoint가 아닙니다") &&
      complete.description.includes("revoked session") &&
      complete.description.includes("TTL 연장"),
    "no fake photo/submit and no replay privilege extension",
  );
  const variants = doc.components.schemas.AttemptLifecycleRequest.oneOf;
  const fiveStatuses =
    "active,deactivation_pending,upload_only,inactive,departed";
  const threeStatuses = "active,deactivation_pending,upload_only";
  assert(
    doc.components.schemas.AttemptLifecycleImpact.properties.profileStatus.enum
          .join(",") === fiveStatuses &&
      doc.components.schemas.AttemptLifecycleResult.properties.profileStatus
          .enum.join(",") === fiveStatuses &&
      doc.components.schemas.DeveloperAuditEvent.properties.summary.properties
          .profileStatus.enum.join(",") === fiveStatuses,
    "admin impact/result and audit preserve disabled expired owners",
  );
  assert(
    doc.components.schemas.LimitedAttempt.properties.profileStatus.enum.join(
          ",",
        ) === threeStatuses &&
      doc.components.schemas.LimitedAttemptLifecycleResult.allOf[1].properties
          ?.profileStatus.enum.join(",") === threeStatuses &&
      complete.responses[200].content["application/json"].schema.$ref ===
        "#/components/schemas/LimitedAttemptLifecycleResult",
    "limited read and complete response stay restricted to three candidate statuses",
  );
  assert(
    variants.length === 4 &&
      variants.every((variant) =>
        variant.additionalProperties === false &&
        variant.required.includes("expectedProfileVersion")
      ),
    "all actions strict CAS",
  );
  assert(
    Object.keys(doc.paths).filter((path) => path.startsWith("/v1/limited/"))
      .length === 2,
    "only read and complete limited endpoints exist",
  );
  const safeKeys = [
    "attemptId",
    "cleaningTargetId",
    "assignmentId",
    "maidProfileId",
    "assignmentRevision",
    "executionVersion",
    "status",
    "startedAt",
    "fieldCompletedAt",
    "endedAt",
    "capabilityKind",
    "expiresAt",
    "profileStatus",
    "profileVersion",
    "nextAttemptId",
  ];
  const summary = doc.components.schemas.DeveloperAuditEvent.properties.summary;
  assert(
    summary.additionalProperties === false &&
      safeKeys.every((key) => key in summary.properties),
    "full lifecycle safe audit summary fits strict schema",
  );
  for (
    const forbidden of [
      "sessionId",
      "accessToken",
      "requestHash",
      "allowedActions",
      "before_state",
      "after_state",
    ]
  ) {
    assert(
      !(forbidden in summary.properties),
      "no credential or raw state in audit projection",
    );
  }
  assert(
    doc.components.schemas.DeveloperAuditEventType.enum.length === 72,
    "actual audit allowlist count",
  );
  assert(
    doc.components.schemas.DeveloperAuditEventType.enum.includes(
      "complaint.rework_materialized",
    ) &&
      doc.components.schemas.DeveloperAuditEventType.enum.includes(
        "compensation.earned",
      ) &&
      doc.components.schemas.DeveloperAuditEventType.enum.includes(
        "photo.collection_item_deleted",
      ),
    "complaint compensation events are operator-visible",
  );
});

Deno.test("room PIN OpenAPI keeps exact sensitive request and response contracts", async () => {
  const doc = await openApiResponse({}).json() as typeof openApiDocument;
  const paths = [
    "/v1/rooms/pins/bootstrap",
    "/v1/rooms/{roomId}/pin/generated/confirm",
    "/v1/rooms/{roomId}/pin-changes/prepare",
    "/v1/rooms/{roomId}/pin-changes/{leaseId}/confirm",
    "/v1/rooms/{roomId}/pin-changes/{leaseId}/rollback",
    "/v1/rooms/{roomId}/pin/reveal",
  ];
  assert(paths.every((path) => path in doc.paths), "six exact PIN paths");
  assert(!("/v1/rooms/{roomId}/pin" in doc.paths), "no reveal alias");

  const prepare = doc.components.schemas.RoomPinChangePrepareRequest;
  const bootstrap = doc.components.schemas.RoomPinBootstrapResult;
  assert(
    prepare.properties.pinDigits.writeOnly === true &&
      prepare.properties.pinDigits.pattern === "^[0-9]{4,8}$" &&
      "accessLeaseId" in prepare.properties,
    "request retains write-only digits and maid lease binding",
  );
  assert(
    bootstrap.properties.initializedRoomIds.maxItems === 25 &&
      bootstrap.properties.remainingCount.maximum === 121 &&
      bootstrap.properties.generatedPins.items.$ref ===
        "#/components/schemas/RoomPinReveal" &&
      !Object.hasOwn(bootstrap.properties, "credential") &&
      !Object.hasOwn(bootstrap.properties, "ciphertext"),
    "bootstrap is bounded and limits plaintext to short-lived reveal items",
  );
  assert(
    !(doc.components.schemas.RoomReasonCode.enum as readonly string[]).includes(
      "PIN_MISMATCH",
    ) &&
      doc.components.schemas.RoomProjection.properties.pinSyncStatus.description
        .includes("예약 등록을 막지 않습니다"),
    "PIN warning is separate from reservation allocation blockers",
  );
  const roomProjection = doc.components.schemas.RoomProjection;
  assert(
    roomProjection.required.includes("evaluatedAt") &&
      roomProjection.properties.evaluatedAt.format === "date-time" &&
      roomProjection.required.includes("reservationPhase") &&
      JSON.stringify(roomProjection.properties.reservationPhase.enum) ===
        JSON.stringify(["none", "upcoming", "current"]) &&
      (doc.components.schemas.RoomReasonCode.enum as readonly string[])
        .includes("RESERVATION_CURRENT"),
    "room projection exposes the authoritative evaluation instant and phase",
  );
  assert(
    roomProjection.required.includes("serverTime") &&
      roomProjection.properties.serverTime.description.includes(
        "evaluatedAt",
      ) &&
      roomProjection.required.includes("reservationLifecycle") &&
      JSON.stringify(
          doc.components.schemas.RoomReservationLifecycle.enum,
        ) ===
        JSON.stringify([
          "NONE",
          "FUTURE",
          "RESERVATION_PRESENT",
          "ARRIVAL_PENDING",
          "OCCUPIED",
        ]) &&
      roomProjection.required.includes("readinessStatus") &&
      roomProjection.required.includes("primaryDisplayStatus") &&
      roomProjection.required.includes("nextReservationId") &&
      roomProjection.required.includes("blockingReasonCodes") &&
      roomProjection.required.includes("readinessReasonCodes"),
    "room projection exposes arrival, readiness, display, and next reservation axes",
  );
  assert(
    (doc.components.schemas.RoomReadinessReasonCode.enum as readonly string[])
      .includes("PIN_MISMATCH") &&
      (doc.components.schemas.RoomReadinessReasonCode.enum as readonly string[])
        .includes("PIN_UNCONFIGURED") &&
      !(doc.components.schemas.RoomBlockingReasonCode.enum as readonly string[])
        .includes("PIN_MISMATCH"),
    "PIN readiness warnings do not become reservation allocation blockers",
  );
  const reveal = doc.components.schemas.RoomPinReveal;
  const change = doc.components.schemas.RoomPinChangeResult;
  assert(
    reveal.properties.credential.readOnly === true &&
      reveal.required.includes("credential") &&
      reveal.properties.clearAfterSeconds.minimum === 1 &&
      reveal.properties.clearAfterSeconds.maximum === 30 &&
      reveal.properties.clearAfterSeconds.description.includes("expiresAt"),
    "response retains read-only credential and remaining TTL",
  );
  assert(
    "accessLeaseId" in change.properties &&
      change.properties.accessLeaseId.description.includes("maid confirm"),
    "maid confirm publishes the reissued current-version access authority",
  );
  for (
    const code of [
      "INVALID_ROOM_PIN",
      "ROOM_PIN_KEY_UNAVAILABLE",
      "ROOM_PIN_CRYPTO_CONFIG_INVALID",
      "ROOM_PIN_DECRYPT_FAILED",
      "ROOM_PIN_COMMAND_FAILED",
      "STALE_PIN_VERSION",
      "ROOM_NUMBER_CHANGED",
      "ROOM_PIN_REISSUE_REQUIRED",
      "ROOM_PIN_MISMATCH_UNRESOLVED",
      "INVALID_PIN_CHANGE_REASON",
      "PIN_CHANGE_IN_PROGRESS_REQUIRED",
      "PIN_CHANGE_IN_PROGRESS",
      "PIN_CHANGE_LEASE_EXPIRED",
      "PIN_CHANGE_LEASE_NOT_RESOLVABLE",
      "PIN_REVEAL_AUTHORIZATION_CHANGED",
      "GENERATED_PIN_REVEAL_NOT_ALLOWED",
      "GENERATED_PIN_CONFIRMATION_NOT_ALLOWED",
      "ROOM_PIN_UNCONFIGURED",
      "PIN_ACCESS_LEASE_REQUIRED",
      "PIN_ENTITLEMENT_REQUIRED",
      "PIN_ACCESS_REQUIRED",
    ] as const
  ) {
    assert(
      doc.components.schemas.ErrorCode.enum.includes(code),
      `error enum includes ${code}`,
    );
  }
  for (
    const eventType of [
      "room.pin_change_prepared",
      "room.pin_change_confirmed",
      "room.pin_mismatch_resolved",
    ] as const
  ) {
    assert(
      doc.components.schemas.DeveloperAuditEventType.enum.includes(eventType),
      `audit enum includes ${eventType}`,
    );
  }
  const summary = doc.components.schemas.DeveloperAuditEvent.properties.summary;
  assert(
    ["roomId", "leaseId", "pinVersion", "status"].every((field) =>
      field in summary.properties
    ),
    "audit summary exposes only useful PIN identity/status",
  );
  for (
    const forbidden of [
      "requestHash",
      "ciphertext",
      "nonce",
      "authTag",
      "aad",
      "pinDigits",
      "credential",
    ]
  ) {
    assert(!(forbidden in summary.properties), `audit omits ${forbidden}`);
  }
});

Deno.test("room PIN Sheet operator OpenAPI exposes only bounded status and fenced full resync", async () => {
  const doc = await openApiResponse({}).json() as typeof openApiDocument;
  const status = doc.paths["/v1/room-pin-sheet-sync/status"].get;
  const command = doc.paths["/v1/room-pin-sheet-sync/full-resync"].post;
  assert(
    status.operationId === "getRoomPinSheetSyncStatus",
    "stable status operation",
  );
  assert(
    command.operationId === "requestRoomPinSheetFullResync",
    "stable command operation",
  );
  assert(
    command.responses["202"].headers["Cache-Control"].schema.const ===
      "no-store",
    "command no-store",
  );
  const fields = Object.keys(
    doc.components.schemas.RoomPinSheetOperatorStatus.properties,
  ).sort();
  assert(
    fields.join(",") === [
      "checkedAt",
      "failed",
      "lastErrorCode",
      "lastSuccessAt",
      "oldestPendingAt",
      "operatorBlocked",
      "pending",
      "version",
    ].sort().join(","),
    "reviewed safe status fields only",
  );
  assert(
    doc.components.schemas.RoomPinSheetFullResyncAccepted.properties.roomCount
      .const === 121,
    "exact room count",
  );
  const auditTypes = doc.components.schemas.DeveloperAuditEventType.enum;
  assert(
    auditTypes.includes("room_pin_sheet.full_resync_requested") &&
      auditTypes.includes("room_pin_sheet.full_resync_succeeded"),
    "full resync audit allowlist",
  );
  const summary =
    doc.components.schemas.DeveloperAuditEvent.properties.summary.properties;
  for (
    const forbidden of [
      "requestHash",
      "targetIdentityDigest",
      "spreadsheetId",
      "tab",
      "credential",
      "token",
      "ciphertext",
      "envelope",
    ]
  ) {
    assert(
      !(forbidden in summary),
      "sensitive full-resync audit fields absent",
    );
  }
});

Deno.test("every Swagger operation has Korean integration guidance", async () => {
  const response = openApiResponse({});
  const document = await response.json() as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };

  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      const summary = operation.summary;
      const description = operation.description;
      assert(
        typeof summary === "string" && /[가-힣]/.test(summary),
        `${method.toUpperCase()} ${path} requires a Korean summary`,
      );
      assert(
        typeof description === "string" && /[가-힣]/.test(description),
        `${method.toUpperCase()} ${path} requires Korean integration guidance`,
      );
    }
  }
});

Deno.test("Swagger UI pins assets, uses SRI and does not persist bearer tokens", async () => {
  const response = swaggerUiResponse({});
  const html = await response.text();
  const csp = response.headers.get("content-security-policy") ?? "";

  assert(
    html.includes("swagger-ui-dist@5.32.11"),
    "Swagger UI version is not pinned",
  );
  assert(html.includes('integrity="sha384-'), "Swagger UI assets require SRI");
  assert(
    html.includes("persistAuthorization: false"),
    "Swagger authorization must not persist",
  );
  assert(
    html.includes("validatorUrl: null"),
    "external schema validation must be disabled",
  );
  assert(
    html.includes("OpenAPI JSON 내려받기"),
    "frontend handoff needs a contract download link",
  );
  assert(
    html.includes("FRONTEND_API_INTEGRATION.md"),
    "frontend integration guide must be linked",
  );
  assert(html.includes("filter: true"), "operation search must be enabled");
  assert(csp.includes("default-src 'none'"), "strict default CSP is required");
  assert(
    csp.includes("script-src 'nonce-"),
    "inline bootstrap requires a nonce",
  );
  assert(!csp.includes("script-src *"), "wildcard scripts are forbidden");
  assert(
    response.headers.get("x-content-type-options") === "nosniff",
    "nosniff required",
  );
});
