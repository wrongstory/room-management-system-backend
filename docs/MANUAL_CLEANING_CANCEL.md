# 수동 청소 요청 취소 — #348 / #326 B안

## 사용자 결정과 범위

2026-10-02 사용자가 B안을 선택하고 PIN 조회에 따른 취소 제한을 전부 제거했다.
관리자는 수동 `manual_room_request + additional` 및 `stayover_request + stayover` 요청을
미배정/draft/notified와 미착수 scheduled 상태에서 취소할 수 있다. PIN 공개/숨김/만료/회수
여부는 판정 입력이 아니다. 자동 checkout, 실제 착수/현장 완료/제출/검수의 일반 취소,
#27 담당 변경·unassign 및 #264 수행 불가 예외는 변경하지 않는다.

## 명령·무결성

기존 `POST /v1/reservations/cleaning-requests/{targetId}/cancel`과
HTTP 응답·입력을 유지한다. app entry는 `public.cancel_manual_cleaning_request_with_session`이며
기존 `public.cancel_manual_cleaning_request`는 내부 실행/receipt 호환용으로만 유지하고
service_role의 직접 EXECUTE를 회수한다. 요청은 target `assignment_version`의
`expectedVersion`, 기존 reasonCode, Idempotency-Key를 사용한다. 신규 사유 enum이나 endpoint는
만들지 않는다. wrapper는 reservation-command advisory lock → actor FOR SHARE → exact session
FOR SHARE 순서로 최신 active/password-complete admin 및 actor auth user와 일치하는 live session을
잠가 검사한다. `clock_timestamp()`로 lock 대기 중 만료도 검사하며 권한 확인은 receipt replay보다
앞선다. session ID는 Auth 검증 bearer에서 추출한 내부 인자일 뿐 response/audit/receipt에 저장하지
않는다. source/status/착수 검사, target CAS와 기존 replay/hash namespace는 유지한다.

93번째 append-only `manual_cleaning_cancel_pin_independent`는 정확한 기존 구문만 변경하며
drift가 있으면 설치를 실패시킨다. 이전 92 migrations, 기존 원장/receipt를 수정·backfill하지 않는다.
취소 직전 current assignment를 잠가 nullable `cancelledAssignmentId`를 **감사 after_state에만**
고정한다. HTTP 응답/receipt는 기존 형태다. typed dispatcher는 동일 target의 exact row와 취소 사유·
종료 시각·감사 effectiveAt·취소 actor·target CAS 전이 증거를 결합한다. 하위 transaction에서도
동작하도록 row xmin과 top-level XID의 동등 비교에 의존하지 않는다. 그 row가 notified일 때만
취소 inbox/outbox를 한 번 기록하고
기존 actionable 알림을 resolve한다. 현재 담당이 없는 요청이나 미통보 draft에는 과거 통보 담당자를
찾아 알리지 않는다. 외부 push 호출은 commit 이후 기존 worker가 처리한다.

scheduled attempt는 superseded로 전환하며 기존 execution guard가 version을 +1 한다.
assignment·target 종료 trigger는 해당 entitlement와 미완료 reveal을 회수하고 legacy access lease도
폐기한다. 성공한 finalized reveal과 sensitive.read 이력, 이전 snapshot은 보존한다.
다른 업무나 관리자 독립 PIN 조회 권한을 회수하거나 물리 PIN을 바꾸지 않는다.

## 경합 기대값

- cancel → start: start 실패. start → cancel: cancel 실패. 실제 시작과 취소는 함께 성공하지 않는다.
- begin → cancel → finalize: finalize가 최신 권한 변경으로 실패해 평문 반환 전에 중단된다.
- finalize → cancel: 둘 다 성공할 수 있다. PIN을 봤어도 미착수 취소 가능하며 이후 해당 배정의 begin은 실패한다.
- 같은 key replay는 최초 응답만 재생하며 version·감사·알림을 다시 만들지 않는다. 다른 key의 오래된 CAS와 같은 key/hash 불일치는 실패한다.

## 검증·배포 상태

이 문서는 source 후보의 계약이다. 실제 검증 결과와 exact-head 독립 QA/required CI/dev 통합 근거는
[#348](https://github.com/wrongstory/room-management-system-backend/issues/348)에서 추적한다.
feature → dev만 처리하며 production/main/release/recovery·실제 PIN/암호키·tag는 변경하지 않는다.
양 Fastify/Edge adapter가 같은 새 session-bound RPC를 호출한다. 운영 승격 시 DB와 adapter를
한 릴리스 단위로 검증/적용해야 한다. 새 migration 적용 뒤 이전 runtime의 취소 호출은 권한 거부로
fail-closed하고, 새 runtime을 먼저 적용하면 미설치 RPC로 실패한다. 취소 명령의 짧은 전환 구간을
릴리스에서 관리하며 DB만 적용하거나 old adapter로 단독 rollback하지 않는다. 이 변경은 현재 운영에
적용하지 않는다. rollback은 호환 adapter/후속 migration을 함께 준비하고 원장/receipt를 되돌리지 않는다.
운영 적용·프런트 연결·사용자 UAT는 별도 gate다. #326 snapshot/sourceKind/rollover/canCancel
DTO 보강은 후속으로 유지한다.

### 이전 검증 차단 기록 — 2026-10-02

- `npm run ci:quality`: 실행 PASS, Node 715 tests / 53 files, typecheck/build 및 OpenAPI 131/141 확인.
- fresh local 93 migrations 설치: PASS. 하위 transaction의 xmin/top-level XID 차이를 실제 로컬
  rollback probe로 확인하고 취소 알림을 exact business evidence에 결합했다.
- 전용 SQL 3차 실행: 110 assertions PASS 후 잘못된 target enum fixture로 중단, 전체 결과 FAIL.
  fixture 후속 정합화는 별도 재검증 전까지 PASS로 간주하지 않는다.
- Edge 3차 실행: format/typecheck PASS, runtime 305 PASS / 4 FAIL. 신규 테스트 helper가
  인증용 sessionId와 금지된 PIN/sourceKey를 정상 업무 body에 섞어 strict validation에서 거부됐다.
  제품의 unknown-field 검사를 약화하지 않으며 유효 요청과 공격 입력 검증을 분리해야 한다.
- 당시 보완 반복 한도에 따라 추가 재시도·정상 완료 commit·push·PR·병합을 보류했다.
  아래 재개 검증과 구분하며 이 FAIL 기록을 새 PASS로 삭제하거나 소급 변경하지 않는다.
- 재개 후 첫 `npm run db:test`는 앞선 18 upgrades PASS 뒤 신규 92→93 fixture 준비에서 FAIL했다.
  SQLSTATE 42601의 원인은 JS replacement string이 SQL `$$`를 단일 `$`로 해석한 것이었다.
  제품 명령 실패나 기존 검증 기준 변경과 구분한다.
- 두 번째 전체 실행은 19 upgrades PASS, SQL 71 files / 3,931 assertions 중 3 FAIL이었다.
  `developer_operations.sql`이 이전 92번째 migration을 current head로 기대했기 때문이다.
  current/previous 이름과 삭제 fixture를 93/92에 맞췄으며 기존 32 assertions·drift 판정·
  transaction rollback을 유지했다. source head 정합화이지 검사 기준 완화가 아니다.

### 재개 검증 — 2026-10-02

- 정상 Edge 요청 body를 `expectedVersion`/`reasonCode`로 한정하고 인증 session은 검증 bearer에만
  둔다. 기존 정상 시나리오는 유지하고 금지된 sessionId/PIN/sourceKey 각각의 400·RPC 미호출·
  입력값 미반사 검증을 별도로 추가했다. 제품의 strict unknown-field 기준을 완화하지 않았다.
- `npm run db:verify`: fresh local 93 migrations PASS.
- `supabase test db supabase/tests/manual_cleaning_cancel_pin_independent.sql --local`:
  전용 SQL 147 assertions PASS. 이전 enum fixture 오류를 정합화한 결과다.
- `npm run ci:quality`: PASS, Node 715 tests / 53 files, lint/typecheck/build/secret scan 및
  OpenAPI 131 paths·141 operations 유지.
- `npm run edge:check`: format/typecheck/runtime/bundle PASS, 312 passed / 0 failed.
- shared fixture 삽입을 replacement callback으로 바꾸고 포함 원문이 byte-identical인 assertion을
  추가했다. 92 baseline rollback probe 및 92→93 upgrade 재실행·fresh cleanup은 PASS이며
  기존 20개 테이블의 이력·완료 receipt·성공한 공개 이력 보존과 역사 backfill 없음도 확인했다.
- Python backend console: Ruff/format/mypy/pytest 95 tests/OpenAPI codegen/package source PASS.
  기존 generator의 union-model 경고는 남아 있으며 이를 해결한 변경은 아니다.
- `npm run db:test:long-stay-clock`: 5개 KST 경계 × 29 assertions, 총 145 PASS.
- `npm run db:test:concurrency`: 기존 전체 경합·민원 response attention 및 신규 수동 취소 경합
  PASS, 마지막 fresh cleanup PASS. 실제 잠금 순서와 lock 대기 중 session 만료, 중복 key,
  cancel/start와 cancel/finalize의 양쪽 순서 및 exact-once 효과를 확인했다.
- `npm run backup:dry-run`: local-synthetic 93 migrations 복구 PASS. 운영 백업 검증이 아니다.
- local `supabase db advisors --type all --level warn --fail-on error`: 결과 0건, PASS.
- 로컬 complete coverage: 동일 제품·migration·script source에서 19 upgrades PASS와
  `supabase test db supabase/tests --local` 재실행 71 files / 3,931 assertions PASS를 확인했다.
  앞선 두 `npm run db:test` 전체 명령의 FAIL을 PASS로 소급 표기하지 않는다.
- exact-head required CI는 `npm run db:test`의 19 upgrades + 71 SQL 전체 SUCCESS를 필수로
  유지한다. 최종 독립 QA·dev 통합 근거는 #348에서 별도로 확인한다. 운영 배포 완료를 뜻하지 않는다.

### 프런트 scoped 확인과 남은 연결

2026-10-02 `makee-ham/room-management-system`의 main
`d509b44b1371f25d73891e04d355b0cb0e923f5f` 및 dev
`09ed28446a4fd43919cddb29ebe442b848548ab8`의 수동 취소 흐름을 읽기 전용 비교했다.
이는 전역 제품 가이드의 프런트 기준 commit 갱신이 아니라 #348/#326 관련 부분 확인이다.

- live 요청은 기존 취소 endpoint와 `expectedVersion`/`ADMIN_MANUAL_CLEANING_CANCELLED`를
  사용하므로 HTTP 계약을 변경할 필요가 없다.
- dev 배정 행의 취소 버튼은 `manualCleaningRequestId`와 정수 `targetVersion`을 요구하지만
  행 변환에서 두 필드를 보장하지 않는다. main에는 해당 배정 행 취소 버튼이 없다.
- demo/local 경로에는 배정·통보 제한 및 `access-review` 기반 PIN 차단이 남아 있다.
  #27 담당 해제의 별도 제한과 혼동하지 않고 수동 target 취소 경로만 정합화해야 한다.
- #326 snapshot/sourceKind/rollover/canCancel 조회와 프런트 담당자의 연결 작업이 남는다.
  #348 명령 구현만으로 버튼 노출·프런트 반영·실제 사용 테스트 완료를 주장하지 않는다.
