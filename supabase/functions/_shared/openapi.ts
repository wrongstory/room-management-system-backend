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

const manualTransitionIdempotencyHeader = {
  ...idempotencyHeader,
  schema: {
    ...idempotencyHeader.schema,
    not: { pattern: "^reservation-scheduler-" },
  },
  description:
    `${idempotencyHeader.description} \`reservation-scheduler-\` 접두사는 scheduler 전용 namespace이므로 수동 실행에서는 \`RESERVED_IDEMPOTENCY_KEY\`로 거부됩니다.`,
};

const noStoreHeader = {
  description: "인증·개인정보 응답은 브라우저나 중간 캐시에 저장하지 않습니다.",
  schema: { const: "no-store" },
};

const accountManagerRoles = ["developer", "admin"] as const;

const reservationRequired = [
  "id",
  "roomId",
  "checkInAt",
  "checkOutAt",
  "guestCount",
  "status",
  "preparationObligationId",
  "checkoutObligationId",
  "version",
  "actualCheckInAt",
  "actualCheckoutAt",
  "cancelledAt",
  "createdAt",
  "updatedAt",
] as const;

const reservationProperties = {
  id: { type: "string", format: "uuid" },
  roomId: { type: "string", format: "uuid" },
  checkInAt: { type: "string", format: "date-time" },
  checkOutAt: { type: "string", format: "date-time" },
  guestCount: { type: "integer", minimum: 1 },
  status: { $ref: "#/components/schemas/ReservationStatus" },
  preparationObligationId: { type: "string", format: "uuid" },
  checkoutObligationId: { type: "string", format: "uuid" },
  version: {
    type: "integer",
    minimum: 1,
    description: "변경·취소·수동 체크아웃의 expectedVersion CAS 값",
  },
  roomStateVersion: {
    type: "integer",
    minimum: 1,
    description: "객실 상태도 함께 변경된 명령에서만 반환",
  },
  actualCheckInAt: { type: ["string", "null"], format: "date-time" },
  actualCheckoutAt: { type: ["string", "null"], format: "date-time" },
  cancelledAt: { type: ["string", "null"], format: "date-time" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

export const openApiDocument = {
  openapi: "3.1.1",
  info: {
    title: "CASTLE THE ART Room Management API",
    version: "0.2.0",
    description: [
      "Supabase Edge API의 인증·계정·객실·주간 가능일·예약 계약입니다. 이 문서는 프론트 코드 생성의 정본이며 실제 자격증명과 운영 환경값은 포함하지 않습니다.",
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
      "- `maid`: 계정·전체 객실 API는 사용할 수 없고 본인의 주간 가능일만 조회·제출·변경 요청할 수 있습니다.",
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
    {
      name: "Availability",
      description:
        "메이드의 다음 주 가능일 제출·변경 요청과 관리자의 승인·후보 조회 API입니다. 제출창은 일요일 12:00–23:59 KST이며 서버가 DB 시각으로 판정합니다.",
    },
    {
      name: "Assignments",
      description:
        "미통보 청소 배정 draft의 담당 메이드·서비스 날짜·순서 immutable revision API입니다. 알림·outbox·청소 attempt는 이 API에서 만들지 않습니다.",
    },
    {
      name: "Reservations",
      description:
        "비밀번호 변경을 완료한 active business admin 전용 예약·점유·수동 청소 요청 API입니다. 고객명은 목록에 포함하지 않고 권한을 재검증한 단건 상세에서만 복호화합니다.",
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
              maxItems: 28,
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
    "/v1/developer/activity-events": {
      get: {
        tags: ["Developer"],
        operationId: "listDeveloperActivityEvents",
        summary: "인증·권한·민감접근 활동 로그 조회",
        description:
          "업무 상태 변경 감사와 분리된 보안 활동을 최대 31일, 페이지당 100건으로 조회합니다. 알 수 없는 로그인과 권한 거부 반복은 원문 request metadata 없이 분 단위 aggregate summary로 반환합니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["developer"],
        parameters: [
          {
            name: "actorProfileId",
            in: "query",
            schema: { type: "string", format: "uuid" },
            description: "알려진 특정 행위자 profile ID 필터",
          },
          {
            name: "role",
            in: "query",
            schema: { $ref: "#/components/schemas/AppRole" },
            description: "이벤트 발생 시점 역할 snapshot 필터",
          },
          {
            name: "category",
            in: "query",
            schema: {
              type: "array",
              maxItems: 3,
              items: { $ref: "#/components/schemas/ActivityCategory" },
            },
            style: "form",
            explode: true,
          },
          {
            name: "eventType",
            in: "query",
            schema: {
              type: "array",
              maxItems: 4,
              items: { $ref: "#/components/schemas/ActivityEventType" },
            },
            style: "form",
            explode: true,
          },
          {
            name: "outcome",
            in: "query",
            schema: {
              type: "array",
              maxItems: 3,
              items: { $ref: "#/components/schemas/ActivityOutcome" },
            },
            style: "form",
            explode: true,
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
            description: "직전 응답의 nextCursor를 그대로 전달합니다.",
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
        ],
        responses: {
          "200": {
            description: "민감 원문을 저장·노출하지 않는 활동 로그 페이지",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeveloperActivityPage" },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "500": errorResponse,
          "503": errorResponse,
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
    "/v1/availability": {
      get: {
        tags: ["Availability"],
        operationId: "listAvailability",
        summary: "현재 주간 가능일 조회",
        description:
          "비밀번호 변경을 완료한 active maid 또는 active business admin 전용입니다. maid는 본인 자료만 조회할 수 있으며, admin만 maidProfileId로 특정 메이드를 선택할 수 있습니다. weekStart는 조회할 주의 월요일 날짜입니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["maid", "admin"],
        parameters: [
          {
            name: "weekStart",
            in: "query",
            required: true,
            schema: { type: "string", format: "date" },
            description: "대상 주의 월요일(YYYY-MM-DD)",
          },
          {
            name: "maidProfileId",
            in: "query",
            schema: { type: "string", format: "uuid" },
            description:
              "admin 선택 필터. maid가 다른 profile ID를 전달하면 403입니다.",
          },
        ],
        responses: {
          "200": availabilityListResponse(),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/availability/submissions": {
      post: {
        tags: ["Availability"],
        operationId: "submitAvailability",
        summary: "다음 주 가능일 제출",
        description:
          "비밀번호 변경을 완료한 active maid만 일요일 12:00–23:59 KST에 다음 월요일 주차를 제출할 수 있습니다. expectedVersion CAS와 Idempotency-Key로 동시 수정·중복 제출을 막습니다. 빈 availableDates는 전일 불가능을 뜻합니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["maid"],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AvailabilitySubmissionRequest",
              },
            },
          },
        },
        responses: {
          "201": availabilityItemResponse("가능일 제출 완료"),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "409": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/availability/change-requests": {
      post: {
        tags: ["Availability"],
        operationId: "requestAvailabilityChange",
        summary: "마감 후 가능일 변경 요청",
        description:
          "비밀번호 변경을 완료한 active maid가 제출 마감 후 현재 version의 변경을 요청합니다. 기존 가능일 원장은 보존되고 pending 요청이 append되며, 같은 주차에는 pending 요청 하나만 허용됩니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["maid"],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AvailabilityChangeRequestInput",
              },
            },
          },
        },
        responses: {
          "201": availabilityChangeResponse("변경 요청 접수 완료"),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "500": errorResponse,
        },
      },
      get: {
        tags: ["Availability"],
        operationId: "listAvailabilityChangeRequests",
        summary: "가능일 변경 요청 목록 조회",
        description:
          "active maid는 본인 요청만, active business admin은 전체 요청을 조회합니다. status·weekStart·maidProfileId 필터는 모두 선택이며 maid가 다른 profile ID를 전달하면 403입니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["maid", "admin"],
        parameters: [
          {
            name: "status",
            in: "query",
            schema: {
              $ref: "#/components/schemas/AvailabilityChangeRequestStatus",
            },
            description: "요청 처리 상태 필터",
          },
          {
            name: "weekStart",
            in: "query",
            schema: { type: "string", format: "date" },
            description: "대상 주의 월요일 날짜 필터",
          },
          {
            name: "maidProfileId",
            in: "query",
            schema: { type: "string", format: "uuid" },
            description: "admin용 메이드 profile 필터",
          },
        ],
        responses: {
          "200": availabilityChangeListResponse(),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/availability/change-requests/{requestId}/decision": {
      post: {
        tags: ["Availability"],
        operationId: "decideAvailabilityChange",
        summary: "가능일 변경 요청 승인 또는 반려",
        description:
          "비밀번호 변경을 완료한 active business admin만 호출합니다. 승인하면 새 가능일 version을 만들고 current pointer를 이동하며, 반려하면 요청 결과만 append합니다. developer는 관리자 권한을 상속하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [
          {
            name: "requestId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "변경 요청 ID",
          },
          idempotencyHeader,
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AvailabilityDecisionRequest",
              },
            },
          },
        },
        responses: {
          "200": availabilityChangeResponse("변경 요청 결정 완료"),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/availability/candidates": {
      get: {
        tags: ["Availability"],
        operationId: "listAvailabilityCandidates",
        summary: "날짜별 배정 가능 메이드 후보 조회",
        description:
          "비밀번호 변경을 완료한 active business admin 전용입니다. 해당 날짜가 가능하다고 제출한 현재 version의 active maid만 반환하며 developer와 maid는 조회할 수 없습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [
          {
            name: "workDate",
            in: "query",
            required: true,
            schema: { type: "string", format: "date" },
            description: "후보를 조회할 근무 날짜",
          },
        ],
        responses: {
          "200": availabilityCandidateListResponse(),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/assignments": {
      get: {
        tags: ["Assignments"],
        operationId: "listAssignments",
        summary: "서비스 날짜별 청소 배정 조회",
        description:
          "비밀번호 변경을 완료한 active business admin은 날짜 전체를, active maid는 자신의 배정만 조회합니다. includeHistory=false가 기본이며 true일 때도 maid에게는 본인 revision만 반환됩니다. developer는 업무 배정을 조회할 수 없습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [
          {
            name: "serviceDate",
            in: "query",
            required: true,
            schema: { type: "string", format: "date" },
            description: "배정 snapshot의 서비스 날짜(YYYY-MM-DD)",
          },
          {
            name: "maidProfileId",
            in: "query",
            schema: { type: "string", format: "uuid" },
            description:
              "admin 선택 필터. maid가 다른 profile ID를 전달하면 ASSIGNMENT_ACCESS_REQUIRED입니다.",
          },
          {
            name: "includeHistory",
            in: "query",
            schema: { type: "boolean", default: false },
            description: "종료된 과거 immutable revision 포함 여부",
          },
        ],
        responses: {
          "200": assignmentListResponse(),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/assignments/{cleaningTargetId}/history": {
      get: {
        tags: ["Assignments"],
        operationId: "getAssignmentHistory",
        summary: "청소 대상의 배정 revision 이력 조회",
        description:
          "active business admin은 전체 revision을 조회하고 active maid는 자신에게 배정된 revision만 조회합니다. maid가 해당 target의 어느 revision에도 포함되지 않으면 ASSIGNMENT_ACCESS_REQUIRED입니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [{
          name: "cleaningTargetId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "청소 대상 ID",
        }],
        responses: {
          "200": assignmentListResponse(),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/assignments/drafts": {
      post: {
        tags: ["Assignments"],
        operationId: "saveAssignmentDraft",
        summary: "미통보 청소 배정 draft 저장",
        description:
          "비밀번호 변경을 완료한 active business admin만 호출합니다. cleaning target row lock, expectedAssignmentVersion CAS, scoped Idempotency-Key로 현재 draft를 새 immutable revision으로 교체합니다. 이 명령은 알림·outbox·attempt를 생성하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AssignmentDraftRequest" },
            },
          },
        },
        responses: {
          "201": assignmentItemResponse("청소 배정 draft 저장 완료"),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/reservations": {
      get: {
        tags: ["Reservations"],
        operationId: "listReservations",
        summary: "예약 목록 조회",
        description:
          "비밀번호 변경을 완료한 active business admin만 조회합니다. 목록은 예약·점유·청소 연결에 필요한 필드만 반환하며 guestName과 암호문을 절대 포함하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [{
          name: "roomId",
          in: "query",
          schema: { type: "string", format: "uuid" },
          description: "특정 객실의 예약만 조회하는 선택 필터",
        }],
        responses: {
          "200": reservationListResponse(),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "500": errorResponse,
        },
      },
      post: {
        tags: ["Reservations"],
        operationId: "createReservation",
        summary: "예약 생성",
        description:
          "active business admin이 객실 일정을 생성합니다. expectedRoomVersion은 객실 CAS 값이며 활성 예약은 [checkInAt, checkOutAt) 반개구간으로 겹치지 않아야 합니다. guestName은 Edge에서 AES-256-GCM으로 암호화되며 명령 응답에 돌려주지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [idempotencyHeader],
        requestBody: reservationRequestBody("ReservationCreateRequest"),
        responses: reservationMutationResponses(201),
      },
    },
    "/v1/reservations/{reservationId}": {
      get: {
        tags: ["Reservations"],
        operationId: "getReservation",
        summary: "예약 상세와 고객명 조회",
        description:
          "active business admin 전용 민감정보 조회입니다. 암호화된 고객명이 있을 때만 복호화하고 #58 sensitive.read 활동 원장을 성공적으로 기록한 뒤 반환합니다. 기록 실패 시 요청은 fail-closed됩니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [reservationIdParameter()],
        responses: {
          "200": reservationObjectResponse(
            "예약 상세",
            "#/components/schemas/ReservationDetail",
          ),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "500": errorResponse,
          "503": errorResponse,
        },
      },
      patch: {
        tags: ["Reservations"],
        operationId: "changeReservation",
        summary: "예약 일정·객실·고객정보 변경",
        description:
          "active business admin이 expectedVersion CAS로 예약을 변경합니다. guestName 필드 생략은 기존값 유지, null은 삭제, 문자열은 새 암호문 설정을 뜻합니다. 이미 배정·시작된 작업과 충돌하면 409로 거부됩니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [reservationIdParameter(), idempotencyHeader],
        requestBody: reservationRequestBody("ReservationChangeRequest"),
        responses: reservationMutationResponses(),
      },
    },
    "/v1/reservations/{reservationId}/cancel": reservationCommandPath(
      "cancelReservation",
      "체크인 전 예약 soft cancel",
      "예약과 연결 의무·감사 이력을 삭제하지 않고 expectedVersion과 reasonCode로 취소합니다. 체크인 후나 충돌 상태에서는 409를 반환합니다.",
    ),
    "/v1/reservations/{reservationId}/manual-checkout": reservationCommandPath(
      "manualCheckoutReservation",
      "예정 전 수동 체크아웃",
      "예약 취소와 다른 명령입니다. 실제 체크아웃 event를 append하고 같은 퇴실 청소 의무를 재사용하며, PIN 공개·수행 중 충돌은 409로 거부합니다.",
    ),
    "/v1/reservations/cleaning-requests": {
      post: {
        tags: ["Reservations"],
        operationId: "createManualCleaningRequest",
        summary: "연박 또는 추가 청소 요청 생성",
        description:
          "active business admin이 투숙 객실에 stayover, 공실에 additional 요청을 생성합니다. stayover는 active reservationId가 필수이며 서버가 점유·접근 구간·기존 target 충돌을 재검증합니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [idempotencyHeader],
        requestBody: reservationRequestBody("ManualCleaningRequestCreate"),
        responses: cleaningRequestMutationResponses(201),
      },
    },
    "/v1/reservations/cleaning-requests/{targetId}/cancel": {
      post: {
        tags: ["Reservations"],
        operationId: "cancelManualCleaningRequest",
        summary: "미착수 수동 청소 요청 soft cancel",
        description:
          "active business admin이 아직 미배정·미공개·미착수인 수동 요청만 expectedVersion CAS로 취소합니다. 자동 퇴실 의무나 이미 시작된 작업은 취소할 수 없습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [
          {
            name: "targetId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "수동 청소 target ID",
          },
          idempotencyHeader,
        ],
        requestBody: reservationRequestBody("ReservationMutationRequest"),
        responses: cleaningRequestMutationResponses(),
      },
    },
    "/v1/reservations/transitions/process": {
      post: {
        tags: ["Reservations"],
        operationId: "processReservationTransitions",
        summary: "관리자가 due 예약 전이 수동 실행",
        description:
          "active business admin이 현재 서버 시각까지의 체크인·체크아웃·고객명 보존 전이를 수동으로 catch-up합니다. scheduler Function의 x-scheduler-secret·scheduledAt·heartbeat 경계를 재사용하지 않으며, 사용자 Idempotency-Key로 독립적으로 실행합니다. `reservation-scheduler-` 접두사는 scheduler 전용이므로 사용할 수 없습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [manualTransitionIdempotencyHeader],
        responses: {
          "200": {
            description: "예약 전이 batch 결과",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["transitions"],
                  properties: {
                    transitions: {
                      $ref: "#/components/schemas/ReservationTransitionResult",
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
          "500": errorResponse,
        },
      },
    },
    "/v1/rooms/{roomId}": {
      get: {
        tags: ["Rooms"],
        operationId: "getRoom",
        summary: "객실 단건 운영 projection 조회",
        description:
          "비밀번호 변경을 완료한 active business admin만 조회합니다. 목록과 동일한 camelCase projection만 반환하며 객실 PIN 원문이나 provider 인증정보는 반환하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [roomIdParameter()],
        responses: roomReadResponses(),
      },
    },
    "/v1/rooms/{roomId}/master-data": {
      patch: roomMutationOperation(
        "changeRoomMasterData",
        "객실 기준정보 변경",
        "RoomMasterDataRequest",
        "room",
        200,
        "expectedVersion은 현재 room.stateVersion입니다. 객실 타입·엘리베이터 구역·기준정보 확인 상태를 기존 DB CAS·감사·멱등성 command로 변경합니다.",
      ),
    },
    "/v1/rooms/{roomId}/operation-blocks": {
      post: roomMutationOperation(
        "createRoomOperationBlock",
        "객실 운영 차단 생성",
        "RoomOperationBlockRequest",
        "operation",
        201,
        "객실 운영 차단을 append합니다. startsAt을 생략하면 DB 시각을 사용하며 endsAt은 null일 수 있습니다.",
      ),
    },
    "/v1/rooms/{roomId}/operation-blocks/{blockId}/release": {
      post: roomMutationOperation(
        "releaseRoomOperationBlock",
        "객실 운영 차단 해제",
        "RoomOperationDecisionRequest",
        "operation",
        200,
        "기존 차단을 삭제하지 않고 release 이력과 객실 CAS version을 기록합니다.",
        roomEntityIdParameter("blockId", "해제할 운영 차단 ID"),
      ),
    },
    "/v1/rooms/{roomId}/candles": {
      post: roomMutationOperation(
        "setRoomCandleCount",
        "객실 촛불 수량 기록",
        "RoomCandleRequest",
        "operation",
        201,
        "현재 수량을 append-only event로 기록합니다. physicallyVerified를 생략하면 false이며 count는 0 이상입니다.",
      ),
    },
    "/v1/rooms/{roomId}/issues": {
      post: roomMutationOperation(
        "reportRoomIssue",
        "객실 이슈 등록",
        "RoomIssueRequest",
        "operation",
        201,
        "객실 이슈를 등록합니다. description에 전화번호나 이메일 등 연락처를 넣으면 SENSITIVE_TEXT_NOT_ALLOWED로 거부합니다.",
      ),
    },
    "/v1/rooms/{roomId}/issues/{issueId}/resolve": {
      post: roomMutationOperation(
        "resolveRoomIssue",
        "객실 이슈 해결",
        "RoomOperationDecisionRequest",
        "operation",
        200,
        "이슈 원장을 삭제하지 않고 해결 상태와 사유를 기록합니다.",
        roomEntityIdParameter("issueId", "해결할 객실 이슈 ID"),
      ),
    },
    "/v1/rooms/{roomId}/pin-sync-events": {
      post: roomMutationOperation(
        "recordRoomPinSync",
        "객실 PIN 동기화 상태 기록",
        "RoomPinSyncRequest",
        "operation",
        201,
        "PIN 원문이 아닌 동기화 상태와 선택적 pinVersion만 기록합니다. pin, rawPin, pinCode, doorCode, credential, providerSecret 필드는 허용하지 않습니다.",
      ),
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
          "ACTIVITY_LOG_UNAVAILABLE",
          "AUTH_LOOKUP_FAILED",
          "LOGIN_STATE_UPDATE_FAILED",
          "INVALID_CURRENT_PASSWORD",
          "AUTH_PASSWORD_CHANGE_FAILED",
          "PASSWORD_STATE_INCONSISTENT",
          "PASSWORD_STATE_UPDATE_FAILED",
          "PASSWORD_CHANGE_REQUIRED",
          "ACCOUNT_MANAGER_REQUIRED",
          "ADMIN_REQUIRED",
          "ASSIGNMENT_ACCESS_REQUIRED",
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
          "RESERVED_IDEMPOTENCY_KEY",
          "DEACTIVATION_MUST_BE_FINISHED",
          "PHONE_ALREADY_REGISTERED",
          "LOGIN_ID_CONFLICT",
          "PHONE_REQUIRED_FOR_RESET",
          "AUTH_USER_CREATE_FAILED",
          "AUTH_USER_UPDATE_FAILED",
          "AUTH_PASSWORD_RESET_FAILED",
          "ACCOUNT_AUTH_STATE_INCONSISTENT",
          "ACCOUNT_COMMAND_FAILED",
          "FORBIDDEN",
          "MAID_REQUIRED",
          "AVAILABILITY_ACCESS_REQUIRED",
          "ACTIVE_MAID_REQUIRED",
          "CLEANING_TARGET_NOT_FOUND",
          "ASSIGNMENT_VERSION_CONFLICT",
          "ASSIGNMENT_TARGET_STATE_INVALID",
          "ASSIGNMENT_SEQUENCE_CONFLICT",
          "ASSIGNMENT_NOT_FOUND",
          "ASSIGNMENT_COMMAND_FAILED",
          "ACTIVE_ADMIN_REQUIRED",
          "OUTSIDE_AVAILABILITY_WINDOW",
          "CHANGE_REQUEST_BEFORE_DEADLINE",
          "STALE_VERSION",
          "PENDING_CHANGE_REQUEST_EXISTS",
          "INVALID_TRANSITION",
          "AVAILABILITY_NOT_FOUND",
          "CHANGE_REQUEST_NOT_FOUND",
          "WEEK_START_MUST_BE_MONDAY",
          "AVAILABILITY_DATES_MUST_BE_UNIQUE",
          "AVAILABILITY_DATE_OUTSIDE_WEEK",
          "AVAILABILITY_COMMAND_FAILED",
          "INVALID_GUEST_NAME",
          "INVALID_GUEST_COUNT",
          "INVALID_RESERVATION_SCHEDULE",
          "RESERVATION_OVERLAP",
          "ROOM_ALLOCATION_BLOCKED",
          "RESERVATION_NOT_FOUND",
          "CLEANING_REQUEST_NOT_FOUND",
          "CLEANING_TEMPLATE_NOT_CONFIGURED",
          "INVALID_MANUAL_CLEANING_REQUEST",
          "ACTIVE_STAY_RESERVATION_REQUIRED",
          "STAYOVER_ACCESS_WINDOW_INVALID",
          "VACANT_ROOM_REQUIRED",
          "RESERVATION_ROOM_MISMATCH",
          "NOT_MANUAL_CLEANING_REQUEST",
          "REPLAN_REQUIRED",
          "SCHEDULE_LOCKED",
          "CONFLICT",
          "RESERVATION_COMMAND_FAILED",
          "RESERVATION_PII_KEY_INVALID",
          "RESERVATION_PII_KEYRING_INVALID",
          "RESERVATION_PII_DECRYPT_FAILED",
          "ROOM_NOT_FOUND",
          "ROOM_OPERATION_NOT_FOUND",
          "SENSITIVE_TEXT_NOT_ALLOWED",
          "PIN_MATERIAL_NOT_ALLOWED",
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
          "availability.submitted",
          "availability.change_requested",
          "availability.change_decided",
          "assignment.draft_saved",
          "reservation.created",
          "reservation.changed",
          "reservation.cancelled",
          "reservation.manual_checkout",
          "reservation.scheduled_check_in",
          "reservation.scheduled_checkout",
          "reservation.guest_name_retention_purged",
          "cleaning.manual_request.created",
          "cleaning.manual_request.cancelled",
          "room.master_data_changed",
          "room.create_block",
          "room.release_block",
          "room.set_candle_count",
          "room.report_issue",
          "room.resolve_issue",
          "room.record_pin_sync",
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
              expectedMigration: {
                type: "string",
                pattern: "^[a-z][a-z0-9_]{2,100}$",
                description:
                  "원격 적용 시각과 무관한 Git migration의 안정적인 name",
              },
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
          "currentMigrationVersion",
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
            pattern: "^[a-z][a-z0-9_]{2,100}$",
          },
          currentMigrationVersion: {
            type: ["string", "null"],
            pattern: "^[0-9]{14}$",
            description:
              "현재 환경이 부여한 원격 migration version. source identity로 사용하지 않습니다.",
          },
          expectedMigration: {
            type: "string",
            pattern: "^[a-z][a-z0-9_]{2,100}$",
          },
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
              "이벤트 종류별로 서버가 승인한 표시 필드만 포함하며 raw before_state/after_state는 반환하지 않습니다.",
            additionalProperties: false,
            properties: {
              displayName: { type: "string" },
              loginId: { type: "string" },
              role: { $ref: "#/components/schemas/AppRole" },
              status: { type: "string" },
              mustChangePassword: { type: "boolean" },
              maidProfileId: { type: "string", format: "uuid" },
              cleaningTargetId: { type: "string", format: "uuid" },
              weekStart: { type: "string", format: "date" },
              version: { type: "integer", minimum: 0 },
              sourceVersion: { type: "integer", minimum: 0 },
              approvedVersionId: { type: "string", format: "uuid" },
              roomId: { type: "string", format: "uuid" },
              checkInAt: { type: "string", format: "date-time" },
              checkOutAt: { type: "string", format: "date-time" },
              purgedCount: { type: "integer", minimum: 0 },
              reservationId: { type: "string", format: "uuid" },
              cleaningKind: { type: "string" },
              serviceDate: { type: "string", format: "date" },
              sequenceNumber: { type: "integer", minimum: 1 },
              revision: { type: "integer", minimum: 1 },
              targetAssignmentVersion: { type: "integer", minimum: 1 },
              availableFrom: { type: "string", format: "date-time" },
              dueAt: { type: "string", format: "date-time" },
              roomTypeId: { type: "string" },
              elevatorZone: { type: "string" },
              dataStatus: { type: "string" },
              stateVersion: { type: "integer", minimum: 0 },
              blockId: { type: "string", format: "uuid" },
              active: { type: "boolean" },
              count: { type: "integer", minimum: 0 },
              issueId: { type: "string", format: "uuid" },
              category: { type: "string" },
              severity: { type: "string" },
              blocksGuestAssignment: { type: "boolean" },
              pinSyncEventId: { type: "string", format: "uuid" },
              syncStatus: { type: "string" },
              pinVersion: { type: "integer", minimum: 0 },
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
      ActivityCategory: {
        type: "string",
        enum: ["auth", "authorization", "sensitive_access"],
      },
      ActivityEventType: {
        type: "string",
        enum: [
          "auth.login_succeeded",
          "auth.login_failed",
          "authorization.denied",
          "sensitive.read",
        ],
      },
      ActivityOutcome: {
        type: "string",
        enum: ["succeeded", "failed", "denied"],
      },
      DeveloperActivityEvent: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "category",
          "eventType",
          "outcome",
          "actorProfileId",
          "actorRole",
          "source",
          "resourceType",
          "resourceId",
          "reasonCode",
          "requestId",
          "occurredAt",
          "recordedAt",
          "summary",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          category: { $ref: "#/components/schemas/ActivityCategory" },
          eventType: { $ref: "#/components/schemas/ActivityEventType" },
          outcome: { $ref: "#/components/schemas/ActivityOutcome" },
          actorProfileId: { type: ["string", "null"], format: "uuid" },
          actorRole: {
            anyOf: [{ $ref: "#/components/schemas/AppRole" }, { type: "null" }],
          },
          source: {
            type: "string",
            description: "소스 코드에 고정된 capability category",
          },
          resourceType: { type: ["string", "null"] },
          resourceId: { type: ["string", "null"], format: "uuid" },
          reasonCode: { type: ["string", "null"] },
          requestId: {
            type: ["string", "null"],
            format: "uuid",
            description:
              "개별 이벤트에만 존재하는 Edge 생성 UUID v4입니다. caller X-Request-ID나 세션 ID가 아닙니다.",
          },
          occurredAt: { type: "string", format: "date-time" },
          recordedAt: { type: "string", format: "date-time" },
          summary: {
            type: "object",
            additionalProperties: false,
            description:
              "unknown login과 authorization denial aggregate에 count/lastOccurredAt/bucketMinutes를 반환합니다.",
            properties: {
              aggregateCount: { type: "integer", minimum: 1, maximum: 600 },
              lastOccurredAt: { type: "string", format: "date-time" },
              bucketMinutes: { const: 1 },
            },
          },
        },
      },
      DeveloperActivityPage: {
        type: "object",
        additionalProperties: false,
        required: ["events", "nextCursor"],
        properties: {
          events: {
            type: "array",
            maxItems: 100,
            items: { $ref: "#/components/schemas/DeveloperActivityEvent" },
          },
          nextCursor: { type: ["string", "null"] },
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
      Assignment: {
        type: "object",
        additionalProperties: false,
        required: [
          "assignmentId",
          "cleaningTargetId",
          "roomId",
          "roomNumber",
          "maidProfileId",
          "maidDisplayName",
          "serviceDate",
          "sequenceNumber",
          "revision",
          "isCurrent",
          "targetAssignmentVersion",
          "availableFrom",
          "dueAt",
          "notifiedAt",
          "endedAt",
          "createdAt",
        ],
        properties: {
          assignmentId: { type: "string", format: "uuid" },
          cleaningTargetId: { type: "string", format: "uuid" },
          roomId: { type: "string", format: "uuid" },
          roomNumber: { type: "string" },
          maidProfileId: { type: "string", format: "uuid" },
          maidDisplayName: { type: "string" },
          serviceDate: { type: "string", format: "date" },
          sequenceNumber: { type: "integer", minimum: 1 },
          revision: { type: "integer", minimum: 1 },
          isCurrent: { type: "boolean" },
          targetAssignmentVersion: {
            type: "integer",
            minimum: 1,
            description: "다음 draft 저장의 expectedAssignmentVersion CAS 값",
          },
          availableFrom: { type: ["string", "null"], format: "date-time" },
          dueAt: { type: ["string", "null"], format: "date-time" },
          notifiedAt: { type: ["string", "null"], format: "date-time" },
          endedAt: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
        },
        description:
          "배정 당시 서비스 날짜·접근 가능 시각·마감 시각을 보존하는 revision projection입니다. 전화번호, 고객명, PIN, provider 식별자는 포함하지 않습니다.",
      },
      AssignmentDraftRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "cleaningTargetId",
          "maidProfileId",
          "sequenceNumber",
          "expectedAssignmentVersion",
        ],
        properties: {
          cleaningTargetId: { type: "string", format: "uuid" },
          maidProfileId: { type: "string", format: "uuid" },
          sequenceNumber: { type: "integer", minimum: 1 },
          expectedAssignmentVersion: { type: "integer", minimum: 1 },
        },
      },
      AvailabilityDay: {
        type: "object",
        additionalProperties: false,
        required: ["workDate", "available"],
        properties: {
          workDate: {
            type: "string",
            format: "date",
            description: "대상 주차의 근무 날짜",
          },
          available: {
            type: "boolean",
            description: "해당 날짜 근무 가능 여부",
          },
        },
      },
      AvailabilityVersion: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "maidProfileId",
          "weekStart",
          "version",
          "status",
          "current",
          "submittedAt",
          "days",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          maidProfileId: {
            type: "string",
            format: "uuid",
            description: "가능일을 제출한 메이드 profile ID",
          },
          weekStart: {
            type: "string",
            format: "date",
            description: "대상 주의 월요일",
          },
          version: {
            type: "integer",
            minimum: 1,
            description: "다음 변경 요청의 expectedVersion으로 사용할 CAS 값",
          },
          status: {
            type: "string",
            enum: ["submitted", "superseded"],
            description: "제출 version의 이력 상태",
          },
          current: {
            type: "boolean",
            description: "해당 메이드·주차의 현재 version 여부",
          },
          submittedAt: { type: "string", format: "date-time" },
          days: {
            type: "array",
            minItems: 7,
            maxItems: 7,
            items: { $ref: "#/components/schemas/AvailabilityDay" },
            description: "월요일부터 일요일까지 날짜순 7개 projection",
          },
        },
      },
      AvailabilityChangeRequestStatus: {
        type: "string",
        enum: ["pending", "approved", "rejected"],
      },
      AvailabilityChangeRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "availabilityVersionId",
          "maidProfileId",
          "weekStart",
          "sourceVersion",
          "requestedAvailableDates",
          "reasonCode",
          "status",
          "requestedAt",
          "decidedBy",
          "decidedAt",
          "decisionReasonCode",
          "approvedVersionId",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          availabilityVersionId: {
            type: "string",
            format: "uuid",
            description: "요청이 기준으로 삼은 가능일 version ID",
          },
          maidProfileId: { type: "string", format: "uuid" },
          weekStart: { type: "string", format: "date" },
          sourceVersion: {
            type: "integer",
            minimum: 1,
            description: "요청 생성 시점의 CAS version",
          },
          requestedAvailableDates: {
            type: "array",
            maxItems: 7,
            uniqueItems: true,
            items: { type: "string", format: "date" },
          },
          reasonCode: {
            type: "string",
            pattern: "^[A-Z0-9_]{2,80}$",
            description: "메이드가 제출한 변경 사유 코드",
          },
          status: {
            $ref: "#/components/schemas/AvailabilityChangeRequestStatus",
          },
          requestedAt: { type: "string", format: "date-time" },
          decidedBy: { type: ["string", "null"], format: "uuid" },
          decidedAt: { type: ["string", "null"], format: "date-time" },
          decisionReasonCode: {
            type: ["string", "null"],
            pattern: "^[A-Z0-9_]{2,80}$",
          },
          approvedVersionId: {
            type: ["string", "null"],
            format: "uuid",
            description: "승인으로 생성된 새 version ID. 반려·대기 중에는 null",
          },
        },
      },
      AvailabilityCandidate: {
        type: "object",
        additionalProperties: false,
        required: [
          "workDate",
          "weekStart",
          "availabilityVersion",
          "maidProfileId",
          "displayName",
        ],
        properties: {
          workDate: { type: "string", format: "date" },
          weekStart: { type: "string", format: "date" },
          availabilityVersion: { type: "integer", minimum: 1 },
          maidProfileId: { type: "string", format: "uuid" },
          displayName: {
            type: "string",
            description: "현재 메이드 표시 이름",
          },
        },
      },
      AvailabilitySubmissionRequest: {
        type: "object",
        additionalProperties: false,
        required: ["weekStart", "availableDates", "expectedVersion"],
        properties: {
          weekStart: {
            type: "string",
            format: "date",
            description: "다음 주 월요일",
          },
          availableDates: {
            type: "array",
            maxItems: 7,
            uniqueItems: true,
            items: { type: "string", format: "date" },
            description: "근무 가능한 날짜만 전달. 빈 배열은 전일 불가능",
          },
          expectedVersion: {
            type: "integer",
            minimum: 0,
            description: "최초 제출은 0, 재제출은 현재 version",
          },
        },
      },
      AvailabilityChangeRequestInput: {
        type: "object",
        additionalProperties: false,
        required: [
          "weekStart",
          "requestedAvailableDates",
          "reasonCode",
          "expectedVersion",
        ],
        properties: {
          weekStart: { type: "string", format: "date" },
          requestedAvailableDates: {
            type: "array",
            maxItems: 7,
            uniqueItems: true,
            items: { type: "string", format: "date" },
          },
          reasonCode: {
            type: "string",
            pattern: "^[A-Z0-9_]{2,80}$",
          },
          expectedVersion: { type: "integer", minimum: 1 },
        },
      },
      AvailabilityDecisionRequest: {
        type: "object",
        additionalProperties: false,
        required: ["decision", "reasonCode", "expectedVersion"],
        properties: {
          decision: {
            type: "string",
            enum: ["approved", "rejected"],
          },
          reasonCode: {
            type: "string",
            pattern: "^[A-Z0-9_]{2,80}$",
          },
          expectedVersion: {
            type: "integer",
            minimum: 1,
            description: "요청의 sourceVersion과 비교할 CAS 값",
          },
        },
      },
      ReasonCode: {
        type: "string",
        pattern: "^[A-Z0-9_]{2,80}$",
        description: "서버·감사 이력에 사용하는 안정적인 영문 사유 코드",
      },
      ReservationStatus: {
        type: "string",
        enum: ["active", "cancelled", "checked_out"],
        description: "예약 일정 상태. 점유·청소 상태와 합치지 않습니다.",
      },
      Reservation: {
        type: "object",
        additionalProperties: false,
        required: reservationRequired,
        properties: reservationProperties,
        description:
          "목록과 mutation 응답에 사용하는 예약 projection입니다. guestName과 암호문은 이 schema에 없습니다.",
      },
      ReservationDetail: {
        type: "object",
        additionalProperties: false,
        required: [...reservationRequired, "guestName"],
        properties: {
          ...reservationProperties,
          guestName: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 80,
            description:
              "암호화 보존 기간 내의 고객명. active business admin 단건 조회에서만 복호화됩니다.",
          },
        },
      },
      ReservationCreateRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "roomId",
          "checkInAt",
          "checkOutAt",
          "guestCount",
          "expectedRoomVersion",
        ],
        properties: {
          roomId: { type: "string", format: "uuid" },
          checkInAt: { type: "string", format: "date-time" },
          checkOutAt: { type: "string", format: "date-time" },
          guestCount: { type: "integer", minimum: 1 },
          guestName: { type: ["string", "null"], minLength: 1, maxLength: 80 },
          expectedRoomVersion: { type: "integer", minimum: 1 },
        },
      },
      ReservationChangeRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "roomId",
          "checkInAt",
          "checkOutAt",
          "guestCount",
          "expectedVersion",
          "reasonCode",
        ],
        properties: {
          roomId: { type: "string", format: "uuid" },
          checkInAt: { type: "string", format: "date-time" },
          checkOutAt: { type: "string", format: "date-time" },
          guestCount: { type: "integer", minimum: 1 },
          guestName: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 80,
            description: "생략하면 유지, null이면 삭제, 문자열이면 재암호화",
          },
          expectedVersion: { type: "integer", minimum: 1 },
          reasonCode: { $ref: "#/components/schemas/ReasonCode" },
        },
      },
      ReservationMutationRequest: {
        type: "object",
        additionalProperties: false,
        required: ["expectedVersion", "reasonCode"],
        properties: {
          expectedVersion: { type: "integer", minimum: 1 },
          reasonCode: { $ref: "#/components/schemas/ReasonCode" },
        },
      },
      ManualCleaningRequestCreate: {
        type: "object",
        additionalProperties: false,
        required: [
          "roomId",
          "cleaningKind",
          "serviceDate",
          "availableFrom",
          "expectedRoomVersion",
          "reasonCode",
        ],
        properties: {
          roomId: { type: "string", format: "uuid" },
          reservationId: {
            type: ["string", "null"],
            format: "uuid",
            description: "stayover에서 필수, additional에서는 일반적으로 null",
          },
          cleaningKind: { type: "string", enum: ["stayover", "additional"] },
          serviceDate: { type: "string", format: "date" },
          availableFrom: { type: "string", format: "date-time" },
          dueAt: { type: ["string", "null"], format: "date-time" },
          expectedRoomVersion: { type: "integer", minimum: 1 },
          reasonCode: { $ref: "#/components/schemas/ReasonCode" },
        },
      },
      ManualCleaningRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "roomId",
          "reservationId",
          "cleaningKind",
          "status",
          "serviceDate",
          "availableFrom",
          "dueAt",
          "version",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          roomId: { type: "string", format: "uuid" },
          reservationId: { type: ["string", "null"], format: "uuid" },
          cleaningKind: { type: "string", enum: ["stayover", "additional"] },
          status: { type: "string" },
          serviceDate: { type: "string", format: "date" },
          availableFrom: { type: "string", format: "date-time" },
          dueAt: { type: ["string", "null"], format: "date-time" },
          version: { type: "integer", minimum: 1 },
        },
      },
      ReservationTransitionResult: {
        type: "object",
        additionalProperties: false,
        required: [
          "asOf",
          "checkedInCount",
          "checkedOutCount",
          "blockedCheckInCount",
          "purgedGuestNameCount",
        ],
        properties: {
          asOf: { type: "string", format: "date-time" },
          checkedInCount: { type: "integer", minimum: 0 },
          checkedOutCount: { type: "integer", minimum: 0 },
          blockedCheckInCount: { type: "integer", minimum: 0 },
          purgedGuestNameCount: { type: "integer", minimum: 0 },
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
        additionalProperties: false,
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
      RoomMasterDataRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "roomTypeId",
          "elevatorZone",
          "dataStatus",
          "expectedVersion",
          "reasonCode",
        ],
        properties: {
          roomTypeId: { type: "string", format: "uuid" },
          elevatorZone: {
            type: ["string", "null"],
            enum: ["A", "B", "C", null],
          },
          dataStatus: {
            type: "string",
            enum: ["verified", "verification_required"],
          },
          dataStatusReason: {
            type: ["string", "null"],
            minLength: 2,
            maxLength: 200,
            description:
              "verification_required일 때 필요한 운영 사유. 앞뒤 공백은 제거됩니다.",
          },
          expectedVersion: { type: "integer", minimum: 1 },
          reasonCode: { $ref: "#/components/schemas/RoomCommandReasonCode" },
        },
      },
      RoomOperationDecisionRequest: {
        type: "object",
        additionalProperties: false,
        required: ["expectedRoomVersion", "reasonCode"],
        properties: {
          expectedRoomVersion: { type: "integer", minimum: 1 },
          reasonCode: { $ref: "#/components/schemas/RoomCommandReasonCode" },
        },
      },
      RoomOperationBlockRequest: {
        type: "object",
        additionalProperties: false,
        required: ["expectedRoomVersion", "reasonCode"],
        properties: {
          expectedRoomVersion: { type: "integer", minimum: 1 },
          reasonCode: { $ref: "#/components/schemas/RoomCommandReasonCode" },
          startsAt: { type: "string", format: "date-time" },
          endsAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      RoomCandleRequest: {
        type: "object",
        additionalProperties: false,
        required: ["expectedRoomVersion", "reasonCode", "count"],
        properties: {
          expectedRoomVersion: { type: "integer", minimum: 1 },
          reasonCode: { $ref: "#/components/schemas/RoomCommandReasonCode" },
          count: { type: "integer", minimum: 0 },
          physicallyVerified: { type: "boolean", default: false },
        },
      },
      RoomIssueRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "expectedRoomVersion",
          "reasonCode",
          "category",
          "severity",
          "blocksGuestAssignment",
        ],
        properties: {
          expectedRoomVersion: { type: "integer", minimum: 1 },
          reasonCode: { $ref: "#/components/schemas/RoomCommandReasonCode" },
          category: { type: "string", pattern: "^[A-Z0-9_]{2,80}$" },
          severity: { type: "string", enum: ["info", "warning", "critical"] },
          blocksGuestAssignment: { type: "boolean" },
          description: {
            type: "string",
            maxLength: 500,
            description:
              "선택적 운영 설명. 전화번호·이메일은 허용하지 않습니다.",
          },
        },
      },
      RoomPinSyncRequest: {
        type: "object",
        additionalProperties: false,
        required: ["expectedRoomVersion", "reasonCode", "syncStatus"],
        properties: {
          expectedRoomVersion: { type: "integer", minimum: 1 },
          reasonCode: { $ref: "#/components/schemas/RoomCommandReasonCode" },
          syncStatus: {
            type: "string",
            enum: ["verified", "mismatch", "unconfigured"],
          },
          pinVersion: { type: ["integer", "null"], minimum: 1 },
        },
        description:
          "PIN 원문·door code·credential·provider secret은 요청할 수 없습니다.",
      },
      RoomCommandReasonCode: {
        type: "string",
        pattern: "^[A-Z0-9_]{2,80}$",
        description: "감사 이력에 남는 소스 제어 가능한 안정적 사유 코드",
      },
      RoomOperationResult: {
        type: "object",
        additionalProperties: false,
        required: ["entityId", "roomId", "roomStateVersion", "recordedAt"],
        properties: {
          entityId: { type: "string", format: "uuid" },
          roomId: { type: "string", format: "uuid" },
          roomStateVersion: { type: "integer", minimum: 1 },
          recordedAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
} as const;

function roomIdParameter(): Record<string, unknown> {
  return {
    name: "roomId",
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
    description: "불변 객실 ID",
  };
}

function roomEntityIdParameter(
  name: "blockId" | "issueId",
  description: string,
): Record<string, unknown> {
  return {
    name,
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
    description,
  };
}

function roomReadResponses(): Record<string, unknown> {
  return {
    "200": {
      description: "객실 운영 projection",
      headers: { "Cache-Control": noStoreHeader },
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["room"],
            properties: {
              room: { $ref: "#/components/schemas/RoomProjection" },
            },
          },
        },
      },
    },
    "400": errorResponse,
    "401": errorResponse,
    "403": errorResponse,
    "404": errorResponse,
    "500": errorResponse,
  };
}

function roomMutationOperation(
  operationId: string,
  summary: string,
  requestSchema: string,
  responseKey: "room" | "operation",
  successStatus: 200 | 201,
  description: string,
  entityParameter?: Record<string, unknown>,
): Record<string, unknown> {
  const responseSchema = responseKey === "room"
    ? "#/components/schemas/RoomProjection"
    : "#/components/schemas/RoomOperationResult";
  return {
    tags: ["Rooms"],
    operationId,
    summary,
    description:
      `${description} 비밀번호 변경을 완료한 active business admin만 실행할 수 있고, Idempotency-Key 재시도와 expected version CAS를 적용합니다.`,
    security: [{ bearerAuth: [] }],
    "x-required-roles": ["admin"],
    parameters: [
      roomIdParameter(),
      ...(entityParameter ? [entityParameter] : []),
      idempotencyHeader,
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${requestSchema}` },
        },
      },
    },
    responses: {
      [String(successStatus)]: {
        description: `${summary} 완료`,
        headers: { "Cache-Control": noStoreHeader },
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: [responseKey],
              properties: { [responseKey]: { $ref: responseSchema } },
            },
          },
        },
      },
      "400": errorResponse,
      "401": errorResponse,
      "403": errorResponse,
      "404": errorResponse,
      "409": errorResponse,
      "500": errorResponse,
    },
  };
}

function reservationIdParameter(): Record<string, unknown> {
  return {
    name: "reservationId",
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
    description: "불변 예약 ID",
  };
}

function reservationRequestBody(schemaName: string): Record<string, unknown> {
  return {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schemaName}` },
      },
    },
  };
}

function reservationObjectResponse(
  description: string,
  reference = "#/components/schemas/Reservation",
): Record<string, unknown> {
  return {
    description,
    headers: { "Cache-Control": noStoreHeader },
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["reservation"],
          properties: { reservation: { $ref: reference } },
        },
      },
    },
  };
}

function reservationListResponse(): Record<string, unknown> {
  return {
    description: "guestName을 포함하지 않는 예약 목록",
    headers: { "Cache-Control": noStoreHeader },
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["reservations"],
          properties: {
            reservations: {
              type: "array",
              items: { $ref: "#/components/schemas/Reservation" },
            },
          },
        },
      },
    },
  };
}

function reservationMutationResponses(
  successStatus = 200,
): Record<string, unknown> {
  return {
    [String(successStatus)]: reservationObjectResponse("예약 명령 완료"),
    "400": errorResponse,
    "401": errorResponse,
    "403": errorResponse,
    "404": errorResponse,
    "409": errorResponse,
    "500": errorResponse,
    "503": errorResponse,
  };
}

function cleaningRequestMutationResponses(
  successStatus = 200,
): Record<string, unknown> {
  return {
    [String(successStatus)]: {
      description: "수동 청소 요청 명령 완료",
      headers: { "Cache-Control": noStoreHeader },
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["cleaningRequest"],
            properties: {
              cleaningRequest: {
                $ref: "#/components/schemas/ManualCleaningRequest",
              },
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
    "500": errorResponse,
  };
}

function reservationCommandPath(
  operationId: string,
  summary: string,
  description: string,
): Record<string, unknown> {
  return {
    post: {
      tags: ["Reservations"],
      operationId,
      summary,
      description,
      security: [{ bearerAuth: [] }],
      "x-required-roles": ["admin"],
      parameters: [reservationIdParameter(), idempotencyHeader],
      requestBody: reservationRequestBody("ReservationMutationRequest"),
      responses: reservationMutationResponses(),
    },
  };
}

function availabilityListResponse(): Record<string, unknown> {
  return availabilityArrayResponse(
    "현재 가능일 version 목록",
    "availability",
    "#/components/schemas/AvailabilityVersion",
  );
}

function availabilityChangeListResponse(): Record<string, unknown> {
  return availabilityArrayResponse(
    "가능일 변경 요청 목록",
    "changeRequests",
    "#/components/schemas/AvailabilityChangeRequest",
  );
}

function availabilityCandidateListResponse(): Record<string, unknown> {
  return availabilityArrayResponse(
    "배정 가능한 active maid 후보 목록",
    "candidates",
    "#/components/schemas/AvailabilityCandidate",
  );
}

function availabilityArrayResponse(
  description: string,
  property: string,
  itemReference: string,
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
          properties: {
            [property]: {
              type: "array",
              items: { $ref: itemReference },
            },
          },
        },
      },
    },
  };
}

function availabilityItemResponse(
  description: string,
): Record<string, unknown> {
  return availabilityObjectResponse(
    description,
    "availability",
    "#/components/schemas/AvailabilityVersion",
  );
}

function availabilityChangeResponse(
  description: string,
): Record<string, unknown> {
  return availabilityObjectResponse(
    description,
    "changeRequest",
    "#/components/schemas/AvailabilityChangeRequest",
  );
}

function availabilityObjectResponse(
  description: string,
  property: string,
  reference: string,
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
          properties: { [property]: { $ref: reference } },
        },
      },
    },
  };
}

function assignmentListResponse(): Record<string, unknown> {
  return {
    description: "청소 배정 revision 목록",
    headers: { "Cache-Control": noStoreHeader },
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["assignments"],
          properties: {
            assignments: {
              type: "array",
              items: { $ref: "#/components/schemas/Assignment" },
            },
          },
        },
      },
    },
  };
}

function assignmentItemResponse(description: string): Record<string, unknown> {
  return {
    description,
    headers: { "Cache-Control": noStoreHeader },
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["assignment"],
          properties: {
            assignment: { $ref: "#/components/schemas/Assignment" },
          },
        },
      },
    },
  };
}

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
