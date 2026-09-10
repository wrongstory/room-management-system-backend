import type { openApiDocument } from "./openapi.ts";
import { openApiResponse, swaggerUiResponse } from "./openapi.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
Deno.test("photo OpenAPI four operations retain raw body boundary, role separation and opaque projections", async () => {
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
    Object.keys(document.paths).length === 85 &&
      Object.values(document.paths).flatMap((item) =>
          Object.keys(item).filter((method) =>
            ["get", "post", "put", "patch", "delete"].includes(method)
          )
        ).length === 92,
    "candidate contract 85/92",
  );
});

Deno.test("payroll OpenAPI separates confirmed, locked and late earnings without client amounts", async () => {
  const document = await openApiResponse({}).json() as typeof openApiDocument;
  const list = document.paths["/v1/payroll"].get;
  const entries = document.paths["/v1/payroll/entries"].get;
  const start = document.paths["/v1/payroll/start"].post;
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
    assert(complaintPaths.length === 8, "eight exact complaint paths");
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
      doc.components.schemas.ComplaintCategory.enum.length === 8,
      "exact category allowlist",
    );
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
      !Object.keys(doc.paths).some((path) => path.includes("reopen")),
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
      "leaseId",
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
    "developer audit filter limit must match the 36-event allowlist",
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
    serialized.includes('"ASSIGNMENT_VERSION_CONFLICT"') &&
      serialized.includes('"ASSIGNMENT_SEQUENCE_CONFLICT"') &&
      serialized.includes('"ASSIGNMENT_IMPACT_CHANGED"') &&
      serialized.includes('"ASSIGNMENT_AVAILABILITY_STALE"'),
    "assignment draft and commit concurrency errors must be documented",
  );
  assert(
    serialized.includes('"OUTSIDE_AVAILABILITY_WINDOW"') &&
      serialized.includes('"STALE_VERSION"'),
    "availability KST and CAS errors must be documented",
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
  assert(
    !serialized.includes('"before_state"') &&
      !serialized.includes('"after_state"'),
    "raw audit state must not be part of the public contract",
  );
  for (
    const forbidden of [
      '"pin"',
      '"rawPin"',
      '"pinCode"',
      '"doorCode"',
      '"credential"',
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

Deno.test("preview OpenAPI documents pure admin preview and separate versioned config", async () => {
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
    doc.paths["/v1/assignment-preview/duration-policy"].post.parameters[0]
      .name === "Idempotency-Key",
    "config mutation has own receipt",
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
    doc.components.schemas.DeveloperAuditEventType.enum.length === 49,
    "actual audit allowlist count",
  );
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
