import { PHOTO_INPUT_MAX_BYTES, PHOTO_MAX_BYTES } from '../photos/photo-binary.js';
import { postApprovalRoomIssueUploadStatuses } from './post-approval-room-issue-upload-contract.js';
import { POST_APPROVAL_HANDOVER_PATH } from './post-approval-room-issue-handover.routes.js';
import {
  POST_APPROVAL_ROOM_ISSUE_EVIDENCE_CONTENT_PATH, POST_APPROVAL_ROOM_ISSUE_EVIDENCE_STATUS_PATH,
  POST_APPROVAL_ROOM_ISSUE_EVIDENCE_UPLOAD_PATH, postApprovalRoomIssueEvidenceHttpErrorStatuses
} from './post-approval-room-issue-evidence.routes.js';

const id = { type: 'string', format: 'uuid' } as const;
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const object = <T extends Record<string, unknown>>(properties: T) => ({
  type: 'object', additionalProperties: false, required: Object.keys(properties), properties
} as const);
const operation = object({ operationId: id, status: { type: 'string', enum: postApprovalRoomIssueUploadStatuses },
  leaseVersion: { type: 'integer', minimum: 0, maximum: 8 }, evidenceId: id, itemRevision: revision, evidenceRevision: revision,
  mimeType: { type: 'string', enum: ['image/jpeg', 'image/webp'] }, sizeBytes: { type: 'integer', minimum: 1, maximum: PHOTO_MAX_BYTES },
  sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } });
const noStore = { 'Cache-Control': { schema: { type: 'string', const: 'no-store' } } } as const;
const error = object({ error: object({ code: { type: 'string', enum: Object.keys(postApprovalRoomIssueEvidenceHttpErrorStatuses) }, message: { type: 'string' } }), requestId: { type: 'string' } });
const response = <T>(schema: T, description: string) => ({ description, headers: noStore, content: { 'application/json': { schema } } });
const errors = Object.fromEntries(['400', '401', '403', '408', '409', '410', '413', '415', '429', '500', '503'].map(status => [status,
  response(error, '고정 safe error code만 반환한다. SQL/provider locator/token/PIN/원문 예외는 반환하지 않는다.') ]));
const path = (name: string) => ({ name, in: 'path', required: true, schema: id });
const decimalSchema = (minimum: number, maximum: number) => ({ type: 'string', pattern: '^[0-9]+$',
  'x-integer-minimum': minimum, 'x-integer-maximum': maximum,
  description: `부호·소수·지수·공백 없는 decimal 문자열. 서버는 safe integer ${minimum}..${maximum}를 강제한다.` });
const casHeader = (name: string, minimum: number, maximum: number) => ({ name, in: 'header', required: true,
  'x-single-header': true, schema: decimalSchema(minimum, maximum) });
const key = { name: 'Idempotency-Key', in: 'header', required: true, 'x-single-header': true,
  schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' } } as const;
const binary = { type: 'string', format: 'binary', maxLength: PHOTO_INPUT_MAX_BYTES, 'x-max-bytes': PHOTO_INPUT_MAX_BYTES } as const;
const uploadContent = Object.fromEntries(['image/jpeg', 'image/webp', 'image/heic', 'image/heif'].map(mime => [mime, { schema: binary }]));
const common = { tags: ['Post-approval Room Issues'], security: [{ bearerAuth: [] }], 'x-required-roles': ['admin', 'maid'],
  'x-implementation-status': 'deployed',
  'x-deployed-release': 'v0.9.0',
  'x-query-allowed': false,
  description: '활성·비밀번호 변경 완료 상태와 실제 통보 배정 이력 또는 관리자 권한이 필요하다. 메이드의 초안 소유권과 업로드 실행자 권한은 별도로 검증하며 다른 메이드의 업로드 실행 권한을 주지 않는다. 모든 DB 경계에서 최신 session/source ownership을 검증하며 query와 caller authority 입력은 금지한다.' } as const;
const openApiPath = (value: string) => value.replace(/:([A-Za-z]+)/g, '{$1}');

/** Source registration accompanies runtime/Edge integration; not a hosted deployment claim. */
export const postApprovalRoomIssueHandoverOpenApiFragment = {
  paths: {
    [openApiPath(POST_APPROVAL_HANDOVER_PATH)]: { post: {
      ...common, 'x-required-roles': ['admin'], operationId: 'handoverPostApprovalRoomIssueEvidenceUpload', summary: '관리자가 증빙 업로드 실행 권한 인계',
      parameters: [path('operationId'), key],
      description: '활성·비밀번호 변경 완료 관리자만 기존 업로드를 본인에게 인계한다. 원 업로더·수행자 이력은 보존한다. 최신 DB session·권한·lease CAS와 공유 제한을 재검증한다. 같은 키와 요청의 재시도는 receipt를 재사용한다. 기존 provider identity만 inspect하며 새 사진을 생성하거나 삭제하지 않는다. query와 호출자 지정 actor/session/fence는 금지한다. 전용 영속 키와 복구 adapter가 없으면 503으로 거부한다.',
      requestBody: { required: true, 'x-max-bytes': 1024, content: { 'application/json': {
        schema: object({ expectedLeaseVersion: { type: 'integer', minimum: 0, maximum: 7 } })
      } } },
      responses: { '200': response(operation, 'operationId는 요청과 같고 leaseVersion은 expectedLeaseVersion보다 크다. 내부 fence/provider 정보는 반환하지 않는다.'), ...errors }
    } }
  }
} as const;

/** Global source OpenAPI includes this fragment; production release remains separate. */
export const postApprovalRoomIssueEvidenceOpenApiFragment = {
  paths: {
    [openApiPath(POST_APPROVAL_ROOM_ISSUE_EVIDENCE_UPLOAD_PATH)]: { post: { ...common, operationId: 'uploadPostApprovalRoomIssueEvidence', summary: '추가 특이사항 신고의 새 증빙 사진 업로드',
      parameters: [path('sourceSubmissionId'), path('clientReportId'), path('evidenceId'), key,
        casHeader('If-Draft-Revision', 1, Number.MAX_SAFE_INTEGER),
        casHeader('If-Evidence-Revision', 0, Number.MAX_SAFE_INTEGER - 1), casHeader('If-Item-Revision', 0, Number.MAX_SAFE_INTEGER - 1)],
      description: `${common.description} 본문 읽기/decoder 전에 durable admission·공유30/min·inflight8·quota를 검증한다. 최대5MiB 원본을 방향 보정·metadata 제거 후 최대307200 bytes JPEG/WebP로 저장한다. accepted replay는 같은 key/payload를 다시 검증하며 새 provider identity를 만들지 않는다. 응답 유실/불확실 업로드는 동일 immutable identity를 reconcile하고 즉시 orphan 삭제하지 않는다.`,
      requestBody: { required: true, content: uploadContent },
      responses: { '200': response(operation, 'DB acceptance 또는 같은 key/payload의 accepted replay. provider ID/session/fence/locator 없음'), ...errors } } },
    [openApiPath(POST_APPROVAL_ROOM_ISSUE_EVIDENCE_STATUS_PATH)]: { get: { ...common, 'x-body-allowed': false, operationId: 'getPostApprovalRoomIssueEvidenceUpload', summary: '추가 특이사항 증빙 업로드 상태 조회',
      parameters: [path('operationId')], responses: { '200': response(operation, '메이드는 본인 초안 작성자·현재 실행자 조건을 모두 충족한 operation만 조회하며, 관리자는 안전한 상태·leaseVersion을 공동 조회한다. 원 제출이 rejected/superseded(반려·대체)되어도 조회 권한만 유지한다. 실제 인계·provider 쓰기 권한은 별도이며 조회로 실행자·fence를 변경하지 않는다. 최신 session·role/status 권한 재검증은 유지한다.'), ...errors } } },
    [openApiPath(POST_APPROVAL_ROOM_ISSUE_EVIDENCE_CONTENT_PATH)]: { get: { ...common, 'x-body-allowed': false, operationId: 'getPostApprovalRoomIssueEvidenceContent', summary: '추가 특이사항 증빙 사진의 특정 버전 열람',
      parameters: [path('evidenceId'), { name: 'revision', in: 'path', required: true, schema: decimalSchema(1, Number.MAX_SAFE_INTEGER) }],
      description: `${common.description} provider read 이후 응답 직전에도 같은 증빙·버전·session·권한·purge 상태를 재검증한다. 원본 locator/hash/PIN을 HTTP header에 넣지 않는다.`,
      responses: { '200': { description: '서버 중계 JPEG/WebP binary만 반환; Cache-Control:no-store', headers: noStore,
        content: { 'image/jpeg': { schema: { type: 'string', format: 'binary', maxLength: PHOTO_MAX_BYTES, 'x-max-bytes': PHOTO_MAX_BYTES } },
          'image/webp': { schema: { type: 'string', format: 'binary', maxLength: PHOTO_MAX_BYTES, 'x-max-bytes': PHOTO_MAX_BYTES } } } }, ...errors } } }
  }
} as const;
