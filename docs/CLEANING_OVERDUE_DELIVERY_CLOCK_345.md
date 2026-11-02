# #345 늦게 등록된 관리자에게 청소 지연 알림 전달

## 계약과 변경

최초 지연 감지 후 24시간이 지나 활성화된 관리자의 새 outbox도 과거 사건 시각을
사용하므로 기존 worker가 즉시 TTL 만료로 처리할 수 있다. 실제 운영 피해는 미확인이다.

123번째 append-only migration 후보는 #343과 같은 방식으로 전달 시각을 분리한다.
사건·inbox·group 발생 시각은 유지하며 새 `cleaning.overdue_admin` outbox의
`enqueued_at`만 불변 recipient `enrolled_at`에서 가져온다. 기존 수신자·outbox·job을
수정하거나 재발행하지 않는다. 새로운 수신자는 아직 미완료인 작업에서만 등록하고,
발생 전 시각으로 등록하는 것을 거부한다.

typed source/actor/recipient/contract/push intent를 INSERT 전에 재검증한다.
기존 양방향 deferred atomic check는 신규 delivery clock과 일치하도록 정확히 한
source needle만 교체하며, 소스가 예상과 다르면 migration을 중단한다.
24시간 TTL, active/password-complete, 자기 push 제외, RLS/ACL, scheduler CAS·멱등성은
유지한다. 새 helper는 runtime 역할에 실행 권한을 주지 않는다.

## 검증 범위

기존 청소 지연 pgTAP에 2일 전 발생/신규 관리자 등록/actual worker의
NO_ACTIVE_SUBSCRIPTION 도달/기존 inbox·outbox 보존/중복 방지/ACL 회귀를 추가했다.
이는 실제 외부 push 전송 성공을 증명하는 검사가 아니다.

**migration 적용·pgTAP·Full DB NOT RUN.** 신규 migration 파일과 manifest만 생성했다.
최종 사용자 승인 후 격리 DB에서 fresh/기존-history upgrade/worker 회귀를 실행해야 한다.
최신 최종 1회 정책에 따라 일반 dev PR은 application/manifest/독립 QA 후 source로 통합한다.
#345는 실제 SQL·upgrade·worker 증거 전 OPEN이며 운영·프런트 API 변경은 없다.

2026-10-25 dev96ec94b 통합에서 PR486이 복원한 진단 SQL head 검사를 대조했다.
`developer_operations.sql`의 current head 기대값 7곳을 신규 manifest head로 맞추고,
실제 직전 history를 보존하는 equal/ahead/behind 검사는 유지했다. DBML의 전달 시각
설명도 신규 outbox/과거 이력 보존 경계와 일치시켰다. SQL 자체는 실행하지 않았다.

첫 통합 application 실행은 3,265 PASS/1 FAIL이었다. 복원된 upgrade catalog 검사의
허용 범위가 122에서 끝나 신규123을 거부했다. 새 migration이 catalog row를 추가하거나
변경하지 않는 것을 검토한 뒤 정확한123까지 확장하고 124 이상 거부 및 기존 전체 row·
metadata 변조/누락/추가 거부를 유지했다. 이는 실제 SQL 실행 증거가 아니다.

보완 후 `npm run ci:quality`는 132 files / 3,268 tests, typecheck/build 포함 PASS,
manifest123 정적 검사는 PASS다. 최초 실패는 위에 보존하며 Full DB/SQL은 여전히 NOT RUN이다.

2026-10-24 application `ci:quality` PASS: 126 files / 3,133 tests,
typecheck/build 포함. manifest 123건 정적 검사 PASS.
초기 검사에서 새 head와 진단/upgrade whitelist가 불일치한 실패를 발견해,
진단 상수와 정확한 파일명·SHA-256 허용값을 함께 동기화했다. 임의 미래 migration
허용이나 기존 122번째 hash 검사를 제거하지 않았다.
독립 정적 QA의 worker limit 100 오류는 허용값 10으로 수정했다.
이 검사는 SQL/worker runtime PASS를 대체하지 않는다.

## 다음 필수 항목

#300과 함께 최종 릴리스의 승인된 격리 DB 검증에서 실제 SQL·worker·upgrade를 확인한다.
#12/#273은 최신 예약 전용 백업 계약과 인계 근거를 따르며 정기 활성화·첫 예약 실행은 별도다.
