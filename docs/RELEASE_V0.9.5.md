# v0.9.5 최종 검증 후보 — 운영 미반영

## PR460 3차 CI 실패 및 지연 업무 경합 회귀 보완 — 2026-10-14

CI38422638426/248e409 attempt1은 application PASS, migration FAIL이다.
이전 SQL 실패5건은 해소됐으며 전체 SQL95파일5692건, upgrade, static-warning,
KST clock 검사는 PASS다. 경합 검사의 지연 업무 whole-row 불변 assertion이
#446의 미착수 자정 이월(version/carryover 갱신)과 충돌했다. 이후 경합은 미실행이며
cleanup PASS, Full DB proof SKIPPED다. 전체 DB 성공 증거로 재사용하지 않는다.

검증 코드만 보완한다. 어제 미배정 업무에8개 동시 scheduler 요청을 보내
version/carryover 각각 정확히+1, 유효한 갱신 시각과 나머지 전체 컬럼 보존을 검사한다.
이월 감사/일정 revision 각각1건 및 날짜·버전 근거 일치, 새 담당/attempt/회수 알림0건,
응답상 대상 이월1회와 최대100건 상한을 검증한다. 기존 지연 event·관리자 fanout·
자기 push 억제·완료 경쟁 검사는 유지하고 receipt replay 뒤 target/이월 근거 불변을 추가한다.
낮은 fixture UUID와 기술 cursor 준비로 기존 합성 업무 누적에 의한 조회 순서 영향을 줄인다.

로컬 ci:quality PASS:123파일3075 tests, typecheck/build/OpenAPI154/166/secrets.
신규 순수 회귀22개, manifest119, script syntax 및 diff 검사 PASS.
별도 검토 에이전트의 독립 source QA PASS(P0/P1/P2 신규 finding 없음), 순수22개 재실행 PASS.
기존 lint20 warning/57 info 유지. DB 실행 없는 검사는 실제 RPC/경합 PASS가 아니다.
SQL migration/API/운영은 변경하지 않았으며 release push·전체 DB CI 재실행은 승인 대기다.

후속 검토: 기존 offline 경합 fixture의 setup이 KST 자정(역사 clock은 해당 날짜 경계)을
넘으면 과거 미착수 start 허용 가정과 #446가 충돌할 가능성이 있다. 이번 CI의 관측 실패는
아니며 lease/expiry 검증 기준을 바꾸지 않고 별도 시간 경계 보완으로 추적한다.

## PR460 2차 CI 실패 및 SQL 회귀 보완 — 2026-10-14

CI38403330268/f3598fb attempt1은 application PASS, 전체 DB FAIL이다.
이전 실패였던 배정94→119 upgrade는 PASS했다. 전체 SQL95파일5689건에서
activation17/61 및 developer diagnostics6/7/9 총5건이 실패했다.
후속 static/KST/concurrency와 full proof는 SKIPPED, cleanup은 PASS다.

현재 확정 #446 정책에 따라 과거 통보 미착수 이월은 typed outbox1건을 기대하며
동일 receipt 재시도 후에도1건임을 추가 검사한다. 회전 처리에서는 과거 업무 이월을
허용하되 activation/rollover 각각100건 상한, 결과 개수 일치, 당일102개 업무의
원 날짜·담당 유지와 이월 결과 제외를 검사한다. 테스트 삭제/skip은 없다.
개발자 진단은 source head119 `room_pin_transfer`를 기대하며 equal/ahead/behind,
head 제거/복원과 직전 migration 검사는 유지한다. Node source 회귀가 SQL fixture의
7개 head 참조를 실제 manifest와 대조하여 다음 head 추가 때 누락을 조기 검출한다.

로컬 ci:quality(122파일3053 tests·typecheck·build·OpenAPI·secrets) 및 manifest119 PASS.
독립 source QA PASS(P0/P1/P2 없음), 별도 edge-runtime19 PASS 및 diff 검사 PASS.
기존 lint20 warning/57 info는 유지한다. SQL 자체의 수정 후 실제 실행은 NOT RUN이다.
수정본 push와 격리 전체 DB 재실행은 새 승인 대기. 운영 migration/배포는 미실행이다.

## PR460 1차 CI 실패 및 로컬 보완 — 2026-10-13

CI38390172872 attempt1은 application PASS, migration FAIL이다. fresh119,
template contract, exact lint baseline, 합성 backup 검사는 PASS했지만 배정 일정
94→current upgrade의 baseline snapshot 단계에서 검증 helper의 상한112가
현재119를 거부했다. cleanup은 PASS, 후속 static/KST/concurrency와 Full DB proof는
SKIPPED다. 전체 DB 성공 증거는 없으며 실패를 재사용하지 않는다.

로컬 보완은 검토 구간을119까지 확장하되 정확한111 catalog 추가 외 예외를 늘리지 않는다.
기존 whole-row catalog 비교·원래 컬럼 digest·receipt/legacy snapshot 검사는 그대로다.
공유 source validator로 manifest/파일명/정규화 SHA를 확인하고 helper 범위도
DB 접근/reset 전에 검사한다. 임의 미래120이나 SQL/manifest 동시 변조는 허용하지 않는다.

113 인증 조회,114 객실 집계,116/117 주급 집계는 함수 정의 변경이며 기존 row backfill이 없다.
115 계획일은 함수/index,118 자정 이월은 함수/index 및 nullable cursor 컬럼 추가다.
118의 업무 변경은 scheduler 호출 때 발생하며 migration 자체는 과거 담당을 이월하지 않는다.
119 PIN 가져오기는 source CHECK 확장·명시 호출 함수 추가로 기존 PIN을 변경하지 않는다.
7개 모두 notification catalog 추가가 없어 기존111 단일 예외를 유지한다.

회귀를 먼저 추가해8건 FAIL 재현 후 보완했다. 관련 source/mock140, 전체122파일3053 tests,
typecheck/build/OpenAPI154/166/secrets/manifest119 PASS. lint exit0, 기존20 warning/57 info 유지.
별도 검토 에이전트의 독립 source QA도 PASS(P0/P1/P2 없음, 순수140 재실행 PASS)다.
실제 SQL 재실행은 NOT RUN이며 위 결과는 전체 DB 검증의 대체가 아니다.
release push는 새 DB CI를 유발하므로 승인 전 보류한다. 운영 migration도 별도 승인 대상이다.

2026-10-13 사용자 승인: release/v0.9.5 → main PR 생성 및 격리 CI 전체 DB 검증1회.
운영 migration은 별도 사전 승인 대상이며 main 병합/배포/태그/실제 PIN 변경은 이번에 하지 않는다.

## 확정 입력

- dev dbc22320d10b4f6282b497ca394fe582227ecabb, main a0cef206c7672541494696bec47ae0ca62723322.
- 기능 범위/후속 제외/운영 설정/rollback: [배포 준비](./RELEASE_V0.9.5_READINESS.md), Issue #458.
- 미병합 PR456의 benchmark-only 후속은 이번 후보에서 제외한다. 다른 Draft379/392/402도 제외한다.
- history112 → source119, 신규113~119만 운영 pending 후보. 운영 적용0회.
- source OpenAPI154 paths/166 operations; 운영151/163과 구분한다.

## 과거 squash 이력 통합 근거

이전 release e021f0a와 main a0cef20의 tree는 03292443a4e0d548e2051e2b04ce8df0fdc262da로 같다.
이전 release의 개발 부모634bfc8은 현재 dev의 ancestor다. 634bfc8과 main의 차이는
문서10개뿐이며 runtime/SQL/tests/CI 입력 차이는 없다. 이 실제 내용 기준을 base로
파일별3-way 병합해 최신 dev 코드와 main 문서 양쪽을 보존했다. 전체 한쪽 선택이 아니다.
통합의 dev 대비 차이는 과거 기록4개 및 이 릴리스 설명뿐이고 비서술 입력은 dev와 같다.

## 검증 및 승인 경계

로컬 application 재검증 후 승인된 PR CI1회만 실행한다. 격리 runner fresh119,
template/정적 baseline/합성 backup/전체 SQL·upgrade/KST·경합/cleanup과 full proof를 확인한다.
실패 또는 입력 변경 후 추가 DB 실행은 다시 승인받는다. CI 중 추가 push/재실행 금지.
운영 백업/복원과 실제 초기화는 후속이며 합성 CI 검사를 운영 복원으로 표현하지 않는다.

통합 완료 전에 너무 일찍 실행한 첫 로컬 application 검사는 남아 있던 충돌 표식으로
FAIL했다. 충돌 해소 이후 재검증 결과를 PR에 기록하며 이 실패는 DB 실행과 무관하다.
최종 CI 완료 전에는 Full DB PASS를 선언하지 않는다.

## 운영 후속

PIN 원본/read-only ACL/별도 HMAC 설정 확인, 자유 문자열을 보존하는 복구 방안 확정,
DB-first 구간의 scheduler 동작 영향과 업무 중지 여부 확인이 필요하다.
SQL118 적용 직후 이월 이력이 생성될 수 있으며 rollback으로 과거 담당을 자동 복구하지 않는다.
필수 CI·리뷰·main 증거 확인 후 운영 pending7개 적용은 다시 승인받는다.
