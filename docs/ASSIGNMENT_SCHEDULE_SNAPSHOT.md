# #328 배정 일정 snapshot·현재 퇴실 조회 계약

> #328 최신 gate(2026-10-03): 세션 만료·KST fixture 보완 후 local 개별 검증은 PASS다(Node859·Edge323·Python95·같은 migration SHA의21 upgrades·전체SQL4161·KST145·전체동시성·fresh95·advisors0·합성복구). 초기 전체 `db:test` FAIL과 원래 CI `37017832732`의 migration FAIL은 이력으로 보존한다. 최종 독립 QA·새 exact-head CI·dev 통합은 후속 gate이며 [PR #351](https://github.com/wrongstory/room-management-system-backend/pull/351)은 아직 Draft다. [상세 실행 기록](./ASSIGNMENT_SCHEDULE_SNAPSHOT.md#보완-후-local-개별-최종-검증)을 따른다.

## 상태와 범위

2026-10-02의 선행 source/dev 정본은 `f34dca3746a1e553a773470aba13b55fa95bf816`이다.
#326은 [PR #350](https://github.com/wrongstory/room-management-system-backend/pull/350)의 source
`2eb489c5950418566f869acb2959fa1ff56d0e33`와 dev squash의 tree
`3eae9e51ade5f3e23104a2f676039a00eef22265` 동일성, required CI `36987938462`
application/migration PASS와 독립 QA98/100으로 source/dev 완료했다. 94 migrations이며
그 결과를 #328의 검증으로 재사용하지 않는다.

#328은 95번째 append-only `assignment_reservation_schedule_snapshot` 및 기존
`AssignmentCard`의 `scheduleSnapshot`/`currentDeparture` 보강 **구현 후보**다.
OpenAPI `0.6.0` / 131 paths·141 operations는 유지한다. Preview·commit-impact·draft/commit
응답과 요청 계약은 확장하지 않는다. local full regression은 PASS다. 이 문서는 PR 생성 전
검증 시점 기록이며 최종 독립 QA·exact-head CI·dev 통합은
[Issue #328](https://github.com/wrongstory/room-management-system-backend/issues/328)의 연결 PR에서
확인하는 후속 gate다. 문서와 후보 코드만으로 source/dev·운영 완료를 선언하지 않는다.
다음 기능 순서는 #328 → #327이다.

`main@1780728a02144c0816565ba091e43a8b3e126c4f`, production/recovery DB·Edge·Pages·provider,
프런트 source·실제 객실 PIN·운영 UAT는 이번 작업 범위가 아니다.

## 제품 근거와 시간 의미

제품 가이드의 target 생성 snapshot, 예정 전 수동 checkout, canonical stay/room segment,
#4 본인 실제 통보 revision 조회, #305/#308 기한 비차단 계약을 따른다.

- `availableFrom`은 해당 assignment의 접근 일정, `dueAt`은 준비/요청 마감이다. 두 필드는 예약의
  예정/실제 퇴실이나 다음 체크인이 아니다. `dueAt + 30분`이나 기본 시각으로 예약을 복원하지 않는다.
- 계획 checkout은 실제 조기 퇴실 뒤에도 보존한다. guest의 최종 checkout과 중간 객실 이동에 의한
  room departure를 구별한다. canonical segment의 미래 종료는 실제 퇴실 사실이 아니다.
- 다음 guest의 **예약 예정** 체크인과 canonical segment의 **객실 도착** 시각은 서로 다른 필드다.
  실제 입실 또는 투숙 중 객실 이동 시각을 guest의 예정 체크인으로 표시하지 않는다.
- 시간은 RFC3339 offset을 가진 instant다. early/late는 저장된 예정 시각의 `Asia/Seoul` 시각을
  각각 16:00/11:00과 비교한다. 정확한 경계는 false, 근거 없음은 null이다. 업무 기한 경과나
  날짜 차이만으로 권한을 종료하거나 담당·일정·attempt를 바꾸지 않는다.

## 공개 DTO

두 key는 카드에 항상 존재하며, 전체 객체가 null일 수 있다. 객체가 있으면 아래 모든 key가
필수다. 내부 reservation/room/segment/event ID와 고객명·숙박 인원·연락처·PIN은 추가하지 않는다.

| `scheduleSnapshot` 필드 | 의미 |
|---|---|
| `capturedAt` | 해당 계획을 생성 schedule에 고정한 DB 시각. 최초 통보 actual capture와 구분한다. |
| `scheduleRevision` | 실제 cleaning schedule revision의 양의 정수. assignment CAS와 별개다. |
| `scheduleReasonCode` | 안전한 source-controlled 일정 사유. 자유형 원문이 아니다. |
| `sourceReservationVersion` | 계획 캡처 당시 source 예약 version, 예약 없으면 null. 이후 current version으로 덮지 않는다. |
| `plannedCheckoutAt` | source 예약의 예정 최종 퇴실, 종료 미정/예약 없음은 null. |
| `actualCheckoutAt` | 최초 통보 write의 DB capture 시 알려진 source 예약의 실제 최종 퇴실, 미확인은 null. |
| `plannedRoomDepartureAt` | exact source room-move에 근거한 예정 객실 이동 퇴실. 확인 근거 없으면 null. |
| `actualRoomDepartureAt` | 최초 통보 write의 DB capture 시 알려진 exact source room departure. 미래 이동은 null. |
| `nextCheckInAt` | 다음 객실 점유 source의 예약 예정 guest check-in. segment 시작을 복사하지 않는다. |
| `nextRoomArrivalAt` | source 객실의 다음 canonical segment 시작. 임의 마감 역산은 없다. |
| `nextArrivalKind` | `check_in` / `room_move` / null. |
| `isEarlyCheckIn` | `check_in`인 다음 예정 체크인의 KST 16:00 전 여부. room_move/근거 없음은 null. |
| `isLateCheckout` | 연결 source 예약의 예정 퇴실이 KST 11:00 후인지. 청소 종류로 제한하지 않으며 이동/해당 근거 없음은 null. |
| `isScheduleUpdated` | 실제 이전 schedule와 날짜/접근/마감 차이 및 명시적 일정 변경 사유가 함께 확인된 boolean. |

`capturedAt` 외의 위 여섯 시각은 모두 nullable이다. actual은 최초 통보 write의 DB capture 시
이미 알려진 사실을 frozen plan에 추가하며 계획의 `capturedAt`을 다시 쓰지 않는다.
카드 `notifiedAt`은 event effective time이므로 actual의 DB capture clock과 같다고 가정하지 않는다.
`isScheduleUpdated`는
version 증가·순서/담당 변경·지연·새 통보가 있다는 이유만으로 true가 되지 않는다.

| `currentDeparture` 필드 | 의미 |
|---|---|
| `evaluatedAt` | 같은 DB 조회 statement의 평가 시각. |
| `actualCheckoutAt` | 평가 시각에 유효한 exact source 예약의 실제 퇴실, 없으면 null. |
| `actualRoomDepartureAt` | 평가 시각에 유효한 exact source room departure, 없으면 null. |

`currentDeparture`는 `GET /v1/assignments`의 **현재 목록 모드에만** 제공한다.
`includeHistory=true`와 `GET /v1/assignments/{cleaningTargetId}/history`에서는 current 행을
포함한 모든 카드가 null이다. draft·종료·재배정·source/room/revision 불일치·legacy unknown은
null이며, 현재 업무여도 actual 두 값이 아직 null일 수 있다. 자동 예정 checkout 이후 새 assignment
revision이 생기지 않은 경우에도 별도 현재 사실로 표시할 수 있으나 불변 snapshot을 덮지 않는다.
점유 재개로 invalidated된 checkout이나 미래 room move를 현재 실제 퇴실로 되살리지 않는다.

## 저장·조회·권한

95번째 migration은 기존 migration을 변경하지 않고 nullable JSONB 두 컬럼을 추가한다.

- `cleaning_target_schedule_revisions.reservation_schedule_snapshot`: 신규 schedule INSERT의
  계획 고정. reservation command의 target/schedule INSERT가 reservation schedule revision
  INSERT보다 앞설 수 있으므로 같은 transaction의 권위 있는 source 현재 row를 사용한다.
- `cleaning_assignments.notified_reservation_schedule_snapshot`: 최초 notified INSERT 또는
  draft→notified UPDATE에서 계획과 당시 알려진 실제 사실을 고정한다. 이후 통보 pack은 불변이다.
- 과거 행·완료 receipt·누락된 생성 계획을 현재 예약으로 채우지 않는다. legacy plan이 null이면
  나중에 최초 통보돼도 전체 pack은 null이다. caller가 supplied한 snapshot은 신뢰하지 않는다.
- 기존 schedule/assignment immutable guard·RLS는 유지하고, source 취소·재계획·재통보 command,
  CAS·멱등성·동시 시작·earning/PIN 권한을 변경하지 않는다.

새 JSONB 원문과 내부 source binding이 browser Data API로 노출되지 않도록 두 테이블의
기존 authenticated table-level SELECT를 회수하고 pre95 컬럼에만 column-level SELECT를
재부여한다. 신규 두 컬럼은 PUBLIC/anon/authenticated의 직접 SELECT가 금지된다.
기존 명시 컬럼 조회·count·join과 RLS는 유지하지만 `SELECT *`/whole-row 조회는 의도적으로
`42501`로 거부한다. service_role의 기존 table grant는 유지한다. 여기서 권한 불변은 업무
authority와 RLS 불변을 뜻하며, 원문 컬럼 조회 권한은 이 보안 경계에 맞게 좁힌다.

#133 `EXTEND_CHECKOUT`의 기존 예약 update가 successor 통보 write 뒤에 있던 순서 seam은
새 capture가 이전 예약을 잘못 고정하지 않도록 좁은 transaction ordering 보완 대상이다.
기존 lock·guard·결과·receipt·실패 rollback 정책을 보존하며 신규 정책이나 별도 권한을 만들지 않는다.
이 보완의 실제 구현·회귀 결과도 아래 gate에서 검증해야 한다.

service-role 전용 `public.get_assignment_schedule_read`는 최신 active/password-complete
admin/maid, live Auth session, maid의 본인 actual notified row를 DB에서 다시 검증한다.
Auth session은 정확한 `id`/`user_id`와 `not_after IS NULL OR not_after > evaluated_at`을
조회 statement 시각으로 검사한다. 만료 행이 cleanup 전까지 남아 있다는 이유로 허용하지 않는다.
이 보안 만료는 업무 기한·PIN 조회 이력·시작/취소 제한을 새로 만드는 조건이 아니다.
adapter는 최초 검증 actor의 role을 `p_expected_actor_role`로 전달하며 RPC의 최신 DB role과
불일치하면 기존 `ASSIGNMENT_ACCESS_REQUIRED` 403으로 fail-closed한다. 초기 admin 형태로
hydrate한 응답을 이후 maid 권한으로 허용하거나 그 반대 전이에서 소유권 경계를 바꾸지 않는다.
role을 클라이언트의 JWT metadata나 HTTP 입력에서 신뢰하지 않으며 이 내부 binding은
새로운 공개 요청 필드/오류 코드가 아니다.
현재 사실에는 exact current/미종료/notified assignment, target revision·날짜·접근/마감·객실과
stored source binding을 추가 검사한다. 조회 batch는 1~100개의 고유 assignment ID다.
내부 source binding은 DTO에서 제거하며 partial/malformed pack은 안전하게 실패한다.
private capture/fact/normalizer helper의 직접 EXECUTE는 PUBLIC/anon/authenticated/service_role에서
회수한다. 새 table·broad DML·예약 상세 권한은 없다. 모든 HTTP 응답은 기존 `no-store`를 유지한다.

예정 일정 변경은 새 schedule revision이고 미통보 draft는 stale 상태를 보존한다. 통보된 업무는
명시적 재계획/재통보의 successor를 통해 새 계획을 얻는다. 과거 본인 notified history는 당시
pack만 보며 현재 다른 담당자의 예약·이동 객실·새 계획·현재 actual을 hydrate하지 않는다.

## scoped 프런트 인계

2026-10-02 조회한 정본 `makee-ham/room-management-system`의 main은
`d509b44b1371f25d73891e04d355b0cb0e923f5f`, dev는
`09ed28446a4fd43919cddb29ebe442b848548ab8`이다. 이 범위 대조는 전역 제품 snapshot 갱신이 아니다.

- dev `DOCS/29:21`, `DOCS/30:63`이 해당 청소의 정확한 일정/early·late/version을 요청한다.
  문서 두 개는 협의 초안이며 main tree에는 없다.
- dev `WIREFRAME/index.html:9359–9366`의 `liveAssignmentScheduleBadges`는 roomId의 모든
  non-cancelled 예약을 순회하는 admin cache 기반 표시다. exact source/next arrival을 고르는
  서버 snapshot으로 대체해야 하며 메이드에게 admin 예약 API 권한을 부여하지 않는다.
- dev `:3227–3236` 예약 fetch는 admin만 허용된다. 메이드 `:9312`에는 일정 API 미제공 표시가
  남아 있다. main의 메이드 `:8830`도 접근/마감만 표시하며 위 live badge helper는 main에 없다.
- 프런트는 검증·승격된 계약으로 generated client를 재생성하고 두 pack을 구분하여 연결한다.
  실제 소비·운영 UAT는 프런트 담당자의 별도 gate다. 이번 백엔드 PR이 UI 완료를 뜻하지 않는다.

## 검증 gate와 알려진 제한

현재 이 문서는 계약/구현 후보를 기록한다. 실행 결과·head·tree·실패/보완 이력은 #328의
Issue/PR과 이 절에 단계별 보존하며 일부 local PASS를 전체 source/dev 완료로 확대하지 않는다.

### 세션 만료 추가 QA 보완

원래 source `efa6609d7e6bf0ba3a65a572beffe8db226d3d74`의 전체 local PASS와 QA98은
아래에 이력으로 보존한다. 추가 감사는 공용 `is_active_auth_session`이 Auth session의
존재만 확인하고 `not_after`를 검사하지 않는 P1을 발견했다. 공식
[Supabase 세션 문서](https://supabase.com/docs/guides/auth/sessions)는 timebox 종료 반영과
행 정리가 lazy하므로 JWT 잔여 유효시간이 있을 수 있음을 설명한다. 배포 Auth 버전 확인과
실제 HTTP 재현은 NOT RUN이며, 다음 결과는 로컬 합성 DB의 실제 실행이다.

- 보완 전 전용 SQL: 57 assertions 중 2 FAIL, 만료 maid/current 및 admin/history 조회가 허용됨.
- 보완: 새 RPC에 exact session/user와 statement-clock `not_after` 경계를 추가한다.
  STABLE/service-only/read-only·기존 role/ownership/source binding은 그대로이며 공용 helper와
  다른 RLS/명령을 이 PR에서 바꾸지 않는다. NULL과 미래 timebox는 유효하다. 공용 helper와
  대표 경로 보완은 [별도 #352](https://github.com/wrongstory/room-management-system-backend/issues/352)로 추적한다.
- 보완 후 `db:verify`: fresh95 PASS. 전용 SQL: 58 assertions PASS(만료 두 역할 거부·미래 허용).
- 보완 후 전체 검증·최종 독립 QA·새 head required CI는 진행 중이다. 원래 CI
  `37017832732`는 application PASS, migration은 SQL/21 upgrade/KST clock PASS 후 기존
  알림 delivery concurrency의 fixture drain에서 FAIL이며 실패를 무시하거나 삭제하지 않는다.
  해당 script/RPC는 dev와 동일하고 원 로그에 due 집계가 없어 실제 원인은 미확정이다.
  parent 상태와 claim predicate 불일치·마지막 claim 뒤 재계수 없는 확정 정적 결함은
  [별도 #353](https://github.com/wrongstory/room-management-system-backend/issues/353)에서 추적한다.
- migration95는 dev에 미병합·원격 DB 미적용인 후보여서 해당 파일과 dev manifest를 보완했다.
  기존 원격 적용 migration/봉인 release manifest는 변경하지 않으며 Git amend/force push도 없다.

### KST 자정 fixture 추가 보완 — #354

2026-10-02 약23:57 KST의 세션 보완 후 `npm run db:test`는 21 upgrade 전부 PASS 뒤
73 SQL files/4,155 assertions 중 기존 checkout incident test28 한 건 FAIL로 종료했다.
기대는 `22023 INVALID_CHECKOUT_INCIDENT_DECISION`, 실제는 `23514 ASSIGNMENT_SCHEDULE_INVALID`다.
이 전체 명령을 PASS로 바꾸지 않는다. source `at_time` 날짜를 사용하면서 from/due만
+10/+11분 이동하던 기존 dev와 같은 fixture가 자정에 날짜 정합성을 먼저 위반한 원인이다.
독립 QA는 이미 #328에서 보강한 같은 checkout/clock SQL의 직접 검증 gate이므로 최소
test-only 보완을 허용했다. [추적 #354](https://github.com/wrongstory/room-management-system-backend/issues/354).

- pg_temp constructor가 실제 제안 from의 KST 날짜와 유효 구간을 만든다. minute precision과
  다음 자정 inclusive 마감을 유지하고 23:49/23:50/23:58/00:00·일→월 구조 5건을 검증한다.
- 후속 maid의 실제 future work-date/week availability를 fixture에서 확보하고 별도로 확인한다.
  일→월 clock을 실제로 바꿔 runtime 검증한 것은 아니며 구조·fixture 바인딩 확인이다.
- 기존 future 거부 `22023`, 별도 날짜 mismatch/마감 초과 `23514`와 무쓰기 검사는 그대로다.
  제품 command/guard/migration은 변경하지 않으며 95번째 SHA는 세션 보완 후 값 그대로다.
- 새 fixture 첫 실행은 SQL alias `window` 문법 오류로 FAIL했다. `future_window`로 보완 후
  두 SQL files/148 assertions(incident90 + schedule58) PASS다. 실패를 삭제하거나 skip하지 않았다.
- 위 21 upgrade는 같은 migration95 SHA의 실제 PASS다. fixture 보완 후 전체 SQL·필수 검증·
  독립 QA·최신 exact-head CI를 별도로 수행하며 그 결과 전 source/dev 완료를 선언하지 않는다.

### 보완 후 local 개별 최종 검증

2026-10-03 아래 결과는 실제 재실행이다. 초기 전체 `npm run db:test`의 FAIL을 숨기지 않는다.
그 실행의 21 upgrades는 이후 fixture-only 수정과 무관한 동일 migration95 SHA
`fcd3e7833d59602d14959e25c2d0a6eb7fde006217412a741f78b68da38a0433`로 PASS했다.
그 후 전체 SQL을 수정된 fixture로 다시 실행해 PASS를 확인했다. 로컬에서 이 조합을
`npm run db:test` 전체 명령 재실행 PASS라고 바꾸지 않으며 최종 CI가 전체 명령을 별도로 검사한다.

| 검증 | 실제 결과 |
|---|---|
| `npm run ci:quality` | fixture 보완 뒤 PASS, Node859/57files·lint/typecheck/build/secrets·OpenAPI131/141 |
| `npm run edge:check` | 세션 보완 뒤 PASS, 323 tests, bundle17,240,852bytes; 이후 adapter source 변경 없음 |
| Python frozen sync·Ruff check/format·mypy·pytest·codegen·build check | 세션 보완 뒤 PASS, 95 tests; 이후 Python/OpenAPI/source 변경 없음. 기존 generator warnings 유지 |
| `npm run db:manifest:verify` | PASS, dev95와 위 SHA 일치, 기존 sealed release manifests 보존 |
| `npm run db:test`의21 upgrade 단계 | PASS, 현재와 같은 migration95; 이어진 당시 전체SQL은 위 자정 fixture1건 FAIL |
| `supabase test db supabase/tests --local` | fixture 보완 후 PASS, 73files/4,161 assertions |
| 전용 expiry+incident SQL | PASS, 2files/148 assertions; 만료 거부·미래 세션 허용·KST 구조 포함 |
| `npm run db:test:long-stay-clock` | PASS, 5 KST 경계×29=145 |
| `npm run db:test:concurrency` | PASS, main/complaint-attention/manual-cancel 전체; 알림 delivery drain도 이번 실행 PASS |
| `npm run db:reset -- --local --no-seed` / migration list | PASS, fresh95 및 local history 확인 |
| `supabase db advisors --local --type all --level warn --fail-on error` | PASS, findings0 |
| `npm run backup:dry-run` | PASS, local-synthetic migrations95/head/rooms121; actual production 데이터 없음 |
| 최종 독립 QA·새 exact-head required CI·dev 통합 | PENDING, PR #351의 후속 gate |

이번 local drain PASS로 #353을 해결 처리하지 않는다. 최초 CI의 실제 backlog 상태는 미확정이며
테스트의 확정 정적 종료 결함은 남았다. drain 실행 후 숫자-only 관측은 pendingJobs0/
claimableTargets0/allDueTargets1(parent operator_blocked)이며, 이는 해당 실행의 **완료 뒤**
관측이다. 최초 CI 실패 직전 상태의 증거로 확대하지 않는다. production/main/recovery는 그대로다.

### 과거 1차 검증·QA 이력

아래는 expected-role 보완을 포함한 최종 exact-source 검증이 아니라 각 실행 시점의 local 결과다.

| 검증 | 실제 결과 | 후속 상태 |
|---|---|---|
| `npm run ci:quality` | PASS, application 857 tests; typecheck/build/lint/secrets 및 OpenAPI 131 paths·141 operations 포함 | 독립 QA 보완 후 최종 source 재검증 필요 |
| 전체 Edge | 321 PASS / 1 FAIL | 당시 기존 HTTP mock의 synthetic-token fixture 보완 필요; 후속 실행 결과는 아래에 별도 기록 |
| 당시 fresh 95 reset | FAIL, sourceDrift CRLF 정규화 문제 | 당시 정규화 수정 후 미재실행; 후속 실행 결과는 아래에 별도 기록 |
| 독립 QA round 1 | P1: adapter 초기 role과 마지막 RPC 최신 role 사이 race | expected-role binding·403 fail-closed 보완 후 최종 QA/실행 검증 PENDING |

기존 HTTP mock은 최신 유효 session을 표현하는 합성 token fixture로 보완하며 보호 검사를
제거하거나 실패 테스트를 skip하지 않는다. sourceDrift는 source의 동일성을 보존하는 LF
정규화로 보완하고, 이 수정만으로 DB reset/SQL/upgrade를 PASS라고 주장하지 않는다.

### 후속 실제 실행 결과 — 마지막 raw-column grant 보완 전

아래 PASS는 각 실행 시점의 결과다. 이후 두 JSONB 원문 조회 grant를 좁히고 실제
authenticated/anon의 신규 컬럼·RPC 거부 SQL 회귀를 추가했다. 따라서 아래 결과를 마지막
보안 변경까지 포함한 최종 전체 검증으로 확대하지 않으며, 최종 전면 재검증은 PENDING이다.

| 검증 | 실제 결과 | 적용 범위/후속 상태 |
|---|---|---|
| Node/application | PASS, 859 tests | 마지막 raw-column grant 보완 전 실행 |
| 전체 Edge·bundle | PASS, 323 tests / 17,240,776 bytes | synthetic-token fixture 보완 후 실행; 마지막 grant 보완 전 |
| Python console·전체 Ruff/mypy/codegen/build check | PASS, 95 tests | 마지막 grant 보완 전 실행 |
| CRLF 정규화 보완 후 fresh 95 reset | PASS | 마지막 grant 보완 전; 최종 fresh/전체 SQL 재검증 필요 |
| 전용 94→95 upgrade | PASS | 마지막 grant 보완 전; 최종 upgrade·원장 보존 재검증 필요 |
| targeted 4 SQL files | PASS, 339 tests | 마지막 grant 보완 전; 추가 raw-column/RPC 거부 회귀 PASS를 뜻하지 않음 |
| 마지막 raw-column grant·추가 역할별 거부 회귀 | PENDING | 최종 fresh/전체 SQL·upgrade·RLS 및 독립 QA/CI 재검증 대상 |

### 과거 efa6609 source의 전면 local PASS — 세션 만료 보완 전

아래는 raw-column grant·expected-role·통보 window 보완 후의 실제 실행 결과다.
기존 SQL의 whole-row 기대값은 기존 컬럼 비교를 유지하면서 신규 pack을 별도로 검사했고,
developer operations의 migration head만 94→95로 갱신했다. 객실 이동 회귀도 5건 추가했다.
어떤 실패 테스트도 삭제·skip하거나 기존 권한/원장 검증을 낮추지 않았다.

| 검증 | 실제 결과 |
|---|---|
| `npm run ci:quality` | PASS, 859 tests / 57 files, typecheck/lint/build/secrets, OpenAPI 131 paths·141 operations |
| `npm run edge:check` | PASS, 323 tests, bundle 17,240,852 bytes, fmt/typecheck 포함 |
| Python console | PASS, pytest 95 tests, Ruff check/format·mypy·build check |
| 실제 ephemeral Python codegen | PASS, 새 list/history·3 models 및 snapshot 13필드 필수 nullable 타입 검사; nextArrivalKind enum은 Node OpenAPI에서 별도 검증. 기존 binary-photo/AttemptLifecycle generator warning은 남아 있으며 전체 generated client 무경고를 뜻하지 않음 |
| 신규 Node 카드/일정/계약 재실행 | PASS, 96 tests / 3 files |
| `npm run db:manifest:verify` / fresh 95 `db:verify` | PASS, 마지막 raw-column grant·통보 window 보완 포함 |
| 수정 후 targeted SQL 3 files | PASS, 138 tests; 신규 컬럼/RPC 실제 역할별 거부 포함 |
| `npm run db:test` | PASS, 21 upgrade + 73 SQL files / 4,152 tests; 기존 원장/컬럼/receipt 보존 및 94→95 포함 |
| `npm run db:test:long-stay-clock` | PASS, KST 5경계 × 29 = 145 assertions |
| `npm run db:test:concurrency` | PASS, main/complaint-attention/manual-cancel 세 스크립트; 실제 별도 DB session 경합·PIN 비차단 취소 포함 |
| `npm run db:reset -- --local --no-seed` | PASS, fresh local 95 |
| `supabase db advisors --local --type all --level warn --fail-on error` | PASS, findings 0 |
| `npm run backup:dry-run` | PASS, local-synthetic, migrations 95/head assignment_reservation_schedule_snapshot, rooms 121; 운영 데이터·비밀값 없음 |

- [x] Fastify·Edge·OpenAPI·생성 client 계약 및 strict/null/legacy 회귀
- [x] typecheck·lint·application tests·build·전체 Edge·Python console
- [x] fresh local 95 reset·DB verify·전체 SQL/upgrade·RLS/DML/immutability
- [x] checkout/stayover/additional/reclean·예약 없음·종료 미정·KST 경계·room move
- [x] 생성/통보 보존·explicit replan·history 미노출·occupancy reopen 및 실제 경합
- [x] 조회 전후 원장·receipt·attempt·알림·수익·CAS/fingerprint 무변경
- [x] local advisors·migration exact-source 합성 backup/restore
- [ ] 독립 QA 최종 판정·exact-head required CI — 연결 Issue/PR의 이후 실행 근거 확인
- [ ] dev squash tree/head와 Issue 상태 — 연결 Issue/PR의 이후 확인 근거 확인

프런트 main/dev는 22:56 KST 재확인에도 위 refs와 동일하다. main 122/dev 130개 text 파일의
전체 blob 원문을 확인해 두 저장 테이블 직접 Data API/whole-row 소비가 없음을 확인했다.
배정/이력은 HTTP API를 사용한다. 이 정적 호환성 확인은 신규 필드 실제 소비나 UAT가 아니다.

배포는 DB migration과 두 adapter를 같은 릴리스 단위로 검증한 뒤 별도 승인 범위에서 진행한다.
rollback은 snapshot/원장을 삭제하거나 migration history를 재작성하지 않고 이전 API 계약으로
rollback하는 방식이며 신규 보존 metadata는 그대로 둔다. 현재 운영 배포·hosted positive smoke는
NOT RUN이다. 미확정 퇴실점검/과거 객실 상태/운영 공급자 정책을 #328에서 확정하지 않는다.
