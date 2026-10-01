# #308 지연 업무: 기존 업무 보존

정책은 #305와 제품 가이드의 확정 결정을 따른다. 현재 작업은 1차 source 후보이며
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

## #308 잔여 범위 — 완료/종료 전 필수

1. overdue durable ledger와 business admin typed inbox/outbox: 원 업무 identity,
   장기 재실행·10분 grouping 경계·동시 실행의 exactly-once, bounded scan, self-push 제외.
2. 관리자↔메이드 업무 상태 변경별 알림 coverage 확인 및 누락 보강.
3. 과거 미배정/draft 업무의 오늘 preview·현재 가능일·sequence 계약:
   target/assignment의 기존 serviceDate snapshot을 임의 수정하지 않는다.
4. 위 후속과 통합한 fresh/upgrade/RLS/concurrency/독립 QA/required CI.

1차 PR은 `Refs #308`로 연결하며 parent Issue를 닫지 않는다. #320 진단 PR과 optimizer
인접 변경이 있으므로 dev 통합 시 최신 head에서 충돌·회귀·문서 정합성을 다시 검사한다.

## 검증 기록

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
| 원격 required CI | NOT RUN(PR 등록 전); source/dev 승인·병합 미완료 |
| production/hosted/frontend UAT | NOT RUN; 별도 운영 범위 |

중간 실패와 보완을 숨기지 않는다. 첫 SQL 실행의 developer diagnostic head 3개 기대값을
86/85 metadata로 정합화한 뒤 전체 재실행은 통과했다. 동시성 회귀는 변경→새 current revision
활성화라는 합법적 직렬 순서를 추가로 검증하도록 identity/owner/revision/원 일정 검사를 보강했다.
기존 미래 fixture와 실제 DB clock 혼용은 실제 실행 시각/분 단위 예약 계약으로 맞췄으며,
checkout 보안 trigger는 완화하지 않았다. fresh reset 없이 재시도한 `DEVELOPER_ALREADY_EXISTS`는
환경 실패로 분리하고 이후 fresh DB로 실행했다. 독립 QA가 각각의 보완 근거를 재검토했다.
