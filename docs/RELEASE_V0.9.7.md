# v0.9.7 사진 업로드 실패 후 재시도

## 범위

- 기준 운영 main: 6640369 (v0.9.6, PR #466), api50.
- 개발 통합: dev4085618 / PR #467 / #464.
- main의 릴리스 문서와 회귀 보완을 보존하고 사진 수정만 추가한다.
- 공통 내용 기준 56dc304의 양측 변경을 비교해 squash 이력 충돌을 해소했다.
  tests/edge-runtime.test.ts는 main의 SQL head 검사와 사진의 head120을 모두 보존한다.
  developer_operations.sql의 기대 head 7곳은 신규 source head로 변경한다.
- 동작/프런트 인계: [#464](./PHOTO_UPLOAD_RETRY_464.md).

## 실행 승인 및 gate

- 사용자 승인: #466 완료 후 사진 릴리스 격리 CI 전체 DB 검증 1회.
- 전체 DB는 아직 NOT RUN. 최종 PR에서 최초 run/입력을 기록한다.
- 실패/취소/입력 변경으로 재실행이 필요하면 다시 승인받는다.
- 운영 migration과 API 배포, 실제 PIN·사진 쓰기, 태그 발행은 아직 미실행.
- 운영 migration은 실행 직전 별도 승인 필요. pending 후보는
  photo_upload_pre_provider_retry 1개이며 실제 history 대조 후 확정한다.
- API 공개 DTO/환경변수 변경 없음. exact claim에만 반납을 허용한다.
  파일 identity 이후의 불확실 업로드는 기존 복구 보호를 유지한다.
- DB 먼저 적용 후 API 배포. 이전 API로 rollback 가능하며 새 함수를 미사용 상태로 둔다.
- 첫 운영 503 상세 원인은 미확정. 진단 추가를 원인 규명 완료로 표현하지 않는다.

## 선행 v0.9.6 완료 근거 (2026-10-22)

- PR466 merged main6640369. 전체 DB CI39618271042 attempt1 PASS.
- main CI39676140116 attempt2 PASS. 첫 application의 외부 ECR 다운로드 제한으로
  application만 재시도했고 DB proof를 재사용했다. DB 재구축 단계는 skipped.
- 운영119/head room_pin_transfer 불변, 신규 운영 migration 0회.
- api50 ACTIVE, artifact 0ce33b91fcd47ab48728db774e72d0dae942b6381f99479fd9dcc09e532ecee1.
- health/OpenAPI200, 154 paths, 무인증 auth-me/rooms401, 운영 CORS204.
- 다른 4개 함수 불변. 실제 PIN preview/apply·사진 쓰기·태그는 NOT RUN.

## 최종 입력 소스 검증 (2026-10-22)

- Node: 124 files / 3,111 tests PASS. typecheck/build/manifest120 PASS.
- lint: exit0, 기존 warning24/info58. secrets 검사 PASS.
- OpenAPI: 154 paths / 166 operations PASS.
- Edge: 기존 537 tests 및 보고 HTTP 68 tests PASS.
- 번들: 18,802,757 bytes, 보고 후보 19,424,608 bytes (20 MB 미만).
- 독립 QA: 7 files / 350 tests PASS. 운영 정본 회귀 보완 보존 확인.
- catalog compatibility 검사에 migration120을 등록했다. SQL은 함수/권한만
  추가하며 catalog DML이 없고, 미등록121 거부와 기존 전체행 불변 검사를 유지한다.
- 실제 DB/SQL 검증은 아직 NOT RUN이며 위 소스 검사와 구분한다.

Refs: #464, PR #467
