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
  description:
    "안정적인 `error.code`로 분기합니다. 화면 문구는 `message`를 그대로 계약으로 고정하지 말고 프론트에서 code 기준으로 관리합니다.",
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
  schema: {
    type: "string",
    minLength: 8,
    maxLength: 128,
    pattern: "^[A-Za-z0-9._:-]{8,128}$",
  },
  description:
    "사용자 동작 한 번마다 생성합니다. 네트워크 오류로 **같은 요청 본문을 재시도할 때만 같은 값**을 재사용하고, 다른 본문에는 새 값을 사용합니다. `crypto.randomUUID()`를 권장합니다.",
};

const noStoreHeader = {
  description: "인증·개인정보 응답은 브라우저나 중간 캐시에 저장하지 않습니다.",
  schema: { const: "no-store" },
};

const accountManagerRoles = ["developer", "admin"] as const;

export const openApiDocument = {
  openapi: "3.1.1",
  info: {
    title: "CASTLE THE ART Room Management API",
    version: "0.2.0",
    description: [
      "Supabase Edge API의 인증·계정·객실 계약입니다. 이 문서는 프론트 코드 생성의 정본이며 실제 자격증명과 운영 환경값은 포함하지 않습니다.",
      "",
      "## 프론트 연동 순서",
      "1. `POST /v1/auth/login`으로 세션 토큰과 `user.mustChangePassword`를 받습니다.",
      "2. 보호 API에는 `Authorization: Bearer {accessToken}`을 보냅니다.",
      "3. `mustChangePassword=true`이면 계정·객실 화면으로 보내지 말고 `POST /v1/auth/password`만 허용합니다.",
      "4. 변경 API에는 사용자 동작별 `Idempotency-Key`를 보내며, 같은 본문 재시도에만 같은 키를 재사용합니다.",
      "5. 실패 처리는 HTTP 상태와 함께 안정적인 `error.code`를 기준으로 분기합니다.",
      "",
      "## 역할 경계",
      "- `developer`: 계정 관리만 가능하며 객실 업무는 금지됩니다.",
      "- `admin`: 계정 관리와 객실 업무가 가능합니다.",
      "- `maid`: 현재 문서 범위의 계정·전체 객실 API는 사용할 수 없습니다.",
      "",
      "프론트 구현 절차와 타입 생성 명령은 저장소의 `docs/FRONTEND_API_INTEGRATION.md`를 참고하세요.",
    ].join("\n"),
  },
  externalDocs: {
    description: "프론트엔드 Codex용 연동 가이드",
    url:
      "https://github.com/wrongstory/room-management-system-backend/blob/main/docs/FRONTEND_API_INTEGRATION.md",
  },
  "x-adapters": ["fastify", "supabase-edge"],
  servers: [{ url: ".", description: "현재 Edge api Function" }],
  tags: [
    {
      name: "System",
      description: "인증 없이 확인하는 Edge runtime·API 문서 상태입니다.",
    },
    {
      name: "Auth",
      description:
        "로그인, 현재 사용자 확인, 최초 비밀번호 변경입니다. 토큰과 비밀번호를 로그·Issue·캡처에 남기지 않습니다.",
    },
    {
      name: "Accounts",
      description:
        "비밀번호 변경을 완료한 active developer 또는 active admin의 계정 관리 API입니다. developer 계정 자체는 변경할 수 없습니다.",
    },
    {
      name: "Developer",
      description:
        "singleton active developer 전용 운영 상태 API입니다. Supabase 내부 schema 원문, secret 값, 고객 개인정보를 반환하지 않습니다.",
    },
    {
      name: "Rooms",
      description:
        "비밀번호 변경을 완료한 active business admin 전용 객실 운영 projection입니다. developer는 접근할 수 없습니다.",
    },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["System"],
        operationId: "getHealth",
        summary: "Edge API 상태 확인",
        description:
          "인증 없이 runtime 응답 여부를 확인합니다. DB·Auth의 전체 정상 여부를 보장하는 readiness 검사는 아닙니다.",
        responses: {
          "200": {
            description: "Edge runtime 정상",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status", "service", "timestamp"],
                  properties: {
                    status: {
                      const: "ok",
                      description:
                        "runtime이 요청에 응답할 수 있음을 뜻합니다.",
                    },
                    service: {
                      type: "string",
                      description: "응답한 서비스 식별자",
                    },
                    timestamp: {
                      type: "string",
                      format: "date-time",
                      description: "서버가 응답을 만든 RFC 3339 시각",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["System"],
        operationId: "getOpenApiDocument",
        summary: "OpenAPI 3.1 JSON 계약 내려받기",
        description:
          "프론트 타입 생성과 Codex 연동에 사용하는 기계 판독 정본입니다. 배포 환경별 API base URL 뒤에 이 path를 붙여 내려받습니다.",
        responses: {
          "200": {
            description: "현재 배포된 API 계약",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
    "/docs": {
      get: {
        tags: ["System"],
        operationId: "getSwaggerUi",
        summary: "Swagger UI 열기",
        description:
          "한글 설명, Bearer Authorize, Idempotency-Key 입력, Try it out을 제공하는 개발자 문서 화면입니다. 입력한 bearer token은 브라우저 저장소에 유지하지 않습니다.",
        responses: {
          "200": {
            description: "Swagger UI HTML",
            content: {
              "text/html": { schema: { type: "string" } },
            },
          },
        },
      },
    },
    "/v1/auth/login": {
      post: {
        tags: ["Auth"],
        operationId: "login",
        summary: "로그인하고 세션 토큰 받기",
        description:
          "로그인 ID는 NFKC·trim·소문자로 정규화됩니다. 알 수 없는 ID와 잘못된 비밀번호는 모두 `INVALID_CREDENTIALS`입니다. Supabase gateway가 확인한 client별 30회/분, ID별 10회/분, 프로젝트 emergency 600회/분 durable 제한을 순서대로 적용하고 계정별 5회 실패/15분 잠금도 유지합니다. 응답의 `mustChangePassword`가 true이면 비밀번호 변경 화면으로 이동하세요.",
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
            headers: { "Cache-Control": noStoreHeader },
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
        summary: "현재 로그인 사용자와 최신 역할 확인",
        description:
          "Bearer token의 Auth 사용자, 최신 active profile, 현재 active session을 모두 다시 검증합니다. 앱 시작·새로고침·세션 복구 후 이 응답을 화면 권한의 기준으로 사용하세요.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["developer", "admin", "maid"],
        responses: {
          "200": {
            description: "현재 사용자",
            headers: { "Cache-Control": noStoreHeader },
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
        summary: "현재 또는 임시 비밀번호를 개인 비밀번호로 변경",
        description:
          "모든 active 역할이 본인 비밀번호를 변경할 때 사용합니다. 새 비밀번호는 숫자 6~72자리 또는 10~72자의 영문 대·소문자·숫자·특수문자 조합입니다. 성공하면 다른 세션이 폐기될 수 있으므로 프론트는 현재 사용자 정보를 다시 조회하세요.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["developer", "admin", "maid"],
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
          "204": {
            description: "비밀번호 변경 완료. 응답 본문은 없습니다.",
            headers: { "Cache-Control": noStoreHeader },
          },
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
        summary: "개발자·관리자·메이드 계정 목록 조회",
        description:
          "비밀번호 변경을 완료한 active developer 또는 active admin만 호출할 수 있습니다. 전체 휴대전화 번호와 내부 Auth 이메일은 반환하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": accountManagerRoles,
        responses: {
          "200": {
            description: "계정 목록",
            headers: { "Cache-Control": noStoreHeader },
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
        summary: "business admin 또는 maid 계정 생성",
        description:
          "role은 `admin | maid`만 허용됩니다. 전체 휴대전화 번호는 중복 검사용 HMAC과 마지막 4자리로만 처리되며 응답에 원문을 돌려주지 않습니다. 생성 응답의 4자리 임시 비밀번호는 권한 있는 생성자에게 한 번 전달하고 로그나 영속 브라우저 저장소에 보관하지 마세요.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": accountManagerRoles,
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
            headers: { "Cache-Control": noStoreHeader },
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
    "/v1/developer/overview": {
      get: {
        tags: ["Developer"],
        operationId: "getDeveloperOverview",
        summary: "개발자 운영 대시보드 요약 조회",
        description:
          "active developer 전용입니다. 계정·객실 집계와 runtime·DB·scheduler의 app-owned projection을 한 번에 반환합니다. 전체 전화번호, 고객명, secret 값, 내부 catalog row는 포함하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["developer"],
        responses: {
          "200": developerResponse("운영 대시보드 요약", "overview", {
            $ref: "#/components/schemas/DeveloperOverview",
          }),
          "401": errorResponse,
          "403": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/developer/runtime-status": {
      get: {
        tags: ["Developer"],
        operationId: "getDeveloperRuntimeStatus",
        summary: "Edge runtime과 설정 여부 조회",
        description:
          "환경 badge, project ref, adapter와 allowlist 설정의 configured 여부만 반환합니다. 환경변수를 열거하거나 secret 값·길이·해시를 노출하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["developer"],
        responses: {
          "200": developerResponse("Edge runtime 상태", "runtime", {
            $ref: "#/components/schemas/DeveloperRuntimeStatus",
          }),
          "401": errorResponse,
          "403": errorResponse,
        },
      },
    },
    "/v1/developer/database-status": {
      get: {
        tags: ["Developer"],
        operationId: "getDeveloperDatabaseStatus",
        summary: "DB migration·RLS·핵심 RPC 상태 조회",
        description:
          "source가 기대하는 migration head와 실제 DB head를 비교하고 public base table RLS 누락과 허용된 핵심 RPC 존재 여부만 반환합니다. auth·vault·migration 원본 row는 반환하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["developer"],
        responses: {
          "200": developerResponse("DB 운영 상태", "database", {
            $ref: "#/components/schemas/DeveloperDatabaseStatus",
          }),
          "401": errorResponse,
          "403": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/developer/scheduler-status": {
      get: {
        tags: ["Developer"],
        operationId: "getDeveloperSchedulerStatus",
        summary: "예약 scheduler·Cron 상태 조회",
        description:
          "Cron 활성 여부, exact-admin actor 유효성, 최근 실행 메타데이터와 app-owned heartbeat를 안전한 projection으로 반환합니다. Cron SQL, Authorization header, Vault 값, HTTP 응답 본문은 노출하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["developer"],
        responses: {
          "200": developerResponse("scheduler 운영 상태", "scheduler", {
            $ref: "#/components/schemas/DeveloperSchedulerStatus",
          }),
          "401": errorResponse,
          "403": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/developer/audit-events": {
      get: {
        tags: ["Developer"],
        operationId: "listDeveloperAuditEvents",
        summary: "허용된 운영 감사 이벤트 조회",
        description:
          "계정·운영 event allowlist만 최대 31일, 페이지당 100건으로 조회합니다. cursor는 응답 값을 그대로 사용하고 raw before_state/after_state 대신 이벤트별 허용 필드 summary만 표시합니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["developer"],
        parameters: [
          {
            name: "eventType",
            in: "query",
            schema: {
              type: "array",
              maxItems: 8,
              items: { $ref: "#/components/schemas/DeveloperAuditEventType" },
            },
            style: "form",
            explode: true,
            description: "반복 query로 전달하는 이벤트 allowlist 필터",
          },
          {
            name: "actorProfileId",
            in: "query",
            schema: { type: "string", format: "uuid" },
            description: "특정 행위자 profile ID 필터",
          },
          {
            name: "from",
            in: "query",
            schema: { type: "string", format: "date-time" },
            description: "조회 시작. 생략 시 최근 7일",
          },
          {
            name: "to",
            in: "query",
            schema: { type: "string", format: "date-time" },
            description: "조회 종료. from과 최대 31일 간격",
          },
          {
            name: "cursor",
            in: "query",
            schema: { type: "string", maxLength: 512 },
            description:
              "직전 응답의 nextCursor. 내부 구조를 수정하지 않습니다.",
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            description: "페이지당 최대 이벤트 수",
          },
        ],
        responses: {
          "200": {
            description: "민감정보를 제거한 감사 이벤트 페이지",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeveloperAuditPage" },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/developer/diagnostics": {
      post: {
        tags: ["Developer"],
        operationId: "runDeveloperDiagnostics",
        summary: "허용된 운영 진단 일괄 실행",
        description:
          "요청 본문·임의 URL·SQL·RPC 이름을 받지 않고 Auth/session 검증 후 runtime·DB·scheduler read-only 검사만 수행합니다. 분당 10회 durable 제한과 개별 timeout을 적용합니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["developer"],
        responses: {
          "200": developerResponse("운영 진단 결과", "diagnostics", {
            $ref: "#/components/schemas/DeveloperDiagnostics",
          }),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "429": {
            ...errorResponse,
            headers: {
              "Retry-After": { schema: { type: "integer", minimum: 1 } },
            },
          },
          "500": errorResponse,
        },
      },
    },
    "/v1/rooms": {
      get: {
        tags: ["Rooms"],
        operationId: "listRooms",
        summary: "전체 객실 운영 projection 조회",
        description:
          "active business admin 전용입니다. `occupied`, `cleaningRequired`, `allocationBlocked`, `allocationReady`는 서로 독립된 축이며 프론트에서 하나의 status enum으로 합치지 않습니다. `allocationReady=false`의 근거는 `reasonCodes`로 표시하세요.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        responses: {
          "200": {
            description: "active business admin 전용 객실 projection",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["rooms"],
                  properties: {
                    rooms: {
                      type: "array",
                      items: { $ref: "#/components/schemas/RoomProjection" },
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
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "로그인 응답의 accessToken만 입력합니다. `Bearer ` 접두사는 Swagger UI가 자동으로 붙이며 토큰을 저장하거나 공유하지 않습니다.",
      },
    },
    schemas: {
      AppRole: {
        type: "string",
        enum: ["developer", "admin", "maid"],
        description:
          "developer는 계정 관리 전용, admin은 업무 관리자, maid는 본인 현장 업무 역할입니다.",
      },
      ManagedRole: {
        type: "string",
        enum: ["admin", "maid"],
        description:
          "일반 계정 API에서 생성·변경할 수 있는 역할입니다. developer는 허용되지 않습니다.",
      },
      AccountStatus: {
        type: "string",
        enum: [
          "active",
          "deactivation_pending",
          "upload_only",
          "inactive",
          "departed",
        ],
        description:
          "프론트가 직접 설정할 수 있는 값은 active, inactive, departed입니다. deactivation_pending과 upload_only는 서버가 제한 capability를 나타낼 때만 반환합니다.",
      },
      ErrorCode: {
        type: "string",
        description:
          "프론트 분기용 안정적 코드입니다. 사용자 표시 문구는 message가 아니라 이 코드 기준으로 관리합니다.",
        enum: [
          "VALIDATION_ERROR",
          "INVALID_PHONE",
          "REQUEST_TOO_LARGE",
          "MISSING_ACCESS_TOKEN",
          "INVALID_ACCESS_TOKEN",
          "PROFILE_NOT_FOUND",
          "ACCOUNT_INACTIVE",
          "SESSION_REVOKED",
          "INVALID_CREDENTIALS",
          "ACCOUNT_LOCKED",
          "LOGIN_RATE_LIMITED",
          "LOGIN_CLIENT_ID_UNAVAILABLE",
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
          "DEVELOPER_REQUIRED",
          "DEVELOPER_PROJECTION_FAILED",
          "DATABASE_UNREACHABLE",
          "MIGRATION_DRIFT",
          "RLS_CONFIGURATION_INVALID",
          "SCHEDULER_NOT_CONFIGURED",
          "SCHEDULER_ACTOR_INVALID",
          "SCHEDULER_DEGRADED",
          "SCHEDULER_HEARTBEAT_FAILED",
          "DIAGNOSTIC_TIMEOUT",
          "DIAGNOSTICS_RATE_LIMITED",
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
      ErrorEnvelope: {
        type: "object",
        required: ["error", "requestId"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: {
                $ref: "#/components/schemas/ErrorCode",
              },
              message: {
                type: "string",
                description:
                  "현재 요청을 위한 한국어 안내입니다. 장기적인 프론트 분기는 error.code를 사용합니다.",
              },
            },
          },
          requestId: {
            type: "string",
            description:
              "운영 문의·로그 추적용 요청 ID입니다. 인증정보 대신 이 값을 전달합니다.",
          },
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
          authUserId: {
            type: "string",
            format: "uuid",
            description:
              "Supabase Auth 사용자 ID입니다. 화면 엔티티 연결에는 profileId를 우선 사용합니다.",
          },
          profileId: {
            type: "string",
            format: "uuid",
            description: "앱 전 영역에서 사용하는 불변 사용자 ID",
          },
          displayName: {
            type: "string",
            description: "현재 화면 표시 이름",
          },
          role: { $ref: "#/components/schemas/AppRole" },
          mustChangePassword: {
            type: "boolean",
            description:
              "true이면 비밀번호 변경과 현재 사용자 확인 외 업무 화면을 차단합니다.",
          },
        },
      },
      LoginRequest: {
        type: "object",
        additionalProperties: false,
        required: ["loginId", "password"],
        properties: {
          loginId: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description:
              "사용자에게 발급된 이름형 로그인 ID. 서버가 NFKC·trim·소문자로 정규화합니다.",
          },
          password: {
            type: "string",
            format: "password",
            writeOnly: true,
            description:
              "최초/초기화 시 휴대전화 뒤 4자리 또는 허용된 개인 비밀번호",
          },
        },
      },
      LoginResponse: {
        type: "object",
        required: ["accessToken", "refreshToken", "expiresIn", "user"],
        properties: {
          accessToken: {
            type: "string",
            readOnly: true,
            description:
              "보호 API의 Bearer token. 로그·Issue·캡처에 남기지 않습니다.",
          },
          refreshToken: {
            type: "string",
            readOnly: true,
            description:
              "Supabase Auth 표준 세션 갱신용 토큰. 서버 API 요청 본문에 보내지 않습니다.",
          },
          expiresIn: {
            type: "integer",
            minimum: 1,
            description: "access token 만료까지 남은 초",
          },
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
            description: "현재 4자리 임시 비밀번호 또는 현재 개인 비밀번호",
          },
          newPassword: {
            type: "string",
            format: "password",
            writeOnly: true,
            description:
              "숫자 6~72자리 또는 10~72자의 영문 대·소문자·숫자·특수문자 조합",
          },
        },
      },
      CreateAccountRequest: {
        type: "object",
        additionalProperties: false,
        required: ["displayName", "role", "phone"],
        properties: {
          displayName: {
            type: "string",
            minLength: 2,
            maxLength: 40,
            description:
              "화면 표시 이름. 동명이인은 서버가 안정적인 login ID suffix로 구분합니다.",
          },
          role: { $ref: "#/components/schemas/ManagedRole" },
          phone: {
            type: "string",
            writeOnly: true,
            minLength: 10,
            maxLength: 30,
            description:
              "010으로 시작하는 국내 휴대전화 번호. 하이픈은 허용하지만 요청 처리 중에만 사용하며 원문을 응답·로그·감사 원장에 저장하지 않습니다.",
          },
        },
      },
      RoleChangeRequest: {
        type: "object",
        additionalProperties: false,
        required: ["role"],
        properties: { role: { $ref: "#/components/schemas/ManagedRole" } },
      },
      StatusChangeRequest: {
        type: "object",
        additionalProperties: false,
        required: ["status", "reasonCode"],
        properties: {
          status: {
            type: "string",
            enum: ["active", "inactive", "departed"],
            description:
              "퇴사는 active에서 바로 전이할 수 없습니다. 먼저 inactive로 변경한 뒤 departed로 처리합니다.",
          },
          reasonCode: {
            type: "string",
            pattern: "^[A-Z0-9_]{2,80}$",
            description:
              "감사 이력에 남는 안정적인 영문 대문자 사유 코드. 자유입력 문구를 보내지 않습니다.",
          },
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
          id: {
            type: "string",
            format: "uuid",
            description: "profile ID. 계정 변경 path의 profileId로 사용합니다.",
          },
          displayName: { type: "string", description: "현재 표시 이름" },
          loginId: {
            type: "string",
            description:
              "현재 로그인 ID. 별도 ID 변경 기능은 제공하지 않습니다.",
          },
          role: { $ref: "#/components/schemas/AppRole" },
          status: { $ref: "#/components/schemas/AccountStatus" },
          phoneLastFour: {
            type: ["string", "null"],
            pattern: "^[0-9]{4}$",
            description:
              "비밀번호 초기화 가능 여부 확인용 마지막 4자리. 전체 번호는 반환하지 않습니다.",
          },
          mustChangePassword: {
            type: "boolean",
            description: "다음 로그인에서 개인 비밀번호 변경이 필요한지 여부",
          },
          failedLoginCount: {
            type: "integer",
            minimum: 0,
            description: "현재 연속 로그인 실패 횟수",
          },
          lockedUntil: {
            type: ["string", "null"],
            format: "date-time",
            description: "로그인 잠금 종료 시각. 잠금이 없으면 null",
          },
          createdAt: {
            type: "string",
            format: "date-time",
            description: "계정 생성 시각",
          },
          updatedAt: {
            type: "string",
            format: "date-time",
            description: "현재 계정 projection 갱신 시각",
          },
        },
      },
      DeveloperAuditEventType: {
        type: "string",
        enum: [
          "account.bootstrap_developer_created",
          "account.bootstrap_admin_created",
          "account.created",
          "account.role_changed",
          "account.status_changed",
          "account.unlocked",
          "account.password_reset_requested",
          "account.password_changed",
        ],
        description:
          "운영 콘솔에 노출할 수 있도록 서버에서 고정한 감사 이벤트 allowlist",
      },
      DeveloperRuntimeStatus: {
        type: "object",
        additionalProperties: false,
        required: [
          "adapter",
          "environment",
          "projectRef",
          "runtime",
          "source",
          "configuration",
          "checkedAt",
        ],
        properties: {
          adapter: { const: "supabase-edge" },
          environment: {
            type: "string",
            enum: ["production", "recovery", "local", "unknown"],
            description:
              "색상만으로 구분하지 말고 이 텍스트와 projectRef를 함께 표시합니다.",
          },
          projectRef: {
            type: "string",
            description:
              "현재 연결 대상 확인용 공개 project ref 또는 local/unknown",
          },
          runtime: {
            type: "object",
            additionalProperties: false,
            required: ["name", "version"],
            properties: {
              name: { const: "deno" },
              version: { type: "string" },
            },
          },
          source: {
            type: "object",
            additionalProperties: false,
            required: [
              "apiVersion",
              "expectedMigration",
              "fastifyRollbackBaseline",
            ],
            properties: {
              apiVersion: { type: "string" },
              expectedMigration: { type: "string", pattern: "^[0-9]{14}$" },
              fastifyRollbackBaseline: {
                type: "string",
                enum: ["available", "retired"],
              },
            },
          },
          configuration: {
            type: "object",
            description:
              "소스 allowlist에 포함된 이름별 configured boolean. 값·길이·해시는 절대 포함하지 않습니다.",
            additionalProperties: false,
            required: [
              "ACCOUNT_PHONE_PEPPER",
              "RESERVATION_PII_KEY_BASE64",
              "RESERVATION_PII_KEY_VERSION",
              "RESERVATION_PII_KEYRING_JSON",
              "RESERVATION_GUEST_NAME_PEPPER",
              "RESERVATION_SCHEDULER_ACTOR_PROFILE_ID",
              "SCHEDULER_INVOKE_SECRET",
              "CORS_ORIGINS",
            ],
            properties: Object.fromEntries(
              [
                "ACCOUNT_PHONE_PEPPER",
                "RESERVATION_PII_KEY_BASE64",
                "RESERVATION_PII_KEY_VERSION",
                "RESERVATION_PII_KEYRING_JSON",
                "RESERVATION_GUEST_NAME_PEPPER",
                "RESERVATION_SCHEDULER_ACTOR_PROFILE_ID",
                "SCHEDULER_INVOKE_SECRET",
                "CORS_ORIGINS",
              ].map((name) => [
                name,
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["configured"],
                  properties: { configured: { type: "boolean" } },
                },
              ]),
            ),
          },
          checkedAt: { type: "string", format: "date-time" },
        },
      },
      DeveloperDatabaseStatus: {
        type: "object",
        additionalProperties: false,
        required: [
          "databaseReachable",
          "currentMigration",
          "expectedMigration",
          "migrationDrift",
          "rlsMissingCount",
          "rlsValid",
          "criticalRpcs",
          "rowCounts",
          "environment",
          "projectRef",
          "checkedAt",
        ],
        properties: {
          databaseReachable: { type: "boolean" },
          currentMigration: {
            type: ["string", "null"],
            pattern: "^[0-9]{14}$",
          },
          expectedMigration: { type: "string", pattern: "^[0-9]{14}$" },
          migrationDrift: {
            type: "string",
            enum: ["ahead", "equal", "behind", "unknown"],
          },
          rlsMissingCount: { type: "integer", minimum: 0 },
          rlsValid: { type: "boolean" },
          criticalRpcs: {
            type: "object",
            additionalProperties: { type: "boolean" },
          },
          rowCounts: {
            type: "object",
            additionalProperties: false,
            required: ["profiles", "rooms", "auditEventsEstimate"],
            properties: {
              profiles: { type: "integer", minimum: 0 },
              rooms: { type: "integer", minimum: 0 },
              auditEventsEstimate: {
                type: "integer",
                minimum: 0,
                description:
                  "append-only 감사 원장의 catalog 추정치. dashboard를 위해 전체 count scan을 하지 않습니다.",
              },
            },
          },
          environment: {
            type: "string",
            enum: ["production", "recovery", "local", "unknown"],
          },
          projectRef: { type: "string" },
          checkedAt: { type: "string", format: "date-time" },
        },
      },
      DeveloperSchedulerStatus: {
        type: "object",
        additionalProperties: false,
        required: [
          "status",
          "cronCatalogAvailable",
          "cronConfigured",
          "cronActive",
          "cadence",
          "schedulerActorConfigured",
          "schedulerActorValid",
          "invokeSecretConfigured",
          "lastCronRun",
          "lastHeartbeat",
          "checkedAt",
        ],
        properties: {
          status: {
            type: "string",
            enum: [
              "not_configured",
              "actor_invalid",
              "awaiting_first_run",
              "degraded",
              "healthy",
            ],
          },
          cronCatalogAvailable: { type: "boolean" },
          cronConfigured: { type: "boolean" },
          cronActive: { type: "boolean" },
          cadence: { type: ["string", "null"] },
          schedulerActorConfigured: { type: "boolean" },
          schedulerActorValid: { type: "boolean" },
          invokeSecretConfigured: { type: "boolean" },
          lastCronRun: {
            type: ["object", "null"],
            additionalProperties: false,
            properties: {
              status: { type: "string" },
              startedAt: { type: ["string", "null"], format: "date-time" },
              endedAt: { type: ["string", "null"], format: "date-time" },
            },
          },
          lastHeartbeat: {
            type: ["object", "null"],
            additionalProperties: false,
            properties: {
              invocationKey: { type: "string" },
              scheduledAt: { type: "string", format: "date-time" },
              status: { type: "string", enum: ["succeeded", "failed"] },
              transitionCount: { type: ["integer", "null"], minimum: 0 },
              errorCode: { type: ["string", "null"] },
              attemptCount: { type: "integer", minimum: 1 },
              completedAt: { type: "string", format: "date-time" },
            },
          },
          checkedAt: { type: "string", format: "date-time" },
        },
      },
      DeveloperAuditEvent: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "eventType",
          "entityType",
          "entityId",
          "actorProfileId",
          "actorDisplayName",
          "effectiveAt",
          "recordedAt",
          "reasonCode",
          "summary",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          eventType: { $ref: "#/components/schemas/DeveloperAuditEventType" },
          entityType: { type: "string" },
          entityId: { type: ["string", "null"], format: "uuid" },
          actorProfileId: { type: ["string", "null"], format: "uuid" },
          actorDisplayName: { type: ["string", "null"] },
          effectiveAt: { type: "string", format: "date-time" },
          recordedAt: { type: "string", format: "date-time" },
          reasonCode: { type: ["string", "null"] },
          summary: {
            type: "object",
            description:
              "이벤트별 displayName/loginId/role/status/mustChangePassword 허용 필드만 포함",
            additionalProperties: false,
            properties: {
              displayName: { type: "string" },
              loginId: { type: "string" },
              role: { $ref: "#/components/schemas/AppRole" },
              status: { $ref: "#/components/schemas/AccountStatus" },
              mustChangePassword: { type: "boolean" },
            },
          },
        },
      },
      DeveloperAuditPage: {
        type: "object",
        additionalProperties: false,
        required: ["events", "nextCursor"],
        properties: {
          events: {
            type: "array",
            maxItems: 100,
            items: { $ref: "#/components/schemas/DeveloperAuditEvent" },
          },
          nextCursor: {
            type: ["string", "null"],
            description: "다음 페이지 요청에 그대로 전달할 opaque cursor",
          },
        },
      },
      DeveloperDiagnostics: {
        type: "object",
        additionalProperties: false,
        required: ["status", "checks", "checkedAt"],
        properties: {
          status: { type: "string", enum: ["passed", "degraded"] },
          checks: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "status"],
              properties: {
                id: { type: "string" },
                status: {
                  type: "string",
                  enum: ["passed", "failed", "timed_out"],
                },
                errorCode: { type: "string" },
                detail: { type: "object", additionalProperties: true },
              },
            },
          },
          checkedAt: { type: "string", format: "date-time" },
        },
      },
      DeveloperOverview: {
        type: "object",
        additionalProperties: false,
        required: [
          "generatedAt",
          "accounts",
          "rooms",
          "auditEventsLast24Hours",
          "runtime",
          "database",
          "scheduler",
        ],
        properties: {
          generatedAt: { type: "string", format: "date-time" },
          accounts: {
            type: "object",
            additionalProperties: false,
            required: ["total", "active", "byRole"],
            properties: {
              total: { type: "integer", minimum: 0 },
              active: { type: "integer", minimum: 0 },
              byRole: {
                type: "object",
                additionalProperties: false,
                required: ["developer", "admin", "maid"],
                properties: {
                  developer: { type: "integer", minimum: 0 },
                  admin: { type: "integer", minimum: 0 },
                  maid: { type: "integer", minimum: 0 },
                },
              },
            },
          },
          rooms: {
            type: "object",
            additionalProperties: false,
            required: ["total"],
            properties: { total: { type: "integer", minimum: 0 } },
          },
          auditEventsLast24Hours: { type: "integer", minimum: 0 },
          runtime: { $ref: "#/components/schemas/DeveloperRuntimeStatus" },
          database: { $ref: "#/components/schemas/DeveloperDatabaseStatus" },
          scheduler: { $ref: "#/components/schemas/DeveloperSchedulerStatus" },
        },
      },
      RoomReasonCode: {
        type: "string",
        enum: [
          "OCCUPIED",
          "CLEANING_REQUIRED",
          "CANDLE_PRESENT",
          "OPERATION_BLOCKED",
          "ROOM_ISSUE_BLOCKED",
          "PIN_MISMATCH",
          "DATA_UNCONFIRMED",
        ],
        description:
          "객실이 고객 배정 준비되지 않은 독립 사유입니다. 여러 값이 동시에 올 수 있습니다.",
      },
      RoomProjection: {
        type: "object",
        required: [
          "id",
          "roomNumber",
          "roomTypeCode",
          "roomTypeName",
          "elevatorZone",
          "dataStatus",
          "stateVersion",
          "occupied",
          "cleaningRequired",
          "candleCount",
          "pinSyncStatus",
          "allocationBlocked",
          "allocationReady",
          "reasonCodes",
        ],
        properties: {
          id: { type: "string", format: "uuid", description: "불변 객실 ID" },
          roomNumber: {
            type: "string",
            description: "사용자에게 표시하는 안정적인 객실 번호",
          },
          roomTypeCode: {
            type: "string",
            description: "타입 표시명이 바뀌어도 유지되는 객실 타입 코드",
          },
          roomTypeName: {
            type: "string",
            description: "현재 객실 타입 표시명",
          },
          elevatorZone: {
            type: ["string", "null"],
            enum: ["A", "B", "C", null],
            description: "엘리베이터 구역",
          },
          dataStatus: {
            type: "string",
            enum: ["verified", "verification_required"],
            description: "객실 기준정보 확인 상태",
          },
          stateVersion: {
            type: "integer",
            minimum: 1,
            description:
              "후속 객실 변경 command에서 expectedVersion으로 사용할 CAS version",
          },
          occupied: { type: "boolean", description: "현재 점유 여부" },
          cleaningRequired: {
            type: "boolean",
            description: "현재 청소 의무 존재 여부",
          },
          candleCount: {
            type: "integer",
            minimum: 0,
            description: "현재 서버 projection의 촛불 수량",
          },
          pinSyncStatus: {
            type: "string",
            enum: ["verified", "mismatch", "unconfigured"],
            description: "객실 PIN 동기화 상태. PIN 원문은 포함하지 않습니다.",
          },
          allocationBlocked: {
            type: "boolean",
            description: "하나 이상의 고객 배정 차단 사유가 있는지 여부",
          },
          allocationReady: {
            type: "boolean",
            description: "현재 고객 배정 준비 조건을 모두 만족하는지 여부",
          },
          reasonCodes: {
            type: "array",
            items: { $ref: "#/components/schemas/RoomReasonCode" },
            description:
              "allocationReady=false의 근거 목록. UI 대표 상태로 덮어쓰지 않습니다.",
          },
        },
      },
    },
  },
} as const;

function developerResponse(
  description: string,
  property: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    description,
    headers: { "Cache-Control": noStoreHeader },
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: false,
          required: [property],
          properties: { [property]: schema },
        },
      },
    },
  };
}

function accountMutationDescription(
  operationId: string,
): { summary: string; description: string; success: string } {
  const descriptions: Record<
    string,
    { summary: string; description: string; success: string }
  > = {
    changeAccountRole: {
      summary: "계정의 business role 변경",
      description:
        "admin과 maid 사이에서만 변경할 수 있습니다. developer 대상과 developer로의 승격은 금지되며 마지막 active admin 보호를 DB가 경쟁 상황에서도 재검증합니다.",
      success: "역할 변경 완료",
    },
    changeAccountStatus: {
      summary: "계정 활성·비활성·퇴사 상태 변경",
      description:
        "developer 대상은 금지됩니다. 퇴사 처리는 먼저 inactive 상태가 되어야 하며, 마지막 active admin 비활성화는 거부됩니다. reasonCode에는 사전에 합의된 영문 대문자 코드를 보냅니다.",
      success: "상태 변경 완료",
    },
    unlockAccount: {
      summary: "계정 로그인 잠금 해제",
      description:
        "5회 로그인 실패로 잠긴 admin 또는 maid 계정의 실패 횟수와 잠금을 해제합니다. developer 대상은 일반 계정 명령으로 처리할 수 없습니다.",
      success: "잠금 해제 완료",
    },
    resetAccountPassword: {
      summary: "계정 비밀번호를 휴대전화 뒤 4자리로 초기화",
      description:
        "admin 또는 maid의 Supabase Auth 비밀번호를 서버 내부 namespace의 임시값으로 초기화하고 `mustChangePassword=true`로 전환합니다. 전체 휴대전화 번호나 임시 내부 변환값은 응답하지 않습니다. developer는 본인 비밀번호 변경 API만 사용합니다.",
      success: "비밀번호 초기화 완료",
    },
  };
  const description = descriptions[operationId];
  if (!description) {
    throw new Error(`Unknown account mutation operation: ${operationId}`);
  }
  return description;
}

function accountMutationPath(
  operationId: string,
  requestSchema?: Record<string, unknown>,
): Record<string, unknown> {
  const post = operationId === "unlockAccount" ||
    operationId === "resetAccountPassword";
  const documentation = accountMutationDescription(operationId);
  return {
    [post ? "post" : "patch"]: {
      tags: ["Accounts"],
      operationId,
      summary: documentation.summary,
      description: documentation.description,
      security: [{ bearerAuth: [] }],
      "x-required-roles": accountManagerRoles,
      parameters: [
        {
          name: "profileId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description:
            "계정 목록 응답의 `account.id`. Auth user ID가 아닙니다.",
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
          description: documentation.success,
          headers: { "Cache-Control": noStoreHeader },
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
  <title>객실관리 API 문서</title>
  <link rel="stylesheet" href="${swaggerCss}" integrity="${swaggerCssIntegrity}" crossorigin="anonymous" />
  <style>
    body { margin: 0; background: #f7f8fa; }
    .api-guide { padding: 16px 24px; background: #101828; color: #fff; font-family: sans-serif; }
    .api-guide h1 { margin: 0 0 8px; font-size: 20px; }
    .api-guide p { margin: 0 0 10px; color: #d0d5dd; line-height: 1.5; }
    .api-guide a { color: #84caff; margin-right: 16px; font-weight: 700; }
  </style>
</head>
<body>
  <header class="api-guide">
    <h1>CASTLE THE ART 프론트 연동 API</h1>
    <p>Authorize에는 access token만 입력하고, 변경 요청에는 사용자 동작별 Idempotency-Key를 사용하세요. 실제 토큰·비밀번호·휴대전화는 캡처나 Issue에 남기지 않습니다.</p>
    <a href="./openapi.json" download="room-management-openapi.json">OpenAPI JSON 내려받기</a>
    <a href="https://github.com/wrongstory/room-management-system-backend/blob/main/docs/FRONTEND_API_INTEGRATION.md" target="_blank" rel="noreferrer">프론트 연동 가이드</a>
  </header>
  <div id="swagger-ui"></div>
  <script src="${swaggerBundle}" integrity="${swaggerBundleIntegrity}" crossorigin="anonymous"></script>
  <script nonce="${nonce}">
    window.ui = SwaggerUIBundle({
      url: "./openapi.json",
      dom_id: "#swagger-ui",
      deepLinking: true,
      displayRequestDuration: true,
      docExpansion: "list",
      filter: true,
      showCommonExtensions: true,
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
