# v0.9.5 최종 검증 후보 — 운영 미반영

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
