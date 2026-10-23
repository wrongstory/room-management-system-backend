# #317 PIN 문의번호 기반 안전 진단

## 계약 및 범위

제품 가이드의 PIN 원문 비노출·권한 재검증 원칙과 #317을 따른다.
POST reveal, prepare, bootstrap, generated-confirm, confirm, rollback의
5xx에만 `{operation, requestId, status, code}` 구조화 진단을 남긴다.
Fastify와 Edge가 같은 순수 투영 함수를 사용한다. Edge 파일은
`node scripts/generate-room-pin-diagnostic-edge.mjs`로 생성하며 edge:check가 drift를 검사한다.

- 문의번호는 서버 UUIDv4다. 클라이언트 x-request-id는 유효한 UUID여도 PIN 명령에서는 무시한다.
- 응답의 requestId와 진단 requestId가 일치한다. 프런트는 기존처럼 응답 문의번호를 표시하면 된다.
- operation은 고정 6종이다. code는 코드에 명시된 PIN/room 서버 오류 허용목록만 기록한다.
  알 수 없는 오류 코드는 INTERNAL_SERVER_ERROR로 투영한다.
- PIN, 키, 암호문, envelope, 요청 본문·헤더·URL, 원문 예외, 사용자·객실·세션 식별자는 진단에 없다.
- Fastify 자동 요청 로그도 PIN 경로에서는 operation만 직렬화한다.
- 예상되는 4xx와 성공 요청은 실패 진단을 남기지 않는다.
- 서버 로그 플랫폼 자체의 시간·severity·프로세스 메타데이터는 플랫폼이 추가할 수 있다.

## 변경하지 않는 것

성공 PIN payload, 30초 조회 정책, no-store, 역할·배정 권한, CAS, 멱등성,
암호화·실제 PIN, DB 스키마를 변경하지 않는다. 기존 오류 응답 계약도 유지한다.
PIN 전송/시트 가져오기·내보내기는 이번 6개 명령 범위 밖이다.
비PIN 요청의 기존 x-request-id 전달은 유지하며 미제공 ID는 불투명 UUID로 생성한다.

## 운영 조회 방법

사용자가 알려준 **응답 문의번호**로 API 함수의 오류 로그를 검색한다.
operation/code/status로 설정·키 사용 불가·DB 명령 실패 등을 분류한다.
추가 조사는 권한 있는 관리자가 수행하고 원문 PIN·키·요청 body·원문 DB 예외를
로그에 덧붙이지 않는다. 이 진단은 원인 분류용이며 자동 PIN 변경이나 복구를 수행하지 않는다.
배포 전 발생한 과거 오류에 소급 진단 기록이 생기지는 않는다.

## 검증 및 배포 경계

- `npm run ci:quality`: PASS, 126 files / 3,133 tests. 기존 lint 경고는 오류 없이 유지.
- `npm run db:manifest:verify`: PASS (파일 정적 검증만, DB 실행 아님).
- `npm run edge:check`: PASS, 후보 번들 19,423,789 bytes (20,000,000 미만).
- 독립 QA: Node 6파일 148개 및 실제 자동 요청 로그 검증 PASS, 미해결 주요 결함 없음.
  최종 추가 회귀 및 CI 결과는 PR에도 기록한다.
- 마이그레이션 추가/실행, DB reset/전체 DB 검증, 운영 API 배포: NOT RUN.
- 배포 시 API 코드만 반영한다. rollback은 이전 API 코드 재배포이며 DB 복구가 필요하지 않다.
- 현재는 개발 후보이며 운영에 반영되었다는 뜻이 아니다.
