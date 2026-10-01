# #308 지연 업무: 기존 업무 보존

정책은 #305와 제품 가이드의 확정 결정을 따른다. 현재 작업은 1·2차 source 후보이며
production/main/recovery, 실제 객실 데이터·PIN·계정은 변경하지 않는다.

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
- 수신자 상태는 enrollment와 typed writer에서 다시 확인한다. 계정 변경과의 역순 잠금을
  피하며 상태 변경으로 필요한 outbox가 불일치하면 transaction 전체를 실패·재시도한다.
  intent 생성 이후 비활성화는 역사 inbox/outbox를 보존하고 worker가 최신 상태로 전송을 억제한다.
- `cleaning_overdue`는 informational history(`requiresAction=false`, resolver `none`)이다.
  별도 검수 SLA·자동 재배정·주기별 반복 경보를 추가하지 않는다. 공개 projection과
  `cleaningTarget` deep link는 기존 Fastify/Edge 알림 API를 재사용하고 private 증거는 숨긴다.
- 프런트 dev `09ed28446a4fd43919cddb29ebe442b848548ab8`와 main
  `d509b44b1371f25d73891e04d355b0cb0e923f5f`를 읽기 전용 재확인했다.
  알림 category는 string, 기존 deep link와 한국어 title/body를 수용한다. 프런트 변경은 없다.

## #308 잔여 범위 — 완료/종료 전 필수

1. 2차 overdue 후보의 fresh/upgrade/RLS/동시성/독립 QA/required CI 완료 및 dev 통합.
2. 관리자↔메이드 업무 상태 변경별 알림 coverage 확인 및 누락 보강.
3. 과거 미배정/draft 업무의 오늘 preview·현재 가능일·sequence 계약:
   target/assignment의 기존 serviceDate snapshot을 임의 수정하지 않는다.
4. 위 후속과 통합한 fresh/upgrade/RLS/concurrency/독립 QA/required CI.

1·2차 후보를 포함한 Draft PR #340은 `Refs #308`로 연결하며 parent Issue를 닫지 않는다. #320 진단 PR과 optimizer
인접 변경이 있으므로 dev 통합 시 최신 head에서 충돌·회귀·문서 정합성을 다시 검사한다.

## 검증 기록: 1차 후보

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

## 검증 기록: 2차 후보

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
| 새 head 원격 required CI | NOT RUN; commit/push 전 |
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
