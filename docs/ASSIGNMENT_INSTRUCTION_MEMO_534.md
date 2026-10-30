# #534 청소 배정 메모 · v1.0.0 인계

현재 상태: 개발 후보. 운영 DB/API와 프런트에 적용하지 않았다. 실제 SQL·경합·전체 DB 검증은
사용자 승인 전 NOT RUN이다. 이 문서는 해당 검증을 대체하지 않는다.

- 백엔드: https://github.com/wrongstory/room-management-system-backend/issues/534
- 프런트: https://github.com/makee-ham/room-management-system/issues/270
- 작업 브랜치: `codex/534-assignment-instruction-memo`, 기준 dev `f01efa3e` (#535 및 #532 보완 통합)
- DB 소스: `20261030143048_assignment_instruction_memo.sql` (dev manifest 140번째 후보)

## 사용자 요구와 보존

관리자가 배정할 때 객실별 선택 지시를 입력한다. `쓰레기만 치워주세요`, `수건 5. 물 캡슐 2.`
같은 텍스트를 해당 청소의 배정 revision에 저장한다. 관리자끼리 공유하며 메이드는 실제
통보받은 본인의 배정 메모만 조회한다. 다른 메이드의 새 초안/후속 메모를 과거 배정에 붙이지 않는다.

메모는 선택 사항이며 텍스트 자체가 청소 유형·사진 제출 조건·검수·수당을 바꾸지 않는다.
메모를 남겨도 자동 청소 완료나 지급은 일어나지 않는다. 현행 청소 사진 계약은 검수 승인/반려
후 168시간이며 특이사항/민원 증빙의 종결 후 180일 계약과 구별한다. 실제 운영 삭제 실행 여부는
별도 기능의 실행 근거로 확인해야 한다. 텍스트에는 현재 자동 만료·삭제가 없으며, 이번 메모도
배정 이력과 함께 남긴다. 새 보관 기간이나 전체 초기화 정책은 추가하지 않는다.

## 프런트 요청·응답

기존 `POST /v1/assignments/drafts`와
`POST /v1/assignments/{cleaningTargetId}/change` body에 선택 `instructionMemo`를 추가한다.
다른 필수 필드·CAS 버전·Idempotency-Key는 기존 계약 그대로다. 메모만 변경해도 기존 change
요청의 필수 담당/순서/버전 등을 함께 보내고 새 요청 키를 사용한다. 기존 착수 후 변경 제한은 유지한다.

| 입력 | 의미 |
| --- | --- |
| 필드 생략 | 동일 청소 target의 가장 최근 배정 메모 유지; 첫 배정이면 null |
| 문자열 | 원본 최대 500 UTF-16 단위, 앞뒤 공백 제거 후 저장 |
| null / 빈 문자열 / 공백만 | 명시적으로 지우기; 후속 배정에서도 옛 메모를 되살리지 않음 |

수량·호수·날짜·줄바꿈은 허용한다. NUL·잘못된 유니코드와 알려진 이메일/URL/휴대전화/PIN
형식은 HTTP 입력 검사에서 `VALIDATION_ERROR`(400)로 거절한다. DB 내부 정규화에서 같은 제한을
위반하면 `ASSIGNMENT_INSTRUCTION_INVALID`(400)로 매핑한다. 두 경로 모두 입력 원문을 오류에 반영하지 않는다.
이는 모든 개인정보를 자동 탐지한다는 보장이 아니다. 프런트에도 개인정보·PIN·인증정보를
쓰지 말라는 안내와 글자 수 표시를 둔다. JavaScript의 `value.length`가 서버의 UTF-16 기준과 같다.

다음 읽기 객체는 `instructionMemo: string | null`을 반환한다.

- Assignment 및 AssignmentCard: 목록·배정 이력·명령 반환의 해당 revision.
- AssignmentCommitCandidate 및 AssignmentCommitBlockedCandidate: 통보 영향 미리보기.
- AttemptExecution: 현재 수행·제한 계정의 정확한 수행 조회·lifecycle 영향 조회.

과거 receipt와 메모를 포함하지 않는 수행 변경 receipt는 null로 정규화한다. 현재 DB의 메모로
과거 응답을 보충하지 않는다. 프런트는 assignment ID/revision이 다른 메모를 재사용하지 말고,
수행 변경 응답으로 메모가 필요한 경우 권한 있는 배정/수행 읽기를 새로 요청한다.
순수 자동배정 추천(`/v1/assignments/preview`)의 알고리즘/추천 DTO에는 메모를 추가하지 않는다.
추천 결과를 draft로 저장할 때 각 청소의 입력란 값을 함께 전달한다.

기존 메모를 수정하지 않는 프런트는 필드를 생략한다. 공통 form 초기값 null을 무조건 보내면
기존 메모가 지워지므로, 사용자가 실제로 초기화한 경우만 명시적 null을 보낸다.
실패한 저장을 화면상 성공으로 처리하지 않고 409 충돌은 최신 배정/버전을 다시 조회한다.

## 저장·권한·호환성

`public.cleaning_assignments.instruction_memo`는 nullable text다. 기존 행은 null을 유지한다.
기존 `changed_by`/`created_at`과 assignment ID/revision이 변경자·시점 근거이며 과거 행의 메모는
직접 UPDATE할 수 없다. 같은 target의 새 revision은 생략 시 최신 이전 revision을 계승한다.
재배정·인계·일정 변경·기한 경과 후 동일 target 재배정도 적용되며, 새 예약/새 target으로는 복사하지 않는다.

INSERT의 내부 빈 문자열 default는 계승 표지다. BEFORE INSERT가 이를 소비하고 실제 값 또는
null로 치환한다. 공개 입력의 빈 문자열은 먼저 null로 정규화하므로 계승과 초기화가 구별된다.
기존 admin/통보받은 자기 배정 RLS와 좁은 컬럼 SELECT 권한을 유지한다.

메모가 명시된 HTTP 요청만 새 `*_with_instruction` RPC를 사용한다. 생략한 요청은 기존 RPC와
hash를 그대로 사용하므로 기존 재시도 receipt가 깨지지 않는다. 변경된 메모는 요청 hash에 포함되고
CAS/동시 요청/동일 키 다른 내용 거절 및 유지보수 차단을 기존 명령과 공유한다.
감사·push/outbox payload에 메모 원문을 추가하지 않는다. 감사용 기본 수행 projection은 그대로다.

## v1.0.0 통합·배포 순서

1. 이 feature PR의 source/application CI와 독립 QA 결과를 확인해 dev에 통합한다.
2. 다른 채팅의 최신 v1.0.0 후보와 source/manifest/head·OpenAPI를 대조한다. 기존 1~139 migration을
   수정하지 않는다. 후보 140의 exact-anchor 검사 실패를 우회하지 말고 통합 상대 변경을 검토한다.
3. 사용자 승인 후 최종 통합 입력에서 전체 DB 검증 1회에 새 SQL 회귀 검사를 포함한다.
4. 운영 이력·pending 목록을 제시하고 운영 migration 실행 전에 별도 승인받는다.
5. 승인된 DB 변경 후 해당 입력의 API/Swagger를 배포하고 프런트 #270을 연결한다.
6. admin 입력→통보→해당 maid 읽기, 재배정 계승/초기화, 타인 접근 거절과 기존 무메모 배정을 점검한다.

DB/API 적용 전에 프런트에서 이 기능을 운영 활성화하지 않는다. DB만 적용한 상태는
완성된 기능이 아니다. 문제가 있으면 프런트 입력을 중지하고 검증된 이전 API로 되돌릴 수 있으나,
기존 데이터·메모 column/이력은 삭제하지 않는다. 파괴적인 down migration을 제공하지 않는다.
신규 환경변수나 외부 서비스 권한은 필요하지 않다.

## 검증 기록

2026-10-31 로컬 최종 입력: dev `f01efa3e`의 #535 및 #532 보완과 #534 후보를 통합했다.
PR #539의 첫 head `1f02676`에서 required CI run41077963617이 통과한 뒤,
dev의 새 #532 보완을 충돌 없이 통합했다. 최종 통합 CI는 PR에서 별도로 확인한다.

| 검증 | 실제 결과 |
| --- | --- |
| `npm run ci:quality` | PASS: 비밀 검사·OpenAPI·lint·typecheck·Node 209파일/5,589건·build |
| `npm run edge:check` | PASS: Deno 577건·사전 65건·생성 JS 68건·fmt 139파일·타입 검사 |
| `npm run db:manifest:verify` | PASS: dev 140건, 139 password-effect와 140 memo의 서로 다른 고정 hash 보존 |
| `npm run openapi:template-client:check` | PASS: 기존 템플릿 client/경계 회귀 |
| Python 콘솔 CI 6종 | PASS: Ruff·format 227파일·mypy 26파일·pytest 139건·임시 전체 OpenAPI 생성/roundtrip/compile·build source |
| 독립 QA | PASS: 관련 147건·별도 Unicode 합성 2,641건 및 최신 dev 통합 134건 재확인; 미해결 P1/P2 없음 |
| 실제 SQL·RLS·경합·전체 DB·운영 적용 | NOT RUN: 실행 전 사용자 승인 필요 |

source grammar 검사는 PostgreSQL 15/17 파서와 정확한 함수 변경 지점을 검사하지만 DB 실행
증거가 아니다. 새 `supabase/tests/assignment_instruction_memo.sql`은 승인된 최종 DB 실행에서
실행해야 한다. migration140 LF SHA-256은
`9bdadc1789d8971b920368af45f3483091e2bddc21af91f3fcb4d6a4d8fcf1e9`다.

최신 통합 전체 검사에서 기존 합성 checkpoint-runner 1건이 5초 시간 초과했다.
코드/검사 기준 변경 없이 단독 11건 및 전체 5,589건 재실행이 통과했다. 이 합성 검사는
실제 DB가 아닌 가짜 입출력만 사용한다. 실패를 실제 DB 실패나 완료 증거로 해석하지 않는다.

최종 실제 API 번들은 19,319,375 bytes, 보고 기능 포함 후보는 19,985,124 bytes다.
후자는 20,000,000 bytes 제한까지 14,876 bytes 여유이므로 v1.0.0 추가 통합 뒤 실제 번들
검사를 다시 확인한다. 기존 Python 생성기의 사진/lifecycle 중복 모델 경고는 남아 있으며
신규 메모 모델의 실제 생성·왕복 검사는 통과했다. 기존 lint 경고는 실패로 처리되지 않았다.
이 검증은 GitHub CI, 최종 DB 검증 또는 운영 적용 완료를 의미하지 않는다.
