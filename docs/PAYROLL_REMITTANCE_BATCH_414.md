# #414 주급 송금 표시 묶음 조회

상태: 개발 후보, 운영 미반영. #414 중 HTTP/Auth 왕복 감소 단계이며 반복 DB 집계 제거는 후속이다.

## 프런트 계약

- `GET /v1/payroll/remittance-markers?weekStart=2026-09-21&maidProfileIds=<uuid>,<uuid>`
- `operationId: listPayrollRemittanceMarkers`, bearer 인증, password-change gate 유지.
- 활성 관리자는 서로 다른 메이드 1~10명, 메이드는 본인 1명만 가능하다.
- UUID 대소문자를 정규화한다. 중복 UUID(대소문자만 다른 경우 포함), 빈 항목,
  11명 이상, 잘못된 날짜, 알 수 없는 query 및 반복 query는 400이다.
- Swagger query는 CSV 문자열(36~369자, UUID 1~10개 패턴)이다. 배열 타입의
  explode:false를 Python 생성기가 반복 query로 보내는 문제를 실제 직렬화 검사로
  발견해 문자열로 명시했다. 호출자는 ID 배열을 쉼표로 합친 문자열을 전달한다.
- 응답: `{ weekStart, markers: PayrollRemittanceMarker[] }`. 요청 ID 순서를 유지한다.
- 기존 단건 GET/표시 변경/reconfirm/history는 그대로다. 모든 신규 기능을 Swagger에 등록한다.

현재 표시할 주급 페이지(최대 10명)만 요청한다. 모든 페이지의 표시를 기다리며 첫 화면을
막지 않는다. 성공한 항목의 `marked`, `needsReconfirmation`, `basisFingerprint`,
`version`을 그대로 사용한다. 표시가 켜져 있어도 금액이 달라지면 재확인 경고를 유지한다.

항목 하나라도 실패하면 전체 오류이며 부분 성공은 반환하지 않는다. 이를 '미송금'으로
치환하지 말고 조회 오류/재시도로 표시한다. 프런트 전환은 실제 백엔드 배포 확인 후 수행한다.
기존 서버에서는 단건 API를 유지할 수 있지만 401/403/500을 단순한 미지원 404로 취급하지 않는다.

## 일관성·권한·부하

입력을 모두 검사한 뒤 최대 3개의 기존 `get_payroll_remittance_marker` RPC를 동시에 실행한다.
각 RPC는 최신 actor role/session/self/week 권한을 재검증한다. 실패를 관측하면 새 항목을
시작하지 않고 실행 중인 읽기를 마친 후 오류를 반환한다. 지급/원장/표시/receipt를 쓰지 않는다.

각 항목은 독립된 읽기 시점이며 묶음 전체나 주급 목록과 같은 DB snapshot이 아니다.
명령 실행 시 기존 CAS version 및 basis fingerprint 검사를 계속 사용한다.
원시 항목 및 최종 응답에 기존 128KiB 상한, 전체 경로에 no-store를 적용한다.
별칭/HEAD/잘못된 method는 기존 단건과 동일하게 거부한다.

10명 조회의 브라우저 HTTP 요청은 기존 단건 10회 대신 1회로 줄지만 DB RPC는 여전히 10회다.
최대 동시성 3은 요청별 한도이며 전역 DB 부하 한도는 아니다. 공통 인증/대기 감소가 목표이고,
실제 운영 p50/p95 개선치는 아직 측정하지 않았다. 금액 전역 캐시나 세션 검사 생략은 하지 않는다.
work-details 반복 집계 및 쿼리 계획 계측은 #414/#416 후속으로 남긴다.

## 배포·복구

DB/migration/환경변수 변경 없음. dev PR과 필수 CI 통과 후 별도 릴리스에 포함한다.
운영 API와 Swagger를 함께 반영한 뒤 frontend #207에서 연결한다. 기존 API 호환을 유지하므로
프런트는 단건 API로 돌아갈 수 있다. 이 문서는 배포 또는 실제 사용자 검증 완료의 증거가 아니다.

## 검증 checkpoint (2026-10-09)

- `npm run ci:quality`: PASS (Node 2,686건, typecheck/build/lint/명세 검사).
  새 endpoint 때문에 발생한 기존 경로 개수 기대값을 151 paths / 163 operations로 갱신했다.
- 독립 QA: 최초 관련 134건, CSV 보완 후 관련 132건 및 실제 Python codegen PASS,
  생성 Edge 일치·diff 검사 PASS, 차단 결함 0.
- Python: CSV 실제 query 직렬화/전체 codegen, ruff check/format, mypy, pytest 102건,
  package source 검사 PASS. 기존 binary endpoint 생성 경고는 유지하며 신규 batch 경고는 없다.
- `npm run openapi:template-client:check`: PASS.
- `npm run edge:check`: PASS (Edge 497건 + 보고 모듈 runtime 65건,
  최종 후보 포함 번들 19,208,072 bytes, 20,000,000 bytes 미만).
- DB reset/실DB 경합/운영 성능 측정: NOT RUN. SQL/쓰기 로직 변경 없음.
- #414는 후속 집계 계측이 남으므로 이번 PR에서 종료하지 않는다.
