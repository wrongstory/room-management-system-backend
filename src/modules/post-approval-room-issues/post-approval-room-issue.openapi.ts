import { POST_APPROVAL_ROOM_ISSUE_BASE_PATH } from './post-approval-room-issue.routes.js';

const id = { type: 'string', format: 'uuid' } as const;
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const positiveRevision = { ...revision, minimum: 1 } as const;
const incrementableRevision = { ...revision, maximum: Number.MAX_SAFE_INTEGER - 1 } as const;
const memo = { type: 'string', minLength: 1, maxLength: 500, 'x-max-utf16-code-units': 500,
  description: 'JS UTF-16 code unit 기준 1..500이다. 공백만 있는 메모는 거부하며 문자열을 임의 trim하지 않는다.' } as const;
const object = <T extends Record<string, unknown>>(properties: T) => ({
  type: 'object', additionalProperties: false, required: Object.keys(properties), properties
} as const);
const evidenceItem = object({ evidenceId: id, revision: positiveRevision, displayOrder: { type: 'integer', minimum: 0, maximum: 9 } });
const evidence = { type: 'array', minItems: 1, maxItems: 10, items: evidenceItem,
  description: '서로 다른 새 evidenceId만 허용하며 displayOrder는 배열 순서대로 0..n-1이다. 기존 제출 사진은 사용할 수 없다.' } as const;
const source = object({ sourceSubmissionId: id, originalPerformerProfileId: id,
  sourceStatus: { type: 'string', enum: ['submitted', 'approved', 'rejected', 'superseded'],
    description: '원 제출의 현재 상태. 반려·대체 후에도 기존 신고 조회·증빙 열람·관리자 종결은 유지하며 신규 신고 가능 여부를 뜻하지 않는다.' },
  ownership: { type: 'string', enum: ['original_performer', 'notified_assignee', 'admin'] } });
const draft = object({ clientReportId: id, sourceSubmissionId: id, draftRevision: positiveRevision,
  evidenceRevision: revision, evidenceCount: { type: 'integer', minimum: 0, maximum: 10 }, memo });
const report = object({ reportId: id, clientReportId: id, sourceSubmissionId: id,
  originalPerformerProfileId: id, reportedByProfileId: id, reportedAt: { type: 'string', format: 'date-time' }, memo, evidence });
const reportRead = { ...object({ ...report.properties,
  closureRevision: { type: 'integer', enum: [0, 1] },
  closedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
  closedByProfileId: { anyOf: [id, { type: 'null' }] }
}), description: '현재 종결 상태. 미종결은 revision0/시각·처리자 null, 종결은 revision1/시각·실제 처리자 UUID다. 확정 명령의 역사 receipt는 변경하지 않는다.',
  oneOf: [
    { properties: { closureRevision: { const: 0 }, closedAt: { type: 'null' }, closedByProfileId: { type: 'null' } } },
    { properties: { closureRevision: { const: 1 }, closedAt: { type: 'string', format: 'date-time' }, closedByProfileId: id } }
  ]
};
const noStore = { 'Cache-Control': { schema: { type: 'string', const: 'no-store' } } } as const;
const error = object({ error: object({ code: { type: 'string' }, message: { type: 'string' } }), requestId: { type: 'string' } });
const response = (schema: unknown, description: string) => ({ description, headers: noStore, content: { 'application/json': { schema } } });
const errors = Object.fromEntries(['400', '401', '403', '409', '413', '415', '500', '503'].map((status) => [status, response(error, '고정 safe error code; raw provider/SQL/token은 반환하지 않는다.') ]));
const pathParameter = { name: 'sourceSubmissionId', in: 'path', required: true, schema: id } as const;
const keyParameter = { name: 'Idempotency-Key', in: 'header', required: true,
  schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' } } as const;
const base = POST_APPROVAL_ROOM_ISSUE_BASE_PATH.replace(':sourceSubmissionId', '{sourceSubmissionId}');
const common = { tags: ['Post-approval Room Issues'], security: [{ bearerAuth: [] }], 'x-required-roles': ['admin', 'maid'],
  'x-implementation-status': 'source-registered-not-deployed',
  description: '활성·비밀번호 변경 완료 업무 관리자 또는 본인 실제 통보 배정 이력이 있는 메이드만 접근한다. 메이드는 원 수행 여부와 무관하게 같은 target의 본인 실제 통보 배정 이력이 필요하며 original_performer/notified_assignee는 응답 ownership 구분이지 별도 접근 권한이 아니다. DB가 매 응답마다 actor/session/source에 묶어 확인하며 내부 근거는 공개 응답과 저장된 처리 결과에 포함하지 않는다. 운영 배포 전 후보 계약이다. 7일은 신고 마감이 아니며 현재 객실·검수·수익·주급을 변경하지 않는다.' } as const;

/** Registered source fragment. Hosted API/Swagger promotion is a separate release gate. */
export const postApprovalRoomIssueOpenApiFragment = {
  paths: {
    [`${base}/source`]: { get: { ...common, operationId: 'getPostApprovalRoomIssueSource', summary: '추가 특이사항 신고 대상과 접근 권한 조회',
      parameters: [pathParameter], responses: { '200': response(object({ source }), '본인 또는 관리자 source projection'), ...errors } } },
    [`${base}/drafts`]: { post: { ...common, operationId: 'savePostApprovalRoomIssueDraft', summary: '추가 특이사항 신고 초안 저장', parameters: [pathParameter, keyParameter],
      requestBody: { required: true, content: { 'application/json': { schema: object({ clientReportId: id, expectedDraftRevision: incrementableRevision, memo }) } } },
      responses: { '200': response(object({ source, draft }), 'CAS로 저장한 draft 또는 동일 key/payload 성공 receipt'), ...errors } } },
    [`${base}/drafts/{clientReportId}`]: { get: { ...common, operationId: 'getPostApprovalRoomIssueDraft', summary: '추가 특이사항 신고 초안과 증빙 상태 복구', parameters: [pathParameter,
      { name: 'clientReportId', in: 'path', required: true, schema: id }],
      description: `${common.description} 활성 관리자는 sourceSubmissionId/clientReportId로 같은 초안을 공동 조회한다. 메이드는 본인 작성 초안만 복구한다. 현재 evidence CAS·봉인 reportId만 반환하며 provider locator는 반환하지 않는다.`,
      responses: { '200': response(object({ source, draft, evidence: { ...evidence, minItems: 0 }, reportId: { anyOf: [id, { type: 'null' }] } }),
        '정확한 current typed 증빙 ID/revision/order; provider locator 없음'), ...errors } } },
    [base]: { get: { ...common, operationId: 'listPostApprovalRoomIssueReports', summary: '원 제출에 연결된 추가 특이사항 신고 목록 조회', parameters: [pathParameter],
      description: `${common.description} 같은 source의 최신50개를 reportedAt DESC/reportId DESC로 조회한다. client query/cursor/version을 받지 않으며 새 날짜 마감/타 메이드/초안 권한을 만들지 않는다.`,
      responses: { '200': response(object({ source, reports: { type: 'array', maxItems: 50, items: reportRead } }), '같은 원 source의 불변 신고와 현재 종결 상태'), ...errors } },
      post: { ...common, operationId: 'finalizePostApprovalRoomIssueReport', summary: '새 증빙으로 추가 특이사항 신고 확정', parameters: [pathParameter, keyParameter],
      description: `${common.description} 새 typed accepted evidence의 정확한 CAS·불변 seal·receipt·typed notification/outbox를 하나의 transaction으로 저장한다. source 등록이며 운영 DB·API 승격은 별도 릴리스 gate다.`,
      requestBody: { required: true, content: { 'application/json': { schema: object({ clientReportId: id, expectedDraftRevision: positiveRevision,
        expectedEvidenceRevision: positiveRevision, memo, evidence }) } } },
      responses: { '201': response(object({ source, report }), 'typed evidence 검증·immutable seal·receipt/outbox commit'), ...errors } } },
    [`${base}/{reportId}`]: { get: { ...common, operationId: 'getPostApprovalRoomIssueReport', summary: '추가 특이사항 신고 상세 조회', parameters: [pathParameter,
      { name: 'reportId', in: 'path', required: true, schema: id }], responses: { '200': response(object({ source, report: reportRead }), '실제 통보 배정 이력이 있는 메이드/관리자의 불변 신고와 현재 종결 상태'), ...errors } } },
    [`${base}/{reportId}/close`]: { post: { ...common, 'x-required-roles': ['admin'], operationId: 'closePostApprovalRoomIssueReport', summary: '관리자가 추가 특이사항 신고 종결',
      parameters: [pathParameter, { name: 'reportId', in: 'path', required: true, schema: id }, keyParameter],
      requestBody: { required: true, content: { 'application/json': { schema: object({ expectedClosureRevision: { type: 'integer', const: 0 } }) } } },
      responses: { '200': response(object({ reportId: id, closureRevision: { type: 'integer', const: 1 }, closedAt: { type: 'string', format: 'date-time' } }),
        'immutable 종결 event; 연결된 새 증빙만 종결+180일 보존, 원 제출/검수/수익 불변'), ...errors } } }
  }
} as const;
