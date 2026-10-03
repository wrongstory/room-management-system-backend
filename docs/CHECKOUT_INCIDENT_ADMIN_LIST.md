# 관리자 미퇴실 사건 목록 계약 (#327)

## 상태와 기준

2026-10-03 KST PR 생성 전 source checkpoint다. 선행 dev는
`3968e42967c8ad223661b7a3eb4ce200aabd2499` / 95 migrations이며 #328은 PR #351,
source `76e2780c0304a7336433cdd17e585610360785e3`, 동일 tree
`a7530cfa9c1f74cc104ca2e9f12f5ce1d341ce17`, CI `37027527827`
application/migration PASS와 독립 QA98/100으로 source/dev 완료했다.
과거 #328 후보/Draft/실패 checkpoint는 삭제하지 않는다.

이번 프런트 대조는 정본 `makee-ham/room-management-system`의
main `d509b44b1371f25d73891e04d355b0cb0e923f5f`,
dev `09ed28446a4fd43919cddb29ebe442b848548ab8` 및
`DOCS/28_FRONTEND_CONNECTION_BACKEND_MEETING.md` B05에 한정한다.
전역 제품 snapshot과 미확정 정책을 갱신하지 않는다.
다른 관리자의 신고 발견 → 최신 상세 → 기존 결정 진입을 제공하며 프런트 구현은 별도다.

## API와 사용자 흐름

`GET /v1/checkout-incidents`는 최신 active/password-complete business admin 전용이며
현재 open 사건만 반환한다. maid의 기존 본인 신고·실제 통보 이력 상세 권한은 유지한다.
`roomId`, `cleaningTargetId`, `serviceDate`를 조합할 수 있고
`limit`은 기본 50, 1–100, `cursor`는 최대 1024다.
알 수 없는/중복/빈 query, 비정규 limit, 잘못된 UUID·달력 날짜·서명 cursor는 400이다.
존재하지 않는 필터 ID도 목록은 빈 결과이며 새 404 계약을 만들지 않는다.

공개 응답은 `{ items, nextCursor }`이고 행은 아래 10개 필드만 가진다.

| 필드 | 의미 |
|---|---|
| incidentId / status | 사건 ID와 항상 open 상태 |
| roomId / roomNumber | 객실 진입 연결 |
| cleaningTargetId / assignmentId / attemptId | 신고 시 업무 graph 연결 |
| reportedAt | UTC 정확한 6자리 microsecond 시각 |
| serviceDate | 사건의 assignment.service_date; target의 현재 이월 날짜가 아님 |
| allowedDecisions | EXTEND_CHECKOUT, CONFIRM_DEPARTED, FALSE_REPORT 순서의 메뉴 안내 |

고객·신고자·예약 ID·PIN·private snapshot·version·impactFingerprint를 목록에 넣지 않는다.
목록은 결정 권한·확정 CAS snapshot을 발급하지 않는다. 사건을 선택한 뒤
`GET /v1/checkout-incidents/{incidentId}`에서 최신 version·impactFingerprint를 받고
기존 decision 명령을 사용한다. stale 결정의 기존 409와 freeze/coordination을 우회하지 않는다.
기존 알림의 cleaningTarget 연결을 해당 필터로 사용할 수 있으며 새 알림 enum·deeplink는 없다.

## 권한·페이지 이동·부작용 경계

신규 service-only `list_checkout_presence_incidents_page`는 STABLE SECURITY DEFINER,
빈 search_path와 명시 EXECUTE revoke/grant를 사용한다.
access token에서 식별한 actor와 session ID에 대해 최신 DB role/status/password,
auth.sessions의 정확한 user/session 및 `not_after IS NULL OR not_after > statement_timestamp()`를
빈 결과 전에도 검증한다. 만료·동일 경계·다른 사용자의 세션은 거부한다.
[Supabase session 문서](https://supabase.com/docs/guides/auth/sessions)의 정리 지연을
권한으로 취급하지 않으며 #352의 기존 공통 helper 개선 전체를 해결했다고 주장하지 않는다.

open partial `(reported_at DESC, id DESC)` index와 동일 정렬의 strict tuple seek를 사용한다.
모든 필터를 limit 전에 적용하고 DB가 limit+1개를 반환한다. Node/Edge는 lookahead까지
정확한 10-key 형태·UTC 달력·정렬·중복·anchor 범위와 최대 128 KiB를 검증한다.
마지막 반환 행으로 nextCursor를 만든다. anchor 사건이 해결돼도 다음 페이지를 탐색할 수 있다.
각 페이지는 현재 open 상태를 다시 읽는다. 페이지 간 동결 snapshot을 약속하지 않으며
더 최신 신고를 보려면 첫 페이지를 새로고침한다.

기존 `INSPECTION_CURSOR_HMAC_SECRET`를 같은 강도/재사용 방지 검사로 사용한다.
cursor v1의 별도 stream `checkout_presence_open`, actor, admin/open,
정렬과 정규화한 모든 nullable 필터가 서명에 묶인다. 페이지 크기는 바꿀 수 있다.
JWT·session·PIN·비밀값은 cursor payload에 넣지 않는다.
모든 성공·인증·권한·입력·실패 응답은 no-store다.

GET은 원장·예약·배정·attempt·version·receipt·감사·알림·outbox를 변경하지 않으며
외부 provider를 호출하지 않는다. 신규 table/column/RLS 정책·명령은 없다.
기존 migration 95개는 보존하고 CLI가 생성한 96번째
`20261002161001_checkout_incident_admin_list.sql`만 추가한다.

## 검증·운영 gate

필수 검증은 품질 gate(typecheck/test/build 포함), Node/Edge/OpenAPI parity,
실제 Python 생성 client, fresh local 96, 전체 SQL, 22개 upgrade, KST clock,
전체 동시성, migration history/ACL/RLS/advisors 및 합성 백업 복구다.
95→96 upgrade에서는 모든 public/private 행 전체 JSON·receipt·#328 snapshot과 기존
함수 정의/권한/RLS를 비교하며 필드 제외로 차이를 숨기지 않는다.
후속 97+ migration에도 이 증명이 변하지 않도록 source hash를 확인한 config와
첫 96개 migration만 생성 임시 workspace에 복사해 정확한 95→96만 적용한다.
원래 source 파일이나 환경/연결 정보를 옮기지 않으며 finally에서 원본 workspace의
최신 migration 전체를 복원하고 count/head를 검사한 뒤 생성 임시 경로만 정리한다.
아직 실행하지 않은 최종 검증은 PASS가 아니다. 독립 QA ≥90 및 in-scope P0/P1=0,
exact-head application/migration CI, 보호 규칙·미해결 review·충돌 확인 뒤에만 dev 병합한다.

기준선 읽기 전용 npm audit는 기존 3개 패키지(High2/Moderate1)를 보고하며
[별도 #334](https://github.com/wrongstory/room-management-system-backend/issues/334#issuecomment-5956564550)에서
Fastify/fast-uri/ip-address 사용 경로·호환 패치를 추적한다. 이 PR은 의존성을 바꾸지 않는다.
#353 기존 CI notification fixture drain도 별도 OPEN이며 이 목록 기능과 혼합하지 않는다.
main·production/recovery DB·운영 API·secret/provider·실제 PIN·프런트 UI/UAT·태그는 변경하지 않는다.
운영 반영은 별도 release→main 승인과 배포/smoke gate가 필요하다.

## PR 생성 전 로컬 완료 checkpoint

이 절은 PR 생성 전의 검증 checkpoint다. 최종 source/tree·CI·dev 통합 상태는
[Issue #327](https://github.com/wrongstory/room-management-system-backend/issues/327)의
연결 PR과 완료 기록을 확인한다. 이 파일에 미래의 병합·운영 완료를 미리 기록하지 않는다.

| 검증 | 현재 확인 결과 |
|---|---|
| application 품질 gate | PASS: typecheck/build 및 Node 913개 / 59 files |
| Edge format/check/test/bundle | PASS: 334개, 최종 OpenAPI prefixItems 변경 후 재실행 |
| Python lint/format/mypy/test/package source | PASS: 95개 테스트, 실제 source check |
| 실제 Python codegen | PASS: 새 목록 operation·10-field DTO·필수 nullable cursor·query; 기존 경고는 아래 별도 범위 |
| fresh local migration96 / manifest | PASS: 기존95 entries와 sealed release manifests 보존 |
| 신규 SQL | PASS: 실제68개(권한·정밀 seek·readonly·기존 결정 진입) |
| 95→96 실제 upgrade | PASS: 전체 행·#328 packs·정확한 receipt·기존 함수/권한/RLS 보존 |
| 전체22 upgrade + 전체 SQL | PASS: 전체22 upgrade 뒤 74 SQL files / 4229 assertions |
| KST clock / 전체 동시성 | PASS: 5 경계 ×29 =145; 중단 후 fresh local에서 동시성 전체3 프로그램 재실행 exit0 |
| 최종 db:reset / local history / advisors / 합성 복구 | PASS: reset96·local history96/source 일치·warn/error advisors0·합성121객실 복구 |
| 독립 QA | 전체 diff 독립 QA98/100, in-scope P0/P1/P2=0; Node↔Edge·SQL 교차 검토도98 |
| exact-head required CI / dev 병합 | NOT RUN: 커밋·PR 이후 gate |

초기 application 실패는 기존 OpenAPI path-count 두 검증값의 131→132 미반영이었다.
초기 SQL 67번 실패는 anon이 기존 schema USAGE 단계에서 42501로 거부되는데 함수 오류
문구만 고정한 시험 문제였다. 권한은 늘리지 않고 SQLSTATE와 별도 EXECUTE ACL 검증을 유지했다.
초기 업그레이드 실패는 전체 기존 함수 정의·ACL 카탈로그가 기본 subprocess 출력 버퍼 1 MiB를
넘은 ENOBUFS였다. 비교 내용을 줄이지 않고 bounded16 MiB·기존60초 timeout·원문 비출력을 유지해
실제 재검증에 통과했다. 이전 실패를 현재 PASS로 덮어쓰거나 운영 결함으로 단정하지 않는다.

#328 때부터 있었던 binary photo/AttemptLifecycleRequest 모델명 경고는
[후속 #355](https://github.com/wrongstory/room-management-system-backend/issues/355)에서 추적한다.
목록 관련 실제 생성 계약 PASS를 전체 SDK의 무경고·전 endpoint 생성 완료로 표현하지 않는다.
