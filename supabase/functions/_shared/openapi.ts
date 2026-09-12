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

const complaintErrorResponse = {
  ...errorResponse,
  headers: { "Cache-Control": noStoreHeader },
};

const accountManagerRoles = ["developer", "admin"] as const;
const photoPathId = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
});
function photoOperation(
  operationId: string,
  summary: string,
  schema: string,
  roles: readonly string[] = ["maid"],
) {
  return {
    tags: ["Photos"],
    operationId,
    summary,
    security: [{ bearerAuth: [] }],
    "x-required-roles": roles,
    responses: {
      "200": {
        description:
          "최신 DB 권한과 상태를 검증한 안전한 결과. Drive ID·locator·OAuth·원문 hash는 반환하지 않습니다.",
        headers: { "Cache-Control": noStoreHeader },
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${schema}` },
          },
        },
      },
      "400": errorResponse,
      "401": errorResponse,
      "403": errorResponse,
      "404": errorResponse,
      "409": errorResponse,
      "413": errorResponse,
      "415": errorResponse,
      "429": errorResponse,
      "500": errorResponse,
      "503": errorResponse,
    },
  };
}

function submissionOperation(
  operationId: string,
  summary: string,
  role: "maid" | "admin",
  responseSchema: string,
  status = "200",
) {
  return {
    tags: [role === "maid" ? "Attempts" : "Inspections"],
    operationId,
    summary,
    description: role === "maid"
      ? "메이드는 본인의 현재 통보 배정에 연결된 수행 회차만 조회·제출할 수 있습니다. 요청마다 최신 계정·세션·소유권·current revision을 다시 검증합니다."
      : "활성 업무 관리자만 current 제출본을 조회·판정할 수 있습니다. 오래된 제출본과 중복 판정은 version 및 멱등성 계약으로 차단합니다.",
    security: [{ bearerAuth: [] }],
    "x-required-roles": [role],
    responses: {
      [status]: {
        description: "검증된 current version의 안전한 projection",
        headers: { "Cache-Control": noStoreHeader },
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${responseSchema}` },
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

function complaintMutationResponses() {
  return {
    "200": {
      description:
        "원자적으로 갱신된 current projection 또는 동일 command receipt replay",
      headers: { "Cache-Control": noStoreHeader },
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ComplaintEnvelope" },
        },
      },
    },
    "400": complaintErrorResponse,
    "401": complaintErrorResponse,
    "403": complaintErrorResponse,
    "404": complaintErrorResponse,
    "409": complaintErrorResponse,
    "500": complaintErrorResponse,
  };
}

function attemptMutationOperation(
  operationId: string,
  summary: string,
  description: string,
) {
  return {
    tags: ["Attempts"],
    operationId,
    summary,
    description,
    security: [{ bearerAuth: [] }],
    "x-required-roles": ["maid"],
    parameters: [
      idempotencyHeader,
      {
        name: "attemptId",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
        description: "본인의 현재 통보 배정에 연결된 수행 회차 ID",
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/AttemptExecutionRequest" },
        },
      },
    },
    responses: {
      "200": {
        description:
          "원자적으로 저장된 수행 결과 또는 동일 요청의 성공 receipt replay",
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["attempt"],
              properties: {
                attempt: { $ref: "#/components/schemas/AttemptExecution" },
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
    },
  };
}

function lifecycleOperation(
  operationId: string,
  summary: string,
  description: string,
  role: "admin" | "maid",
  responseSchema: string,
) {
  return {
    tags: ["Attempts"],
    operationId,
    summary,
    description,
    security: [{ bearerAuth: [] }],
    "x-required-roles": [role],
    responses: {
      "200": {
        description:
          "현재 scope의 안전한 수명주기 결과. credential·PIN·원문 snapshot은 반환하지 않습니다.",
        headers: { "Cache-Control": noStoreHeader },
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${responseSchema}` },
          },
        },
      },
      "400": errorResponse,
      "401": errorResponse,
      "403": errorResponse,
      "409": errorResponse,
      "500": errorResponse,
    },
  };
}
const attemptPathParameter = {
  name: "attemptId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
  description: "서버 발급 수행 회차 ID이며 인증 credential이 아닙니다.",
};
const lifecycleCasProperties = {
  expectedExecutionVersion: {
    type: "integer",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  },
  expectedAssignmentId: { type: "string", format: "uuid" },
  expectedAssignmentRevision: {
    type: "integer",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  },
  expectedProfileVersion: {
    type: "integer",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  },
};
function lifecycleRequestVariant(
  action: string,
  reasonCode: string[],
  payload: unknown,
) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      ...Object.keys(lifecycleCasProperties),
      "action",
      "payload",
      "reasonCode",
    ],
    properties: {
      ...lifecycleCasProperties,
      action: { const: action },
      reasonCode: { type: "string", enum: reasonCode },
      payload,
    },
  };
}

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
      name: "Push Subscriptions",
      description:
        "active admin/maid 본인의 Web Push 구독을 암호화된 revision 원장으로 등록·회전·폐기합니다. 실제 provider 전송은 #111/#112 범위입니다.",
    },
    {
      name: "Photos",
      description:
        "서버가 bytes·형식·디코딩·EXIF 제거·최종 SHA를 검증하는 사진 업로드/상태/원본 proxy입니다. limited upload capability는 원본 조회 권한이 아닙니다. 저장 완료는 제출·검수·입실 준비 완료를 뜻하지 않습니다.",
    },
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
      name: "Attempts",
      description:
        "통보된 본인 업무의 온라인 시작·물리 완료 및 실행 version 조회입니다. 오프라인 lease·인계·사진 제출·검수·수익은 후속 단계입니다.",
    },
    {
      name: "Inspections",
      description:
        "active business admin 전용 검수 대상·폭탄방 선판정·최종 승인/반려 API입니다. 승인·반려 side effect는 DB transaction 하나로 처리됩니다.",
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
    {
      name: "Payroll",
      description:
        "종료된 KST 주차의 확정 수익만 조회하고 active business admin이 PAYING snapshot을 잠그는 API입니다. 실제 외부 송금 성공을 의미하지 않습니다.",
    },
    {
      name: "Notifications",
      description:
        "비밀번호 변경을 완료한 active admin/maid의 본인 알림함 API입니다. 원본 dedupe/group 내부값은 노출하지 않고 읽음 시각은 서버가 최초 한 번만 기록합니다.",
    },
  ],
  paths: {
    "/v1/attempts/{attemptId}/bomb-room-reports": {
      post: {
        ...submissionOperation(
          "reportBombRoom",
          "본인 수행 회차의 폭탄방 신고",
          "maid",
          "BombRoomReportEnvelope",
          "201",
        ),
        description:
          "current full submission 전에만 신고하며 증빙 1~20장을 현재 verified photo version으로 고정합니다. inspection_reclean에는 신고할 수 없습니다. memo와 사진 원문/locator는 audit에 복제하지 않습니다.",
        parameters: [photoPathId("attemptId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BombRoomReportRequest" },
            },
          },
        },
      },
    },
    "/v1/attempts/{attemptId}/submissions": {
      get: {
        ...submissionOperation(
          "listAttemptSubmissions",
          "본인 회차의 immutable 제출 이력 조회",
          "maid",
          "SubmissionListEnvelope",
        ),
        parameters: [photoPathId("attemptId")],
        description:
          "active maid가 본인 attempt의 current 및 과거 immutable submission version을 조회합니다. 다른 maid, 미통보 draft와 관리자 전용 review context/photo binding은 노출하지 않습니다.",
      },
      post: {
        ...submissionOperation(
          "createSubmissionVersion",
          "필수 사진을 봉인하고 검수 요청",
          "maid",
          "SubmissionEnvelope",
          "201",
        ),
        description:
          "active maid 또는 live upload_submit limited capability가 있는 upload_only 원 담당자만 호출합니다. deactivation_pending의 finish_current capability는 제출 권한으로 확장되지 않습니다. field_completed와 모든 필수 current verified slot을 확인하고 새 immutable version과 정확한 photo binding set을 만든 뒤 이전 current version은 superseded 처리하고 pointer를 expectedRevision CAS로 교체합니다. 단, 폭탄방 신고/증빙은 최초 seal된 immutable submission version에서 이동할 수 없으므로 해당 version의 재제출은 BOMB_REPORT_SEALED(409)로 차단합니다.",
        parameters: [photoPathId("attemptId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateSubmissionRequest" },
            },
          },
        },
      },
    },
    "/v1/inspections": {
      get: {
        ...submissionOperation(
          "listPendingInspections",
          "검수 대상 목록 조회",
          "admin",
          "SubmissionListEnvelope",
        ),
        description:
          "current submitted version만 오래된 제출부터 최대 100건 반환합니다. 각 항목에는 immutable 검수 reviewContext가 포함됩니다. developer/maid는 관리자 전체 queue를 볼 수 없습니다. 100건 초과 cursor pagination은 후속 hardening 범위입니다.",
      },
    },
    "/v1/inspections/{submissionId}": {
      get: {
        ...submissionOperation(
          "getInspectionSubmission",
          "검수 제출 상세 조회",
          "admin",
          "SubmissionEnvelope",
        ),
        parameters: [photoPathId("submissionId")],
      },
    },
    "/v1/inspections/{submissionId}/bomb-room-decision": {
      post: {
        ...submissionOperation(
          "decideBombRoom",
          "폭탄방 신고 선판정",
          "admin",
          "BombRoomDecisionEnvelope",
        ),
        description:
          "current submission에 seal된 신고만 1회 판정합니다. current pointer와 다른 제출은 STALE_VERSION(409), 다른 idempotency key의 동시·후속 판정은 BOMB_DECISION_ALREADY_RECORDED(409)로 거부되며, 폭탄방 판정만으로 earning은 생성되지 않습니다.",
        parameters: [photoPathId("submissionId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BombRoomDecisionRequest" },
            },
          },
        },
      },
    },
    "/v1/inspections/{submissionId}/approve": {
      post: {
        ...submissionOperation(
          "approveSubmission",
          "current 제출 최종 승인",
          "admin",
          "InspectionDecisionEnvelope",
        ),
        description:
          "current pointer와 다른 제출은 STALE_VERSION(409)로 거부합니다. 제출·attempt·target 승인, notification/outbox/audit, 유상 원청소 earning을 한 transaction에서 정확히 한 번 생성합니다. 승인된 폭탄방 bonus는 base snapshot과 정확히 같습니다.",
        parameters: [photoPathId("submissionId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/InspectionDecisionRequest",
              },
            },
          },
        },
      },
    },
    "/v1/inspections/{submissionId}/reject": {
      post: {
        ...submissionOperation(
          "rejectSubmission",
          "current 제출 최종 반려",
          "admin",
          "InspectionDecisionEnvelope",
        ),
        description:
          "current pointer와 다른 제출은 STALE_VERSION(409)로 거부합니다. 원 attempt/maid/submission/decision에 묶인 0원 inspection_reclean target을 정확히 하나 만듭니다. 다른 메이드 이관과 earning 생성은 금지합니다.",
        parameters: [photoPathId("submissionId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/InspectionDecisionRequest",
              },
            },
          },
        },
      },
    },
    "/v1/attempts/{attemptId}/photo-slots": {
      get: {
        ...photoOperation(
          "getAttemptPhotoSlots",
          "본인 회차의 사진 슬롯과 current revision 조회",
          "AttemptPhotoSlots",
        ),
        parameters: [photoPathId("attemptId")],
        description:
          "업로드 전에 slotId와 currentRevision을 얻습니다. active maid의 본인 현재 회차 또는 해당 회차의 유효 upload_evidence capability만 허용합니다. 제한 계정/과거 인계 회차에는 photoId=null이며 원본 조회를 제공하지 않습니다. 슬롯 snapshot 미확정은 PHOTO_SLOT_INVALID로 차단하고 현재 template으로 추측하지 않습니다.",
      },
    },
    "/v1/attempts/{attemptId}/photo-slots/{slotId}/upload": {
      post: {
        ...photoOperation(
          "uploadAttemptPhoto",
          "검증된 JPEG/WebP 사진을 슬롯에 업로드",
          "PhotoUploadResponse",
        ),
        responses: {
          ...photoOperation(
            "uploadAttemptPhoto",
            "사진 업로드",
            "PhotoUploadResponse",
          ).responses,
          "408": {
            ...errorResponse,
            description:
              "PHOTO_BODY_TIMEOUT: raw body 수신 제한시간 초과. 부분 본문은 업로드하지 않습니다.",
          },
        },
        description:
          "multipart/base64가 아닌 raw binary body입니다. Content-Length 유무와 무관하게 원문 307200 bytes(300KiB)까지 허용하고 307201번째 byte에서 취소합니다. JPEG/WebP magic·전체 decode·단일 frame·자원상한을 검사하고 EXIF 등 metadata 제거 후 output decode/크기/SHA를 다시 검증합니다. assignmentId/assignmentRevision/expectedPhotoRevision의 3개 query만 허용합니다. Idempotency-Key는 같은 최종 효과 재시도에 재사용하며 DB에는 scoped digest만 저장합니다. quota/현재 권한 admission은 디코딩과 Drive 호출 전입니다. 업로드 응답 유실 시 같은 key 재시도 또는 operation status 조회를 사용하고 새 파일을 임의 생성하지 않습니다. accepted만 current 사진 연결 완료이며 provider_succeeded/불확실 상태는 완료가 아닙니다. Google createdTime의 KST 날짜와 사전예약 폴더 날짜가 다르면 PHOTO_PROVIDER_DATE_MISMATCH로 fail-closed합니다. 실제 운영 OAuth/배포 준비가 없으면 503이며 이 source 문서만으로 운영 활성화가 되지 않습니다.",
        parameters: [
          photoPathId("attemptId"),
          photoPathId("slotId"),
          idempotencyHeader,
          {
            name: "assignmentId",
            in: "query",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "assignmentRevision",
            in: "query",
            required: true,
            schema: {
              type: "integer",
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER - 1,
            },
          },
          {
            name: "expectedPhotoRevision",
            in: "query",
            required: true,
            schema: {
              type: "integer",
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER - 1,
            },
            description:
              "슬롯 조회의 currentRevision. 최초는0, 교체는 최신CAS revision.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "image/jpeg": {
              schema: {
                type: "string",
                format: "binary",
                maxLength: 307200,
                "x-max-bytes": 307200,
              },
            },
            "image/webp": {
              schema: {
                type: "string",
                format: "binary",
                maxLength: 307200,
                "x-max-bytes": 307200,
              },
            },
          },
        },
      },
    },
    "/v1/photo-uploads/{operationId}": {
      get: {
        ...photoOperation(
          "getPhotoUploadOperation",
          "본인 업로드 작업의 안전한 상태 조회",
          "PhotoUploadOperation",
        ),
        parameters: [photoPathId("operationId")],
        description:
          "본인 회차·현재 session·해당 업로드 capability를 DB에서 재검증합니다. Drive file ID/URL/claim digest는 노출하지 않습니다. accepted 결과도 현재 권한이 없으면 조회할 수 없으며 내부 reconciliation의 accepted 보존 판정과는 별도입니다.",
      },
    },
    "/v1/photos/{photoId}/content": {
      get: {
        ...photoOperation(
          "getPhotoContent",
          "권한을 다시 확인한 사진 원본 proxy",
          "PhotoUploadOperation",
          ["admin", "maid"],
        ),
        parameters: [photoPathId("photoId")],
        description:
          "비밀번호 변경을 완료한 active business admin 또는 본인의 현재 유효 회차에 속한 active maid만 허용합니다. developer와 upload_only/deactivation_pending/과거 인계 회차의 원본 읽기는 금지합니다. provider bytes를 bounded download/SHA 검증한 뒤 응답 첫 byte 전에 session/ownership/7일 만료를 다시 확인합니다. redirect/Range/공개 URL은 지원하지 않으며 Cache-Control:no-store, nosniff, 서버 고정 filename만 반환합니다.",
        responses: {
          ...photoOperation("unused", "unused", "PhotoUploadOperation")
            .responses,
          "200": {
            description:
              "검증 완료된 원본 JPEG/WebP. Drive 응답 header/Location/filename은 전달하지 않습니다.",
            headers: {
              "Cache-Control": noStoreHeader,
              "X-Content-Type-Options": { schema: { const: "nosniff" } },
            },
            content: {
              "image/jpeg": { schema: { type: "string", format: "binary" } },
              "image/webp": { schema: { type: "string", format: "binary" } },
            },
          },
        },
      },
    },
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
          "모든 active 역할이 본인 비밀번호를 변경할 때 사용합니다. 새 비밀번호는 숫자 6~72자리 또는 10~72자의 영문 대·소문자·숫자·특수문자 조합입니다. timeout/응답 유실 시 같은 Idempotency-Key와 원래 요청 body를 다시 보내세요. 서버는 비밀번호 파생 fingerprint를 저장하지 않으므로 currentPassword의 byte equality는 durable receipt에 포함하지 않습니다. 대신 Auth app_metadata의 비밀이 아닌 서버 발급 operation marker와 재전송한 newPassword가 현재 Auth 상태에 함께 일치할 때만 동일한 의도 효과로 증명하여 204를 replay합니다. 이후 변경·관리자 초기화로 marker가 바뀐 과거 key는 409가 됩니다. 모든 Auth 비밀번호 확인은 세션·client·key 회전으로 우회할 수 없는 actor 단위 durable rate limit을 먼저 소비하며, 한도 초과는 429입니다. 처리 중에는 PASSWORD_CHANGE_IN_PROGRESS이며 성공하면 현재 세션을 제외한 다른 세션이 폐기됩니다.",
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
          "409": errorResponse,
          "429": {
            ...errorResponse,
            headers: {
              "Retry-After": { schema: { type: "integer", minimum: 1 } },
            },
          },
          "500": errorResponse,
          "502": errorResponse,
          "503": errorResponse,
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
    "/v1/accounts/{profileId}/role": accountMutationPath("changeAccountRole", {
      $ref: "#/components/schemas/RoleChangeRequest",
    }),
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
              maxItems: 58,
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
    "/v1/assignments/{cleaningTargetId}/change": {
      post: prestartOperation(
        "changeCleaningAssignmentPrestart",
        "시작 전 담당·순서·접근 시간 변경",
        "AssignmentPrestartChangeRequest",
        "Assignment",
        "admin",
        "cleaningTargetId",
      ),
    },
    "/v1/assignments/{cleaningTargetId}/unassign": {
      post: prestartOperation(
        "unassignCleaningAssignmentPrestart",
        "시작 전 담당 해제 — 청소 target 취소 아님",
        "AssignmentPrestartUnassignRequest",
        "Assignment",
        "admin",
        "cleaningTargetId",
      ),
    },
    "/v1/assignments/{cleaningTargetId}/cancellation-requests": {
      post: prestartOperation(
        "requestAssignmentCancellation",
        "본인 통보 배정 취소 요청",
        "AssignmentCancellationRequest",
        "AssignmentChangeRequest",
        "maid",
        "cleaningTargetId",
      ),
    },
    "/v1/assignment-change-requests/{requestId}/decision": {
      post: prestartOperation(
        "decideAssignmentCancellationRequest",
        "메이드 담당 취소 요청 승인·반려",
        "AssignmentCancellationDecisionRequest",
        "AssignmentChangeRequest",
        "admin",
        "requestId",
      ),
    },
    "/v1/assignment-change-requests": {
      get: {
        tags: ["Assignments"],
        operationId: "listAssignmentChangeRequests",
        summary: "담당 취소 요청 이력 조회",
        description:
          "active admin은 전체, active maid는 본인만 조회합니다. developer는 거부됩니다. 최대 31일/100건이며 cursor로 다음 페이지를 조회합니다. reasonDetail에는 개인정보·PIN·인증정보를 입력하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [
          {
            name: "maidProfileId",
            in: "query",
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "status",
            in: "query",
            schema: {
              type: "string",
              enum: ["pending", "approved", "rejected", "superseded"],
            },
          },
          ...["from", "to"].map((name) => ({
            name,
            in: "query",
            schema: { type: "string", format: "date-time" },
          })),
          {
            name: "cursor",
            in: "query",
            schema: { type: "string", maxLength: 256 },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
        ],
        responses: {
          "200": {
            description: "취소 요청 목록",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AssignmentChangeRequestPage",
                },
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
    "/v1/attempts/{attemptId}/start-with-lease": {
      post: {
        ...lifecycleOperation(
          "startAttemptWithLease",
          "온라인 청소 시작과 오프라인 완료 lease 발급",
          "active 본인 maid의 online start 성공과 lease 발급을 원자적으로 수행합니다. 기존 /start 응답은 바뀌지 않으며 기존 /start만 사용한 회차에는 lease가 없습니다. 2시간 TTL·lease 발급 시각 기준 90일 metadata/replay 만료는 재시도·다른 key로 연장할 수 없습니다. lease ID는 credential이 아니며 재연결 때 유효 Supabase Auth 세션이 필요합니다. PIN·사진·개인정보는 lease/오프라인 큐에 저장하지 않습니다.",
          "maid",
          "AttemptWithOfflineLease",
        ),
        parameters: [idempotencyHeader, attemptPathParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AttemptExecutionRequest" },
            },
          },
        },
      },
    },
    "/v1/offline-events": {
      post: {
        ...lifecycleOperation(
          "syncOfflineCompletion",
          "본인 lease의 단일 오프라인 완료 이벤트 동기화",
          "인증된 maid의 active/deactivation_pending/upload_only 상태와 현재 세션을 검증하고, 본인에게 서버가 발급한 lease의 complete_field_work 한 슬롯만 처리합니다. offline start·batch·임의 action은 없습니다(본문 최대 2048 bytes). eventId는 재시도 UUID이며 같은 UUID+payload만 90일 안에서 원 응답을 replay합니다. 같은 lease의 다른 UUID도 새 효과/무제한 row를 만들지 않습니다. 90일은 lease.issuedAt 기준이며 이후 거부하고 영구 tombstone은 남기지 않습니다. 보존 중 만료 lease는 OFFLINE_EVENT_EXPIRED, 이미 삭제/unknown lease는 OFFLINE_LEASE_UNKNOWN이며 모두 재실행하지 않습니다. normalizedOccurredAt=occurredAt+serverOffsetMs이며 ±5분 skew/server anchor/시작~lease 만료/KST 경계를 DB가 검증합니다. 잠금 후 수신이 TTL 이상이거나 취소/인계/시계·날짜 충돌이면 quarantined이고 수행 성공이 아닙니다. unknown/타인 lease와 revoked session은 거부합니다. Idempotency-Key/X-Request-ID를 이벤트 원장 식별로 사용하지 않습니다.",
          "maid",
          "OfflineSyncResult",
        ),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OfflineCompletionRequest" },
            },
          },
        },
      },
    },
    "/v1/offline-quarantines": {
      get: {
        ...lifecycleOperation(
          "listOfflineQuarantines",
          "관리자 오프라인 격리 기록 조회",
          "active business admin 전용입니다. 최대 31일·100건·cursor 조회이며 90일 metadata horizon 밖 기록은 반환하지 않습니다. 기본 조회는 최근 7일입니다. 원 client event UUID/hash/offset/body는 반환하지 않고 발생 시각은 서버가 계산한 후보 시각이며 신뢰된 수행 완료를 뜻하지 않습니다.",
          "admin",
          "OfflineQuarantinePage",
        ),
        parameters: [
          {
            name: "from",
            in: "query",
            schema: { type: "string", format: "date-time" },
          },
          {
            name: "to",
            in: "query",
            schema: { type: "string", format: "date-time" },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
          {
            name: "cursor",
            in: "query",
            schema: { type: "string", minLength: 1, maxLength: 256 },
          },
        ],
      },
    },
    "/v1/offline-quarantines/{quarantineId}": {
      get: {
        ...lifecycleOperation(
          "getOfflineQuarantine",
          "관리자 격리 기록과 현재 수행 CAS 확인",
          "과거 회차 복구 권한을 부여하지 않습니다. currentAttempt는 현재 유효 배정에 연결된 안전한 DTO 또는 null이며 correction 전에 status/executionVersion을 확인합니다. 원문 event UUID/clock offset/PII/PIN은 반환하지 않습니다.",
          "admin",
          "OfflineQuarantine",
        ),
        parameters: [
          {
            name: "quarantineId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
      },
    },
    "/v1/offline-quarantines/{quarantineId}/resolve": {
      post: {
        ...lifecycleOperation(
          "resolveOfflineQuarantine",
          "관리자 격리 기록 판정 또는 현재 회차 완료 정정",
          "record_only/reject_effect는 수행 상태를 바꾸지 않습니다. correction_link는 현재 유효 in_progress 회차·본인 소유/source/CAS와 검증 가능한 기존 normalizedOccurredAt만 명시 확인하여 별도 correction audit로 연결합니다. 새 correctedAt 입력·과거 인계/종료 회차 복구·ready/검수/수익 생성은 금지합니다. 격리 원 이벤트는 그대로 보존됩니다. 응답 effectiveAt/recordedAt은 관리자 결정 시각이며 물리 완료 정본은 attempt.fieldCompletedAt입니다. 판정 receipt도 lease 발급 기준 90일 안에서만 보존합니다.",
          "admin",
          "OfflineResolutionResult",
        ),
        parameters: [
          idempotencyHeader,
          {
            name: "quarantineId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OfflineResolutionRequest" },
            },
          },
        },
      },
    },
    "/v1/attempts/lifecycle-impact": {
      get: {
        ...lifecycleOperation(
          "getAttemptLifecycleImpact",
          "관리자 수행 수명주기 영향 조회",
          "현재 assignment 한 건의 attempt, 계정 lifecycle version, target version 및 제한 권한 metadata만 조회합니다. 명령 전에 CAS 입력을 확보하고 최신 값을 다시 확인합니다. business admin 전용이며 무제한 목록·PII 조회가 아닙니다.",
          "admin",
          "AttemptLifecycleImpact",
        ),
        parameters: [
          {
            name: "assignmentId",
            in: "query",
            required: true,
            schema: { type: "string", format: "uuid" },
            description:
              "명령을 검토할 현재 통보 배정 한 건. 추가·중복 query는 거부합니다.",
          },
        ],
      },
    },
    "/v1/attempts/{attemptId}/lifecycle": {
      post: {
        ...lifecycleOperation(
          "manageAttemptLifecycle",
          "관리자 수행 중단·인계 및 제한 권한 결정",
          "active business admin이 영향 조회의 CAS로 현재 한 건 2시간 마무리, 완료 뒤 24시간 업로드·제출 권한, 즉시 중단·인계, 만료된 미착수 scheduled 해소 중 하나를 명시합니다. TTL은 서버가 고정하며 연장 입력은 없습니다. 인계의 새 일정은 현재 예약/source/점유로 재검증하고 새 maid 시작 검증도 유지합니다. 재청소의 다른 maid 인계는 금지합니다. 일반 계정 변경의 Auth ban/session 폐기 경로를 재사용하지 않습니다. 사진·제출 API는 아직 구현하지 않습니다.",
          "admin",
          "AttemptLifecycleResult",
        ),
        parameters: [idempotencyHeader, attemptPathParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AttemptLifecycleRequest" },
            },
          },
        },
      },
    },
    "/v1/limited/attempts/{attemptId}": {
      get: {
        ...lifecycleOperation(
          "getLimitedAttempt",
          "본인 제한 수행 범위 조회",
          "기존 Supabase Auth 사용자와 유효 세션, 최신 maid profile, 정확한 attempt/revision, 미만료 DB capability를 모두 확인합니다. active(인계 뒤 증빙 범위)·deactivation_pending·upload_only만 후보이며 상태만으로 허용하지 않습니다. 별도 bearer capability token을 발급하지 않고 PIN·사진·현재 target 상세를 노출하지 않습니다. upload/validate/submit allowedActions는 후속 계약이며 실행 endpoint가 아닙니다.",
          "maid",
          "LimitedAttempt",
        ),
        parameters: [
          attemptPathParameter,
          {
            name: "assignmentRevision",
            in: "query",
            required: true,
            schema: {
              type: "integer",
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            description:
              "제한 권한에 동결된 배정 revision. 추가·중복 query는 거부합니다.",
          },
        ],
      },
    },
    "/v1/limited/attempts/{attemptId}/complete-field-work": {
      post: {
        ...lifecycleOperation(
          "completeLimitedFieldWork",
          "현재 한 건 제한 권한으로 물리 완료",
          "finish_current의 2시간 hard expiry 안에서 본인 in_progress 한 건만 완료합니다. 현재 세션·권한·revision·execution CAS를 transaction에서 재검증합니다. 성공 후 execution capability를 종료하고 upload_only로 전환합니다. 응답 유실 뒤 동일 요청 receipt replay는 허용하지만 TTL 연장·새 수행 권한을 만들지 않습니다. revoked session은 replay도 차단합니다. 사진은 선행조건이 아니며 제출·검수·ready·earning을 생성하지 않습니다.",
          "maid",
          "LimitedAttemptLifecycleResult",
        ),
        parameters: [idempotencyHeader, attemptPathParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AttemptExecutionRequest" },
            },
          },
        },
      },
    },
    "/v1/attempts/current": {
      get: {
        tags: ["Attempts"],
        operationId: "getCurrentAttempt",
        summary: "본인 통보 배정의 수행 회차와 CAS version 조회",
        description:
          "비밀번호 변경을 완료한 active maid 전용입니다. 정확한 본인 current/notified assignmentId 한 건만 조회하며 attempt 활성화 전에는 null을 반환합니다. 미통보·종료 배정·다른 메이드·존재하지 않는 배정은 ATTEMPT_ACCESS_REQUIRED로 차단합니다. 목록/history API가 아니며 현재 객실·PIN·고객명·사진 snapshot은 반환하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["maid"],
        parameters: [
          {
            name: "assignmentId",
            in: "query",
            required: true,
            schema: { type: "string", format: "uuid" },
            description:
              "본인에게 실제 통보된 현재 assignment revision ID. 중복·추가 query는 금지합니다.",
          },
        ],
        responses: {
          "200": {
            description: "허용된 배정의 수행 회차 또는 활성화 대기 null",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["attempt"],
                  properties: {
                    attempt: {
                      anyOf: [
                        { $ref: "#/components/schemas/AttemptExecution" },
                        { type: "null" },
                      ],
                    },
                  },
                },
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
    "/v1/attempts/{attemptId}/start": {
      post: attemptMutationOperation(
        "startCleaning",
        "온라인 현장 청소 시작",
        "active maid 본인의 현재 통보 배정과 scheduled attempt만 시작합니다. executionVersion·assignment ID/revision CAS와 최신 접근 시각·source·실제 점유를 DB에서 검증하며 한 메이드의 in_progress는 최대 한 건입니다. 온라인 시작만 허용하고 lease/PIN/사진/오프라인 claim을 발급하지 않습니다. 같은 Idempotency-Key와 같은 본문은 기존 결과를 replay하고 다른 본문은 IDEMPOTENCY_KEY_REUSED입니다.",
      ),
    },
    "/v1/attempts/{attemptId}/complete-field-work": {
      post: attemptMutationOperation(
        "completeFieldWork",
        "물리적인 현장 청소 완료 선언",
        "active maid 본인의 현재 통보 배정에 연결된 in_progress attempt만 field_completed로 전이합니다. 사진은 선행조건이 아니며 사진 완전성은 이후 submission gate입니다. 이미 적법하게 시작한 수행은 자정·마감 경과·정상 checkout만으로 완료를 막지 않지만 최신 권한·취소 여부·assignment identity·execution CAS는 다시 검증합니다. room ready·검수 승인·earning·payroll·submission·upload capability는 생성하지 않습니다. client timestamp와 임의 payload는 금지하며 같은 요청 재시도는 성공 receipt를 replay합니다.",
      ),
    },
    "/v1/assignments": {
      get: {
        tags: ["Assignments"],
        operationId: "listAssignments",
        summary: "서비스 날짜별 청소 배정 조회",
        description:
          "비밀번호 변경을 완료한 active business admin은 날짜 전체를, active maid는 본인에게 실제 통보된 revision만 조회합니다. includeHistory=false가 기본이며 현재 통보 배정만 반환합니다. true이면 본인의 과거 실제 통보된 superseded revision도 포함하지만 미통보 draft와 다른 메이드의 revision은 숨깁니다. developer는 업무 배정을 조회할 수 없습니다.",
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
            description:
              "종료된 과거 immutable revision 포함 여부. maid는 본인에게 실제 통보된 과거 revision만 포함하며 target의 모든 이력을 조회하는 권한이 아닙니다.",
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
          "active business admin은 전체 revision을 조회하고 active maid는 본인에게 실제 통보된 revision만 조회합니다. 과거 superseded revision도 통보 사실이 있으면 읽기 전용으로 보존합니다. 한 번 통보받은 target이라도 미통보 draft·다른 메이드의 revision·현재 target version은 공개하지 않습니다. 본인의 실제 통보 이력이 없으면 ASSIGNMENT_ACCESS_REQUIRED입니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [
          {
            name: "cleaningTargetId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "청소 대상 ID",
          },
        ],
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
    "/v1/assignments/preview": {
      post: {
        tags: ["Assignments"],
        operationId: "previewAssignments",
        summary: "동선 고려 랜덤 배정 초안 계산",
        description:
          "비밀번호 변경을 완료한 active business admin 전용입니다. KST 오늘/내일만 허용합니다. 확정 duration policy가 없으면 ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED(409)로 실패하며 데모 시간은 사용하지 않습니다. 성공 preview는 assignment/attempt/audit/receipt/알림을 만들지 않습니다. 기존 고정 workload를 보존하고 완료 객실 수 → 요금 격차/편차 → 구역/호수 → seed 동률 순서로 비교합니다. 저장과 통보는 기존 draft/commit API에서 CAS를 다시 검증해야 합니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AssignmentPreviewRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "저장되지 않은 배정 초안",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AssignmentPreviewResult",
                },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "409": {
            description: "청소시간 미확정: 결정 불가이며 제안은 항상 빈 배열",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AssignmentPreviewUnconfirmed",
                },
              },
            },
          },
          "422": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/assignment-preview/duration-policy": {
      get: {
        tags: ["Assignments"],
        operationId: "getAssignmentDurationPolicy",
        summary: "현재 확정 청소시간 정책 조회",
        description:
          "active business admin 전용. 미확정 상태는 durationPolicy=null입니다. 데모 55/65/70/80분을 운영값으로 승격하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        responses: {
          "200": {
            description: "현재 확정 정책 또는 null",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AssignmentDurationPolicyEnvelope",
                },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "500": errorResponse,
        },
      },
      post: {
        tags: ["Assignments"],
        operationId: "confirmAssignmentDurationPolicy",
        summary: "네 객실 타입의 청소시간 정책을 함께 확정",
        description:
          "active business admin 전용 별도 config command입니다. 4개 positive integer를 완전하게 입력하고 expectedVersion(최초 0), Idempotency-Key로 CAS/재시도를 검증합니다. 과거 정책을 보존하고 새 version과 안전한 감사 이벤트를 생성합니다. preview 계산에서는 호출하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AssignmentDurationPolicyRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "확정 정책",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AssignmentDurationPolicyEnvelope",
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
    "/v1/assignments/commit-impact": {
      get: {
        tags: ["Assignments"],
        operationId: "getAssignmentCommitImpact",
        summary: "청소 배정 알림 확정 사전 영향도 조회",
        description:
          "비밀번호 변경을 완료한 active business admin 전용입니다. 오늘/내일 서비스 날짜의 현재 draft를 최신 객실 일정·메이드 상태·가능일 version과 다시 대조합니다. 예약 저장 시 생성된 미래 checkout 계획도 포함하지만 실제 checkout 전 attempt/PIN/현장 시작은 금지됩니다. 일정 변경으로 stale이 된 draft는 재저장하고 통보된 계획은 explicit replan해야 합니다. 응답 fingerprint는 POST /v1/assignments/commit의 optimistic concurrency gate이며 이 조회는 상태를 변경하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [
          {
            name: "serviceDate",
            in: "query",
            required: true,
            schema: { type: "string", format: "date" },
            description: "KST 기준 오늘 또는 내일인 서비스 날짜",
          },
        ],
        responses: {
          "200": assignmentCommitImpactResponse(),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "409": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/assignments/commit": {
      post: {
        tags: ["Assignments"],
        operationId: "commitAndNotifyAssignments",
        summary: "선택한 청소 배정 알림 확정",
        description:
          "비밀번호 변경을 완료한 active business admin 전용입니다. preflight fingerprint와 선택한 draft의 assignment/availability version을 모두 재검증한 뒤 선택 부분집합을 단일 transaction으로 notified 상태로 전환하고 메이드 notification 및 persistent outbox를 기록합니다. 일부 항목만 실패하는 처리는 없으며 attempt나 외부 네트워크 호출은 생성하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AssignmentCommitRequest" },
            },
          },
        },
        responses: {
          "200": assignmentCommitResultResponse(),
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "409": errorResponse,
          "500": errorResponse,
        },
      },
    },
    "/v1/push-subscriptions": {
      post: {
        tags: ["Push Subscriptions"],
        operationId: "registerWebPushSubscription",
        summary: "본인 Web Push 구독 등록·회전",
        description:
          "비밀번호 변경을 완료한 active admin/maid와 현재 live Auth session만 허용합니다. 먼저 config에서 받은 actor/session-bound bindingProof를 그대로 보내야 하며 client가 keyVersion을 선택할 수 없습니다. 최초 등록과 exact replay는 expectedCurrent 없이, endpoint·key·session 변경은 현재 subscriptionId/version CAS와 함께 요청합니다. live session당 1개, profile당 5개, 동일 endpoint 전역 1개이며 다른 profile 충돌은 소유자 정보 없이 409입니다. endpoint와 key는 응답·로그·감사에 노출되지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/WebPushSubscriptionRegisterRequest",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "등록 또는 회전된 안전한 logical subscription",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WebPushSubscriptionEnvelope",
                },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "409": errorResponse,
          "429": errorResponse,
          "500": errorResponse,
          "503": errorResponse,
        },
      },
    },
    "/v1/push-subscriptions/config": {
      get: {
        tags: ["Push Subscriptions"],
        operationId: "getWebPushSubscriptionConfig",
        summary: "현재 Web Push 공개 VAPID 설정 조회",
        description:
          "비밀번호 변경을 완료한 active admin/maid의 live Auth session에만 현재 서버 선택 VAPID 공개키와 10분짜리 actor/profile/session-bound opaque bindingProof를 반환합니다. client는 keyVersion을 등록 요청에 보내거나 선택하지 않습니다. rotation 뒤에도 proof version이 prior public keyring에 남은 동안 같은 proof replay가 가능합니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        responses: {
          "200": {
            description: "현재 공개 VAPID key version과 공개키",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "keyVersion",
                    "publicKey",
                    "bindingProof",
                    "proofExpiresAt",
                  ],
                  properties: {
                    keyVersion: {
                      type: "string",
                      pattern: "^[A-Za-z0-9._-]{1,32}$",
                    },
                    publicKey: {
                      type: "string",
                      description:
                        "canonical base64url P-256 uncompressed public key",
                    },
                    bindingProof: {
                      type: "string",
                      minLength: 1,
                      maxLength: 2048,
                      description:
                        "actor/profile/live session과 공개키 identity·발급/만료를 HMAC으로 결합한 opaque proof",
                    },
                    proofExpiresAt: { type: "string", format: "date-time" },
                  },
                },
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
    "/v1/push-subscriptions/{subscriptionId}/retire": {
      post: {
        tags: ["Push Subscriptions"],
        operationId: "retireWebPushSubscription",
        summary: "본인 Web Push 구독 폐기",
        description:
          "현재 version CAS로 본인 logical subscription을 영구 retired 처리하고 같은 transaction에서 current ciphertext를 crypto-shred합니다. 동일 명령 재시도는 최초 retiredAt을 반환하며 resurrect는 금지됩니다. unknown과 다른 소유자의 ID는 같은 404입니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [{
          name: "subscriptionId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "폐기할 본인 logical subscription ID",
        }, idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/WebPushSubscriptionRetireRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "최초 retiredAt이 보존된 안전한 logical subscription",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WebPushSubscriptionEnvelope",
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
      },
    },
    "/v1/notifications": {
      get: {
        tags: ["Notifications"],
        operationId: "listNotifications",
        summary: "본인 알림함 조회",
        description:
          "active admin/maid가 본인 수신 알림만 occurredAt, id 내림차순 keyset으로 조회합니다. limit 기본 50, 최대 100이며 opaque cursor는 actor ID·role·stream·고정 sort에 서명됩니다. dedupeKey, groupKey, 수신자 및 내부 actor/session 정보는 반환하지 않고 전체 응답은 UTF-8 JSON 128 KiB로 제한됩니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            description: "알림 page 크기. DB도 최대 100을 독립 강제합니다.",
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 1024 },
            description:
              "직전 응답 nextCursor의 opaque 서명값. 해석하거나 다른 사용자·역할·stream에 재사용하지 않습니다.",
          },
        ],
        responses: {
          "200": {
            description: "본인 알림의 안전한 bounded projection",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/NotificationListEnvelope",
                },
              },
            },
          },
          "400": complaintErrorResponse,
          "401": complaintErrorResponse,
          "403": complaintErrorResponse,
          "500": complaintErrorResponse,
          "503": complaintErrorResponse,
        },
      },
    },
    "/v1/notifications/{notificationId}/read": {
      post: {
        tags: ["Notifications"],
        operationId: "markNotificationRead",
        summary: "본인 알림 읽음 처리",
        description:
          "경로의 알림이 현재 actor 본인 수신분일 때만 서버 시각으로 최초 readAt을 기록합니다. 재시도와 동시 호출은 같은 최초 readAt을 반환하며 client timestamp, unread 복귀, content/resolution 변경은 허용하지 않습니다. 다른 수신자의 ID도 NOTIFICATION_NOT_FOUND로 응답합니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [{
          name: "notificationId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "읽음 처리할 본인 알림 ID",
        }],
        responses: {
          "200": {
            description: "최초 readAt이 보존된 알림 projection",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NotificationEnvelope" },
              },
            },
          },
          "400": complaintErrorResponse,
          "401": complaintErrorResponse,
          "403": complaintErrorResponse,
          "404": complaintErrorResponse,
          "500": complaintErrorResponse,
        },
      },
    },
    "/v1/complaints": {
      get: {
        tags: ["Complaints"],
        operationId: "listComplaints",
        summary: "컴플레인 목록 조회",
        description:
          "비밀번호 변경을 완료한 active admin은 전체, active maid는 본인 원 청소에 연결된 사건만 조회합니다. from/to는 반열린 RFC 3339 구간이며 최대 31일, limit은 최대 100입니다. opaque cursor는 actor·기간·정렬에 서명되고 전체 응답은 128 KiB로 제한됩니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [
          {
            name: "from",
            in: "query",
            required: true,
            schema: { type: "string", format: "date-time" },
            description: "조회 시작 시각(포함)",
          },
          {
            name: "to",
            in: "query",
            required: true,
            schema: { type: "string", format: "date-time" },
            description: "조회 종료 시각(미포함), from부터 최대 31일",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            description: "DB에서도 강제하는 page 크기",
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 1024 },
            description:
              "동일 actor·기간에서만 유효한 opaque continuation. 빈 값·변조·scope 불일치는 INVALID_COMPLAINT_CURSOR(400)입니다.",
          },
        ],
        responses: {
          "200": {
            description: "안전한 current projection의 bounded page",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ComplaintListEnvelope" },
              },
            },
          },
          "400": complaintErrorResponse,
          "401": complaintErrorResponse,
          "403": complaintErrorResponse,
          "500": complaintErrorResponse,
          "503": complaintErrorResponse,
        },
      },
      post: {
        tags: ["Complaints"],
        operationId: "createComplaint",
        summary: "승인된 원 청소 컴플레인 접수",
        description:
          "active business admin이 원 수익 ID만 전달하면 서버가 room/target/attempt/submission/approved inspection/maid를 실제 FK로 확정합니다. 승인 후 30일 경계를 포함하며 자유문·고객정보·PIN·사진 locator는 입력할 수 없습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ComplaintCreateRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "원자적으로 접수된 사건 또는 동일 receipt replay",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ComplaintEnvelope" },
              },
            },
          },
          "400": complaintErrorResponse,
          "401": complaintErrorResponse,
          "403": complaintErrorResponse,
          "404": complaintErrorResponse,
          "409": complaintErrorResponse,
          "500": complaintErrorResponse,
        },
      },
    },
    "/v1/complaints/{complaintId}": {
      get: {
        tags: ["Complaints"],
        operationId: "getComplaint",
        summary: "컴플레인 current projection 조회",
        description:
          "active admin 또는 사건의 원 담당 maid만 현재 상태·판정·단일 응답을 조회합니다. 자유문 고객정보와 증빙 locator는 반환하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [photoPathId("complaintId")],
        responses: {
          "200": {
            description: "권한 범위의 current projection",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ComplaintEnvelope" },
              },
            },
          },
          "401": complaintErrorResponse,
          "403": complaintErrorResponse,
          "404": complaintErrorResponse,
          "500": complaintErrorResponse,
        },
      },
    },
    "/v1/complaints/{complaintId}/history": {
      get: {
        tags: ["Complaints"],
        operationId: "listComplaintHistory",
        summary: "컴플레인 불변 이력 조회",
        description:
          "active admin 또는 원 담당 maid가 append-only event·decision·response 이력을 eventId 내림차순 keyset으로 조회합니다. limit은 최대 100이며 cursor는 actor와 complaint ID에 서명됩니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [
          photoPathId("complaintId"),
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            description: "이력 page 크기",
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 1024 },
            description:
              "동일 actor·사건 전용 continuation. 빈 값·변조·scope 불일치는 INVALID_COMPLAINT_CURSOR(400)입니다.",
          },
        ],
        responses: {
          "200": {
            description: "bounded append-only history page",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ComplaintHistoryEnvelope",
                },
              },
            },
          },
          "400": complaintErrorResponse,
          "401": complaintErrorResponse,
          "403": complaintErrorResponse,
          "404": complaintErrorResponse,
          "500": complaintErrorResponse,
          "503": complaintErrorResponse,
        },
      },
    },
    "/v1/complaints/{complaintId}/review": {
      post: {
        tags: ["Complaints"],
        operationId: "startComplaintReview",
        summary: "컴플레인 검토 시작",
        description:
          "active business admin이 expectedVersion CAS와 멱등성 키로 received 사건을 under_review로 전이합니다. 사건 원천과 과거 event는 변경하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [photoPathId("complaintId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ComplaintCasRequest" },
            },
          },
        },
        responses: complaintMutationResponses(),
      },
    },
    "/v1/complaints/{complaintId}/decision": {
      post: {
        tags: ["Complaints"],
        operationId: "decideComplaint",
        summary: "컴플레인 최초 판정",
        description:
          "active business admin이 finding, 평가 전용 penaltyScore 0..10, reworkRequired를 불변 decision version으로 기록합니다. 벌점은 수익·주급·정정 원장을 자동 변경하지 않으며 최초 판정부터 7일 응답 창이 열립니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [photoPathId("complaintId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ComplaintDecisionRequest" },
            },
          },
        },
        responses: complaintMutationResponses(),
      },
    },
    "/v1/complaints/{complaintId}/response": {
      post: {
        tags: ["Complaints"],
        operationId: "respondComplaint",
        summary: "담당 메이드 판정 확인 또는 이의",
        description:
          "active 원 담당 maid만 최초 current decision 후 7일 경계를 포함해 정확히 한 번 acknowledged 또는 source-controlled appeal을 제출합니다. finding·벌점·재작업 판정은 변경할 수 없습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["maid"],
        parameters: [photoPathId("complaintId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ComplaintResponseRequest" },
            },
          },
        },
        responses: complaintMutationResponses(),
      },
    },
    "/v1/complaints/{complaintId}/close": {
      post: {
        tags: ["Complaints"],
        operationId: "closeComplaint",
        summary: "컴플레인 종결",
        description:
          "active business admin만 확인 완료 사건, correction으로 해결된 이의 사건, 또는 7일 응답 창이 지난 미응답 사건을 종결합니다. closed 사건을 reopen하는 API는 존재하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [photoPathId("complaintId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ComplaintCasRequest" },
            },
          },
        },
        responses: complaintMutationResponses(),
      },
    },
    "/v1/complaints/{complaintId}/corrections": {
      post: {
        tags: ["Complaints"],
        operationId: "correctComplaintDecision",
        summary: "컴플레인 판정 정정 version 추가",
        description:
          "active business admin이 현재 판정을 priorDecisionId로 가리키는 correction version을 append하고 pointer만 CAS 교체합니다. closed 상태는 유지되고 새 응답 창·수익·주급·자동 재작업 side effect는 생기지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [photoPathId("complaintId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ComplaintDecisionRequest" },
            },
          },
        },
        responses: complaintMutationResponses(),
      },
    },
    "/v1/complaints/{complaintId}/rework": {
      post: {
        tags: ["Complaints"],
        operationId: "materializeComplaintRework",
        summary: "확정 컴플레인 재작업·보상 결정 생성",
        description:
          "active business admin이 current confirmed+rework decision과 expectedVersion을 CAS 검증해 게시된 재청소 템플릿, 안전한 현재 접근 창, notified assignment, immutable compensation decision을 원자적으로 확정합니다. client는 일정이나 금액 snapshot을 지정할 수 없습니다. 같은 원 maid는 금액 0이고 earning이 없으며, 다른 active maid는 승인 후 0원 포함 typed entitlement와 earning이 정확히 한 번 생성됩니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [photoPathId("complaintId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ComplaintReworkRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "원자적으로 고정된 재작업 결정과 notified assignment",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ComplaintReworkEnvelope",
                },
              },
            },
          },
          "400": complaintErrorResponse,
          "401": complaintErrorResponse,
          "403": complaintErrorResponse,
          "404": complaintErrorResponse,
          "409": complaintErrorResponse,
          "500": complaintErrorResponse,
        },
      },
    },

    "/v1/payroll": {
      get: {
        tags: ["Payroll"],
        operationId: "listPayrollCycles",
        summary: "종료 주차의 메이드별 주급 조회",
        description:
          "비밀번호 변경을 완료한 active admin은 전체 또는 선택 메이드를, active maid는 본인만 조회합니다. cycle이 아직 없으면 쓰기 없이 cycleId=null, version=0인 conceptual OPEN을 반환합니다. admin 전체 조회는 maidProfileId 오름차순 keyset cursor이며 page 최대 10개입니다. opaque cursor는 actor 역할/ID, weekStart, 적용된 maid filter, 고정 sort와 stream kind에 묶여 있으므로 저장한 URL 전체를 그대로 이어서 사용해야 합니다. 각 cycle의 items/lateEarnings는 최대 10개 preview이며 정확한 count/amount 합계와 별도 continuation을 제공합니다. 모든 payroll HTTP 응답은 UTF-8 JSON 128 KiB 상한을 초과하면 실패합니다. totalAmount는 현재 OPEN에 편입 가능한 확정 수익이며 검수 대기 예상액을 포함하지 않습니다. PAYING 이후 늦게 확정된 수익은 lateEarnings로 분리하며 lockedAmount를 바꾸지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [
          {
            name: "weekStart",
            in: "query",
            required: true,
            schema: { type: "string", format: "date" },
            description: "KST 기준 월요일인 종료 주차 시작일",
          },
          {
            name: "maidProfileId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
            description: "admin 선택 필터. maid는 본인 ID만 허용됩니다.",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 10, default: 10 },
            description:
              "cycle page 크기. 10진 양의 정수만 허용되며 DB도 최대 10을 독립 강제합니다.",
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 1024 },
            description:
              "직전 응답 nextCursor의 opaque 서명값. 해석하거나 다른 사용자/주차/필터에 재사용하지 않습니다.",
          },
        ],
        responses: {
          "200": {
            description: "확정 earning만 포함한 주급 projection",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PayrollListEnvelope" },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "500": errorResponse,
          "503": errorResponse,
        },
      },
    },
    "/v1/payroll/entries": {
      get: {
        tags: ["Payroll"],
        operationId: "listPayrollEntries",
        summary: "주급 item 또는 늦은 확정 수익 연속 조회",
        description:
          "cycle preview의 itemsNextCursor 또는 lateEarningsNextCursor를 사용해 earnedOn, earningId 오름차순 keyset으로 이어서 조회합니다. limit 기본 25, 최대 50이며 OFFSET을 사용하지 않습니다. cursor는 actor 역할/ID, weekStart, maidProfileId, kind와 고정 sort에 서명되어 scope가 달라지거나 위변조되면 거부됩니다. 전체 응답은 UTF-8 JSON 128 KiB 상한을 적용합니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin", "maid"],
        parameters: [
          {
            name: "weekStart",
            in: "query",
            required: true,
            schema: { type: "string", format: "date" },
            description: "KST 기준 월요일인 종료 주차 시작일",
          },
          {
            name: "maidProfileId",
            in: "query",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "조회 대상 메이드. maid는 본인 ID만 허용됩니다.",
          },
          {
            name: "kind",
            in: "query",
            required: true,
            schema: {
              type: "string",
              enum: ["items", "lateEarnings", "adjustments"],
            },
            description:
              "items, lateEarnings, adjustments는 서로 다른 cursor stream입니다.",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 50, default: 25 },
            description: "상세 page 크기. DB도 최대 50을 독립 강제합니다.",
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 1024 },
            description: "동일 scope 직전 응답의 opaque nextCursor",
          },
        ],
        responses: {
          "200": {
            description: "최대 50개의 주급 상세 keyset page",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PayrollEntriesEnvelope" },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "500": errorResponse,
          "503": errorResponse,
        },
      },
    },
    "/v1/payroll/start": {
      post: {
        tags: ["Payroll"],
        operationId: "startPayrollCycle",
        summary: "OPEN 주급을 PAYING snapshot으로 잠금",
        description:
          "비밀번호 변경을 완료한 active business admin 전용입니다. 종료된 주차의 아직 claim되지 않은 positive earning을 서버가 계산해 원자적으로 잠급니다. 응답과 동일 command replay는 정확한 합계와 최대 10개 nested preview/continuation만 반환하며 UTF-8 JSON 128 KiB 상한을 적용합니다. 응답은 지급 처리 시작 상태일 뿐 실제 송금 성공이 아닙니다. amount나 earning ID는 클라이언트가 입력할 수 없습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PayrollStartRequest" },
            },
          },
        },
        responses: {
          "200": {
            description:
              "원자적으로 잠긴 PAYING snapshot 또는 동일 command replay",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PayrollCycleEnvelope" },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "500": errorResponse,
          "503": errorResponse,
        },
      },
    },
    "/v1/payroll/adjustments/corrections": {
      post: {
        tags: ["Payroll"],
        operationId: "recordPayrollCorrection",
        summary: "signed 주급 정정 원장 추가",
        description:
          "active password-complete business admin만 실제 선행 earning 또는 adjustment를 typed source로 지정합니다. amount는 0이 아닌 정수 KRW이고, 음수여도 root 누적 지급 권리를 0원 미만으로 만들 수 없습니다. reasonCode는 서버가 source에 따라 고정하며 자유문을 받지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PayrollCorrectionRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "immutable correction",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PayrollAdjustmentEnvelope",
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
      },
    },
    "/v1/payroll/adjustments/reversals": {
      post: {
        tags: ["Payroll"],
        operationId: "reversePayrollSource",
        summary: "선행 원장의 미반전 전액 반전",
        description:
          "source earning/adjustment 금액의 정확한 반대 부호를 서버가 계산합니다. source별 1회만 가능하고 partial reversal은 허용하지 않습니다. reversal-of-reversal도 같은 immutable exact-inverse chain과 root cumulative floor를 따릅니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PayrollReversalRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "immutable full reversal",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PayrollAdjustmentEnvelope",
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
      },
    },
    "/v1/payroll/carry-forward": {
      post: {
        tags: ["Payroll"],
        operationId: "carryForwardPayrollCycle",
        summary: "0원 이하 OPEN 주차 상계·순차 이월",
        description:
          "net payable이 0원 이하일 때만 immutable offset settlement를 기록하고 cycle version을 증가시킵니다. payment event는 만들지 않으며 net 0이면 residual row도 없습니다. 음수 residual은 정확히 다음 KST week에만 한 번 적용되고 더 늦은 주차 선점은 거부됩니다. offset-settled cycle은 status=open을 유지하지만 경제적으로 동결됩니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PayrollStartRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "offset-settled projection",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PayrollCycleEnvelope" },
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
      },
    },
    "/v1/payroll/late-earnings/{earningId}/carry": {
      post: {
        tags: ["Payroll"],
        operationId: "carryLatePayrollEarning",
        summary: "동결 주차의 늦은 earning을 다음 주차로 명시 이월",
        description:
          "PAID 또는 offset-settled cycle의 아직 claim되지 않은 positive earning을 원본 변경 없이 unique late_earning_carry adjustment로 정확히 다음 주차에 반영합니다. PAYING/CHECK에서는 #103 결과 전 fail-closed합니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [
          {
            name: "earningId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          idempotencyHeader,
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PayrollLateCarryRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "server-derived late earning carry adjustment",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PayrollAdjustmentEnvelope",
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
      },
    },
    "/v1/payroll/payment-attempts/{attemptId}/check": {
      post: {
        tags: ["Payroll"],
        operationId: "recordPayrollPaymentCheck",
        summary: "외부 송금 결과 불확실 CHECK 기록",
        description:
          "active password-complete business admin이 현재 PAYING attempt에 고정 코드 TRANSFER_RESULT_UNCERTAIN만 기록합니다. 외부 provider 호출이나 자유문·증빙 업로드는 하지 않으며 immutable 결과, audit, 알림/outbox가 한 transaction에 기록됩니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [photoPathId("attemptId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/PayrollPaymentCheckRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "immutable CHECK result",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PayrollPaymentResultEnvelope",
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
      },
    },
    "/v1/payroll/payment-attempts/{attemptId}/paid": {
      post: {
        tags: ["Payroll"],
        operationId: "recordPayrollPaymentPaid",
        summary: "외부 전액 송금 완료 PAID 기록",
        description:
          "POST 자체가 현재 PAYING/CHECK attempt의 잠긴 양수 KRW 전액 외부 송금 완료 attestation입니다. client는 amount·paidAt·계좌·수취인·영수증을 보내지 않습니다. paymentMethod는 bank_transfer만, providerReferenceId는 현재 미확정 은행 형식을 대신하는 fail-closed ASCII 계약이며 서버가 uppercase canonical로 저장합니다. 시스템은 provider HTTP를 호출하지 않습니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [photoPathId("attemptId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/PayrollPaymentPaidRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "immutable full-payment result",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PayrollPaymentResultEnvelope",
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
      },
    },
    "/v1/payroll/payment-attempts/{attemptId}/reopen": {
      post: {
        tags: ["Payroll"],
        operationId: "reopenPayrollPaymentAttempt",
        summary: "송금 없음 확인 후 OPEN 재개",
        description:
          "PAYING/CHECK에서 외부 송금이 없음을 확인한 active business admin만 고정 코드 NO_TRANSFER_CONFIRMED로 OPEN에 되돌립니다. PAID는 재개할 수 없고, 다음 지급 시작은 새 immutable attempt를 생성합니다.",
        security: [{ bearerAuth: [] }],
        "x-required-roles": ["admin"],
        parameters: [photoPathId("attemptId"), idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/PayrollPaymentReopenRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "immutable no-transfer reopen result",
            headers: { "Cache-Control": noStoreHeader },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PayrollPaymentResultEnvelope",
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
        parameters: [
          {
            name: "roomId",
            in: "query",
            schema: { type: "string", format: "uuid" },
            description: "특정 객실의 예약만 조회하는 선택 필터",
          },
        ],
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
      BombRoomReportRequest: {
        type: "object",
        additionalProperties: false,
        required: ["evidencePhotoIds", "memo"],
        properties: {
          evidencePhotoIds: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            uniqueItems: true,
            items: { type: "string", format: "uuid" },
            description: "본인 attempt의 현재 verified 사진 version ID",
          },
          memo: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description:
              "검수용 신고 메모. audit/notification에는 복제되지 않습니다.",
          },
        },
      },
      CreateSubmissionRequest: {
        type: "object",
        additionalProperties: false,
        required: ["clientSubmissionId", "expectedRevision", "candleCount"],
        properties: {
          clientSubmissionId: { type: "string", format: "uuid" },
          expectedRevision: {
            type: "integer",
            minimum: 0,
            description: "최초0, 이후 current submission pointer revision CAS",
          },
          candleCount: { type: "integer", minimum: 0 },
        },
      },
      BombRoomDecisionRequest: {
        type: "object",
        additionalProperties: false,
        required: ["decision", "reasonCode"],
        properties: {
          decision: { type: "string", enum: ["approved", "rejected"] },
          reasonCode: {
            type: "string",
            enum: [
              "BOMB_CONFIRMED",
              "BOMB_NOT_CONFIRMED",
              "BOMB_EVIDENCE_INSUFFICIENT",
            ],
            description:
              "approved는 BOMB_CONFIRMED만, rejected는 나머지 두 코드만 허용합니다.",
          },
        },
      },
      InspectionDecisionRequest: {
        type: "object",
        additionalProperties: false,
        required: ["reasonCode"],
        properties: {
          reasonCode: {
            type: "string",
            enum: [
              "QUALITY_OK",
              "QUALITY_REWORK",
              "EVIDENCE_INCOMPLETE",
              "CLEANING_INCOMPLETE",
            ],
            description:
              "approve는 QUALITY_OK만, reject는 나머지 재작업 코드만 허용합니다.",
          },
        },
      },
      CleaningSubmission: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "attemptId",
          "version",
          "status",
          "submittedBy",
          "submittedAt",
          "currentRevision",
          "current",
          "photoCount",
          "candleCount",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          attemptId: { type: "string", format: "uuid" },
          version: { type: "integer", minimum: 1 },
          status: {
            type: "string",
            enum: ["submitted", "superseded", "approved", "rejected"],
          },
          submittedBy: { type: "string", format: "uuid" },
          submittedAt: { type: "string", format: "date-time" },
          currentRevision: { type: "integer", minimum: 1 },
          current: { type: "boolean" },
          photoCount: { type: "integer", minimum: 1, maximum: 100 },
          candleCount: { type: "integer", minimum: 0 },
          bombReportId: { type: ["string", "null"], format: "uuid" },
          bombDecision: {
            type: ["string", "null"],
            enum: ["approved", "rejected", null],
          },
          inspectionDecision: {
            type: ["string", "null"],
            enum: ["approved", "rejected", null],
          },
          inspectionReasonCode: { type: ["string", "null"] },
          decidedAt: { type: ["string", "null"], format: "date-time" },
          bombReport: {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "attemptId",
              "memo",
              "evidenceCount",
              "evidencePhotoIds",
              "reportedAt",
            ],
            properties: {
              id: { type: "string", format: "uuid" },
              attemptId: { type: "string", format: "uuid" },
              memo: { type: "string", minLength: 1, maxLength: 500 },
              evidenceCount: { type: "integer", minimum: 1, maximum: 20 },
              evidencePhotoIds: {
                type: "array",
                minItems: 1,
                maxItems: 20,
                uniqueItems: true,
                items: { type: "string", format: "uuid" },
                description:
                  "봉인된 증빙 photo version ID. 관리자만 기존 사진 content API에서 조회합니다.",
              },
              reportedAt: { type: "string", format: "date-time" },
            },
          },
          photos: {
            type: "array",
            maxItems: 100,
            description:
              "관리자 검수 상세에만 포함되는 immutable 제출 증빙 목록입니다. photoId는 기존 사진 content API 조회에 사용하며 provider locator/hash는 노출하지 않습니다.",
            items: { $ref: "#/components/schemas/SubmissionPhotoBinding" },
          },
          reviewContext: {
            $ref: "#/components/schemas/SubmissionReviewContext",
          },
        },
      },
      SubmissionPhotoBinding: {
        type: "object",
        additionalProperties: false,
        required: [
          "photoId",
          "targetPhotoSlotId",
          "slotKey",
          "label",
          "displayOrder",
          "required",
          "photoVersion",
        ],
        properties: {
          photoId: { type: "string", format: "uuid" },
          targetPhotoSlotId: { type: "string", format: "uuid" },
          slotKey: { type: "string" },
          label: { type: "string" },
          displayOrder: { type: "integer", minimum: 0, maximum: 99 },
          required: { type: "boolean" },
          photoVersion: { type: "integer", minimum: 1 },
        },
      },
      SubmissionReviewContext: {
        type: "object",
        additionalProperties: false,
        required: [
          "cleaningTargetId",
          "cleaningKind",
          "roomNumber",
          "serviceDate",
          "maidProfileId",
        ],
        properties: {
          cleaningTargetId: { type: "string", format: "uuid" },
          cleaningKind: {
            type: "string",
            enum: ["checkout", "stayover", "additional", "reclean"],
          },
          roomNumber: { type: "string" },
          serviceDate: { type: "string", format: "date" },
          maidProfileId: { type: "string", format: "uuid" },
        },
      },
      SubmissionEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["submission"],
        properties: {
          submission: { $ref: "#/components/schemas/CleaningSubmission" },
        },
      },
      SubmissionListEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["submissions"],
        properties: {
          submissions: {
            type: "array",
            maxItems: 100,
            items: { $ref: "#/components/schemas/CleaningSubmission" },
          },
        },
      },
      BombRoomReportEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["bombReport"],
        properties: {
          bombReport: {
            type: "object",
            additionalProperties: false,
            required: ["id", "attemptId", "evidenceCount", "reportedAt"],
            properties: {
              id: { type: "string", format: "uuid" },
              attemptId: { type: "string", format: "uuid" },
              evidenceCount: { type: "integer", minimum: 1, maximum: 20 },
              reportedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
      BombRoomDecisionEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["bombDecision"],
        properties: {
          bombDecision: {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "submissionId",
              "decision",
              "reasonCode",
              "decidedAt",
            ],
            properties: {
              id: { type: "string", format: "uuid" },
              submissionId: { type: "string", format: "uuid" },
              decision: { type: "string", enum: ["approved", "rejected"] },
              reasonCode: { type: "string" },
              decidedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
      InspectionDecisionEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["inspection"],
        properties: {
          inspection: {
            type: "object",
            additionalProperties: false,
            required: [
              "submissionId",
              "decisionId",
              "decision",
              "reasonCode",
              "decidedAt",
              "earningId",
              "recleanTargetId",
              "recleanAssignmentId",
            ],
            properties: {
              submissionId: { type: "string", format: "uuid" },
              decisionId: { type: "string", format: "uuid" },
              decision: { type: "string", enum: ["approved", "rejected"] },
              reasonCode: { type: "string" },
              decidedAt: { type: "string", format: "date-time" },
              earningId: { type: ["string", "null"], format: "uuid" },
              recleanTargetId: { type: ["string", "null"], format: "uuid" },
              recleanAssignmentId: {
                type: ["string", "null"],
                format: "uuid",
              },
            },
          },
        },
      },
      AttemptPhotoSlots: {
        type: "object",
        additionalProperties: false,
        required: ["attemptId", "assignmentId", "assignmentRevision", "slots"],
        properties: {
          attemptId: { type: "string", format: "uuid" },
          assignmentId: { type: "string", format: "uuid" },
          assignmentRevision: { type: "integer", minimum: 1 },
          slots: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "slotId",
                "slotKey",
                "required",
                "displayOrder",
                "currentRevision",
                "uploadStatus",
                "photoId",
              ],
              properties: {
                slotId: { type: "string", format: "uuid" },
                slotKey: { type: "string", pattern: "^[a-z][a-z0-9-]{0,79}$" },
                required: { type: "boolean" },
                displayOrder: { type: "integer", minimum: 0, maximum: 99 },
                currentRevision: { type: "integer", minimum: 0 },
                uploadStatus: {
                  type: "string",
                  enum: [
                    "missing",
                    "cleared",
                    "verified",
                    "pending",
                    "failed",
                    "purged",
                    "expired",
                  ],
                },
                photoId: {
                  anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
                  description:
                    "원본 읽기 권한이 있는 active 현재 회차+accepted+미만료 사진만 ID를 반환합니다. 업로드 전용 권한에는 null.",
                },
              },
            },
          },
        },
      },
      PhotoUploadResponse: {
        allOf: [
          { $ref: "#/components/schemas/PhotoUploadOperation" },
          { type: "object", required: ["quotaWarning"] },
        ],
        description:
          "초기 업로드와 동일 key 재시도 모두 quotaWarning을 반환합니다. quota raw 사용량/Google 계정 정보는 반환하지 않습니다.",
      },
      PhotoUploadOperation: {
        type: "object",
        additionalProperties: false,
        required: [
          "operationId",
          "objectId",
          "attemptId",
          "targetSlotId",
          "status",
          "leaseVersion",
          "leaseExpiresAt",
          "photoId",
          "photoVersion",
          "uploadedAt",
          "purgeAfter",
          "compensationAllowed",
        ],
        properties: {
          operationId: { type: "string", format: "uuid" },
          objectId: {
            type: "string",
            format: "uuid",
            description: "앱 object UUID이며 Google Drive ID가 아닙니다.",
          },
          attemptId: { type: "string", format: "uuid" },
          targetSlotId: { type: "string", format: "uuid" },
          status: {
            type: "string",
            enum: [
              "reserved",
              "provider_succeeded",
              "reconciliation_pending",
              "accepted",
              "compensation_pending",
              "compensated",
            ],
          },
          leaseVersion: { type: "integer", minimum: 0 },
          leaseExpiresAt: {
            anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
          },
          photoId: {
            anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
          },
          photoVersion: {
            anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
          },
          uploadedAt: {
            anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
            description:
              "서버가 identity/parent/MIME/size/SHA를 확인한 Google immutable createdTime. 클라이언트 촬영시각이 아닙니다.",
          },
          purgeAfter: {
            anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
            description:
              "uploadedAt+정확한7일. 응답 재전송/교체 시 연장되지 않습니다.",
          },
          compensationAllowed: {
            type: "boolean",
            description:
              "내부 fenced worker용 상태 표시입니다. 이 값은 클라이언트 삭제 capability가 아니며 공개 delete/worker endpoint는 없습니다.",
          },
          quotaWarning: {
            type: "boolean",
            description:
              "업로드 응답에서 필수. admission 기준 decimal10GB 이상 경고이며 raw 사용량은 노출하지 않습니다. 상태 조회에는 생략됩니다.",
          },
        },
      },
      AssignmentPreviewRequest: {
        type: "object",
        additionalProperties: false,
        required: ["serviceDate"],
        properties: {
          serviceDate: {
            type: "string",
            format: "date",
            description: "KST 오늘 또는 내일",
          },
          previewSeed: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9_-]{1,128}$",
            description:
              "동일 snapshot+seed 결과 재현용. 생략하면 서버 UUID 생성, 개인정보 입력 금지",
          },
        },
      },
      AssignmentPreviewUnconfirmed: {
        type: "object",
        additionalProperties: false,
        required: [
          "serviceDate",
          "previewSeed",
          "decisionReady",
          "durationPolicyStatus",
          "proposedAssignments",
          "error",
        ],
        properties: {
          serviceDate: { type: "string", format: "date" },
          previewSeed: { type: "string" },
          decisionReady: { const: false },
          durationPolicyStatus: { const: "unconfirmed" },
          proposedAssignments: {
            type: "array",
            maxItems: 0,
            items: { $ref: "#/components/schemas/AssignmentPreviewRow" },
          },
          error: {
            type: "object",
            additionalProperties: false,
            required: ["code", "message"],
            properties: {
              code: { const: "ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED" },
              message: { type: "string" },
            },
          },
        },
      },
      AssignmentDurationPolicyRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "expectedVersion",
          "standardMinutes",
          "premiumMinutes",
          "oceanPremiumMinutes",
          "oceanFamilyMinutes",
        ],
        properties: {
          expectedVersion: {
            type: "integer",
            minimum: 0,
            maximum: 9007199254740991,
          },
          standardMinutes: { type: "integer", minimum: 1, maximum: 2147483647 },
          premiumMinutes: { type: "integer", minimum: 1, maximum: 2147483647 },
          oceanPremiumMinutes: {
            type: "integer",
            minimum: 1,
            maximum: 2147483647,
          },
          oceanFamilyMinutes: {
            type: "integer",
            minimum: 1,
            maximum: 2147483647,
          },
        },
      },
      AssignmentDurationPolicy: {
        type: "object",
        additionalProperties: false,
        required: [
          "version",
          "status",
          "standardMinutes",
          "premiumMinutes",
          "oceanPremiumMinutes",
          "oceanFamilyMinutes",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          version: { type: "integer", minimum: 1 },
          status: { const: "confirmed" },
          standardMinutes: { type: "integer", minimum: 1 },
          premiumMinutes: { type: "integer", minimum: 1 },
          oceanPremiumMinutes: { type: "integer", minimum: 1 },
          oceanFamilyMinutes: { type: "integer", minimum: 1 },
          createdAt: { type: "string", format: "date-time" },
          confirmedAt: { type: "string", format: "date-time" },
        },
      },
      AssignmentDurationPolicyEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["durationPolicy"],
        properties: {
          durationPolicy: {
            anyOf: [
              { $ref: "#/components/schemas/AssignmentDurationPolicy" },
              {
                type: "null",
              },
            ],
          },
        },
      },
      AssignmentPreviewRow: {
        type: "object",
        additionalProperties: false,
        required: [
          "cleaningTargetId",
          "roomId",
          "roomNumber",
          "roomTypeCode",
          "elevatorZone",
          "maidProfileId",
          "maidDisplayName",
          "proposedSequenceNumber",
          "serviceDate",
          "expectedAssignmentVersion",
          "expectedAvailabilityVersion",
          "feeSnapshot",
          "durationMinutes",
          "availableFrom",
          "dueAt",
        ],
        properties: {
          cleaningTargetId: { type: "string", format: "uuid" },
          roomId: { type: "string", format: "uuid" },
          roomNumber: { type: "string" },
          roomTypeCode: {
            type: "string",
            enum: [
              "standard",
              "premium",
              "oceanPremium",
              "oceanFamily",
              "unknown",
            ],
          },
          elevatorZone: { type: "string" },
          maidProfileId: { type: "string", format: "uuid" },
          maidDisplayName: { type: "string" },
          proposedSequenceNumber: {
            type: "integer",
            minimum: 1,
            description:
              "고정 행에서는 기존 sequence, 신규 행은 고정 순서 이후 연속 번호",
          },
          serviceDate: { type: "string", format: "date" },
          expectedAssignmentVersion: { type: "integer", minimum: 1 },
          expectedAvailabilityVersion: {
            type: ["integer", "null"],
            minimum: 1,
          },
          feeSnapshot: { type: "integer", minimum: 0 },
          durationMinutes: {
            type: ["integer", "null"],
            minimum: 1,
            description:
              "신규 제안은 확정 정책의 양수 시간. 고정 업무의 미지원 타입은 null이며 해당 메이드 신규 제안을 차단합니다.",
          },
          availableFrom: { type: "string", format: "date-time" },
          dueAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      AssignmentPreviewBlockedTarget: {
        type: "object",
        additionalProperties: false,
        required: ["cleaningTargetId", "reason"],
        properties: {
          cleaningTargetId: { type: "string", format: "uuid" },
          reason: {
            type: "string",
            description: "서버의 source/capacity 고정 reason code",
          },
        },
      },
      AssignmentPreviewResult: {
        type: "object",
        additionalProperties: false,
        required: [
          "serviceDate",
          "previewSeed",
          "durationPolicy",
          "decisionReady",
          "inputFingerprint",
          "fixedAssignments",
          "proposedAssignments",
          "remainingUnassignedTargets",
          "blockedTargets",
          "maidSummaries",
          "objectiveScore",
        ],
        properties: {
          serviceDate: { type: "string", format: "date" },
          previewSeed: { type: "string" },
          durationPolicy: {
            $ref: "#/components/schemas/AssignmentDurationPolicy",
          },
          decisionReady: { const: true },
          inputFingerprint: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
            description:
              "seed를 제외한 정렬된 정책 입력 snapshot SHA-256; 최종 DB CAS 대체 불가",
          },
          fixedAssignments: {
            type: "array",
            maxItems: 242,
            items: { $ref: "#/components/schemas/AssignmentPreviewRow" },
          },
          proposedAssignments: {
            type: "array",
            maxItems: 121,
            items: { $ref: "#/components/schemas/AssignmentPreviewRow" },
          },
          remainingUnassignedTargets: {
            type: "array",
            maxItems: 121,
            items: {
              $ref: "#/components/schemas/AssignmentPreviewBlockedTarget",
            },
          },
          blockedTargets: {
            type: "array",
            maxItems: 242,
            items: {
              $ref: "#/components/schemas/AssignmentPreviewBlockedTarget",
            },
          },
          maidSummaries: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "maidProfileId",
                "totalFee",
                "fixedCount",
                "proposedCount",
              ],
              properties: {
                maidProfileId: { type: "string", format: "uuid" },
                totalFee: { type: "integer", minimum: 0 },
                fixedCount: { type: "integer", minimum: 0 },
                proposedCount: { type: "integer", minimum: 0 },
              },
            },
          },
          objectiveScore: {
            type: "object",
            additionalProperties: false,
            required: [
              "completedTargetCount",
              "feeSpread",
              "feeDeviation",
              "routeScore",
            ],
            properties: {
              completedTargetCount: { type: "integer", minimum: 0 },
              feeSpread: { type: "integer", minimum: 0 },
              feeDeviation: {
                type: "string",
                pattern: "^[0-9]+$",
                description:
                  "정수 편차 Σ(n*fee - Σfee)^2. 고정 workload 포함, float 오차 없이 decimal string 반환",
              },
              routeScore: {
                type: "object",
                additionalProperties: false,
                required: ["zoneChanges", "roomDistance"],
                properties: {
                  zoneChanges: { type: "integer", minimum: 0 },
                  roomDistance: { type: "integer", minimum: 0 },
                },
              },
            },
          },
        },
      },
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
          "ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED",
          "ATTEMPT_ACCESS_REQUIRED",
          "ATTEMPT_NOT_FOUND",
          "ATTEMPT_VERSION_CONFLICT",
          "ASSIGNMENT_NOT_NOTIFIED",
          "ATTEMPT_INVALID_TRANSITION",
          "MAID_ALREADY_IN_PROGRESS",
          "ATTEMPT_COMMAND_FAILED",
          "CAPABILITY_ACCESS_REQUIRED",
          "ACCOUNT_VERSION_CONFLICT",
          "CLEANING_WINDOW_NOT_EXPIRED",
          "ASSIGNMENT_SCHEDULE_INVALID",
          "ROLLOVER_NOT_ALLOWED",
          "INVALID_ATTEMPT_COMMAND",
          "ATTEMPT_ACTIVATION_NOT_ALLOWED",
          "CLEANING_SERVICE_DATE_NOT_DUE",
          "CLEANING_SERVICE_DATE_EXPIRED",
          "CLEANING_WINDOW_NOT_OPEN",
          "CLEANING_WINDOW_EXPIRED",
          "CHECKOUT_NOT_MATERIALIZED",
          "RECLEAN_MAID_IMMUTABLE",
          "PREVIOUS_ROOM_WORKFLOW_ACTIVE",
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
          "PASSWORD_CHANGE_RECEIPT_FAILED",
          "PASSWORD_CHANGE_IN_PROGRESS",
          "PASSWORD_CHANGE_SESSION_MISMATCH",
          "PASSWORD_VERIFICATION_RATE_LIMITED",
          "PASSWORD_VERIFICATION_RATE_LIMIT_UNAVAILABLE",
          "PASSWORD_VERIFICATION_SESSION_REVOKE_FAILED",
          "PASSWORD_RESET_STATE_UPDATE_FAILED",
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
          "ASSIGNMENT_IMPACT_CHANGED",
          "ASSIGNMENT_DRAFT_STALE_SCHEDULE",
          "ASSIGNMENT_AVAILABILITY_REQUIRED",
          "ASSIGNMENT_AVAILABILITY_STALE",
          "ASSIGNMENT_MAID_UNAVAILABLE",
          "ASSIGNMENT_WINDOW_EXPIRED",
          "ASSIGNMENT_COMMIT_NOT_ALLOWED",
          "ASSIGNMENT_COMMAND_FAILED",
          "ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED",
          "ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED",
          "ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED",
          "ASSIGNMENT_PREVIEW_FAILED",
          "INVALID_ASSIGNMENT_DURATION_POLICY",
          "ASSIGNMENT_DURATION_POLICY_VERSION_CONFLICT",
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
          "COMPLAINT_ACCESS_REQUIRED",
          "COMPLAINT_MAID_MISMATCH",
          "COMPLAINT_NOT_FOUND",
          "INVALID_COMPLAINT_CATEGORY",
          "INVALID_COMPLAINT_FINDING",
          "INVALID_COMPLAINT_PENALTY",
          "INVALID_REWORK_DECISION",
          "INVALID_COMPLAINT_RESPONSE",
          "COMPLAINT_APPEAL_REASON_REQUIRED",
          "COMPLAINT_APPEAL_REASON_FORBIDDEN",
          "COMPLAINT_PERIOD_INVALID",
          "COMPLAINT_PAGE_LIMIT_INVALID",
          "INVALID_COMPLAINT_CURSOR",
          "INVALID_COMPLAINT_REWORK",
          "COMPLAINT_COMPENSATION_AMOUNT_INVALID",
          "COMPLAINT_INTAKE_WINDOW_CLOSED",
          "COMPLAINT_SOURCE_NOT_APPROVED",
          "COMPLAINT_RESPONSE_WINDOW_CLOSED",
          "COMPLAINT_RESPONSE_WINDOW_OPEN",
          "COMPLAINT_APPEAL_UNRESOLVED",
          "COMPLAINT_RESPONSE_ALREADY_RECORDED",
          "COMPLAINT_DECISION_REQUIRED",
          "COMPLAINT_REWORK_MAID_UNAVAILABLE",
          "COMPLAINT_REWORK_WINDOW_UNAVAILABLE",
          "COMPLAINT_REWORK_NOT_CONFIRMED",
          "COMPLAINT_REWORK_ALREADY_MATERIALIZED",
          "COMPLAINT_REWORK_DECISION_STALE",
          "COMPLAINT_REWORK_PRESTART_FROZEN",
          "RECLEAN_TEMPLATE_NOT_CONFIGURED",
          "COMPLAINT_INVALID_TRANSITION",
          "COMPLAINT_COMMAND_FAILED",
          "NOTIFICATION_ACCESS_REQUIRED",
          "NOTIFICATION_NOT_FOUND",
          "INVALID_NOTIFICATION_CURSOR",
          "NOTIFICATION_CURSOR_NOT_CONFIGURED",
          "NOTIFICATION_RESPONSE_TOO_LARGE",
          "NOTIFICATION_QUERY_FAILED",
          "PAYROLL_ACCESS_REQUIRED",
          "PAYROLL_MAID_NOT_FOUND",
          "PAYROLL_WEEK_MUST_START_MONDAY",
          "PAYROLL_PAGE_LIMIT_INVALID",
          "PAYROLL_PAGE_KIND_INVALID",
          "PAYROLL_CURSOR_INVALID",
          "PAYROLL_CURSOR_NOT_CONFIGURED",
          "PAYROLL_RESPONSE_TOO_LARGE",
          "INVALID_EXPECTED_VERSION",
          "PAYROLL_WEEK_NOT_CLOSED",
          "PAYROLL_CYCLE_NOT_OPEN",
          "NO_PAYROLL_AMOUNT",
          "PAYROLL_NONPOSITIVE_REQUIRES_CARRY",
          "PAYROLL_POSITIVE_REQUIRES_START",
          "PAYROLL_CYCLE_ECONOMICALLY_FROZEN",
          "PAYROLL_SOURCE_PAYMENT_UNCERTAIN",
          "PAYROLL_SOURCE_ALREADY_REVERSED",
          "PAYROLL_ROOT_ENTITLEMENT_NEGATIVE",
          "STALE_ADJUSTMENT_VERSION",
          "PAYROLL_LATE_EARNING_ALREADY_CARRIED",
          "PAYROLL_EARNING_NOT_LATE",
          "PAYROLL_LATE_CARRY_TARGET_FROZEN",
          "PAYROLL_EARLIER_CARRY_PENDING",
          "PAYROLL_PRIOR_LATE_EARNING_PENDING",
          "PAYROLL_SOURCE_NOT_FOUND",
          "PAYROLL_ADJUSTMENT_INVALID",
          "PAYROLL_PAYMENT_ATTEMPT_NOT_FOUND",
          "PAYROLL_PAYMENT_ATTEMPT_TERMINAL",
          "PAYROLL_PAYMENT_TRANSITION_INVALID",
          "PAYROLL_PAYMENT_REFERENCE_ALREADY_USED",
          "PAYROLL_PAYMENT_REFERENCE_INVALID",
          "PAYROLL_PAYMENT_METHOD_INVALID",
          "PAYROLL_PAYMENT_REASON_INVALID",
          "PAYROLL_PAYMENT_REOPEN_REASON_INVALID",
          "PAYROLL_PAYMENT_RESULT_AMOUNT_MISMATCH",
          "PAYROLL_COMMAND_FAILED",
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
          "assignment.notified",
          "assignment.prestart_changed",
          "assignment.prestart_unassigned",
          "assignment.cancellation_requested",
          "assignment.cancellation_decided",
          "assignment.attempt_activated",
          "assignment.rolled_over",
          "assignment.duration_policy_confirmed",
          "cleaning.attempt_started",
          "cleaning.field_completed",
          "cleaning.finish_current_allowed",
          "cleaning.upload_only_allowed",
          "cleaning.interrupted_handover",
          "cleaning.scheduled_expired",
          "cleaning.offline_event_resolved",
          "photo.upload_accepted",
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
          "submission.bomb_reported",
          "submission.created",
          "inspection.bomb_decided",
          "inspection.approved",
          "inspection.rejected",
          "complaint.rework_materialized",
          "compensation.earned",
          "payroll.adjustment_recorded",
          "payroll.adjustment_reversed",
          "payroll.offset_settled",
          "payroll.late_earning_carried",
          "payroll.payment_check_recorded",
          "payroll.payment_paid",
          "payroll.payment_reopened",
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
              "GOOGLE_DRIVE_CLIENT_ID",
              "GOOGLE_DRIVE_CLIENT_SECRET",
              "GOOGLE_DRIVE_REFRESH_TOKEN",
              "GOOGLE_DRIVE_ROOT_FOLDER_ID",
              "PHOTO_PURGE_INVOKE_SECRET",
              "PAYROLL_CURSOR_HMAC_SECRET",
              "NOTIFICATION_CURSOR_HMAC_SECRET",
              "WEB_PUSH_SUBSCRIPTION_KEY_BASE64",
              "WEB_PUSH_SUBSCRIPTION_KEY_VERSION",
              "WEB_PUSH_SUBSCRIPTION_KEYRING_JSON",
              "WEB_PUSH_BINDING_DIGEST_SECRET",
              "VAPID_SUBJECT",
              "VAPID_CURRENT_KEY_VERSION",
              "VAPID_PUBLIC_KEY",
              "VAPID_PUBLIC_KEYRING_JSON",
              "VAPID_PRIVATE_KEY",
              "VAPID_KEYRING_JSON",
              "NOTIFICATION_DELIVERY_INVOKE_SECRET",
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
                "GOOGLE_DRIVE_CLIENT_ID",
                "GOOGLE_DRIVE_CLIENT_SECRET",
                "GOOGLE_DRIVE_REFRESH_TOKEN",
                "GOOGLE_DRIVE_ROOT_FOLDER_ID",
                "PHOTO_PURGE_INVOKE_SECRET",
                "PAYROLL_CURSOR_HMAC_SECRET",
                "NOTIFICATION_CURSOR_HMAC_SECRET",
                "WEB_PUSH_SUBSCRIPTION_KEY_BASE64",
                "WEB_PUSH_SUBSCRIPTION_KEY_VERSION",
                "WEB_PUSH_SUBSCRIPTION_KEYRING_JSON",
                "WEB_PUSH_BINDING_DIGEST_SECRET",
                "VAPID_SUBJECT",
                "VAPID_CURRENT_KEY_VERSION",
                "VAPID_PUBLIC_KEY",
                "VAPID_PUBLIC_KEYRING_JSON",
                "VAPID_PRIVATE_KEY",
                "VAPID_KEYRING_JSON",
                "NOTIFICATION_DELIVERY_INVOKE_SECRET",
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
          "photoPurge",
          "notificationDelivery",
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
          photoPurge: {
            type: "object",
            additionalProperties: false,
            required: ["status", "lastHeartbeat", "backlog", "checkedAt"],
            properties: {
              status: {
                type: "string",
                enum: ["awaiting_first_run", "healthy", "degraded", "failed"],
              },
              lastHeartbeat: {
                type: ["object", "null"],
                additionalProperties: false,
                properties: {
                  status: {
                    type: "string",
                    enum: ["succeeded", "degraded", "failed"],
                  },
                  claimed: { type: "integer", minimum: 0, maximum: 10 },
                  purged: { type: "integer", minimum: 0, maximum: 10 },
                  retrying: { type: "integer", minimum: 0, maximum: 10 },
                  blocked: { type: "integer", minimum: 0, maximum: 10 },
                  acceptedClaimed: { type: "integer", minimum: 0, maximum: 10 },
                  orphanClaimed: { type: "integer", minimum: 0, maximum: 10 },
                  folderClaimed: { type: "integer", minimum: 0, maximum: 10 },
                  errorCode: { type: ["string", "null"] },
                  recordedAt: { type: "string", format: "date-time" },
                },
              },
              backlog: {
                type: "object",
                additionalProperties: false,
                required: ["acceptedDue", "orphanDue", "folderDue", "blocked"],
                properties: Object.fromEntries(
                  ["acceptedDue", "orphanDue", "folderDue", "blocked"].map(
                    (name) => [
                      name,
                      { type: "integer", minimum: 0, maximum: 1000 },
                    ],
                  ),
                ),
              },
              checkedAt: { type: "string", format: "date-time" },
            },
          },
          notificationDelivery: {
            type: "object",
            additionalProperties: false,
            required: [
              "status",
              "lastHeartbeat",
              "backlog",
              "activation",
              "checkedAt",
            ],
            properties: {
              status: {
                type: "string",
                enum: ["awaiting_first_run", "healthy", "degraded", "failed"],
              },
              lastHeartbeat: {
                type: ["object", "null"],
                additionalProperties: false,
                properties: {
                  status: {
                    type: "string",
                    enum: ["succeeded", "degraded", "failed"],
                  },
                  claimed: { type: "integer", minimum: 0, maximum: 10 },
                  delivered: { type: "integer", minimum: 0, maximum: 10 },
                  retrying: { type: "integer", minimum: 0, maximum: 10 },
                  suppressed: { type: "integer", minimum: 0, maximum: 10 },
                  deadLetter: { type: "integer", minimum: 0, maximum: 10 },
                  blocked: { type: "integer", minimum: 0, maximum: 10 },
                  deferred: { type: "integer", minimum: 0, maximum: 10 },
                  errorCode: { type: ["string", "null"] },
                  recordedAt: { type: "string", format: "date-time" },
                },
              },
              backlog: {
                type: "object",
                additionalProperties: false,
                required: [
                  "due",
                  "retrying",
                  "deadLetter",
                  "jobOnlyDeadLetter",
                  "blocked",
                  "expiredLeases",
                  "oldestDueAt",
                ],
                properties: {
                  due: { type: "integer", minimum: 0, maximum: 1000 },
                  retrying: { type: "integer", minimum: 0, maximum: 1000 },
                  deadLetter: { type: "integer", minimum: 0, maximum: 1000 },
                  jobOnlyDeadLetter: {
                    type: "integer",
                    minimum: 0,
                    maximum: 1000,
                  },
                  blocked: { type: "integer", minimum: 0, maximum: 1000 },
                  expiredLeases: { type: "integer", minimum: 0, maximum: 1000 },
                  oldestDueAt: {
                    type: ["string", "null"],
                    format: "date-time",
                  },
                },
              },
              activation: {
                type: "object",
                additionalProperties: false,
                required: [
                  "cronConfigured",
                  "cronActive",
                  "functionSecretsConfigured",
                  "providerConfigurationValid",
                ],
                properties: {
                  cronConfigured: { type: "boolean" },
                  cronActive: { type: "boolean" },
                  functionSecretsConfigured: { type: "boolean" },
                  providerConfigurationValid: { type: "boolean" },
                },
              },
              checkedAt: { type: "string", format: "date-time" },
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
              assignmentId: { type: "string", format: "uuid" },
              previousAssignmentId: { type: "string", format: "uuid" },
              previousMaidProfileId: { type: "string", format: "uuid" },
              requestId: { type: "string", format: "uuid" },
              decision: { type: "string", enum: ["approved", "rejected"] },
              reasonCode: { type: "string" },
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
              attemptId: { type: "string", format: "uuid" },
              submissionId: { type: "string", format: "uuid" },
              bombReportId: { type: "string", format: "uuid" },
              earningId: { type: "string", format: "uuid" },
              recleanTargetId: { type: "string", format: "uuid" },
              evidenceCount: { type: "integer", minimum: 1, maximum: 20 },
              photoCount: { type: "integer", minimum: 1 },
              currentRevision: { type: "integer", minimum: 1 },
              attemptNumber: { type: "integer", minimum: 1 },
              assignmentRevision: { type: "integer", minimum: 1 },
              executionVersion: { type: "integer", minimum: 1 },
              startedAt: { type: "string", format: "date-time" },
              fieldCompletedAt: { type: "string", format: "date-time" },
              endedAt: { type: "string", format: "date-time" },
              capabilityKind: {
                type: "string",
                enum: ["finish_current", "upload_submit", "evidence_upload"],
              },
              expiresAt: { type: "string", format: "date-time" },
              profileStatus: {
                type: "string",
                enum: [
                  "active",
                  "deactivation_pending",
                  "upload_only",
                  "inactive",
                  "departed",
                ],
              },
              profileVersion: { type: "integer", minimum: 1 },
              nextAttemptId: { type: "string", format: "uuid" },
              targetSlotId: { type: "string", format: "uuid" },
              photoId: { type: "string", format: "uuid" },
              photoVersion: { type: "integer", minimum: 1 },
              uploadedAt: { type: "string", format: "date-time" },
              purgeAfter: { type: "string", format: "date-time" },
              offlineQuarantineId: {
                type: "string",
                format: "uuid",
                description:
                  "서버 발급 격리 기록 ID. 원 client event UUID가 아닙니다.",
              },
              resolution: {
                type: "string",
                enum: ["record_only", "reject_effect", "correction_link"],
              },
              rolloverFromDate: { type: "string", format: "date" },
              rolloverToDate: { type: "string", format: "date" },
              carryoverCount: { type: "integer", minimum: 0 },
              policyVersion: { type: "integer", minimum: 1 },
              standardMinutes: { type: "integer", minimum: 1 },
              premiumMinutes: { type: "integer", minimum: 1 },
              oceanPremiumMinutes: { type: "integer", minimum: 1 },
              oceanFamilyMinutes: { type: "integer", minimum: 1 },
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
              complaintId: { type: "string", format: "uuid" },
              sourceComplaintDecisionId: { type: "string", format: "uuid" },
              compensationDecisionId: { type: "string", format: "uuid" },
              reworkCleaningTargetId: { type: "string", format: "uuid" },
              inspectionDecisionId: { type: "string", format: "uuid" },
              sameMaid: { type: "boolean" },
              compensationAmount: { type: "integer", minimum: 0 },
              amount: { type: "integer", minimum: 0 },
              currency: { type: "string", enum: ["KRW"] },
              caseVersion: { type: "integer", minimum: 1 },
              paymentAttemptNumber: { type: "integer", minimum: 1 },
              paymentMethod: { type: "string", enum: ["bank_transfer"] },
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
      AssignmentPrestartChangeRequest: prestartRequestSchema("change"),
      AssignmentPrestartUnassignRequest: prestartRequestSchema("unassign"),
      AssignmentCancellationRequest: prestartRequestSchema("request"),
      AssignmentCancellationDecisionRequest: prestartRequestSchema("decision"),
      AssignmentChangeRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "requestId",
          "cleaningTargetId",
          "assignmentId",
          "maidProfileId",
          "requestType",
          "reasonCode",
          "reasonDetail",
          "status",
          "sourceAssignmentRevision",
          "sourceTargetAssignmentVersion",
          "requestedAt",
          "decision",
          "decisionReasonCode",
          "decidedAt",
        ],
        properties: {
          requestId: { type: "string", format: "uuid" },
          cleaningTargetId: { type: "string", format: "uuid" },
          assignmentId: { type: "string", format: "uuid" },
          maidProfileId: { type: "string", format: "uuid" },
          requestType: { type: "string", const: "cancel_assignment" },
          reasonCode: { type: "string" },
          reasonDetail: { type: ["string", "null"], maxLength: 200 },
          status: {
            type: "string",
            enum: ["pending", "approved", "rejected", "superseded"],
          },
          sourceAssignmentRevision: { type: "integer", minimum: 1 },
          sourceTargetAssignmentVersion: { type: "integer", minimum: 1 },
          requestedAt: { type: "string", format: "date-time" },
          decision: {
            type: ["string", "null"],
            enum: ["approved", "rejected", null],
          },
          decisionReasonCode: { type: ["string", "null"] },
          decidedAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      AssignmentChangeRequestPage: {
        type: "object",
        additionalProperties: false,
        required: ["requests", "nextCursor"],
        properties: {
          requests: {
            type: "array",
            maxItems: 100,
            items: { $ref: "#/components/schemas/AssignmentChangeRequest" },
          },
          nextCursor: { type: ["string", "null"] },
        },
      },
      AttemptLifecycleRequest: {
        description:
          "action별 payload/reason은 고정 계약입니다. raw body·자유문·session ID·capability token·TTL은 입력하지 않습니다.",
        oneOf: [
          lifecycleRequestVariant(
            "allow_finish",
            ["DEACTIVATION_FINISH_CURRENT"],
            { type: "object", additionalProperties: false, maxProperties: 0 },
          ),
          lifecycleRequestVariant(
            "allow_upload",
            ["DEACTIVATION_UPLOAD_ONLY"],
            { type: "object", additionalProperties: false, maxProperties: 0 },
          ),
          lifecycleRequestVariant("expire_scheduled", ["SCHEDULE_EXPIRED"], {
            type: "object",
            additionalProperties: false,
            maxProperties: 0,
          }),
          lifecycleRequestVariant(
            "interrupt_handover",
            ["ADMIN_HANDOVER", "DEACTIVATION_HANDOVER"],
            {
              type: "object",
              additionalProperties: false,
              required: [
                "maidProfileId",
                "sequenceNumber",
                "serviceDate",
                "availableFrom",
                "dueAt",
                "deactivateOld",
              ],
              properties: {
                maidProfileId: { type: "string", format: "uuid" },
                sequenceNumber: {
                  type: "integer",
                  minimum: 1,
                  maximum: Number.MAX_SAFE_INTEGER,
                },
                serviceDate: { type: "string", format: "date" },
                availableFrom: { type: "string", format: "date-time" },
                dueAt: { type: "string", format: "date-time" },
                deactivateOld: {
                  type: "boolean",
                  description:
                    "true는 DEACTIVATION_HANDOVER, false는 ADMIN_HANDOVER 사유만 허용",
                },
              },
            },
          ),
        ],
      },
      AttemptCapability: {
        type: "object",
        additionalProperties: false,
        description:
          "서버 DB 권한 metadata이며 bearer credential이 아닙니다. 반환된 ID만으로 접근할 수 없습니다. 사진/검증/submit action은 후속 구현을 위한 계약뿐입니다.",
        required: [
          "capabilityId",
          "attemptId",
          "assignmentId",
          "assignmentRevision",
          "kind",
          "allowedActions",
          "issuedAt",
          "expiresAt",
          "revokedAt",
        ],
        properties: {
          capabilityId: { type: "string", format: "uuid" },
          attemptId: { type: "string", format: "uuid" },
          assignmentId: { type: "string", format: "uuid" },
          assignmentRevision: { type: "integer", minimum: 1 },
          kind: {
            type: "string",
            enum: ["finish_current", "upload_submit", "evidence_upload"],
          },
          allowedActions: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: {
              type: "string",
              enum: [
                "complete_field_work",
                "upload_evidence",
                "validate_evidence",
                "submit",
              ],
            },
          },
          issuedAt: { type: "string", format: "date-time" },
          expiresAt: { type: "string", format: "date-time" },
          revokedAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      LimitedAttempt: {
        type: "object",
        additionalProperties: false,
        required: ["attempt", "capability", "profileStatus"],
        properties: {
          attempt: { $ref: "#/components/schemas/AttemptExecution" },
          capability: {
            anyOf: [
              { $ref: "#/components/schemas/AttemptCapability" },
              {
                type: "null",
              },
            ],
          },
          profileStatus: {
            type: "string",
            enum: ["active", "deactivation_pending", "upload_only"],
          },
        },
      },
      AttemptLifecycleImpact: {
        type: "object",
        additionalProperties: false,
        required: [
          "attempt",
          "capability",
          "profileStatus",
          "profileVersion",
          "targetAssignmentVersion",
        ],
        properties: {
          attempt: { $ref: "#/components/schemas/AttemptExecution" },
          capability: {
            anyOf: [
              { $ref: "#/components/schemas/AttemptCapability" },
              {
                type: "null",
              },
            ],
          },
          profileStatus: {
            type: "string",
            enum: [
              "active",
              "deactivation_pending",
              "upload_only",
              "inactive",
              "departed",
            ],
          },
          profileVersion: { type: "integer", minimum: 1 },
          targetAssignmentVersion: { type: "integer", minimum: 1 },
        },
      },
      OfflineWorkLease: {
        type: "object",
        additionalProperties: false,
        required: [
          "leaseId",
          "version",
          "attemptId",
          "assignmentId",
          "assignmentRevision",
          "issuedAt",
          "expiresAt",
          "metadataExpiresAt",
          "allowedActions",
        ],
        properties: {
          leaseId: { type: "string", format: "uuid" },
          version: { type: "integer", const: 1 },
          attemptId: { type: "string", format: "uuid" },
          assignmentId: { type: "string", format: "uuid" },
          assignmentRevision: { type: "integer", minimum: 1 },
          issuedAt: { type: "string", format: "date-time" },
          expiresAt: {
            type: "string",
            format: "date-time",
            description: "서버 발급 +2시간 hard TTL",
          },
          metadataExpiresAt: {
            type: "string",
            format: "date-time",
            description: "서버 발급 +90일 absolute retention/replay horizon",
          },
          allowedActions: {
            type: "array",
            minItems: 1,
            maxItems: 1,
            items: { type: "string", const: "complete_field_work" },
          },
        },
      },
      AttemptWithOfflineLease: {
        type: "object",
        additionalProperties: false,
        required: ["attempt", "lease", "serverTime"],
        properties: {
          attempt: { $ref: "#/components/schemas/AttemptExecution" },
          lease: { $ref: "#/components/schemas/OfflineWorkLease" },
          serverTime: {
            type: "string",
            format: "date-time",
            description:
              "현재 응답의 서버 clock anchor. 재시도에서 갱신되어도 lease TTL은 불변입니다.",
          },
        },
      },
      OfflineCompletionRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "leaseId",
          "eventId",
          "expectedExecutionVersion",
          "occurredAt",
          "serverOffsetMs",
        ],
        properties: {
          leaseId: { type: "string", format: "uuid" },
          eventId: {
            type: "string",
            format: "uuid",
            description:
              "단일 완료 이벤트의 client UUID. 비밀값을 넣거나 로그로 출력하지 않습니다.",
          },
          expectedExecutionVersion: {
            type: "integer",
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
          },
          occurredAt: {
            type: "string",
            format: "date-time",
            description: "client 발생 시각. 그 자체로 신뢰하지 않습니다.",
          },
          serverOffsetMs: {
            type: "integer",
            minimum: -86400000,
            maximum: 86400000,
            description:
              "서버-클라이언트 clock 차이. ±300000ms 초과는 CLOCK_CONFLICT 격리이며 허용 skew 확대가 아닙니다.",
          },
        },
      },
      OfflineQuarantineReason: {
        type: "string",
        enum: [
          "LEASE_EXPIRED",
          "LEASE_REVOKED",
          "ASSIGNMENT_CHANGED",
          "CLOCK_CONFLICT",
          "KST_DATE_CONFLICT",
        ],
      },
      OfflineSyncResult: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: [
              "eventId",
              "outcome",
              "receivedAt",
              "metadataExpiresAt",
              "attempt",
            ],
            properties: {
              eventId: { type: "string", format: "uuid" },
              outcome: { type: "string", const: "applied" },
              receivedAt: { type: "string", format: "date-time" },
              metadataExpiresAt: { type: "string", format: "date-time" },
              attempt: { $ref: "#/components/schemas/AttemptExecution" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: [
              "eventId",
              "outcome",
              "receivedAt",
              "metadataExpiresAt",
              "reasonCode",
              "quarantineId",
            ],
            properties: {
              eventId: { type: "string", format: "uuid" },
              outcome: { type: "string", const: "quarantined" },
              receivedAt: { type: "string", format: "date-time" },
              metadataExpiresAt: { type: "string", format: "date-time" },
              reasonCode: {
                $ref: "#/components/schemas/OfflineQuarantineReason",
              },
              quarantineId: { type: "string", format: "uuid" },
            },
          },
        ],
      },
      OfflineResolution: {
        type: "string",
        enum: ["record_only", "reject_effect", "correction_link"],
      },
      OfflineQuarantine: {
        type: "object",
        additionalProperties: false,
        required: [
          "quarantineId",
          "attemptId",
          "assignmentId",
          "assignmentRevision",
          "actorProfileId",
          "reasonCode",
          "occurredAt",
          "receivedAt",
          "metadataExpiresAt",
          "resolution",
          "currentAttempt",
        ],
        properties: {
          quarantineId: { type: "string", format: "uuid" },
          attemptId: { type: "string", format: "uuid" },
          assignmentId: { type: "string", format: "uuid" },
          assignmentRevision: { type: "integer", minimum: 1 },
          actorProfileId: { type: "string", format: "uuid" },
          reasonCode: { $ref: "#/components/schemas/OfflineQuarantineReason" },
          occurredAt: {
            type: "string",
            format: "date-time",
            description:
              "계산된 후보 normalizedOccurredAt. clock 검증 여부에 따라 정정이 거부될 수 있습니다.",
          },
          receivedAt: { type: "string", format: "date-time" },
          metadataExpiresAt: { type: "string", format: "date-time" },
          resolution: {
            anyOf: [
              { $ref: "#/components/schemas/OfflineResolution" },
              {
                type: "null",
              },
            ],
          },
          currentAttempt: {
            anyOf: [
              { $ref: "#/components/schemas/AttemptExecution" },
              {
                type: "null",
              },
            ],
          },
        },
      },
      OfflineQuarantinePage: {
        type: "object",
        additionalProperties: false,
        required: ["items", "nextCursor"],
        properties: {
          items: {
            type: "array",
            maxItems: 100,
            items: { $ref: "#/components/schemas/OfflineQuarantine" },
          },
          nextCursor: { type: ["string", "null"] },
        },
      },
      OfflineResolutionRequest: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["resolution", "expectedExecutionVersion", "reasonCode"],
            properties: {
              resolution: { type: "string", const: "record_only" },
              expectedExecutionVersion: { type: "null" },
              reasonCode: { type: "string", const: "OFFLINE_RECORD_ONLY" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["resolution", "expectedExecutionVersion", "reasonCode"],
            properties: {
              resolution: { type: "string", const: "reject_effect" },
              expectedExecutionVersion: { type: "null" },
              reasonCode: { type: "string", const: "OFFLINE_REJECT_EFFECT" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["resolution", "expectedExecutionVersion", "reasonCode"],
            properties: {
              resolution: { type: "string", const: "correction_link" },
              expectedExecutionVersion: {
                type: "integer",
                minimum: 1,
                maximum: Number.MAX_SAFE_INTEGER,
              },
              reasonCode: {
                type: "string",
                const: "OFFLINE_CORRECTION_APPROVED",
              },
            },
          },
        ],
      },
      OfflineResolutionResult: {
        type: "object",
        additionalProperties: false,
        required: [
          "quarantineId",
          "resolution",
          "attempt",
          "effectiveAt",
          "recordedAt",
        ],
        properties: {
          quarantineId: { type: "string", format: "uuid" },
          resolution: { $ref: "#/components/schemas/OfflineResolution" },
          attempt: {
            anyOf: [
              { $ref: "#/components/schemas/AttemptExecution" },
              {
                type: "null",
              },
            ],
          },
          effectiveAt: {
            type: "string",
            format: "date-time",
            description:
              "관리자 결정 시각. 물리 완료는 attempt.fieldCompletedAt 확인",
          },
          recordedAt: { type: "string", format: "date-time" },
        },
      },
      AttemptLifecycleResult: {
        type: "object",
        additionalProperties: false,
        required: [
          "attempt",
          "capability",
          "profileStatus",
          "profileVersion",
          "nextAttempt",
          "effectiveAt",
          "recordedAt",
        ],
        properties: {
          attempt: { $ref: "#/components/schemas/AttemptExecution" },
          capability: {
            anyOf: [
              { $ref: "#/components/schemas/AttemptCapability" },
              {
                type: "null",
              },
            ],
          },
          profileStatus: {
            type: "string",
            enum: [
              "active",
              "deactivation_pending",
              "upload_only",
              "inactive",
              "departed",
            ],
            description:
              "관리자의 미착수 만료 정리는 inactive/departed 상태를 그대로 보존하며 계정을 재활성화하거나 새 제한 권한을 발급하지 않습니다.",
          },
          nextAttempt: {
            anyOf: [
              { $ref: "#/components/schemas/AttemptExecution" },
              {
                type: "null",
              },
            ],
          },
          profileVersion: { type: "integer", minimum: 1 },
          effectiveAt: { type: "string", format: "date-time" },
          recordedAt: { type: "string", format: "date-time" },
        },
      },
      LimitedAttemptLifecycleResult: {
        description:
          "제한 완료 응답은 inactive/departed 계정에 반환하지 않습니다. 성공 receipt replay도 현재 유효한 세션과 DB capability 계약을 적용합니다.",
        allOf: [
          { $ref: "#/components/schemas/AttemptLifecycleResult" },
          {
            type: "object",
            properties: {
              profileStatus: {
                type: "string",
                enum: ["active", "deactivation_pending", "upload_only"],
              },
            },
          },
        ],
      },
      AttemptExecutionRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "expectedExecutionVersion",
          "expectedAssignmentId",
          "expectedAssignmentRevision",
        ],
        properties: {
          expectedExecutionVersion: {
            type: "integer",
            minimum: 1,
            maximum: 9007199254740991,
          },
          expectedAssignmentId: { type: "string", format: "uuid" },
          expectedAssignmentRevision: {
            type: "integer",
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
        description:
          "직전 조회의 수행 version과 본인 배정 ID/revision만 보냅니다. 사용자 ID·시각·사진·PIN·lease·오프라인 payload는 서버가 받지 않습니다.",
      },
      AttemptExecution: {
        type: "object",
        additionalProperties: false,
        required: [
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
          "effectiveAt",
          "recordedAt",
        ],
        properties: {
          attemptId: { type: "string", format: "uuid" },
          cleaningTargetId: { type: "string", format: "uuid" },
          assignmentId: { type: "string", format: "uuid" },
          maidProfileId: { type: "string", format: "uuid" },
          assignmentRevision: { type: "integer", minimum: 1 },
          executionVersion: { type: "integer", minimum: 1 },
          status: {
            type: "string",
            enum: [
              "scheduled",
              "in_progress",
              "field_completed",
              "upload_pending",
              "submitted",
              "approved",
              "rejected",
              "interrupted",
              "superseded",
            ],
          },
          startedAt: { type: ["string", "null"], format: "date-time" },
          fieldCompletedAt: { type: ["string", "null"], format: "date-time" },
          endedAt: { type: ["string", "null"], format: "date-time" },
          effectiveAt: { type: "string", format: "date-time" },
          recordedAt: { type: "string", format: "date-time" },
        },
        description:
          "서버가 검증한 수행 identity/version/timestamp만 포함합니다. 일반 상태 enum의 후속 단계가 보이더라도 이번 API는 scheduled→in_progress→field_completed만 변경합니다. 현장 상태는 attempt.status·fieldCompletedAt·endedAt이 정본이며 target의 거친 in_progress 값만으로 청소중 표시를 판단하지 않습니다. 전체 room/template snapshot·고객명·PIN·사진·token은 공개하지 않습니다.",
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
          roomId: {
            type: ["string", "null"],
            format: "uuid",
            description:
              "maid는 통보 당시 객실 snapshot입니다. 복원 근거가 없는 과거 이력은 null이며 현재 target 객실로 대체하지 않습니다. admin은 현재 객실 ID입니다.",
          },
          roomNumber: {
            type: ["string", "null"],
            description:
              "maid는 통보 당시 객실 번호이며 과거 snapshot 부재 시 null입니다. admin은 현재 객실 번호입니다.",
          },
          maidProfileId: { type: "string", format: "uuid" },
          maidDisplayName: { type: "string" },
          serviceDate: { type: "string", format: "date" },
          sequenceNumber: { type: "integer", minimum: 1 },
          revision: { type: "integer", minimum: 1 },
          isCurrent: { type: "boolean" },
          targetAssignmentVersion: {
            type: "integer",
            minimum: 1,
            description:
              "admin은 현재 target의 expectedAssignmentVersion CAS 값입니다. maid는 본인 통보 revision에 고정된 version이며 다른 담당의 현재 target version을 노출하지 않습니다. 과거 이력 조회는 mutation 권한이 아닙니다.",
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
      AssignmentCommitCandidate: {
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
          "targetAssignmentVersion",
          "expectedAvailabilityVersion",
          "availableFrom",
          "dueAt",
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
          targetAssignmentVersion: { type: "integer", minimum: 1 },
          expectedAvailabilityVersion: { type: "integer", minimum: 1 },
          availableFrom: { type: ["string", "null"], format: "date-time" },
          dueAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      AssignmentCommitBlockedCandidate: {
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
          "targetAssignmentVersion",
          "currentAvailabilityVersion",
          "reasonCodes",
          "availableFrom",
          "dueAt",
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
          targetAssignmentVersion: { type: "integer", minimum: 1 },
          currentAvailabilityVersion: {
            type: ["integer", "null"],
            minimum: 1,
          },
          reasonCodes: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
          },
          availableFrom: { type: ["string", "null"], format: "date-time" },
          dueAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      AssignmentCommitUnassignedTarget: {
        type: "object",
        additionalProperties: false,
        required: [
          "cleaningTargetId",
          "roomId",
          "roomNumber",
          "serviceDate",
          "status",
          "targetAssignmentVersion",
          "availableFrom",
          "dueAt",
        ],
        properties: {
          cleaningTargetId: { type: "string", format: "uuid" },
          roomId: { type: "string", format: "uuid" },
          roomNumber: { type: "string" },
          serviceDate: { type: "string", format: "date" },
          status: { const: "unassigned" },
          targetAssignmentVersion: { type: "integer", minimum: 1 },
          availableFrom: { type: ["string", "null"], format: "date-time" },
          dueAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      AssignmentCommitImpact: {
        type: "object",
        additionalProperties: false,
        required: [
          "serviceDate",
          "impactFingerprint",
          "committableDrafts",
          "blockedDrafts",
          "remainingUnassignedTargets",
        ],
        properties: {
          serviceDate: { type: "string", format: "date" },
          impactFingerprint: {
            type: "string",
            pattern: "^[0-9a-f]{64}$",
            description:
              "commit 직전 동일 impact인지 검증하는 SHA-256 fingerprint",
          },
          committableDrafts: {
            type: "array",
            items: { $ref: "#/components/schemas/AssignmentCommitCandidate" },
          },
          blockedDrafts: {
            type: "array",
            items: {
              $ref: "#/components/schemas/AssignmentCommitBlockedCandidate",
            },
          },
          remainingUnassignedTargets: {
            type: "array",
            items: {
              $ref: "#/components/schemas/AssignmentCommitUnassignedTarget",
            },
          },
        },
      },
      AssignmentCommitItem: {
        type: "object",
        additionalProperties: false,
        required: [
          "cleaningTargetId",
          "expectedAssignmentVersion",
          "expectedAvailabilityVersion",
        ],
        properties: {
          cleaningTargetId: { type: "string", format: "uuid" },
          expectedAssignmentVersion: { type: "integer", minimum: 1 },
          expectedAvailabilityVersion: { type: "integer", minimum: 1 },
        },
      },
      AssignmentCommitRequest: {
        type: "object",
        additionalProperties: false,
        required: ["serviceDate", "expectedImpactFingerprint", "items"],
        properties: {
          serviceDate: { type: "string", format: "date" },
          expectedImpactFingerprint: {
            type: "string",
            pattern: "^[0-9a-f]{64}$",
          },
          items: {
            type: "array",
            minItems: 1,
            maxItems: 121,
            items: { $ref: "#/components/schemas/AssignmentCommitItem" },
          },
        },
      },
      AssignmentNotified: {
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
          "targetAssignmentVersion",
          "expectedAvailabilityVersion",
          "availableFrom",
          "dueAt",
          "notifiedAt",
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
          targetAssignmentVersion: { type: "integer", minimum: 1 },
          expectedAvailabilityVersion: { type: "integer", minimum: 1 },
          availableFrom: { type: ["string", "null"], format: "date-time" },
          dueAt: { type: ["string", "null"], format: "date-time" },
          notifiedAt: { type: "string", format: "date-time" },
        },
        description:
          "알림 확정 결과입니다. expectedAvailabilityVersion은 preflight 입력 version을 나타냅니다.",
      },
      AssignmentCommitResult: {
        type: "object",
        additionalProperties: false,
        required: [
          "serviceDate",
          "impactFingerprint",
          "notifiedAssignments",
          "remainingDrafts",
          "blockedDrafts",
          "unassignedTargets",
        ],
        properties: {
          serviceDate: { type: "string", format: "date" },
          impactFingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
          notifiedAssignments: {
            type: "array",
            items: { $ref: "#/components/schemas/AssignmentNotified" },
          },
          remainingDrafts: {
            type: "array",
            items: { $ref: "#/components/schemas/AssignmentCommitCandidate" },
          },
          blockedDrafts: {
            type: "array",
            items: {
              $ref: "#/components/schemas/AssignmentCommitBlockedCandidate",
            },
          },
          unassignedTargets: {
            type: "array",
            items: {
              $ref: "#/components/schemas/AssignmentCommitUnassignedTarget",
            },
          },
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
      ComplaintCategory: {
        type: "string",
        enum: [
          "cleanliness_general",
          "bathroom_cleanliness",
          "bedding_quality",
          "trash_not_removed",
          "amenity_missing",
          "damage_or_loss",
          "odor_or_smoke",
          "access_or_handover",
        ],
      },
      ComplaintFinding: {
        type: "string",
        enum: ["confirmed", "unverifiable", "false"],
      },
      ComplaintStatus: {
        type: "string",
        enum: [
          "received",
          "under_review",
          "decided",
          "acknowledged",
          "appealed",
          "closed",
        ],
      },
      ComplaintDecision: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "complaintId",
          "decisionVersion",
          "decisionKind",
          "priorDecisionId",
          "finding",
          "penaltyScore",
          "reworkRequired",
          "decidedAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          complaintId: { type: "string", format: "uuid" },
          decisionVersion: { type: "integer", minimum: 1 },
          decisionKind: { type: "string", enum: ["initial", "correction"] },
          priorDecisionId: { type: ["string", "null"], format: "uuid" },
          finding: { $ref: "#/components/schemas/ComplaintFinding" },
          penaltyScore: {
            type: "integer",
            minimum: 0,
            maximum: 10,
            description:
              "평가 전용이며 payroll deduction side effect가 없습니다.",
          },
          reworkRequired: { type: "boolean" },
          decidedAt: { type: "string", format: "date-time" },
        },
      },
      WebPushSubscriptionRegisterRequest: {
        type: "object",
        additionalProperties: false,
        required: ["bindingProof", "subscription"],
        properties: {
          bindingProof: {
            type: "string",
            minLength: 1,
            maxLength: 2048,
            description:
              "동일 session에서 config endpoint가 발급한 opaque proof. 만료·변조·타 actor/session·removed version은 거부됩니다.",
          },
          subscription: {
            type: "object",
            additionalProperties: false,
            required: ["endpoint", "expirationTime", "keys"],
            properties: {
              endpoint: {
                type: "string",
                format: "uri",
                minLength: 1,
                maxLength: 4096,
                pattern: "^https://",
                description:
                  "브라우저가 발급한 opaque capability URL. 저장·로그·응답에서는 원문이 노출되지 않습니다.",
              },
              expirationTime: {
                type: ["integer", "null"],
                minimum: 0,
                description:
                  "PushSubscription expirationTime epoch milliseconds. null 또는 서버 현재보다 미래만 허용합니다.",
              },
              keys: {
                type: "object",
                additionalProperties: false,
                required: ["p256dh", "auth"],
                properties: {
                  p256dh: {
                    type: "string",
                    minLength: 1,
                    maxLength: 256,
                    description:
                      "padding 없는 canonical base64url 65-byte uncompressed P-256 public point",
                  },
                  auth: {
                    type: "string",
                    minLength: 1,
                    maxLength: 128,
                    description:
                      "padding 없는 canonical base64url 16-byte auth secret",
                  },
                },
              },
            },
          },
          expectedCurrent: {
            type: "object",
            additionalProperties: false,
            required: ["subscriptionId", "version"],
            properties: {
              subscriptionId: { type: "string", format: "uuid" },
              version: { type: "integer", minimum: 1 },
            },
          },
        },
      },
      WebPushSubscriptionRetireRequest: {
        type: "object",
        additionalProperties: false,
        required: ["expectedVersion"],
        properties: { expectedVersion: { type: "integer", minimum: 1 } },
      },
      WebPushSubscription: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "version",
          "status",
          "createdAt",
          "updatedAt",
          "retiredAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          version: { type: "integer", minimum: 1 },
          status: { type: "string", enum: ["active", "retired"] },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          retiredAt: { type: ["string", "null"], format: "date-time" },
        },
        description:
          "endpoint, host/path, key, cipher/nonce/tag, digest, session/device 정보를 포함하지 않는 공개 projection.",
      },
      WebPushSubscriptionEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["subscription"],
        properties: {
          subscription: { $ref: "#/components/schemas/WebPushSubscription" },
        },
      },
      Notification: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "category",
          "title",
          "body",
          "roomId",
          "cleaningTargetId",
          "deepLink",
          "groupId",
          "requiresAction",
          "readAt",
          "resolvedAt",
          "occurredAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          category: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          roomId: { type: ["string", "null"], format: "uuid" },
          cleaningTargetId: { type: ["string", "null"], format: "uuid" },
          deepLink: {
            oneOf: [{
              type: "object",
              additionalProperties: false,
              required: ["kind", "entityId"],
              properties: {
                kind: {
                  type: "string",
                  enum: [
                    "cleaningTarget",
                    "assignmentRequest",
                    "submission",
                    "complaintCase",
                    "payrollCycle",
                    "payrollProfile",
                  ],
                },
                entityId: { type: "string", format: "uuid" },
              },
            }, { type: "null" }],
          },
          groupId: { type: ["string", "null"], format: "uuid" },
          requiresAction: { type: "boolean" },
          readAt: { type: ["string", "null"], format: "date-time" },
          resolvedAt: { type: ["string", "null"], format: "date-time" },
          occurredAt: { type: "string", format: "date-time" },
        },
        description:
          "본인 알림의 안전한 projection. typed 알림은 허용된 deepLink와 비민감 UUID groupId만 추가하며 recipientProfileId, dedupeKey, groupKey, provenance와 내부 actor/session은 포함하지 않습니다.",
      },
      NotificationEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["notification"],
        properties: {
          notification: { $ref: "#/components/schemas/Notification" },
        },
      },
      NotificationListEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["notifications", "nextCursor"],
        properties: {
          notifications: {
            type: "array",
            maxItems: 100,
            items: { $ref: "#/components/schemas/Notification" },
          },
          nextCursor: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 1024,
          },
        },
      },
      ComplaintMaidResponse: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "complaintId",
          "decisionId",
          "maidProfileId",
          "responseType",
          "appealReasonCode",
          "respondedAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          complaintId: { type: "string", format: "uuid" },
          decisionId: { type: "string", format: "uuid" },
          maidProfileId: { type: "string", format: "uuid" },
          responseType: { type: "string", enum: ["acknowledged", "appealed"] },
          appealReasonCode: {
            type: ["string", "null"],
            enum: [
              "work_completed_as_required",
              "evidence_misinterpreted",
              "not_responsible",
              "timeline_mismatch",
              null,
            ],
          },
          respondedAt: { type: "string", format: "date-time" },
        },
      },
      Complaint: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "roomId",
          "cleaningTargetId",
          "cleaningAttemptId",
          "submissionId",
          "inspectionDecisionId",
          "originalEarningId",
          "maidProfileId",
          "category",
          "status",
          "version",
          "currentDecisionId",
          "firstDecidedAt",
          "responseDeadline",
          "receivedAt",
          "updatedAt",
          "currentDecision",
          "maidResponse",
          "reworkDecision",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          roomId: { type: "string", format: "uuid" },
          cleaningTargetId: { type: "string", format: "uuid" },
          cleaningAttemptId: { type: "string", format: "uuid" },
          submissionId: { type: "string", format: "uuid" },
          inspectionDecisionId: { type: "string", format: "uuid" },
          originalEarningId: { type: "string", format: "uuid" },
          maidProfileId: { type: "string", format: "uuid" },
          category: { $ref: "#/components/schemas/ComplaintCategory" },
          status: { $ref: "#/components/schemas/ComplaintStatus" },
          version: { type: "integer", minimum: 1 },
          currentDecisionId: { type: ["string", "null"], format: "uuid" },
          firstDecidedAt: { type: ["string", "null"], format: "date-time" },
          responseDeadline: { type: ["string", "null"], format: "date-time" },
          receivedAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          currentDecision: {
            oneOf: [
              { $ref: "#/components/schemas/ComplaintDecision" },
              {
                type: "null",
              },
            ],
          },
          maidResponse: {
            oneOf: [
              { $ref: "#/components/schemas/ComplaintMaidResponse" },
              {
                type: "null",
              },
            ],
          },
          reworkDecision: {
            oneOf: [
              { $ref: "#/components/schemas/ComplaintReworkDecision" },
              { type: "null" },
            ],
          },
        },
      },
      ComplaintReworkDecision: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["view", "sameMaid", "sourceDecisionIsCurrent"],
            properties: {
              view: { const: "originalMaid", type: "string" },
              sameMaid: { type: "boolean" },
              sourceDecisionIsCurrent: { type: "boolean" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: [
              "view",
              "id",
              "reworkCleaningTargetId",
              "compensationAmount",
              "currency",
              "sourceDecisionIsCurrent",
            ],
            properties: {
              view: { const: "assigneeMaid", type: "string" },
              id: { type: "string", format: "uuid" },
              reworkCleaningTargetId: { type: "string", format: "uuid" },
              compensationAmount: { type: "integer", minimum: 0 },
              currency: { const: "KRW", type: "string" },
              sourceDecisionIsCurrent: { type: "boolean" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: [
              "view",
              "id",
              "complaintId",
              "sourceComplaintDecisionId",
              "currentComplaintDecisionId",
              "sourceDecisionIsCurrent",
              "originalCleaningTargetId",
              "reworkCleaningTargetId",
              "originalMaidProfileId",
              "assigneeMaidProfileId",
              "sameMaid",
              "originalBaseFeeSnapshot",
              "compensationAmount",
              "currency",
              "sourceCaseVersion",
              "decisionVersion",
              "decidedAt",
            ],
            properties: {
              view: { const: "admin", type: "string" },
              id: { type: "string", format: "uuid" },
              complaintId: { type: "string", format: "uuid" },
              sourceComplaintDecisionId: { type: "string", format: "uuid" },
              currentComplaintDecisionId: { type: "string", format: "uuid" },
              sourceDecisionIsCurrent: { type: "boolean" },
              originalCleaningTargetId: { type: "string", format: "uuid" },
              reworkCleaningTargetId: { type: "string", format: "uuid" },
              originalMaidProfileId: { type: "string", format: "uuid" },
              assigneeMaidProfileId: { type: "string", format: "uuid" },
              sameMaid: { type: "boolean" },
              originalBaseFeeSnapshot: { type: "integer", minimum: 0 },
              compensationAmount: { type: "integer", minimum: 0 },
              currency: { const: "KRW", type: "string" },
              sourceCaseVersion: { type: "integer", minimum: 1 },
              decisionVersion: { const: 1, type: "integer" },
              decidedAt: { type: "string", format: "date-time" },
            },
          },
        ],
      },
      ComplaintCreateRequest: {
        type: "object",
        additionalProperties: false,
        required: ["originalEarningId", "category", "expectedVersion"],
        properties: {
          originalEarningId: { type: "string", format: "uuid" },
          category: { $ref: "#/components/schemas/ComplaintCategory" },
          expectedVersion: { const: 0, type: "integer" },
        },
      },
      ComplaintCasRequest: {
        type: "object",
        additionalProperties: false,
        required: ["expectedVersion"],
        properties: { expectedVersion: { type: "integer", minimum: 1 } },
      },
      ComplaintDecisionRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "expectedVersion",
          "finding",
          "penaltyScore",
          "reworkRequired",
        ],
        properties: {
          expectedVersion: { type: "integer", minimum: 1 },
          finding: { $ref: "#/components/schemas/ComplaintFinding" },
          penaltyScore: { type: "integer", minimum: 0, maximum: 10 },
          reworkRequired: { type: "boolean" },
        },
      },
      ComplaintReworkRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "expectedVersion",
          "complaintDecisionId",
          "assigneeMaidProfileId",
          "compensationAmount",
        ],
        properties: {
          expectedVersion: { type: "integer", minimum: 1 },
          complaintDecisionId: { type: "string", format: "uuid" },
          assigneeMaidProfileId: { type: "string", format: "uuid" },
          compensationAmount: { type: "integer", minimum: 0 },
        },
      },
      ComplaintResponseRequest: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["expectedVersion", "responseType"],
            properties: {
              expectedVersion: { type: "integer", minimum: 1 },
              responseType: { const: "acknowledged", type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["expectedVersion", "responseType", "appealReasonCode"],
            properties: {
              expectedVersion: { type: "integer", minimum: 1 },
              responseType: { const: "appealed", type: "string" },
              appealReasonCode: {
                type: "string",
                enum: [
                  "work_completed_as_required",
                  "evidence_misinterpreted",
                  "not_responsible",
                  "timeline_mismatch",
                ],
              },
            },
          },
        ],
      },
      ComplaintEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["complaint"],
        properties: { complaint: { $ref: "#/components/schemas/Complaint" } },
      },
      ComplaintReworkEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["complaint", "reworkDecision", "assignment"],
        properties: {
          complaint: { $ref: "#/components/schemas/Complaint" },
          reworkDecision: {
            $ref: "#/components/schemas/ComplaintReworkDecision",
          },
          assignment: {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "cleaningTargetId",
              "maidProfileId",
              "sequenceNumber",
              "revision",
              "serviceDate",
              "availableFrom",
              "dueAt",
            ],
            properties: {
              id: { type: "string", format: "uuid" },
              cleaningTargetId: { type: "string", format: "uuid" },
              maidProfileId: { type: "string", format: "uuid" },
              sequenceNumber: { type: "integer", minimum: 1 },
              revision: { type: "integer", minimum: 1 },
              serviceDate: { type: "string", format: "date" },
              availableFrom: { type: "string", format: "date-time" },
              dueAt: { type: ["string", "null"], format: "date-time" },
            },
          },
        },
      },
      ComplaintListEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["complaints", "nextCursor"],
        properties: {
          complaints: {
            type: "array",
            maxItems: 100,
            items: { $ref: "#/components/schemas/Complaint" },
          },
          nextCursor: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 1024,
          },
        },
      },
      ComplaintHistoryEvent: {
        type: "object",
        additionalProperties: false,
        required: [
          "eventId",
          "eventType",
          "toStatus",
          "caseVersion",
          "occurredAt",
        ],
        properties: {
          eventId: { type: "integer", minimum: 1 },
          eventType: {
            type: "string",
            enum: [
              "received",
              "review_started",
              "decided",
              "acknowledged",
              "appealed",
              "closed",
              "corrected",
              "rework_materialized",
            ],
          },
          fromStatus: {
            type: "string",
            enum: [
              "received",
              "under_review",
              "decided",
              "acknowledged",
              "appealed",
              "closed",
            ],
          },
          toStatus: { $ref: "#/components/schemas/ComplaintStatus" },
          caseVersion: { type: "integer", minimum: 1 },
          occurredAt: { type: "string", format: "date-time" },
          decision: { $ref: "#/components/schemas/ComplaintDecision" },
          maidResponse: { $ref: "#/components/schemas/ComplaintMaidResponse" },
          compensationDecisionId: { type: "string", format: "uuid" },
        },
      },
      ComplaintHistoryEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["events", "nextCursor"],
        properties: {
          events: {
            type: "array",
            maxItems: 100,
            items: { $ref: "#/components/schemas/ComplaintHistoryEvent" },
          },
          nextCursor: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 1024,
          },
        },
      },

      PayrollStatus: {
        type: "string",
        enum: ["open", "paying", "check", "paid"],
        description:
          "지급 상태 enum은 유지합니다. offset-settled는 별도 boolean projection입니다.",
      },
      PayrollItem: {
        type: "object",
        additionalProperties: false,
        required: ["earningId", "earnedOn", "amount", "alreadyClaimed"],
        properties: {
          earningId: { type: "string", format: "uuid" },
          earnedOn: {
            type: "string",
            format: "date",
            description: "현장 완료 KST 날짜",
          },
          amount: { type: "integer", minimum: 1 },
          alreadyClaimed: {
            type: "boolean",
            description: "이미 이 OPEN cycle item에 편입된 확정 수익 여부",
          },
        },
      },
      PayrollLateEarning: {
        type: "object",
        additionalProperties: false,
        required: ["earningId", "earnedOn", "amount"],
        properties: {
          earningId: { type: "string", format: "uuid" },
          earnedOn: { type: "string", format: "date" },
          amount: { type: "integer", minimum: 1 },
        },
        description:
          "PAYING/CHECK/PAID snapshot 잠금 뒤 확정되어 현재 lockedAmount에는 포함되지 않은 수익입니다.",
      },
      PayrollCycle: {
        type: "object",
        additionalProperties: false,
        required: [
          "cycleId",
          "maidProfileId",
          "weekStart",
          "status",
          "version",
          "lockedAmount",
          "paymentStartedAt",
          "itemCount",
          "totalAmount",
          "items",
          "itemsNextCursor",
          "lateEarningCount",
          "lateEarningAmount",
          "lateEarnings",
          "lateEarningsNextCursor",
          "offsetSettled",
          "adjustmentAmount",
          "carryInAmount",
          "carryOutAmount",
          "payableAmount",
          "adjustmentCount",
          "paymentAttemptId",
          "paymentAttemptNumber",
          "paidAt",
          "checkReasonCode",
          "lastReopenReasonCode",
        ],
        properties: {
          cycleId: { type: ["string", "null"], format: "uuid" },
          maidProfileId: { type: "string", format: "uuid" },
          weekStart: { type: "string", format: "date" },
          status: { $ref: "#/components/schemas/PayrollStatus" },
          version: { type: "integer", minimum: 0 },
          lockedAmount: {
            type: ["integer", "null"],
            minimum: 1,
            description:
              "PAYING 시작 시 고정된 금액. late earnings를 포함해 다시 계산하지 않습니다.",
          },
          paymentStartedAt: { type: ["string", "null"], format: "date-time" },
          itemCount: { type: "integer", minimum: 0 },
          totalAmount: {
            type: "integer",
            minimum: 0,
            description:
              "OPEN이면 현재 편입 가능한 확정 수익 합계, PAYING 이후에는 lockedAmount 합계",
          },
          items: {
            type: "array",
            maxItems: 10,
            items: { $ref: "#/components/schemas/PayrollItem" },
          },
          itemsNextCursor: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 1024,
            description:
              "items preview가 더 있으면 동일 actor/week/maid/items scope의 opaque continuation",
          },
          lateEarningCount: { type: "integer", minimum: 0 },
          lateEarningAmount: {
            type: "integer",
            minimum: 0,
            description: "현재 lockedAmount와 분리된 늦은 확정 수익 합계",
          },
          lateEarnings: {
            type: "array",
            maxItems: 10,
            items: { $ref: "#/components/schemas/PayrollLateEarning" },
          },
          lateEarningsNextCursor: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 1024,
            description:
              "lateEarnings preview가 더 있으면 별도 opaque continuation",
          },
          offsetSettled: {
            type: "boolean",
            description:
              "0원 이하 상계가 완료되어 경제적으로 동결된 OPEN cycle 여부",
          },
          adjustmentAmount: {
            type: "integer",
            description: "이번 cycle의 signed adjustment 합계",
          },
          carryInAmount: {
            type: "integer",
            maximum: 0,
            description: "이전 주차 residual의 signed 차감액",
          },
          carryOutAmount: {
            type: "integer",
            maximum: 0,
            description: "다음 주차로 넘긴 signed residual. 없으면 0",
          },
          payableAmount: {
            type: "integer",
            description: "earning + adjustment + carry-in의 signed net",
          },
          adjustmentCount: { type: "integer", minimum: 0 },
          paymentAttemptId: { type: ["string", "null"], format: "uuid" },
          paymentAttemptNumber: { type: ["integer", "null"], minimum: 1 },
          paidAt: { type: ["string", "null"], format: "date-time" },
          checkReasonCode: {
            type: ["string", "null"],
            enum: ["TRANSFER_RESULT_UNCERTAIN", null],
          },
          lastReopenReasonCode: {
            type: ["string", "null"],
            enum: ["NO_TRANSFER_CONFIRMED", null],
          },
        },
      },
      PayrollStartRequest: {
        type: "object",
        additionalProperties: false,
        required: ["maidProfileId", "weekStart", "expectedVersion"],
        properties: {
          maidProfileId: { type: "string", format: "uuid" },
          weekStart: { type: "string", format: "date" },
          expectedVersion: { type: "integer", minimum: 0 },
        },
        description:
          "금액과 earning ID는 서버가 계산하므로 입력할 수 없습니다.",
      },
      PayrollAdjustmentReason: {
        type: "string",
        enum: [
          "earning_correction",
          "adjustment_correction",
          "earning_reversal",
          "adjustment_reversal",
          "late_earning_carry",
        ],
      },
      PayrollAdjustmentEntry: {
        type: "object",
        additionalProperties: false,
        required: [
          "adjustmentId",
          "availableWeekStart",
          "amount",
          "reasonCode",
          "alreadyClaimed",
        ],
        properties: {
          adjustmentId: { type: "string", format: "uuid" },
          availableWeekStart: { type: "string", format: "date" },
          amount: { type: "integer" },
          reasonCode: { $ref: "#/components/schemas/PayrollAdjustmentReason" },
          alreadyClaimed: { type: "boolean" },
        },
      },
      PayrollAdjustment: {
        type: "object",
        additionalProperties: false,
        required: [
          "adjustmentId",
          "maidProfileId",
          "bookVersion",
          "availableWeekStart",
          "amount",
          "currency",
          "reasonCode",
          "rootEarningId",
          "alreadyClaimed",
          "createdAt",
        ],
        properties: {
          adjustmentId: { type: "string", format: "uuid" },
          maidProfileId: { type: "string", format: "uuid" },
          bookVersion: { type: "integer", minimum: 1 },
          availableWeekStart: { type: "string", format: "date" },
          amount: { type: "integer" },
          currency: { const: "KRW" },
          reasonCode: { $ref: "#/components/schemas/PayrollAdjustmentReason" },
          rootEarningId: { type: "string", format: "uuid" },
          correctionOfEarningId: { type: "string", format: "uuid" },
          correctionOfAdjustmentId: { type: "string", format: "uuid" },
          reversalOfEarningId: { type: "string", format: "uuid" },
          reversalOfAdjustmentId: { type: "string", format: "uuid" },
          lateCarriedEarningId: { type: "string", format: "uuid" },
          alreadyClaimed: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      PayrollCorrectionRequest: {
        oneOf: [
          { $ref: "#/components/schemas/PayrollEarningCorrectionRequest" },
          { $ref: "#/components/schemas/PayrollAdjustmentCorrectionRequest" },
        ],
      },
      PayrollEarningCorrectionRequest: {
        type: "object",
        additionalProperties: false,
        required: ["sourceEarningId", "amount", "expectedVersion"],
        properties: {
          sourceEarningId: { type: "string", format: "uuid" },
          amount: { type: "integer", not: { const: 0 } },
          expectedVersion: { type: "integer", minimum: 0 },
        },
      },
      PayrollAdjustmentCorrectionRequest: {
        type: "object",
        additionalProperties: false,
        required: ["sourceAdjustmentId", "amount", "expectedVersion"],
        properties: {
          sourceAdjustmentId: { type: "string", format: "uuid" },
          amount: { type: "integer", not: { const: 0 } },
          expectedVersion: { type: "integer", minimum: 0 },
        },
      },
      PayrollReversalRequest: {
        oneOf: [
          { $ref: "#/components/schemas/PayrollEarningReversalRequest" },
          { $ref: "#/components/schemas/PayrollAdjustmentReversalRequest" },
        ],
      },
      PayrollEarningReversalRequest: {
        type: "object",
        additionalProperties: false,
        required: ["sourceEarningId", "expectedVersion"],
        properties: {
          sourceEarningId: { type: "string", format: "uuid" },
          expectedVersion: { type: "integer", minimum: 0 },
        },
      },
      PayrollAdjustmentReversalRequest: {
        type: "object",
        additionalProperties: false,
        required: ["sourceAdjustmentId", "expectedVersion"],
        properties: {
          sourceAdjustmentId: { type: "string", format: "uuid" },
          expectedVersion: { type: "integer", minimum: 0 },
        },
      },
      PayrollLateCarryRequest: {
        type: "object",
        additionalProperties: false,
        required: ["expectedVersion"],
        properties: { expectedVersion: { type: "integer", minimum: 0 } },
      },
      PayrollPaymentCheckRequest: {
        type: "object",
        additionalProperties: false,
        required: ["expectedVersion", "reasonCode"],
        properties: {
          expectedVersion: { type: "integer", minimum: 1 },
          reasonCode: { const: "TRANSFER_RESULT_UNCERTAIN" },
        },
      },
      PayrollPaymentPaidRequest: {
        type: "object",
        additionalProperties: false,
        required: ["expectedVersion", "paymentMethod", "providerReferenceId"],
        properties: {
          expectedVersion: { type: "integer", minimum: 1 },
          paymentMethod: { const: "bank_transfer" },
          providerReferenceId: {
            type: "string",
            minLength: 8,
            maxLength: 64,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$",
            description:
              "ASCII letter와 digit을 각각 포함하고 7자리 연속 숫자·URL-like 문자열을 금지합니다. 응답에서는 uppercase canonical 값입니다.",
          },
        },
      },
      PayrollPaymentReopenRequest: {
        type: "object",
        additionalProperties: false,
        required: ["expectedVersion", "reasonCode"],
        properties: {
          expectedVersion: { type: "integer", minimum: 1 },
          reasonCode: { const: "NO_TRANSFER_CONFIRMED" },
        },
      },
      PayrollPaymentResult: {
        type: "object",
        additionalProperties: false,
        required: [
          "paymentResultId",
          "paymentAttemptId",
          "payrollCycleId",
          "resultType",
          "beforeStatus",
          "afterStatus",
          "cycleVersion",
          "lockedAmount",
          "occurredAt",
        ],
        properties: {
          paymentResultId: { type: "string", format: "uuid" },
          paymentAttemptId: { type: "string", format: "uuid" },
          payrollCycleId: { type: "string", format: "uuid" },
          resultType: { type: "string", enum: ["check", "paid", "reopened"] },
          beforeStatus: { type: "string", enum: ["paying", "check"] },
          afterStatus: { type: "string", enum: ["check", "paid", "open"] },
          cycleVersion: { type: "integer", minimum: 1 },
          lockedAmount: {
            type: "integer",
            minimum: 1,
            description:
              "attempt 시작 시 서버가 잠근 전액 snapshot. CHECK/reopen에서는 지급액을 뜻하지 않으며 client 입력이 아닙니다.",
          },
          paymentMethod: { type: "string", const: "bank_transfer" },
          providerReferenceId: {
            type: "string",
            minLength: 8,
            maxLength: 64,
            readOnly: true,
            description:
              "admin command result 전용 canonical reference. maid/developer/audit/notification에는 노출되지 않습니다.",
          },
          reasonCode: {
            type: "string",
            enum: ["TRANSFER_RESULT_UNCERTAIN", "NO_TRANSFER_CONFIRMED"],
          },
          occurredAt: {
            type: "string",
            format: "date-time",
            description: "서버 기록 시각",
          },
        },
      },
      PayrollPaymentResultEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["paymentResult"],
        properties: {
          paymentResult: { $ref: "#/components/schemas/PayrollPaymentResult" },
        },
      },
      PayrollListEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["payroll", "nextCursor"],
        properties: {
          payroll: {
            type: "array",
            maxItems: 10,
            items: { $ref: "#/components/schemas/PayrollCycle" },
          },
          nextCursor: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 1024,
            description: "admin-all cycle keyset의 opaque continuation",
          },
        },
      },
      PayrollEntriesEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "entries", "nextCursor"],
        properties: {
          kind: {
            type: "string",
            enum: ["items", "lateEarnings", "adjustments"],
          },
          entries: {
            type: "array",
            maxItems: 50,
            items: {
              oneOf: [
                { $ref: "#/components/schemas/PayrollItem" },
                { $ref: "#/components/schemas/PayrollLateEarning" },
                { $ref: "#/components/schemas/PayrollAdjustmentEntry" },
              ],
            },
          },
          nextCursor: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 1024,
          },
        },
      },
      PayrollCycleEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["payroll"],
        properties: {
          payroll: { $ref: "#/components/schemas/PayrollCycle" },
        },
      },
      PayrollAdjustmentEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["adjustment"],
        properties: {
          adjustment: { $ref: "#/components/schemas/PayrollAdjustment" },
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

function prestartOperation(
  operationId: string,
  summary: string,
  input: string,
  output: string,
  role: string,
  id: string,
) {
  return {
    tags: ["Assignments"],
    operationId,
    summary,
    description:
      "active 역할·최신 session·비밀번호 변경 완료를 검증합니다. non-superseded attempt가 있으면 ASSIGNMENT_ALREADY_STARTED입니다. expectedCurrentAssignmentId와 expectedAssignmentVersion을 함께 전달합니다. 변경은 새 immutable revision이며 draft는 통보하지 않고 notified는 알림/outbox를 원자적으로 기록합니다. 예정 checkout identity와 실행 금지 경계를 유지합니다. 같은 key/본문 재시도는 동일 결과, 다른 본문은 IDEMPOTENCY_KEY_REUSED입니다.",
    security: [{ bearerAuth: [] }],
    "x-required-roles": [role],
    parameters: [
      {
        name: id,
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
      idempotencyHeader,
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${input}` },
        },
      },
    },
    responses: {
      "200": {
        description: "명령 완료",
        headers: { "Cache-Control": noStoreHeader },
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${output}` },
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

function prestartRequestSchema(
  action: "change" | "unassign" | "request" | "decision",
) {
  const properties: Record<string, unknown> = {
    expectedCurrentAssignmentId: { type: "string", format: "uuid" },
    expectedAssignmentVersion: { type: "integer", minimum: 1 },
    reasonCode: {
      type: "string",
      enum: action === "request"
        ? [
          "PERSONAL_REASON",
          "HEALTH_REASON",
          "MAID_UNAVAILABLE",
          "OPERATIONAL_CHANGE",
        ]
        : action === "decision"
        ? ["APPROVED", "REJECTED", "OPERATIONAL_CHANGE", "MAID_UNAVAILABLE"]
        : [
          "MAID_UNAVAILABLE",
          "SCHEDULE_CHANGED",
          "SEQUENCE_CHANGED",
          "OPERATIONAL_CHANGE",
        ],
    },
  };
  const required = Object.keys(properties);
  if (action === "change") {
    properties.maidProfileId = { type: "string", format: "uuid" };
    properties.sequenceNumber = { type: "integer", minimum: 1 };
    required.push("maidProfileId", "sequenceNumber");
    properties.availableFrom = {
      type: "string",
      format: "date-time",
      description:
        "수동 청소의 기존 접근 창 안에서 같은 KST 날짜로 좁히기만 허용. checkout 원장 시간 변경은 불가.",
    };
    properties.dueAt = {
      type: "string",
      format: "date-time",
      description: "기존 마감 이후로 늘릴 수 없음. 생략하면 기존 값 유지.",
    };
  }
  if (action === "request") {
    properties.reasonDetail = {
      type: "string",
      minLength: 1,
      maxLength: 200,
      pattern: "^[^0-9@:/]+$",
      description:
        "선택 상세 사유. PIN·고객정보·연락처·인증정보 입력 금지. 감사/알림에는 복제하지 않음.",
    };
  }
  if (action === "decision") {
    properties.decision = { type: "string", enum: ["approved", "rejected"] };
    required.push("decision");
  }
  return { type: "object", additionalProperties: false, required, properties };
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

function assignmentCommitImpactResponse(): Record<string, unknown> {
  return {
    description: "배정 알림 확정 사전 영향도",
    headers: { "Cache-Control": noStoreHeader },
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["impact"],
          properties: {
            impact: { $ref: "#/components/schemas/AssignmentCommitImpact" },
          },
        },
      },
    },
  };
}

function assignmentCommitResultResponse(): Record<string, unknown> {
  return {
    description: "선택한 배정 알림 확정 결과와 남은 작업",
    headers: { "Cache-Control": noStoreHeader },
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["result"],
          properties: {
            result: { $ref: "#/components/schemas/AssignmentCommitResult" },
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

function accountMutationDescription(operationId: string): {
  summary: string;
  description: string;
  success: string;
} {
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
        "admin 또는 maid의 Supabase Auth 비밀번호를 서버 내부 namespace의 임시값으로 초기화하고 `mustChangePassword=true`로 전환합니다. 외부 Auth 성공 뒤 server operation marker를 확인한 후에만 충돌한 개인 비밀번호 변경 receipt를 supersede하므로 Auth 실패가 복구 원장을 허위 완료하지 않습니다. 전체 휴대전화 번호나 임시 내부 변환값은 응답하지 않습니다. developer는 본인 비밀번호 변경 API만 사용합니다.",
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
