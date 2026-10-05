## #332 등록 신고 조회 — source 후보, 운영 미배포

## 2026-10-06 최신 dev 통합

#318/PR321과 #330/PR337이 병합된 `dev@109d6b77c8874a184693d5ce603ced9b666a1eb5`의
108개 migration을 보존하고 기존 PR338/source580b080에서 정상 통합했다.
현재 후보는 110 migrations, head `room_candle_session_hard_expiry`,
OpenAPI 0.6.0 / 140 paths / 151 operations다. 아래 86/132·142 검증은 최초 후보의 과거 기록이다.

- 미적용 원 SQL은 CLI가 생성한 `20261004232901_admin_registered_report_read.sql`로
  byte-identical 이동했다. LF SHA-256은
  `83541ca1f351b8e6d830cb8e4c2b13e9a58e338c58284854fe4105fa37f938e3`다.
  이전 hosted history/signature 조회의 운영85/복구73 미적용 근거를 사용했으며 원격 적용/repair는 없다.
- `20261005003351_admin_registered_report_fresh_session_guard.sql`은 #329 private fresh helper가
  실제 설치된 뒤 원 VOLATILE RPC의 단일 session-helper 호출만 교체한다.
  원 body MD5 `5244a78ce24b971106cae3d7bd49d46b`와 교체 후
  `5981a7d9c2d1a4ecba51c45bb4f04ffb`를 검증하고 OID/owner/ACL 등 모든 비본문 속성을 보존한다.
  원 #329 installer의 strict caller 목록은 변경하지 않는다. 최종 전체 caller 기준은 snapshot7/fresh19/core2다.
- `npm run ci:quality`: PASS — secret scan897, OpenAPI140/151, lint/typecheck,
  Node1,831/81파일, build. 첫 실행의 기존 촛불 fixture CRLF 비교 실패는
  비교 문자열만 LF 정규화하여 보완했고 SQL/검증 내용은 그대로다.
- `npm run edge:check`: PASS — 491 tests, bundle17,640,862 bytes.
- Python Ruff/format/mypy/pytest95/business client codegen/package source: PASS.
  기존 binary 사진 endpoint codegen 경고는 유지하며 신고 모델/client 생성은 확인했다.
- `npm run db:reset`: PASS — 원본492개를 변경하지 않은 manifest SHA 동일 LF 임시본에서
  110개를 fresh 적용했다. 첫 개별 SQL 실행은 존재하지 않는 파일 경로 지정으로 NOTESTS/exit1이므로
  전체 SQL 디렉터리 검증으로 전환하여 87파일/5,327 assertions PASS를 확인했다.
  `db:lint:baseline`은 exact9/catalog3 PASS이며 원 strict는 FAIL9/exit1 그대로다.
  이후 `npm run db:test` 전체27 upgrade와 SQL87파일/5,327 assertions도 exit0 PASS다.
  static/KST·전체 경합 결과는 후속 기록 전까지 미완료다.
- 다섯 manifest와 TypeScript template client6순열 검증 PASS.
  이전108개 SQL identity/hash는 그대로이며 #332 두 파일 삽입으로 마지막 촛불 두 파일의
  manifest order만 각각 +2다. 전체 row를 비교한 최초 임시 검사는 이 예상 order 차이를 실패로
  판정했으며, identity/hash 불변과 정확한 +2 위치 이동을 각각 검사하여 PASS를 확인했다.
  LF 검증본의 원본492개 hash drift는0이다.
- 독립 source QA: 관련7파일109 tests PASS, P0/P1/P2 없음.
  최종 staged tree QA·필수 CI·dev 병합·release/main·실제 백업/복원·운영 배포는 아직 미완료다.

Supabase-only B 백업/복원은 모든 개발 후, 운영 반영 전에 완료해야 한다.
프런트 소스·운영/복구 DB·Auth 설정·실제 PIN·v0.8.0은 변경하지 않았다.

사용자가 승인한 A안에 따라 active/password-complete business admin은 전체 제출 전부터
서버에 실제 등록된 객실 특이사항과 폭탄방 신고를 읽을 수 있다.
`GET /v1/rooms/{roomId}/reports`는 기존 `room_issues` 목록을 대체하지 않고
immutable report-linked subset과 폭탄방만 함께 보여준다. room_issue의 `id`는 기존 운영 이슈 ID다.

- query: `status=registered`(기본), `limit=1..10`(기본 5), `cursor=nextCursor`.
- 정렬: `reportedAt DESC, id DESC`. cursor는 actor/role/room/stream/status/sort에 서명한다.
- 빈 `items`는 해당 페이지에 등록된 신고가 없다는 뜻이며, 권한 오류나 provider 장애를 빈 목록으로 바꾸지 않는다.
- `kind=room_issue`: `status=open|resolved`. `kind=bomb_room`: `reported`(제출 미봉인),
  `pending`(제출 봉인 후 판정 대기), `approved|rejected`(기존 폭탄방 판정).
  `sealedSubmissionId`는 폭탄방의 최초 봉인 제출 ID이며 객실 이슈에서는 null이다.
- 선택된 불변 photo version만 `evidence`로 반환한다. 일반 사진/current collection/미신고 업로드는 열거하지 않는다.
- `readState=available|expired|purged|unavailable`과 보존 metadata를 반환하며 만료·삭제 후에도 신고를 숨기지 않는다.
  `mediaAvailability`는 저장된 보존 상태이고 시각상 만료 여부는 `readState`를 우선한다.
- 원본은 기존 `GET /v1/photos/{photoId}/content`를 사용한다. 실제 요청에서 session/role/ownership/만료를
  provider 응답 전후 다시 검증한다. provider HTTP 실패는 content 오류이며 신고가 없다는 뜻이 아니다.
- 기존 관리자 accepted-photo 열람 및 실제 수행 메이드의 본인 사진 권한은 변경하지 않는다.
  신규 목록은 admin 전용이며 다른 메이드·limited·비활성·developer는 관리자 권한을 얻지 않는다.
- 모든 응답은 no-store. locator, Drive ID, token, hash, 내부 감사 payload는 반환하지 않는다.
- 조회로 제출·검수·수익·지급을 생성하거나 신고/증빙/보존 기간을 변경하지 않는다.
  제출 이후 새 신고 정책은 #336이며 이번 범위가 아니다.

최초 86번째 후보였던 `admin_registered_report_read`는 service-role 전용 조회 RPC 하나를 추가한다.
기존 table/RLS/DML/retention/봉인 함수를 변경하지 않는다. 새 환경 변수·provider 권한·데이터 변환은 없다.
fresh DB와 기존 migration 누적 업그레이드를 검증하며, 운영 적용은 별도 release 승인 후에만 한다.
되돌릴 때는 이전 API bundle을 사용하고 미사용 조회 함수는 남긴다. 이력 삭제나 down migration은 하지 않는다.

최초 source API는 OpenAPI 0.6.0 / 132 paths / 142 operations였다. 이는 #332 단독 후보 기준이며
미병합 #330 촛불 API까지 합친 개수가 아니다. frontend/release/main/production/Pages는 변경하지 않았다.

## 2026-10-01 로컬 검증

- `npm run ci:quality`: PASS (application 582 tests, lint/typecheck/build, secrets, OpenAPI 계약).
- `npm run edge:check`: PASS (289 tests, format/type, pinned Edge bundle).
- `npm run db:reset`: PASS (fresh local 86 migrations).
- `npm run db:test`: PASS (누적 upgrade 및 전체 SQL 64 files / 3,398 assertions).
- `npm run db:test:long-stay-clock`: PASS (5시각 / 145 assertions).
- `npm run db:test:concurrency`: PASS (기존 배정·사진·지급·알림·PIN 경쟁 회귀).
- local public/private DB lint: error 0. migration manifest 검증 PASS.
- 실제 local catalog 검사: 새 RPC는 service_role만 실행 가능, RLS 미설정 public table 0개.
- Python ruff/format/mypy/pytest(95)/business codegen/package-source 검사 PASS.
- 독립 정적 QA: 97/100, 미해결 P0/P1/P2 0건. 원격 exact-head CI는 PR에서 별도 확인한다.
- 실제 운영 계정/provider/UAT와 원격 Security Advisor는 실행하지 않았다. 이 문서는 운영 반영 증거가 아니다.
