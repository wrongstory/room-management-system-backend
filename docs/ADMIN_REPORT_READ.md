## #332 등록 신고 조회 — source 후보, 운영 미배포

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

86번째 append-only `admin_registered_report_read`는 service-role 전용 조회 RPC 하나를 추가한다.
기존 table/RLS/DML/retention/봉인 함수를 변경하지 않는다. 새 환경 변수·provider 권한·데이터 변환은 없다.
fresh DB와 기존 migration 누적 업그레이드를 검증하며, 운영 적용은 별도 release 승인 후에만 한다.
되돌릴 때는 이전 API bundle을 사용하고 미사용 조회 함수는 남긴다. 이력 삭제나 down migration은 하지 않는다.

source API는 OpenAPI 0.6.0 / 132 paths / 142 operations다. 이는 #332 단독 후보 기준이며
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
