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
