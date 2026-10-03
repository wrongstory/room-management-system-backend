# 최신 주급 조정 원장 CAS 조회 (#325)

## PR #358 후속 경로 경계 보완 checkpoint

첫 source `b3f9077c3fa9c4f86853b62b15f5edde026d1333` 이후 독립 실측에서 Fastify의
percent-encoded static alias가 정상 GET으로 매칭되는 P2를 확인했다. 권한 우회는 아니지만
Node/Edge exact-route 차이를 보완했다. 한 번 decode한 segment로 이 API family만 인식하고,
실제 허용은 원래 raw canonical path로만 판정한다. 정상 파싱 가능한 encoded 문자·slash alias는
인증/RPC 전에404/no-store이며 OPTIONS는204/no-store다. invalid URI의 transport 파싱이나
double-encoded 미매칭 경로에 recursive decoder/전역 Auth 정책을 추가하지 않는다.

보완 후 `npm run ci:quality` PASS(Node1010/61files), `npm run edge:check`
PASS(343 tests, bundle17,305,023bytes), 독립 실제 guard/routes/CORS24요청 PASS다.
기존 SQL97 migration·manifest·두 DB harness는 바이트 변경이 없어 진행 중 전체 DB 회귀는
동일 migration SHA 검증으로 유지한다. 초기 source CI의 application은 PASS이고,
최종 승인은 이 보완 commit의 새 exact-head application/migration CI로 판정한다.
전체 DB·최종 QA점수·CI/dev 상태는 [PR #358](https://github.com/wrongstory/room-management-system-backend/pull/358)에서 갱신한다.
아래 PR 생성 전 checkpoint와 당시 대기/통과 결과는 이력으로 보존한다.

## 상태와 기준

2026-10-03 KST PR 생성 전 고정 checkpoint다. 구현과 아래 개별 검증은 완료했고,
전체 local DB 회귀·최종 독립 QA·exact-head CI·dev 통합은 후속 gate다.
이 절의 대기 상태는 이 시점의 기록이며 현재 완료/차단 상태와 source·CI·dev 증빙은
[Issue #325의 연결 PR](https://github.com/wrongstory/room-management-system-backend/issues/325)에서 갱신한다.
선행 dev는
`b6f799811416fad6f80dba3d721ba279159c0aa8` / 96 migrations다.
#327은 PR #357 source `22cbf0be9ed2c5e228e6c5091059c2052a61adce`,
동일 tree `8ed55b3843e4015e46212087b4790f6d99103f45`,
required CI `37086130779` application/migration PASS·독립 QA98/100으로 완료했다.
이전 후보·실패·PR 생성 전 checkpoint는 당시 이력으로 보존한다.

프런트 정본 `makee-ham/room-management-system`의 main
`d509b44b1371f25d73891e04d355b0cb0e923f5f`, dev
`09ed28446a4fd43919cddb29ebe442b848548ab8`와
DOCS/28 B02의 기존 조정 재정정·취소 version 누락만 대조했다.
전역 제품 snapshot·미확정 정책·프런트 소스·운영 페이지는 변경하지 않는다.

## 조회와 연동 계약

`GET /v1/payroll/adjustment-book?maidProfileId=<UUID>&weekStart=<YYYY-MM-DD>`

두 query는 필수다. 알 수 없는/중복/빈 query, 잘못된 UUID·실제 달력 날짜는
400 VALIDATION_ERROR다. 날짜는 서기 1–9999년의 정확한 4자리 연도 형식이다.
현재 또는 과거 KST 월요일 주차만 허용하며, 월요일이 아니면
400 PAYROLL_WEEK_MUST_START_MONDAY, 미래면 409 PAYROLL_WEEK_NOT_CLOSED다.
지급 시작의 종료 주차 제한을 조회에 추가하지 않는다.

```json
{
  "adjustmentBook": {
    "maidProfileId": "f3250000-0000-4000-8000-000000000002",
    "weekStart": "2026-09-28",
    "currentBookVersion": 0
  }
}
```

내부 book ID, 조정 ID·금액·개인정보·PIN·session 정보는 반환하지 않는다.
currentBookVersion은 메이드 전체 원장의 현재 CAS다.
`payroll_adjustment_books` PK는 maid_profile_id 하나이며 weekStart는
화면 context 검증·echo일 뿐 원장 identity가 아니다. 동일 시점에는 유효한
다른 주차로 조회해도 같은 전체 version이다.

불변 조정 row와 기존 mutation 응답의 bookVersion은 생성 당시 version이다.
기존 entries/cycle/mutation DTO와 signed correction/reversal 규칙은 유지한다.
조정 없는 유효한 maid의 원장은 서버가 0을 판정하며 조회로 book을 만들지 않는다.
없는 book에 조정 이력이 남은 비정상 상태를 0이나 max(row.bookVersion)으로 복구하지 않는다.
불완전·잘못된 DB projection이나 안전한 정수 범위 밖 version은 안전하게 실패한다.

프런트는 항목을 조정/취소하기 직전에 조회한 currentBookVersion을 기존
expectedVersion으로 사용한다. 200은 향후 명령 성공이나 항목 취소 가능의 보장이 아니다.
관리자 A/B가 V를 조회한 뒤 A가 변경하면 B의 V는 기존 409로 거부되고,
재조회한 V+1로 다시 명령해야 한다. 새 브라우저/유효한 재로그인에서도 서버를 조회하며
0이나 과거 행 version을 추측하지 않는다.

기존 명령은 source의 실제 maid book을 잠그고 CAS를 검사한다.
관리자의 타 maid 조회 자체는 금지하지 않으며, 동값 version을 사용해도 source의
실제 귀속이 다른 maid로 이동하지 않는다. 화면에서 선택한 maid를 기존 mutation에
새로 bind하는 정책 변경은 이번 범위가 아니다. 이미 반전된 source를 새 key로
반전하는 거부·기존 receipt replay·PAID snapshot 불변은 그대로 유지한다.

## 권한과 DB 경계

신규 service-only `public.get_payroll_adjustment_book(uuid,uuid,uuid,date)`는
STABLE SECURITY DEFINER와 빈 search_path, 명시 EXECUTE revoke/grant를 사용한다.
최신 DB admin/active, 비밀번호 변경 완료와 token에서 식별한 정확한 Auth
user/session을 다시 검증한다. auth.sessions.not_after가 NULL이거나
statement_timestamp()보다 엄격하게 미래여야 한다. 만료·동일 경계·타 사용자·
삭제된 세션은 401 SESSION_REVOKED다. 비밀번호 변경은 403 PASSWORD_CHANGE_REQUIRED,
그 밖의 관리자 역할·상태 거부는 403 ADMIN_REQUIRED다.

대상은 role=maid여야 한다. 없는/non-maid 대상은 404 PAYROLL_MAID_NOT_FOUND다.
기존 관리자 역사 정산 조회처럼 inactive/departed maid도 조회할 수 있다.
빈 원장에도 actor/session/대상/기간 검사를 생략하지 않는다.
[Supabase 세션 정리 지연](https://supabase.com/docs/guides/auth/sessions)을 권한으로
취급하지 않으며 공통 helper 전체 개선 #352는 별도다.

기존 96개 migration을 수정하지 않고 CLI가 생성한 97번째
`20261003021153_payroll_adjustment_book_read.sql`만 추가한다.
새 table/column/index/RLS 정책·table grant는 없고 maid/profile PK 조회를 사용한다.
FOR UPDATE·book INSERT·CAS 변경·receipt·audit·notification·outbox·provider 호출이 없다.
anon/authenticated는 RPC를 직접 실행할 수 없으며 service role도 actor 검사를 우회하지 못한다.
성공·인증·권한·입력·실패·잘못된 method/path는 no-store다.
GET만 허용하고 HEAD·잘못된 method·slash alias는 404, 기존 CORS OPTIONS는 유지한다.
최종 UTF-8 JSON은 기존 128 KiB 상한을 적용하며 raw DB 오류는 노출하지 않는다.

## 검증과 완료 gate

변경 전 `npm ci`, `npm run ci:quality`는 PASS(Node913/59files).
신규 구현의 `npm run ci:quality`는 PASS(Node1006/61files, typecheck/test/build 포함),
최종 `npm run edge:check`는 PASS(343 tests, bundle17,303,786bytes)다.
Python ruff lint/format226files·mypy25sourcefiles·pytest95·실제 business client
생성·package source check는 PASS다. 초기 codegen 검사 substring 오류와 mypy 변수 재사용은
보완 후 재실행 PASS이며, 기존 전체 SDK #355 warnings는 그대로 기록했다.

fresh97 `db:reset`·`db:verify`, 신규 SQL79, 5 manifests, exact96→97 전체 row/
function/ACL/RLS/index 보존 upgrade 및 실제 correction/reversal 양방향 경합은 PASS다.
각 경합에서 winner1/stale1/deadlock0, nonlocking committed read·refetch retry·
정확한 receipt와 original earning 보존, finally fresh97 복원까지 실제 확인했다.
합성 백업/복구97는 PASS(rooms121/table154/public RLS missing0/row counts 일치)이나
이 시점의 Git HEAD는 선행 b6f7998이다. 최종 source commit의 백업 증빙은 후속 gate에 기록한다.
전체 `db:test`23upgrades/SQL·KST clock·전체 concurrency는 진행 중이며 아직 PASS가 아니다.
정적 독립 QA의 P0/P1/P2는 0이고 신규 Node/OpenAPI93 독립 실행 PASS다.
최종 점수·exact source 승인·required CI와 dev 병합은 이 시점에 NOT RUN이다.
QA가 지적한 조기 method/path guard·OPTIONS no-store와 oversized raw RPC 오류 parity는
수정 후 위 Node/Edge 최종 실행으로 확인했다.

source 실제 inventory는 OpenAPI 0.6.0 / 133 paths / 143 operations다.
운영 Pages/runtime의 131/141 inventory를 미리 올리지 않는다.

필수 gate는 Node/Edge/OpenAPI parity·실제 Python 생성 client, fresh local
`db:reset`·`db:verify`, 전체 SQL·23 upgrade·KST clock·전체 동시성,
migration history/ACL/RLS/advisors와 합성 백업 복구다.
정확한 96→97 upgrade는 source hash를 확인한 첫 97개 migration과 config만
격리 임시 workspace에 복사한다. 모든 기존 public/private row 전체 JSON,
함수 정의/ACL/RLS·receipt를 제외 없이 보존하고 새 read RPC만 추가됐음을 검증한다.
finally에서 원본 workspace의 현재 최신 전체 migration을 복원하며 생성한
검증된 임시 경로만 정리한다. 운영 DB 또는 기존 source 파일을 reset/이동하지 않는다.

관리자 A/B stale 재조회와 실제 병렬 correction/reversal의 winner1/stale1/deadlock0,
original/PAID/멱등 replay, 최초0·과거항목·유효 재로그인·역할/세션/기간 matrix를 검증한다.
최종 독립 QA ≥90 및 in-scope P0/P1=0, exact-head required application/migration PASS,
미해결 blocking review 없음·충돌 없음·보호 규칙 확인 뒤에만 dev squash한다.

#324 객실별 상세 산출, #331 송금 표시, #334 기존 의존성 취약점,
#352 공통 auth deadline, #353 drain, #355 전체 SDK 기존 warning은 별도다.
전체 codegen PASS는 기존 warning이 0이라는 뜻이 아니다.
main·production/recovery DB·운영 API·secret·provider·실제 PIN·프런트 UI/UAT·
tag/Release는 변경하지 않는다. 운영 반영에는 별도 release 승인·배포/smoke가 필요하다.
최종 exact source/tree·CI·QA·dev 통합은 [Issue #325](https://github.com/wrongstory/room-management-system-backend/issues/325)의
연결 PR에서 기록하고, 실행하지 않은 결과를 완료로 선기록하지 않는다.
