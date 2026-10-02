# #308 지연 업무: 기존 업무 보존

정책은 #305와 제품 가이드의 확정 결정을 따른다. 2026-10-02 기준 #308의 1·2·3차와
4A/4B1/4B2·5·6차는 PR #340으로 source/dev 완료했다. 아래 후보·Draft·잔여 gate는
2026-10-01 각 단계의 과거 기록이며 현재의 미완료 상태가 아니다.
6차 상대 역할 신고·선판정 통지는 [별도 검증 기록](./CLEANING_REPORT_NOTIFICATIONS.md)에 기록한다.

## 현재 source/dev 완료 근거 — 2026-10-02

| 범위 | 승인·통합 근거 |
|---|---|
| #308 업무 보존·알림·#320 진단 source 결합 | [PR #340](https://github.com/wrongstory/room-management-system-backend/pull/340), source `bdf3cda2347041134a73708f4209c4a36907f140` → dev `4d85458c5d0a900cf87f7318fcd9b2474c03a889`; 동일 tree `6013c056dd32208ce375138d17918de4bbfa3743`, [CI36864792279](https://github.com/wrongstory/room-management-system-backend/actions/runs/36864792279) application/migration PASS, 독립 QA98/100 |
| #343 컴플레인 미응답 주의 알림 | [PR #346](https://github.com/wrongstory/room-management-system-backend/pull/346), source `cc7eb199fae8f6b56408c932a8d4ea6b76d881b7` → dev `4fe6c981ff8252a55ce707525d2e659ed9f2d0a0`; 동일 tree `2c8e06ef48846a28670f472f6bdc3b1be8c5221f`, [CI36952950791 attempt 2](https://github.com/wrongstory/room-management-system-backend/actions/runs/36952950791/attempts/2) application/migration PASS, 독립 QA98/100 |

#308/#343의 source/dev gate는 완료했다. #305 종료는 이 문서 정합화 PR의 exact-head CI·
독립 QA·dev 통합 확인 뒤에만 수행하며 최종 근거는 [Issue #305](https://github.com/wrongstory/room-management-system-backend/issues/305)에서 추적한다.
최종 92 migrations·18 upgrade·70 SQL/3,784 assertions·Node694·Edge304·Python95·
KST145·121실 backup PASS와 과거 실패는 [#305 종료 감사](./WORK_DEADLINE_CLOSURE.md)를 따른다.
이 문서 변경은 main/production/recovery·프런트·tag·UAT의 변경이나 최신 운영 재검증이 아니다.
#320 실제 신고 사례 원인·프런트 한국어 매핑/UAT, #342 잠금 비용, #345 기존 지연 알림의
late-admin 원 event-clock 24h TTL 한계는 별도다. #343 신규 family의 enrollment-clock은
#345 보완이 아니다. 이전 `5267f35` same-key CI FAIL의 원인과 #300 실제 매칭 필드는 미확정이다.

## 1차 범위

- 당일 preview/commit은 dueAt 경과만으로 업무를 제외하지 않는다.
- 기존 통보 업무는 과거 서비스 날짜/dueAt 경과만으로 활성화·시작을 거부하지 않는다.
- 미래 날짜·접근 시각 미도래, 실제 점유, 퇴실 materialization, 현재 source/담당/회차/CAS,
  terminal state, 보안 session/capability/lease TTL은 유지한다.
- scheduler는 자동 rollover 대신 기존 배정의 활성화만 시도한다. 응답 호환용
  `rolledOverCount=0`, `rolloverResults=[]`는 유지한다.
- private 기술 cursor로 100건씩 공정하게 회전한다. 오래 막힌 선두 업무도 유지하지만
  뒤 업무를 영구히 굶기지 않는다. command receipt/replay는 기존 scope를 유지한다.
- UUID 스캔 순서는 업무 수행 순서가 아니다. 같은 객실의 선행 current notified 업무는
  아직 attempt가 없어도 후속 활성화를 보류한다. 선행 업무가 다른 페이지에 있거나
  cursor 이후 새로 삽입돼도 검사하며, 이미 종료된 회차 이력만으로 업무를 되살리지 않는다.
- `expire_scheduled`는 HTTP/DB 입력에서 거부한다. 기존 superseded 이력은 재작성하지 않는다.

Fastify와 Edge preview는 같은 순수 optimizer를 사용한다. lifecycle/start는 기존 Edge-only
경로이며 없는 Fastify endpoint를 추가했다고 표현하지 않는다. OpenAPI에서 폐기 action을 제거한다.

## 2차 범위: 최초 지연 관리자 알림

- `dueAt`은 현장 청소 완료 기한이다. 해당 시각을 지난 미완료 업무와, dueAt이 없고
  서비스일이 지난 업무만 탐지한다. null dueAt은 서비스일 다음 날 00:00 KST를
  지연 표시 기준으로만 사용하며 업무 창·권한 만료로 변환하지 않는다.
- 미배정/draft 또는 current notified/in_progress의 attempt-zero/scheduled/in_progress를 검사한다.
  현장 완료·업로드·제출·검수 대기 및 종료 회차에 새 overdue event를 만들지 않는다.
- 최초 target identity당 immutable typed evidence 1건, 활성/password-complete business
  admin 수신자별 enrollment/알림 1건을 원자적으로 남긴다. 담당·배정·일정·회차는 변경하지 않는다.
- 100건 keyset 순환과 기존 global reservation lock을 사용한다. 10분 grouping은 표시 묶음이지
  이벤트 identity가 아니다. 이후 실행과 다른 actor는 최초 event 시각/기존 notice를 재사용한다.
- 자기 수신 inbox는 보존하고 자기 push만 생략한다. 늦게 활성화된 admin의 inbox 추가는
  허용하지만 push의 기존 24시간 TTL을 연장하지 않는다. 완료된 업무에는 새 수신자를 추가하지 않는다.
  이 family의 outbox는 원 event 시각을 유지하므로 24시간 뒤 신규 admin push가 즉시 만료될 수 있다.
  이 한계는 [#345](https://github.com/wrongstory/room-management-system-backend/issues/345) OPEN이며
  [#343 신규 family의 enrollment-clock](./COMPLAINT_RESPONSE_ATTENTION.md)과 구분한다.
- 수신자 상태는 enrollment와 typed writer에서 다시 확인한다. 계정 변경과의 역순 잠금을
  피하며 상태 변경으로 필요한 outbox가 불일치하면 transaction 전체를 실패·재시도한다.
  intent 생성 이후 비활성화는 역사 inbox/outbox를 보존하고 worker가 최신 상태로 전송을 억제한다.
- `cleaning_overdue`는 informational history(`requiresAction=false`, resolver `none`)이다.
  별도 검수 SLA·자동 재배정·주기별 반복 경보를 추가하지 않는다. 공개 projection과
  `cleaningTarget` deep link는 기존 Fastify/Edge 알림 API를 재사용하고 private 증거는 숨긴다.
- 프런트 dev `09ed28446a4fd43919cddb29ebe442b848548ab8`와 main
  `d509b44b1371f25d73891e04d355b0cb0e923f5f`를 읽기 전용 재확인했다.
  알림 category는 string, 기존 deep link와 한국어 title/body를 수용한다. 프런트 변경은 없다.

## 과거 #308 잔여 범위 — 2026-10-01, PR #340 승인 전

아래는 단계 진행 당시 남았던 gate다. 6차 보완·전체 종료 감사·exact-head CI·dev 승인은
위 PR #340 근거로 완료됐으며 단계별 PASS/FAIL/NOT RUN 이력은 그대로 보존한다.

1. 1·2차 overdue 후보는 exact head `7d2337e`의 독립 QA 98점/required CI PASS. dev 통합은 미완료.
2. 3차 정상 시작 보완 이후 전체 종료 감사에서 신고·폭탄방 선판정 3건의 누락을 확인했다.
   6차 보완과 새 head 검증을 별도 기록하며, 3차의 주요 전이 표를 전체 알림 완료 근거로 사용하지 않는다.
3. 과거 미배정/draft 업무의 오늘 preview·현재 가능일·sequence 계약:
   4A/4B1은 DB 대상집합·공유 계산기까지, 4B2는 오늘 목록/commit 후보·잠금/가능일 보호까지 연결한다.
   5차는 최신 dev e19f81f 기준 #320 직접 의존 후보 ad91d2e와 source 계약을 결합한다.
   dev 병합·전체 coverage/종료 검토는 남았다.
   target/assignment의 기존 serviceDate snapshot을 임의 수정하지 않는다.
4. 위 후속과 통합한 fresh/upgrade/RLS/concurrency/독립 QA/required CI.

당시 Draft PR #340은 `Closes #308`을 예약했지만 미병합이어서 #308/#305를 닫지 않았다.
#320 진단 PR #339의 후보를 직접 의존 관계로 결합하며 `Refs #320`만 사용한다.
#320 실제 사용자 사례는 여전히 미확정이다. 당시 남아 있던 dev 통합 시 최신 head의
충돌·회귀·문서 정합성 검사는 PR #340의 최종 gate에서 수행했다.

## 과거 검증 기록: 1차 후보 — 2026-10-01

2026-10-01 로컬 합성 환경에서 실제 실행했다. 운영 검증 결과가 아니다.

| 검증 | 결과 |
|---|---|
| `npm run ci:quality` (secret/OpenAPI/lint/typecheck/test/build) | PASS; 50 files/582 tests, OpenAPI 131 paths/141 operations, 기존 lint info 2건 |
| `npm run edge:check` | PASS; 289 tests/fmt/type/bundle 17,167,699 bytes |
| `npm run db:test` | PASS; 13 upgrade 검사 후 fresh 86 migrations, 64 SQL files/3,406 assertions |
| `npm run db:test:long-stay-clock` | PASS; KST 경계 145 assertions |
| `npm run db:verify`, `npm run backup:dry-run` | PASS; fresh 86 migrations local-synthetic dump/restore |
| `npm run db:manifest:verify` | PASS; 기존 85개 SHA 보존, 신규 86번 head |
| Python ruff/format/mypy/pytest/codegen/package source | PASS; 95 tests. 기존 binary endpoint/lifecycle payload generator warning은 유지 |
| `npm run db:test:concurrency` | PASS; fresh DB 최종 재실행에서 전체 실제 RPC/다중 세션 경합 통과 |
| `npm run supabase -- db lint --local --schema public,private --level warning` | exit 0/error 0; 기존 STABLE/VOLATILE·unused 경고 유지. 기한 제거 후 private helper의 호환 signature `p_command_at` unused 경고도 유지 |
| 독립 QA (1차 범위) | 97/100, P0=0/P1=0; 승인 범위25/25·보안29/30·검증24/25·문서19/20 |
| 원격 required CI | phase 1 head `2789c30`의 run `36799349850`, attempt 2 application/migration PASS; source/dev 승인·병합 미완료 |
| production/hosted/frontend UAT | NOT RUN; 별도 운영 범위 |

중간 실패와 보완을 숨기지 않는다. 첫 SQL 실행의 developer diagnostic head 3개 기대값을
86/85 metadata로 정합화한 뒤 전체 재실행은 통과했다. 동시성 회귀는 변경→새 current revision
활성화라는 합법적 직렬 순서를 추가로 검증하도록 identity/owner/revision/원 일정 검사를 보강했다.
기존 미래 fixture와 실제 DB clock 혼용은 실제 실행 시각/분 단위 예약 계약으로 맞췄으며,
checkout 보안 trigger는 완화하지 않았다. fresh reset 없이 재시도한 `DEVELOPER_ALREADY_EXISTS`는
환경 실패로 분리하고 이후 fresh DB로 실행했다. 독립 QA가 각각의 보완 근거를 재검토했다.

## 과거 검증 기록: 2차 후보 — 2026-10-01

2026-10-01 로컬 합성 환경의 87번째 migration을 검증한다. 위 1차 결과와 별도이며
새 commit의 원격 CI와 독립 QA를 마치기 전에는 승인·병합 결과로 사용하지 않는다.

| 검증 | 결과 |
|---|---|
| `npm run ci:quality` | PASS; 50 files/583 tests, OpenAPI 131 paths/141 operations, 기존 lint info 2건 |
| `npm run edge:check` | PASS; 290 tests/fmt/type/bundle 17,167,699 bytes |
| Python ruff/format/mypy/pytest/codegen/package source | PASS; 95 tests, 기존 generator warning 유지 |
| `npm run db:reset` | PASS; fresh 87 migrations |
| `npm run db:manifest:verify` | PASS; 기존 86개 SHA 보존, 신규 87번 head |
| 최초 지연 SQL | PASS; worker 최신 상태를 포함한 최종 62 assertions |
| `npm run db:test` → 전체 SQL 재실행 | 13 upgrade PASS; 최초 SQL은 신규 overdue side effect를 미반영한 기존 snapshot 7개 FAIL. 보강 뒤 `npm run supabase -- test db supabase/tests --local` 전체 65 files/3,492 assertions PASS |
| `npm run db:test:long-stay-clock` | PASS; KST 경계 145 assertions |
| `npm run db:test:concurrency` | PASS; fresh 전체 재실행, 신규 8 actual RPC·현장 완료·stayover/checkout/change 경합 포함 |
| `npm run db:verify`, `npm run backup:dry-run` | PASS; fresh 87 migrations local-synthetic dump/restore |
| DB lint | exit 0/error 0; 기존 STABLE/VOLATILE·unused 경고와 새 helper `notice_id` unused 경고 유지. 오류 없이 writer 부수 효과로 호출하며 응답 UUID는 소비하지 않음 |
| 독립 QA (2차 범위) | 로컬 98/100, P0=0/P1=0/P2=0; 범위25/25·보안29/30·검증24/25·문서20/20. commit 후 exact-head 재확인/원격 CI 별도 |
| 새 head 원격 required CI | exact head `7d2337eb2b5239ef0c8b215daa13627fa2355e15`, run `36804535550` attempt 2 application PASS / migration PASS. 독립 QA exact-head 98/100, P0/P1/P2=0. Draft/미병합 유지 |
| production/hosted/frontend UAT | NOT RUN; 별도 운영 범위 |

첫 fresh reset은 신규 deferred 검사 함수의 CASE 괄호 누락으로 실패했다. 미적용 신규
migration만 보완한 뒤 fresh reset과 57개 검사를 재실행해 통과했다. 현장 수행 중인 target도
검사하되 최신 current attempt만 평가하며, 완료 요청과 감시 요청의 실제 RPC 경합 검사를 추가했다.
phase 1 CI attempt 1의 기존 password-change SQL test 88 실패는 #300에 기록했다.
같은 head와 검사 기준을 유지한 attempt 2는 통과했지만 #300을 해결됐다고 판단하지 않는다.
기존 SQL/동시성 snapshot은 신규 overdue 관찰만 별도 exact 검사로 분리했다. 모든 기존 notice
ID의 전체 원문과 다른 family는 기존 불변 검사를 유지한다. 신규 event/enrollment/inbox/outbox
개수·actor·deep link·원 시각·자기 push 없음도 검사하므로 새 알림을 단순 무시하지 않는다.
전체 동시성 검사는 해당 보강 뒤 fresh DB에서 재실행해 모두 통과했다. 13 upgrade 검사에
사용한 source는 바뀌지 않았으며 최종 SQL 재실행 결과와 최초 `db:test` FAIL을 구분한다.

같은 head의 첫 application CI는 pinned ECR 이미지 다운로드 `Rate exceeded`로 실패했다.
전체 run 종료 후 실패 application job만 한 번 재실행해 PASS했다. migration은 첫 실행에서
full `db:test`와 전체 concurrency까지 PASS했다. 이미지 digest/테스트 기준/코드는 바꾸지 않았다.
재발 방지 #341은 별도 OPEN이고 이 재실행으로 해결됐다고 판단하지 않는다.

## 3차 범위: 정상 청소 시작의 상대 역할 알림

- 기존 start/start-with-lease command가 남기는 `cleaning.attempt_started` audit에
  `cleaning.started_admin` / `cleaning_started`를 추가한다. 새 endpoint·table·외부 호출은 없다.
- 현재 attempt/assignment identity·revision·owner·시작 시각과 감사 actor/전이 evidence를
  확인하고 informational inbox(`requiresAction=false`, resolver `none`)를 만든다.
- 업무관리자 inbox는 계정 상태와 무관하게 보존한다. outbox는 active/password-complete
  비자기 수신자만 생성하고 기존 worker의 최신 계정/구독/TTL 검사를 유지한다.
- start 상태/CAS/audit/receipt/inbox/outbox가 같은 transaction이며 실패는 전체 롤백한다.
  동일 key replay는 같은 응답을 반환하고 새 key/stale version은 새 시작 알림을 만들지 않는다.
  migration은 기존 start 이력을 backfill하거나 늦게 추가된 관리자에게 과거 알림을 재생하지 않는다.
  같은 attempt의 start audit 복제도 거부하며 attempt-keyed partial audit index로 이 조회를 지원한다.
- 프런트 dev `09ed284` / main `d509b44`를 읽기 전용 재확인했다. 프런트 알림 정책의
  '정상 청소 시작은 관리자 자기 푸시 대상이 아니다'를 자기 actor 제외로 유지한다.
  #308의 상대 역할 통지는 메이드 시작→관리자이며 메이드 자기 push를 만들지 않는다.
- 완료·제출·검수·담당 변경의 기존 family와 push eligibility는 유지한다. 정상 사진 한 장 업로드,
  단순 조회·receipt replay·private draft 저장에는 새 업무 상태 알림을 만들지 않는다.

### 상태 변경 coverage

| 의미 있는 전이 | 상대 역할 통지 |
|---|---|
| 관리자 통보·재배정·순서/일정 변경·회수 | 기존 assignment/reservation family → 담당 maid |
| 관리자 담당 취소 결정·검수 승인/반려·제한 권한·인계 | 기존 decision/capability/handover family → 해당 maid; 승인 inbox/push 기존 정책 유지 |
| 메이드 담당 취소 요청·수행 불가 후속 | 기존 request/reassignment family → business admin |
| 메이드 정상 청소 시작(lease 포함) | 3차 started_admin → business admin |
| online/limited/offline 정상 적용·관리자 correction 현장 완료 | 기존 field_completed_admin → business admin |
| 최초 제출·재검수 요청 | 기존 initial/reinspection requested → business admin |
| 기한 경과 미완료 현장 업무 | 2차 overdue_admin → active/password-complete business admin, 원 업무 보존 |

과거 미배정/draft의 오늘 preview·현재 가능일/sequence는 이 단계에서 변경하지 않는다.

### 과거 검증 기록: 3차 후보 — 2026-10-01

2026-10-01 로컬 합성 환경의 88번째 migration과 직접 관련 회귀를 검증한다.
위 1·2차 결과는 역사 기록이며 3차 새 head 승인으로 사용하지 않는다.

| 검증 | 결과 |
|---|---|
| `npm run ci:quality` | PASS; 50 files/584 tests, OpenAPI 131 paths/141 operations, 기존 lint info 2건 |
| `npm run edge:check` | PASS; 291 tests/fmt/type/bundle 17,167,711 bytes |
| Python ruff/format/mypy/pytest/codegen/package source | PASS; 95 tests, 기존 generator warning 유지 |
| `npm run db:reset`, `npm run db:verify` | PASS; fresh 88 migrations |
| `npm run db:manifest:verify` | PASS; 기존 87개 SHA 보존, 신규 88번 head |
| `npm run db:test` → 전체 SQL 재실행 | 14 upgrade PASS; 최초 전체 SQL은 신규 start 알림을 미반영한 handover 총계 2건 FAIL. 보강 뒤 `npm run supabase -- test db supabase/tests --local` 전체 66 files/3,545 assertions PASS |
| `npm run db:test:long-stay-clock` | PASS; KST 경계 145 assertions |
| `npm run db:test:concurrency` | PASS; fresh 전체 재실행, 신규 actual 8 same-key/4 CAS start 및 기존 모든 RPC 경합 포함 |
| `npm run backup:dry-run:fresh` | PASS; fresh 88 migrations local-synthetic dump/restore, 121 rooms |
| DB lint | exit 0/error 0; 기존 STABLE/VOLATILE·unused 경고 유지, 신규 started helper 경고 없음 |
| local Security Advisor (`--level warn --fail-on error`) | PASS; No issues found |
| 독립 QA (3차 범위) | 로컬 98/100, P0/P1/P2=0; 범위25/25·보안29/30·검증24/25·문서20/20. Draft/push 준비 판정이며 새 exact-head CI 전 source/dev·병합 승인 아님 |
| 새 head 원격 required CI | NOT RUN; commit/push 뒤 새 exact-head 확인 필요 |
| production/hosted/frontend UAT | NOT RUN; 별도 운영 범위 |

최초 focused SQL의 짧은 idempotency key fixture는 기존 입력 규칙을 만족하도록 보완했다.
최종 신규 SQL 46 assertions는 위 전체 SQL PASS에 포함된다. handover 총계는 기존 3개 family와
새 start 1건을 각각 exact count로 검증하고, 원 start 알림 전체 JSON과 outbox 귀속도 보존한다.
최초 concurrency는 두 합성 계정이 같은 normalized 이름/sequence를 사용해 기존 고유 제약에서
실패했다. UUID별 이름으로 fixture만 보완했고 제품 제약·RPC 경합 수·판정 기준은 바꾸지 않았다.
이 최초 실패와 최종 fresh 전체 재실행을 구분하며 독립 QA가 보완 근거를 재검토했다.

## 4A 범위: 과거 업무를 보존하는 공유 순수 계산기

- 오늘 KST 계획 snapshot에 과거 미배정 target이 제공되면 원 날짜·접근/마감 그대로 제안한다.
  미래 신규 target을 오늘로 당기거나 과거 신규 target을 내일 계획으로 보내지 않는다.
- 과거 draft/notified/진행 고정 업무가 있다는 이유만으로 현재 가능 메이드의 새 계획을 제외하지 않는다.
  slot은 `(원 serviceDate, sequence)`이며 같은 날짜 중복·source 차단·owner/일정 불일치는 유지한다.
  고정 업무의 담당·날짜·sequence는 변경하지 않으며 동선 계산용 날짜/sequence 정렬을 새 실행 우선순위로 쓰지 않는다.
- 신규 제안은 고정 부하의 최대 sequence 다음 번호를 사용한다. 승인된 terminal target의 current
  assignment까지 포함한 실제 번호 점유·동시성 검증은 DB 저장의 책임이며 이번 계산기 변경으로 완료되지 않는다.
- Fastify/Edge가 같은 코드를 사용한다. 공개 endpoint/schema·DB/RLS/migration·receipt·알림 변경 없음.
- **4A 당시 종단 기능 미완료**: DB snapshot의 과거 대상집합, 오늘 목록 projection, commit 후보/잠금,
  오늘 가능일 변경 보호를 다음 단계에서 함께 연결해야 한다. 원 날짜 history 조회 의미는 보존한다.
  과거 데이터 planningDate 추측 backfill·단일 1–N 재번호화·자동 담당 변경은 하지 않는다.

### 과거 검증 기록: 4A 후보 — 2026-10-01

3차 source `9b039775a26e2a420e27178c9f98d0e6c4050c11`의 [required CI run36810797836](https://github.com/wrongstory/room-management-system-backend/actions/runs/36810797836)는
application/migration 모두 PASS로 2026-10-01 12:46 KST 완료됐다. 이는 4A 새 head 검증을 대신하지 않는다.
당시 PR #340은 Draft이며 #308/#305는 OPEN이었다.

| 4A 검증 | 실제 결과 |
|---|---|
| `npm run ci:quality` | PASS; typecheck/build/secret/OpenAPI/lint 포함, 50 files/588 tests, 131 paths/141 operations, 기존 lint info2 유지 |
| `npx vitest run tests/assignment-preview.test.ts` | PASS; 32 tests. KST 자정/내일 제외/현재 가능일/날짜별 고정 slot/기존 guard/입력 불변·shuffle 재현성 |
| `npm run edge:check` | PASS; fmt/type/292 tests/bundle17,167,852 bytes |
| `git diff --check` | PASS |
| 독립 QA | 로컬 96/100(범위25·보안29·검증23·문서19), P0/P1/P2 blocking0. focused 32 tests 재실행 PASS. commit 후 exact-head 재확인 별도 |
| fresh DB/upgrade/SQL/RLS/concurrency | NOT RUN for 4A; migration/DB/RLS/command 변경 없음. 3차 결과를 4A 새 head 승인으로 사용하지 않음 |
| Python/codegen/package | NOT RUN for 4A; 공개 API/schema 및 Python 코드 변경 없음 |
| 새 head required CI | exact head `4e1df5b1601b5720f6895d299e4e86456169139c`, [run36812997989](https://github.com/wrongstory/room-management-system-backend/actions/runs/36812997989) application/migration PASS; 2026-10-01 13:17:29 KST 완료. 4B1 새 head 승인으로 사용하지 않음 |
| production/hosted/frontend UAT | NOT RUN; 운영·프런트 변경 없음 |

## 4B1 범위: 오늘 DB snapshot·실제 날짜별 번호 점유

- CLI로 생성한 89번째 `20261001041801_cleaning_overdue_preview_snapshot.sql`은 기존 private
  STABLE snapshot 조회만 교체한다. 오늘 KST에는 과거 unfinished 업무를 포함하고 내일 신규
  계획에는 과거 attempt-0 업무를 복제하지 않는다. 과거 scheduled/current의 날짜 경과만으로
  unresolved를 만들지 않으며 미래 busy/원 schedule 불일치/실제 source·점유·선행 업무 guard는 유지한다.
- 원 target/assignment의 날짜·담당·순번·창·fee/history를 갱신하지 않는다. 최신 가능일은 요청 계획일의
  주차·날짜에서 읽고 과거 불가능을 오늘 가능으로 추측하지 않는다. 성공 조회는 모든 business/delivery
  원장의 exact byte-equivalence를 유지하며 새 receipt/audit/inbox/outbox를 만들지 않는다.
- 내부 `sequenceReservations`는 실제 UNIQUE가 살아 있는 current assignment를 원 날짜/메이드별
  max로 읽는다. approved/cancelled terminal target도 점유에 포함하고 noncurrent와 대상 날짜 밖 이력은
  제외한다. 공개 Preview에 이 필드를 노출하지 않고 fee/route 부하에도 합산하지 않는다.
- 계산기는 최대 번호 뒤에서 날짜별 새 번호를 제안하고 PostgreSQL integer overflow를 피한다.
  1,000 group/1,001 sentinel, 242 target/243 sentinel, 1,000 maid/1,001 sentinel은 fail-closed다.
  UUID·날짜별 계산 순서는 업무 실행 우선순위가 아니며 새 단일 1–N·planningDate backfill은 없다.
- 기존 private helper의 PUBLIC/anon/authenticated/service_role EXECUTE를 계속 막고, 기존 server-only
  public wrapper와 actor gate만 사용한다. RLS/table/public endpoint/schema/worker/외부 호출 변경은 없다.
- **4B1 당시 종단 기능 미완료**: 오늘 현재 목록, commit 후보·잠금, 오늘 가능일 변경 보호와 최신 dev/#320 통합은
  후속이다. Preview는 저장 권한이 아니며 최종 UNIQUE/CAS·ownership·멱등성은 저장 DB가 다시 검사한다.
  당시 PR #340 Draft, #308/#305 OPEN을 유지했다. 이 단계에서 production/main/recovery/프런트 변경 없음.

### 과거 검증 기록: 4B1 후보 — 2026-10-01

2026-10-01 fresh local synthetic 환경에서 검증한다. 4A exact-head CI PASS는 역사 기록이며
4B1 새 commit의 required CI를 대신하지 않는다. 프런트 `dev@09ed28446a4fd43919cddb29ebe442b848548ab8` /
`main@d509b44b1371f25d73891e04d355b0cb0e923f5f`를 읽기 전용 재확인했고 최신 head 변동은 없었다.
운영 wireframe은 draft 요청에 원 target ID/순번/CAS를 전달하고 target 날짜 자체를 수정하지 않는다.

| 4B1 검증 | 실제 결과 |
|---|---|
| `npm run ci:quality` | PASS; 50 files/606 tests, typecheck/build/secret/OpenAPI 131 paths/141 operations, 기존 lint info2 |
| `npx vitest run tests/assignment-preview.test.ts` | PASS; 50 tests; 실제 날짜별 terminal 점유·malformed/duplicate/limit/fingerprint/int overflow/입력 비변경 |
| `npm run edge:check` | PASS; fmt/type/292 tests/bundle17,174,044 bytes |
| 집중 SQL | PASS; 신규54 + 기존65 = 2 files/119 assertions; actual 역할별 RPC·private ACL·read-only transaction·source·snapshot·sentinel |
| `npm run db:manifest:verify` | PASS; 기존 88개 SHA 보존, 신규 89번 head |
| fresh DB/15 upgrade/전체 SQL | `npm run db:test` PASS; fresh89, 15 upgrades 및 67 files/3,599 assertions. 88→89 exact row digest 보존, today4→8/tomorrow4/terminal max60. 독립 집중119 재실행 PASS |
| KST clock | `npm run db:test:long-stay-clock` PASS; KST 경계 145 assertions |
| 전체 concurrency | `npm run db:reset` 후 `npm run db:test:concurrency` PASS; fixture 객실 분리 보완 후 전체 fresh 재실행. 기존 모든 RPC 경합·신규8 same-key/4 CAS 포함, 최초 FAIL 원인은 아래 기록 |
| fresh backup | `npm run backup:dry-run:fresh` PASS; fresh89 local-synthetic dump/restore |
| local DB lint/Security Advisor | lint exit0/error0, 기존 STABLE/VOLATILE·unused 경고 유지, 새 snapshot 경고 없음; `--level warn --fail-on error` Security Advisor PASS/No issues found |
| 독립 QA | 98/100(범위25·보안29·검증24·문서20), P0/P1/P2 blocking0; 독립 core50/SQL119/manifest/fixture 보완 PASS. 로컬 Draft/push 준비 평가이며 새 exact-head CI 전 source/dev·병합 승인 아님. commit 후 exact-head 별도 재확인 |
| 새 head required CI | exact head a5a78d0ec240bda64e93a18502eafa0a6691f241, [run36818593997](https://github.com/wrongstory/room-management-system-backend/actions/runs/36818593997) application/migration PASS; 2026-10-01 14:28:36 KST 완료. 4B2 승인으로 사용하지 않음 |
| Python/codegen/package | NOT RUN; 공개 API/schema 및 Python 코드 변경 없음 |
| production/hosted/frontend UAT | NOT RUN; 별도 운영 범위 |

첫 upgrade fixture의 upload-only 계정 신규 배정은 기존 `ACTIVE_MAID_REQUIRED`에서 실패했다.
실제 assignment/attempt는 활성 메이드로 생성하고 별도 제한 계정의 조회 상태를 검증하도록 fixture만
보완했다. 첫 집중 SQL의 제한 probe는 PL/pgSQL 변수/alias 이름 충돌에서 실패했고 alias만 바꿨다.
제품 guard·sentinel·검증 기준을 완화하지 않았으며 이후 집중119 assertions 재실행은 PASS다.

최초 fresh 전체 동시성 검사는 앞선 `overdue-complete-race`의 field_completed 업무와 activation-race가
640호를 공유해 `PREVIOUS_ROOM_WORKFLOW_ACTIVE`에서 실패했다. 독립 QA는 원 날짜/담당/current
revision이 보존된 상태에서 기존 객실 workflow guard가 올바르게 차단했음을 읽기 전용으로 확인했다.
activation fixture는 위치 기반 객실 slice 대신 기존 target/reservation/stay segment가 전혀 없는
활성·검증·미중단·점유 override 없는 객실 10개를 읽어 서로 분리한다. 실제 RPC 경합·exact count·
원 날짜/담당/회차 assertion과 제품 guard는 그대로다. 재검증 결과는 위 표에 별도로 기록한다.

## 4B2 범위: 오늘 현재 목록·과거 draft 확정·계획일 가능일 보호

- Fastify/Edge 오늘 `includeHistory=false` 목록만 과거 current unfinished assignment를 함께 읽는다.
  과거 approved/cancelled는 DB join/filter에서 제외하고 오늘 terminal 카드는 호환 유지한다.
  내일·다른 날짜·includeHistory/target history는 기존 범위다. 날짜→순번→revision→ID 정렬은
  표시의 안정성이지 새 수행 순서·재번호화가 아니다. KST 시각은 한 호출에서 한 번 캡처한다.
- 사용자 access-token RLS에서 메이드 본인 통보 row를 먼저 제한한다. 과거 current의 target innerjoin도
  기존 exact owner/revision/window/room RLS를 따르며 stale/모호한 조회를 관리자 권한으로 확대하지 않는다.
  역사 조회는 current target join 없이 자기 통보 revision을 유지한다. 메이드의 객실은 통보 snapshot만 쓴다.
- 목록 총1,000건, 관련 조회는 ID100건 batch별1,000건이다. exact count·실제 반환 수·상한을 검사하고
  잘린 attempt/submission/schedule에서 최신 상태를 추측하지 않는다. DB impact는1,001 sentinel로
  전체 후보1,000 상한을 확인한 뒤 fingerprint를 만든다. 상한 오류는 기존 redacted500 계약을 유지한다.
- CLI 생성 `20261001064101_cleaning_overdue_commit_planning.sql`은 90번째 append-only migration이다.
  동일 private 포함 함수로 오늘 preflight와 target/assignment/maid lock 집합에 과거 draft를 포함한다.
  기존 exact-date 범위 밖 요청의 blocked 사유와 오늘/내일 mutation gate를 유지하고 내일에 과거를 넣지 않는다.
  선택 항목121 상한·예약 advisory lock·현재 계정/원 schedule·CAS·receipt·부분집합 원자성은 그대로다.
- 최신 availability는 요청 계획일의 주차/날짜에서 읽는다. 항목별 serviceDate는 원 assignment/target
  날짜이고 최상위 요청/`assignment.notified` 감사의 serviceDate는 계획일이다. 불변 감사의 exact
  entity/assignment/target/maid/revision/계획일로 오늘 가능일 변경을 보호하며 원 날짜 보호도 유지한다.
  감사에는 notified assignment entity 전용 partial index를 추가한다. 새 business table/RLS/backfill은 없다.
- 기존 source preflight는 원 일정 검증이며 현재 점유/선행 workflow의 최종 activation/start 검사를
  대체하지 않는다. oversized commit의 기존 전체 후보 lock 뒤 impact 상한 재검증 순서는 유지하므로,
  forged/stale 요청의 lock 작업량까지1,000으로 제한하는 성능 보완은 후속이다. 일부 write/응답은 허용하지 않는다.
- 4B2 당시 PR #340 Draft, #308/#305 OPEN이었다. 최신 dev/#320 통합·전체 coverage/종료 판단과
  exact-head CI는 별도 gate였으며 이후 PR #340으로 완료했다. 이 단계의 운영·프런트 변경은 없었다.

### 과거 검증 기록: 4B2 후보 — 2026-10-01

2026-10-01 local synthetic 환경의 이번 후보 결과다. 이전4B1 CI PASS는 새 head 승인으로 사용하지
않는다. 프런트 dev09ed284/main d509b44를 읽기 전용 재확인했다. 최신 wireframe은 오늘 날짜로 목록/
preflight를 읽고 draft에는 target/maid/sequence/CAS만, commit에는 요청 계획일과 fingerprint를 보낸다.
원 target 날짜를 요청으로 변경하지 않는 계약을 유지한다.

| 4B2 검증 | 실제 결과 |
|---|---|
| `npm run ci:quality` | PASS;50files/616tests, secret/OpenAPI131paths141operations/typecheck/build, 기존 lint info2 |
| `npx vitest run tests/assignment-card.test.ts` | PASS;15tests, KST 경계·history/tomorrow·terminal·1000/1001·100ID batch·메이드 snapshot |
| `npm run edge:check` | PASS;fmt/check/295tests/bundle17,175,800bytes |
| fresh90 집중 SQL | PASS;`cleaning_overdue_commit.sql`50 + `assignment_commit.sql`35 = 2files/85assertions |
| `npm run db:manifest:verify` | PASS;기존89개 order/name/SHA 보존, 신규90 head |
| `npm run db:test` | PASS;fresh90/16upgrade harness/68files3,649assertions. 89→90의14원장 exact digest 보존과 실제 DB Lock 경합 양방향 PASS |
| KST clock | `npm run db:test:long-stay-clock` PASS;5시각145assertions |
| 전체 concurrency | `npm run db:reset` 후 `npm run db:test:concurrency` PASS;기존 실제 RPC 경합·과거 확정 양방향 경합 보존 |
| fresh backup | `npm run backup:dry-run:fresh` PASS;fresh90/121rooms local-synthetic dump/restore |
| local DB lint/Security Advisor | lint exit0/error0·기존 warning 보존, Security Advisor PASS/No issues found |
| 독립 QA | 98/100(범위25·보안29·검증24·문서20), blocking P0/P1/P2=0. 독립 전체Node616/typecheck/manifest5/diffcheck/focused15/1000·1001 batch probe/3filesSQL117 PASS. 로컬 Draft commit/push 준비 평가이며 새 commit/tree·exact-head CI 전 source/dev·병합 승인은 아님 |
| 4B2 exact-head required CI | head744662c, run36830906929 application/migration PASS(2026-10-01 16:50:38 KST 완료). 5차 새 head 승인 아님 |
| Python/codegen/package | 로컬 추가 NOT RUN;공개 schema/enum/생성 Python 변경 없음 |
| production/hosted/frontend UAT | NOT RUN;별도 운영 범위 |

첫 Edge format과 HTTP mock의 exact count/limit 누락은 보완 후 전체295tests PASS다. 첫 집중 SQL85는
원 요청 날짜가 범위 밖일 때 기존 preflight의 blocked 사유가 사라지는 회귀2건과 불변 가능일 row를
직접 UPDATE한 fixture1건에서 FAIL했다. exact-date 조회와 기존 mutation 요청일 gate를 보존하고,
fixture는 실제 submit RPC·새 버전을 사용하도록 보완한 뒤 같은85assertions를 재실행해 PASS했다.
제품 guard·기존 날짜 범위·원장 불변성·assertion을 삭제하거나 완화하지 않았다.

## 5차 구현 이력: #320 진단 후보와 업무 보존 계약 결합 — 2026-10-01

당시 같은 bounded assignment context의 직접 의존 후보를 로컬 source 브랜치에서 결합했다.
기준은 #308 `744662c`, #320 `ad91d2e`, 최신 dev `e19f81f`다. dev/main/운영 및
프런트 변경은 없었다. PR #340 Draft/#308/#305/#320 OPEN을 유지했으며 PR #339를 닫지 않았다.

- #320 진단은 #308의 `(원 날짜, 순번)` 고정 슬롯 검사를 사용한다. 과거 날짜와 동일 순번을
  충돌로 오판하지 않으며 원 target/assignment 날짜 불일치·진짜 중복·revision/owner/source
  차단·회차 provenance를 유지한다. orphan attempt는 기존 invalid snapshot으로 거부한다.
- 오늘 과거 후보·dueAt 경과 비차단·terminal 슬롯 예약·PG int 최대값·내일/미래 scheduled
  경계는 그대로다. 새 허용 목록 진단만 가산하고 fingerprint·점수·기존 배열 의미는 유지한다.
- Fastify/Edge/OpenAPI와 생성 Python 모델을 함께 검증한다. 성공/오류 preview는 no-store이며
  진단은 동일 snapshot에서 계산한다. 새 endpoint/migration·원장 write·RLS 변경 없음.
- 큰 board의 lock 전 상한 보완은 별도 [#342](https://github.com/wrongstory/room-management-system-backend/issues/342)다.
  이번 변경이 기존 전체 후보 lock 비용까지 제한하거나 #342를 해결한 것으로 표시하지 않는다.

### 과거 5차 검증 기록 — 2026-10-01

| 검증 | 실제 결과 |
|---|---|
| 시작 baseline | npm test PASS;50files616tests |
| npm run ci:quality | PASS;50files625tests/typecheck/build/secret/OpenAPI131paths141operations, 기존 lint info2 |
| Preview focused | PASS;pure/Fastify65tests. 독립 current-card 포함3files80tests |
| npm run edge:check | PASS;fmt/type/298tests/bundle17,194,004bytes |
| 기존744662c 직접 비교 | PASS;합성100개 mixed-date 기존 응답/점수/fingerprint 동일·입력 비변경;새 진단만 가산 |
| npm run db:reset + supabase test db supabase/tests --local | PASS;fresh90/68files3,649assertions |
| npm run db:test:long-stay-clock | PASS;5시각145assertions |
| npm run db:manifest:verify | PASS;5종/90개 기존 migration SHA/order 보존 |
| Python ruff/format/mypy/pytest/business OpenAPI codegen/package source | PASS;95tests,226files format/25source mypy;기존 binary-photo/handover generator warning 유지 |
| 5차 누적 upgrade/전체 RPC concurrency/복구 재실행 | NOT RUN;SQL/migration/worker/command 불변. 이전4B2와 동일90 source의 실제 검증/CI PASS는 역사 근거이며 새 head 승인 아님 |
| 독립 QA | 98/100(범위25·보안29·검증24·문서20), P0/P1/blockingP2=0. 독립 Node625/focused80/typecheck/manifest5/diffcheck와 기준744662c 직접 비교56case PASS. 로컬 Draft 통합 commit/push 준비만 승인 |
| 5차 exact-head required CI | head14676c17d6d05f5149ced2d14139f4516ea464fc, run36833580274 application/migration PASS(2026-10-01 17:17:47 KST 완료). 전체 db:test/16upgrade/SQL3,649/concurrency/backup도 원격에서 PASS. 6차 새 head 승인 아님 |
| production/hosted/기기/frontend UAT | NOT RUN |

첫 결합 focused는 3건 FAIL이었다. #320의 이전 e19 golden은 #308 빈 sequence metadata
정규화 전 fingerprint이고, 기존 conflict fixture는 날짜가 다른 두 순번을 같은 슬롯으로 가정했다.
git-show744를 독립 실행한 exact golden과 진짜 동일 원 날짜 중복 fixture로 검증했다.
overflow는 기존 NO_ELIGIBLE_MAID와 새 NO_FEASIBLE_ASSIGNMENT를 모두 엄격 검증한다.
계산기 hash·보안/제약·검증 기준을 옛 기대값에 맞추어 완화하지 않았다.
첫 quality는 새 합성 fixture의 undefined 가능성 typecheck에서 FAIL했다. 명시적 fixture guard를
추가한 뒤 전체 quality625/Edge298 재실행 PASS다. 최초 실패를 최종 PASS로 숨기지 않는다.
독립 QA 비교 probe의 첫 TypeScript7 transpile API setup은 실행 도구 오류로 FAIL했고,
esbuild로 같은 baseline을 변환해 56case PASS했다. 제품 결함·검증 기준 완화로 취급하지 않는다.
