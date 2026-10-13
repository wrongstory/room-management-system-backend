# v0.9.5 최종 검증 후보 — 운영 미반영

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
