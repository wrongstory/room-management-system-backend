# #446 KST 자정 미착수 이월

상태: source 후보. 실제 DB 적용·SQL·upgrade·경합 검증 NOT RUN, 운영 미배포.
사용자 결정: 2026-10-13. 선행 계획일 API는 PR #447이며 프런트 연계는
makee-ham/room-management-system#219다.

## 날짜와 담당

10/13 23:59의 내일(10/14) 계획은 10/14 00:00에 오늘 계획이 된다. 해당 계획의
담당·순번·target·snapshot은 그대로다. 10/13 수행 예정이던 미배정·미착수만 같은 target으로
10/14에 이월한다. 통보일/조회 시각이 아니라 KST 계획일을 비교한다.

- 미배정: 일별 이월 근거, carryover_count, assignment_version, schedule revision을 추가한다.
- draft/notified: 기존 담당을 종료하고 미배정으로 바꾼다. 실제 시작하지 않은 scheduled 회차만
  superseded로 보존한다. 이미 통보한 담당에게만 기존 typed 회수 알림을 한 번 만든다.
- in_progress 및 이후 현장 완료/업로드/제출/검수: 담당·회차·사진·수익 근거를 유지한다.
- 원 담당 불변인 inspection_reclean, 미해결 checkout incident, 아직 materialize되지 않은
  퇴실 계획은 일반 이월에서 제외한다. 실제 퇴실·접근·점유 검사는 계속 적용한다.

원 `original_service_date`, `effective_service_date`, assignment `service_date`, `available_from`,
`due_at`, 요금/템플릿은 날짜 경과만으로 바꾸지 않는다. 예약의 원 일정과 불변 snapshot을
보존하기 위해 `assignment.rolled_over` 감사의 from/to 날짜와 해당 target version으로
현재 배정 계획일을 따로 계산한다. 오늘/내일 목록은 기존 `planningDate`를 사용하고
과거 assignment 이력과 완료 receipt는 재작성하지 않는다. 원 업무일을 오늘로 덮지 않는다.

## 구현과 경쟁

116번째 append-only migration `20261013065246_assignment_midnight_rollover.sql`을 추가한다.
기존 migration은 수정하지 않는다. private helper 세 개와 회전 cursor 컬럼·조회 index만
추가하며 public table/RLS/새 HTTP 경로는 없다. 새 helper는 runtime role에 직접 grant하지 않는다.

기존 scheduler receipt와 예약 공통 advisory lock 아래 이월을 먼저 처리하고 activation한다.
target/current assignment row lock과 version CAS, 실제 회차 상태를 다시 검사한다.
시작 command도 같은 activation guard에서 전일 미착수를 거부하므로 늦은 cron을 이용해
지난 담당이 시작할 수 없다. 이미 시작한 회차의 자정 이후 완료는 허용한다.
이전 회차/담당 종료와 기존 capability/entitlement trigger, 새 revision/감사/typed 알림을
한 transaction에 기록하며 외부 provider 호출은 없다.

한 번에 최대 100개 후보, 최대 100건 일별 이월을 처리한다. 누락 일수만큼 하루씩 근거를
남기고 회전 cursor로 이후 호출에서 계속한다. 중복 실행은 같은 날 근거를 추가하지 않는다.
재시작 직후 backlog 전체가 즉시 처리된다고 보장하지 않는다. source 날짜는 보존되므로
조회 후보가 반복 검사될 수 있으나 현재 계획일과 version이 중복 전이를 막는다.

## 프런트 계약과 배포

`GET /v1/assignments?serviceDate=D`의 D는 선택 계획일이며 응답 `serviceDate`는 원 업무일이다.
관리자/메이드 current 오늘 목록에서 미래 `planningDate`를 제외한다. 메이드 내일 목록은
해당 계획일만, 관리자 내일 목록은 그날까지의 배정 후보를 포함한다. 생성/통보 시각으로
필터하지 않는다. 담당 변경/확정에는 선행 #447의 D와 최신 CAS/availability를 그대로 전달한다.

최종 승인된 릴리스에서 DB-first 후 Edge/API 순서로 반영한다. 기존 schedule read RPC와
기존 응답 필드는 보존한다. 장애 시 scheduler/API를 직전 버전으로 되돌릴 수 있지만 이미
발생한 이월 이력을 삭제하거나 과거 담당을 자동 복구하지 않는다. 담당은 새 명시 배정으로
정정한다. 운영 migration/배포/cron 활성화는 이번 dev PR 범위에 없다.

## 검증 범위

- Node/Edge 합성 회귀: KST 자정 전후 동일 카드/담당, admin/maid, 원 업무일 보존.
- pgTAP 작성: 자정 전/정각, stale CAS/반복, draft/notified/scheduled, 사전 계획 보존,
  진행/현장완료/업로드/제출 제외, typed 알림 및 draft 무알림, 다일·월말·연말·윤년,
  100건 한도/catch-up, 관리자 제한/직접 EXECUTE 금지.
- 기존 activation/execution SQL과 병렬 scheduler 회귀 기대값을 새 정책에 맞춘다.
- 실제 SQL·upgrade·병렬 DB 검사는 실행하지 않았다. dev CI의 migration PASS는 manifest 검사다.
  전체 DB는 최종 릴리스에서 대상/범위를 사전 안내하고 매번 명시 승인 후 1회 검증한다.

독립 QA는 신규 pgTAP fixture의 typed writer mode 누락을 발견했다. 공개 scheduler가 receipt에서
설정하는 동일 `typed_v1` 모드를 직접 helper fixture에도 설정해 알림 검사가 실제 dispatcher를
통과하도록 보완했다. SQL 실행 PASS를 주장하지 않는다.
