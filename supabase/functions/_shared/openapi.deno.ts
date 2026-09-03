import type { openApiDocument } from "./openapi.ts";
import { openApiResponse, swaggerUiResponse } from "./openapi.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("OpenAPI publishes bearer and idempotency contracts", async () => {
  const response = openApiResponse({});
  const document = await response.json() as typeof openApiDocument;
  const serialized = JSON.stringify(document);

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
    serialized.includes('"assignment.draft_saved"'),
    "assignment draft audit must be part of the developer allowlist",
  );
  const auditEventTypeParameter = document.paths["/v1/developer/audit-events"]
    .get.parameters.find((parameter) => parameter.name === "eventType");
  assert(
    auditEventTypeParameter?.schema.maxItems === 28,
    "developer audit filter limit must match the 28-event allowlist",
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
      serialized.includes('"#/components/schemas/AssignmentDraftRequest"'),
    "assignment codegen schemas must be reusable",
  );
  assert(
    serialized.includes('"ASSIGNMENT_VERSION_CONFLICT"') &&
      serialized.includes('"ASSIGNMENT_SEQUENCE_CONFLICT"'),
    "assignment CAS and ordering errors must be documented",
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
