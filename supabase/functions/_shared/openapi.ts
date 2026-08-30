const swaggerUiVersion = "5.32.11";
const swaggerCss =
  `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${swaggerUiVersion}/swagger-ui.css`;
const swaggerBundle =
  `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${swaggerUiVersion}/swagger-ui-bundle.js`;
const swaggerCssIntegrity =
  "sha384-9Q2fpS+xeS4ffJy6CagnwoUl+4ldAYhOs9pgZuEKxypVModhmZFzeMlvVsAjf7uT";
const swaggerBundleIntegrity =
  "sha384-vfl/klfTFrIz5urj0HnhcXLAbzPdRHezizfy+XgFB6GqcKkhlk0lS3bIbyB39NLA";

const errorResponse = {
  description: "오류",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorEnvelope" },
    },
  },
};

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", minLength: 8, maxLength: 128 },
  description: "같은 actor·command 재시도에 재사용하는 멱등성 키",
};

export const openApiDocument = {
  openapi: "3.1.1",
  info: {
    title: "CASTLE THE ART Room Management API",
    version: "0.2.0",
    description:
      "Supabase Edge API의 인증·계정·객실 계약. 실제 자격증명과 운영 환경값은 문서에 포함하지 않습니다.",
  },
  "x-adapters": ["fastify", "supabase-edge"],
  servers: [{ url: ".", description: "현재 Edge api Function" }],
  tags: [
    { name: "System" },
    { name: "Auth" },
    { name: "Accounts" },
    { name: "Rooms" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["System"],
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Edge runtime 정상",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status", "service", "timestamp"],
                  properties: {
                    status: { const: "ok" },
                    service: { type: "string" },
                    timestamp: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/auth/login": {
      post: {
        tags: ["Auth"],
        operationId: "login",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/LoginRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "로그인 성공",
            headers: { "Cache-Control": { schema: { const: "no-store" } } },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LoginResponse" },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "423": errorResponse,
          "429": {
            ...errorResponse,
            headers: {
              "Retry-After": { schema: { type: "integer", minimum: 1 } },
            },
          },
        },
      },
    },
    "/v1/auth/me": {
      get: {
        tags: ["Auth"],
        operationId: "getCurrentUser",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "현재 사용자",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["user"],
                  properties: { user: { $ref: "#/components/schemas/Actor" } },
                },
              },
            },
          },
          "401": errorResponse,
          "403": errorResponse,
        },
      },
    },
    "/v1/auth/password": {
      post: {
        tags: ["Auth"],
        operationId: "changePassword",
        security: [{ bearerAuth: [] }],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PasswordChangeRequest" },
            },
          },
        },
        responses: {
          "204": { description: "비밀번호 변경 완료" },
          "400": errorResponse,
          "401": errorResponse,
          "500": errorResponse,
          "502": errorResponse,
        },
      },
    },
    "/v1/accounts": {
      get: {
        tags: ["Accounts"],
        operationId: "listAccounts",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "계정 목록",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["accounts"],
                  properties: {
                    accounts: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Account" },
                    },
                  },
                },
              },
            },
          },
          "401": errorResponse,
          "403": errorResponse,
        },
      },
      post: {
        tags: ["Accounts"],
        operationId: "createAccount",
        security: [{ bearerAuth: [] }],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateAccountRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "계정 생성 완료",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["account", "temporaryPassword"],
                  properties: {
                    account: { $ref: "#/components/schemas/Account" },
                    temporaryPassword: {
                      type: "string",
                      pattern: "^[0-9]{4}$",
                      readOnly: true,
                      description:
                        "권한 있는 생성자에게만 반환하며 로그에 기록하지 않음",
                    },
                  },
                },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "409": errorResponse,
          "502": errorResponse,
        },
      },
    },
    "/v1/accounts/{profileId}/role": accountMutationPath(
      "changeAccountRole",
      { $ref: "#/components/schemas/RoleChangeRequest" },
    ),
    "/v1/accounts/{profileId}/status": accountMutationPath(
      "changeAccountStatus",
      { $ref: "#/components/schemas/StatusChangeRequest" },
    ),
    "/v1/accounts/{profileId}/unlock": accountMutationPath("unlockAccount"),
    "/v1/accounts/{profileId}/password-reset": accountMutationPath(
      "resetAccountPassword",
    ),
    "/v1/rooms": {
      get: {
        tags: ["Rooms"],
        operationId: "listRooms",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "active business admin 전용 객실 projection",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["rooms"],
                  properties: {
                    rooms: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
          "401": errorResponse,
          "403": errorResponse,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    schemas: {
      ErrorEnvelope: {
        type: "object",
        required: ["error", "requestId"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: {
                type: "string",
                enum: [
                  "VALIDATION_ERROR",
                  "REQUEST_TOO_LARGE",
                  "MISSING_ACCESS_TOKEN",
                  "INVALID_ACCESS_TOKEN",
                  "PROFILE_NOT_FOUND",
                  "ACCOUNT_INACTIVE",
                  "SESSION_REVOKED",
                  "INVALID_CREDENTIALS",
                  "ACCOUNT_LOCKED",
                  "LOGIN_RATE_LIMITED",
                  "LOGIN_RATE_LIMIT_UNAVAILABLE",
                  "AUTH_LOOKUP_FAILED",
                  "LOGIN_STATE_UPDATE_FAILED",
                  "INVALID_CURRENT_PASSWORD",
                  "AUTH_PASSWORD_CHANGE_FAILED",
                  "PASSWORD_STATE_INCONSISTENT",
                  "PASSWORD_STATE_UPDATE_FAILED",
                  "PASSWORD_CHANGE_REQUIRED",
                  "ACCOUNT_MANAGER_REQUIRED",
                  "ADMIN_REQUIRED",
                  "ACCOUNT_NOT_FOUND",
                  "DEVELOPER_ACCOUNT_PROTECTED",
                  "LAST_ACTIVE_ADMIN_REQUIRED",
                  "ACCOUNT_MUST_BE_INACTIVE",
                  "DEPARTED_ACCOUNT_IMMUTABLE",
                  "IDEMPOTENCY_KEY_REUSED",
                  "DEACTIVATION_MUST_BE_FINISHED",
                  "PHONE_ALREADY_REGISTERED",
                  "LOGIN_ID_CONFLICT",
                  "PHONE_REQUIRED_FOR_RESET",
                  "AUTH_USER_CREATE_FAILED",
                  "AUTH_USER_UPDATE_FAILED",
                  "AUTH_PASSWORD_RESET_FAILED",
                  "ACCOUNT_AUTH_STATE_INCONSISTENT",
                  "ACCOUNT_COMMAND_FAILED",
                  "ROOM_COMMAND_FAILED",
                  "ORIGIN_NOT_ALLOWED",
                  "ROUTE_NOT_FOUND",
                  "RUNTIME_NOT_CONFIGURED",
                  "INTERNAL_SERVER_ERROR",
                ],
              },
              message: { type: "string" },
            },
          },
          requestId: { type: "string" },
        },
      },
      Actor: {
        type: "object",
        required: [
          "authUserId",
          "profileId",
          "displayName",
          "role",
          "mustChangePassword",
        ],
        properties: {
          authUserId: { type: "string", format: "uuid" },
          profileId: { type: "string", format: "uuid" },
          displayName: { type: "string" },
          role: { enum: ["developer", "admin", "maid"] },
          mustChangePassword: { type: "boolean" },
        },
      },
      LoginRequest: {
        type: "object",
        additionalProperties: false,
        required: ["loginId", "password"],
        properties: {
          loginId: { type: "string", minLength: 1, maxLength: 80 },
          password: { type: "string", format: "password", writeOnly: true },
        },
      },
      LoginResponse: {
        type: "object",
        required: ["accessToken", "refreshToken", "expiresIn", "user"],
        properties: {
          accessToken: { type: "string", readOnly: true },
          refreshToken: { type: "string", readOnly: true },
          expiresIn: { type: "integer", minimum: 1 },
          user: { $ref: "#/components/schemas/Actor" },
        },
      },
      PasswordChangeRequest: {
        type: "object",
        additionalProperties: false,
        required: ["currentPassword", "newPassword"],
        properties: {
          currentPassword: {
            type: "string",
            format: "password",
            writeOnly: true,
          },
          newPassword: { type: "string", format: "password", writeOnly: true },
        },
      },
      CreateAccountRequest: {
        type: "object",
        additionalProperties: false,
        required: ["displayName", "role", "phone"],
        properties: {
          displayName: { type: "string", minLength: 2, maxLength: 40 },
          role: { enum: ["admin", "maid"] },
          phone: {
            type: "string",
            writeOnly: true,
            description:
              "요청 처리 중에만 사용하며 문서·로그·감사 원장에 저장하지 않음",
          },
        },
      },
      RoleChangeRequest: {
        type: "object",
        additionalProperties: false,
        required: ["role"],
        properties: { role: { enum: ["admin", "maid"] } },
      },
      StatusChangeRequest: {
        type: "object",
        additionalProperties: false,
        required: ["status", "reasonCode"],
        properties: {
          status: { enum: ["active", "inactive", "departed"] },
          reasonCode: { type: "string", pattern: "^[A-Z0-9_]{2,80}$" },
        },
      },
      Account: {
        type: "object",
        required: [
          "id",
          "displayName",
          "loginId",
          "role",
          "status",
          "phoneLastFour",
          "mustChangePassword",
          "failedLoginCount",
          "lockedUntil",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          displayName: { type: "string" },
          loginId: { type: "string" },
          role: { enum: ["developer", "admin", "maid"] },
          status: {
            enum: [
              "active",
              "deactivation_pending",
              "upload_only",
              "inactive",
              "departed",
            ],
          },
          phoneLastFour: { type: ["string", "null"], pattern: "^[0-9]{4}$" },
          mustChangePassword: { type: "boolean" },
          failedLoginCount: { type: "integer", minimum: 0 },
          lockedUntil: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
} as const;

function accountMutationPath(
  operationId: string,
  requestSchema?: Record<string, unknown>,
): Record<string, unknown> {
  const post = operationId === "unlockAccount" ||
    operationId === "resetAccountPassword";
  return {
    [post ? "post" : "patch"]: {
      tags: ["Accounts"],
      operationId,
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "profileId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        idempotencyHeader,
      ],
      ...(requestSchema
        ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: requestSchema } },
          },
        }
        : {}),
      responses: {
        "200": {
          description: "계정 변경 완료",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["account"],
                properties: {
                  account: { $ref: "#/components/schemas/Account" },
                },
              },
            },
          },
        },
        "400": errorResponse,
        "401": errorResponse,
        "403": errorResponse,
        "404": errorResponse,
        "409": errorResponse,
        "502": errorResponse,
      },
    },
  };
}

export function openApiResponse(corsHeaders: Record<string, string>): Response {
  return Response.json(openApiDocument, {
    status: 200,
    headers: {
      "cache-control": "public, max-age=300",
      ...corsHeaders,
    },
  });
}

export function swaggerUiResponse(
  corsHeaders: Record<string, string>,
): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Room Management API</title>
  <link rel="stylesheet" href="${swaggerCss}" integrity="${swaggerCssIntegrity}" crossorigin="anonymous" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${swaggerBundle}" integrity="${swaggerBundleIntegrity}" crossorigin="anonymous"></script>
  <script nonce="${nonce}">
    window.ui = SwaggerUIBundle({
      url: "./openapi.json",
      dom_id: "#swagger-ui",
      deepLinking: true,
      displayRequestDuration: true,
      persistAuthorization: false,
      validatorUrl: null,
      tryItOutEnabled: true
    });
  </script>
</body>
</html>`;
  const cdn = "https://cdn.jsdelivr.net";
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' ${cdn}`,
        `style-src 'unsafe-inline' ${cdn}`,
        "connect-src 'self'",
        "img-src data:",
        "font-src data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...corsHeaders,
    },
  });
}
