# #415 배정 카드 조회 최적화 — 1차 후보

## 2026-10-13 단일 순회 이월 표시 후보

PR453은 dev153ab78에 병합했다(CI38361677993 PASS). 후속 후보는 각 카드의
대상별 이력에서 기존 filter→revision 내림차순 sort→count/첫 reason 선택을
한 번 순회하는 count/최대 revision 선택으로 바꾼다. 같은 revision에서는 먼저 등장한
행을 유지하여 stable sort와 일치한다. cap=0에서도 reason=null을 유지하며 caller의
유효 carryover 검사와 target ID/revision/reason 조건을 그대로 사용한다.

필터 결과 배열 할당과 정렬을 제거하지만 DB 왕복·조회량·최종 권한 RPC 순서는
변경하지 않는다. #453의 요청-local 색인을 유지하며 카드 간 캐시도 추가하지 않는다.
이전 방법과 1200개 합성 조합 비교, tie/빈 이력/범위/횟수 상한/비변이성을 검사한다.
Node3003/typecheck/build와 Edge assignment39 PASS. 실제 운영 성능과 DB는 NOT RUN이다.
새 SQL/migration은 없고 Swagger/프런트 호출도 동일하다. 독립 QA4파일184개 PASS,
추가 P0/P1/P2 없음. 원격 전체 CI는 별도 확인한다.
Supabase 스킬의 권한 보존 기준을 따라 표시 계산만 변경하며 DB 검증은 승인 전 실행하지 않는다.

## 2026-10-13 후속: 요청 안의 일정 이력 색인 (미배포)

Node/Edge가 카드마다 전체 일정 이력을 필터링하던 부분을 대상 ID별 Map으로 한 번 묶는다.
각 카드에서는 자기 대상 이력만 기존 revision/reason 조건으로 필터링·정렬한다.
중복 revision, 입력 순서, 과거 배정, rollover 계산 및 응답 필드는 보존한다.
요청 간 캐시가 아니며 새 요청마다 새 Map을 만든다. DB/SQL/migration 변경은 없다.

대상마다 이력 1개인 N개 카드의 ID 검사량은 기존 N×N 대신 색인 N + 카드 N이다.
동일 대상에 여러 배정 revision이 있으면 대상 내부의 반복 필터링/정렬은 여전히 남는다.
이는 합성 검사에서 확인하는 탐색량이지 운영 지연시간 개선률이 아니다.
DB 왕복 수(기존 1/100/1000 fixture의 7/7/52), 100-ID 분할, exact count/누락 거부는 유지한다.
최신 #446의 최종 `get_assignment_schedule_read_for_plan` 권한·세션 검사는
모든 관계 조회 뒤에 그대로 남는다. 아래 이전 RPC명/검증 기록은 과거 checkpoint다.

API·Swagger·프런트 호출 변경 없음. 배포 전 후보이며 실제 DB/성능/UAT는 NOT RUN이다.
전체 DB 검증은 최종 릴리스에 1회, 마이그레이션/재구축 실행은 사전 사용자 승인 후만 한다.

로컬 검증: `npm run ci:quality` PASS (Node120파일3001개, typecheck/build,
secrets/OpenAPI/lint). lint의 기존 warning2/info37은 남아 있다. manifest117 PASS.
독립 QA4파일182개 PASS, 신규 P0/P1/P2 없음. Node/Edge core 일치 및 동일 대상의
여러 revision에서도 기존 필터·순서·비변이성을 검토했다. Edge 전체 검증/원격 CI는
별도 확인하며 이 로컬 결과로 대체하지 않는다.

PR453 최초 CI는 Edge 파일2개의 Deno 서식 불일치로 FAIL했다. 고정 Deno2.1.4로
서식만 보정 후 3파일 fmt check·Node3001/typecheck/build 재실행·Edge assignment39개
PASS를 확인했다. 코드 의미·검증 기준은 그대로이며 원격 전체 CI는 새 head에서 확인한다.

dev a5ab90d의 주급 서명 최적화를 통합했다. 충돌은 프런트 인계문서 한 곳이며
양쪽 절을 모두 보존했다. 주급 구현/검사는 dev와 동일하다. ci:quality Node3001 PASS.
Edge assignment+payroll 합성63개 PASS. 최초 두 수동 명령은 환경변수 접근 허용 목록
누락으로 FAIL했으며, 기존 CI와 같은 명시적 허용 목록으로 재실행하여 통과했다.
Docker/DB/마이그레이션은 실행하지 않았다.

2026-10-09, `dev@3e91d88` 기준. source 후보이며 운영 반영을 뜻하지 않는다.
사용자의 권장 순서 승인에 따른 #413 후속이다. #415 전체 완료/종료가 아니다.

2026-10-10에는 v0.9.2 사진 기능이 반영된 최신 dev `5787158`과 통합해 재검증한다.
최신 사용자 조정 순서는 가능일 누락 방지 #427 우선, 사진 정상 UAT 별도 진행,
공통 계측 PR417·묶음 조회 PR418·이 PR419 통합 및 릴리스다. 프런트가 이미 완료한
첫 페이지·단계별 표시를 중복 개발하지 않고 기존 조회 계약을 그대로 유지한다.

## 변경과 유지 계약

Node와 Edge에서 `attempts → 최신 attempt의 submissions` 조회를 하나의 의존 분기로
묶어 target/profile/schedule-history 조회와 겹쳐 실행한다. 다른 세 조회가 끝날 때까지
submissions를 대기시키던 순서만 변경한다. 관련 row 조회의 최대 동시 실행은 여전히 4다.

마지막 `get_assignment_schedule_read`는 모든 hydration이 성공한 뒤 실행한다.
최신 actor role/status, live session, 메이드의 실제 통보·본인 소유권을 다시 검증하는
기존 DB 경계를 앞당기지 않는다. historical 모드의 currentDeparture=null,
불변 통보 snapshot, 오늘 overdue/과거 exact-date, 제한 계정 차단을 유지한다.

최신 attempt/submission의 선택 순서와 취소 판정에 쓰는 **모든 attempt**를 보존한다.
쿼리별 exact count, 1,000건 상한 및 100-ID 순차 분할도 유지하며 누락/초과 결과는
부분 성공으로 반환하지 않는다. 추가 캐시·권한 완화·새 RPC·SQL·migration은 없다.
GET 두 경로의 요청/응답·Swagger·SDK는 그대로여서 프런트 코드 변경이 필요하지 않다.

## 호출 비용과 검증 방법

동일 메이드, 카드별 target/attempt 1개, 빈 rollover 이력, exact-date 목록 fixture 기준:

| 카드 수 | 이전 총 DB 요청 | 후보 총 DB 요청 | 최대 ID 묶음 |
| --- | --- | --- | --- |
| 1 | 7 | 7 | 1 |
| 100 | 7 | 7 | 100 |
| 1,000 | 52 | 52 | 100 |

목록 1 + profile 1 + 관계 조회 4×ceil(N/100) + 최종 RPC ceil(N/100)이다.
오늘 목록의 overdue 추가 조회, 여러 메이드, 여러 회차/이력은 별도 비용이다.
이 단계는 **DB 요청 수/부하 감소가 아닌 불필요한 의존 대기 제거**다.
시간 모델은 종전 `max(target,profile,attempt,history)+submission+authority`에서
`max(target,profile,attempt+submission,history)+authority`로 바뀐다.
이미 attempt가 가장 느리거나 submissions가 없으면 이득이 없을 수 있다.

Node 1/100/1,000 합성 fixture는 실제 adapter의 분할·호출수·순서·동일 카드 필드를 확인한다.
Node/Edge gate 테스트는 느린 target/profile/history를 의도적으로 멈춘 상태에서
submission 완료와 최종 권한 RPC의 미실행을 검증한 뒤, gate 해제 후 SESSION_REVOKED로
전체 응답이 거부되는지 확인한다. 타이머 기반 성능 비율을 통과 기준으로 쓰지 않는다.

## 검증 상태

- PASS: `npm run ci:quality` — secret scan, frontend OpenAPI 150 paths/162 operations,
  lint(기존 info 19개), typecheck, Node 106파일/2,675건, build.
- PASS: 독립 QA의 assignment-card 52건·Edge assignment 36건 직접 실행 및
  source/최종 문서 검토, 미해결 P0/P1/P2 없음.
- PASS: `npm run edge:check` — 전체 format/type/test/runtime 및 후보 bundle
  19,224,850 bytes (<20,000,000). 첫 실행의 변경 파일 format 2건 실패는
  Deno formatter 적용 뒤 전체 재실행(exit 0)으로 해소했다.
- NOT RUN: 이번 후보의 fresh DB·역할별 실제 DB/경합·운영 UAT·실제 p50/p95 및 payload 계측.
  SQL/RLS/schema 변경이 없어 로컬 migration 재적용은 하지 않았다. required CI는 별도다.

## 다음 단계 / 배포

#413 계측과 함께 실제 목록 크기·응답 bytes·DB 시간·왕복을 비교한다. 남은 DB 왕복 통합은
권한·snapshot 경계를 유지하는 bounded read RPC가 필요한지 #415에서 후속 판단한다.
인덱스/계획은 #416에서 다룬다. 위 합성 검증을 운영 속도 향상 수치로 제시하지 않는다.
프런트 인계는 기존 endpoint 유지 및 운영 미반영을 명시한다.

일반 PR은 dev 대상이며 필수 application/migration CI와 독립 QA를 통과해야 한다.
최종 release 승인 범위에서 API 코드를 반영한다. 이 변경의 DB 적용/secret/설정 변경은 없다.
문제 시 이전 API artifact로 rollback하며 DB rollback이나 이력 수정은 하지 않는다.

## 최신 dev 통합 검증 (2026-10-10)

- dev `5787158` 통합. 충돌은 제품 가이드 양쪽 변경을 보존해 해결했다.
- `npm run ci:quality`: PASS, Node 2722건 및 secrets/OpenAPI/lint/typecheck/build.
- `npm run edge:check`: PASS, Edge 496 + 보고 runtime 65건,
  후보 포함 bundle 19,248,612 bytes (20,000,000 bytes 미만).
- 독립 QA: Node assignment-card 52 + Edge assignment 36 = 88건 PASS,
  P0/P1/P2 차단 결함 없음. 최종 권한·세션 재확인과 누락·통보 이력 경계 보존 확인.
- `git diff --check` 및 staged diff PASS. 신규 SQL·운영 DB 적용은 없으며
  실제 DB/운영 성능/UAT는 NOT RUN. 새 head의 필수 CI 확인과 병합·릴리스는 후속이다.

## 가능일 누락 방지 통합 검증 (2026-10-10)

- dev `2f97cca`의 #427을 통합했고 가이드 #415/#427 양쪽 계약을 보존했다.
  배정 구현은 직전 HEAD와 같고 가능일 구현은 dev와 같으며 새 SQL은 없다.
- `npm run ci:quality`: PASS, Node 2746건 및 secrets/OpenAPI/lint/typecheck/build.
- `npm run edge:check`: PASS, Edge 519 + 보고 runtime 65건,
  후보 포함 bundle 19,254,568 bytes (20,000,000 bytes 미만).
- 독립 증분 QA: Node 79 + Edge 68 = 147건 PASS. 생성/구현 보존과 제품 가이드
  통합 검토 완료, 신규 P0/P1/P2 차단 결함 없음.
- 실제 DB/운영 UAT/실측 성능은 이번 검증에 포함하지 않았다.
  공통 계측 PR417 → 묶음 조회 PR418 → 이 PR419 순서로 최종 dev와 통합하며,
  각 최종 HEAD의 필수 CI·리뷰·보호 규칙을 확인하기 전 병합하지 않는다.

## 공통 계측·묶음 조회 병합 후 최종 통합 (2026-10-10)

- PR417/418이 필수 CI·독립 QA·리뷰·보호 규칙 확인 후 병합된 dev `a50355a`를 통합했다.
  제품 가이드 #415/#414/#413 절을 모두 보존했다. 배정 구현은 이전 HEAD `df0f689`와
  같고 timing/batch/photo/availability/dispatcher는 dev와 같다. SQL 변경은 없다.
- `npm run ci:quality`: PASS, Node 109파일/2789건 및 secrets/OpenAPI/lint/typecheck/build.
- `npm run edge:check`: 최종 PASS, Edge 525 + 보고 runtime 65건,
  후보 포함 bundle 19,277,578 bytes (20,000,000 미만).
- 첫 Edge 실행은 꺼진 Docker 엔진의 pipe 부재로 generated-format 단계에서 종료됐다
  (exit1, 환경 BLOCKED). 지정 Safe Start 1회 후 desktop running/server29.7.2 확인,
  같은 전체 명령 재실행 exit0으로 해소했다. 이미지/volume/WSL 삭제나 DB reset은 없다.
- 독립 QA: Node 235 + Edge 144 = 379건 PASS. 초기 Edge 환경 BLOCKED와 복구 후
  PASS를 구분한다. 생성 원본 두 종류·diff 검사 PASS, 신규 P0/P1/P2 없음.
- 실제 DB/운영 UAT/성능은 NOT RUN. 새 HEAD의 필수 application/migration CI 확인 후
  PR419 dev 병합과 별도 v0.9.3/#429 릴리스를 진행하며 현재 운영 기능으로 표시하지 않는다.
