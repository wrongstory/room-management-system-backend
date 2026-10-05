# #324 객실별 주급 근거 조회 계약

상태: `dev@d65f4f600f856bd990b52762cf57530830970f12` / 97 migrations에서 시작한 구현 후보.
운영 API·main·recovery·프런트 UI 변경이나 배포 완료가 아니다. 신규 migration은
`20261003042015_payroll_work_details_read.sql`이며 기존 적용 migration을 수정하지 않는다.

## 근거와 범위

제품 정본은 `AI_BACKEND_PRODUCT_GUIDE.md`의 확정 수익·무급 재청소·typed 보상·KST 주차·
불변 지급 계약이다. 이번 소비자 대조는 프런트 main
`d509b44b1371f25d73891e04d355b0cb0e923f5f` / dev
`09ed28446a4fd43919cddb29ebe442b848548ab8`의
[DOCS/28 B01](https://github.com/makee-ham/room-management-system/blob/09ed28446a4fd43919cddb29ebe442b848548ab8/DOCS/28_FRONTEND_CONNECTION_BACKEND_MEETING.md)
및 `renderLivePayrollDetail`에 한정한다. 전역 제품 snapshot `165fed2`를 갱신하거나
dev 요청을 새로운 제품 정책으로 승격하지 않는다. 기존 `/payroll/entries` 및 v1 cursor는 그대로다.

## HTTP와 권한

`GET /v1/payroll/work-details?weekStart=YYYY-MM-DD&maidProfileId=UUID&kind=earnings|workflow`
에 `limit`(기본25, 최대50), `cursor`를 선택적으로 지정한다. 중복·알 수 없는 query,
유효하지 않은 날짜·월요일이 아닌 주 시작일·미래 KST 주차를 거부한다.
GET만 제공하며 HEAD·trailing slash·인코딩된 경로 별칭은 허용하지 않는다.
최종 UTF-8 JSON은 최대128KiB이고 성공·오류 모두 `Cache-Control: no-store`다.

활성·비밀번호 변경 완료 admin 또는 본인 maid만 읽는다. admin은 비활성/퇴사 maid의
과거 수익을 읽을 수 있으나 비활성 actor·developer·다른 maid·제한 capability의 일반
주급 조회는 허용하지 않는다. RPC는 adapter가 검증한 actor role과 최신 DB role,
actor 소유 `auth.sessions.id/user_id`, strict `not_after > statement_timestamp()`를 재검증한다.
service_role만 실행 가능하고 raw table 권한·RLS는 넓히지 않는다.

## 응답

Envelope: `{weekStart, maidProfileId, kind, summary, entries, nextCursor}`.
summary는 기존 `private.project_payroll_cycle_bounded`에서 다음 필드만 추출한다.

`cycleId, cycleStatus, cycleVersion, accrualAmount, expectedAmount, pendingAmount, pendingCount,
totalAmount, lateEarningAmount, adjustmentAmount, carryInAmount, carryOutAmount, payableAmount,
offsetSettled, lockedAmount`. alreadyClaimed는 지급 완료가 아니라 item membership이며
OPEN+offsetSettled인 경제적 동결도 별도 표시한다.

공통 행: `entryId, entryDate, cleaningTargetId, assignmentId, attemptId, submissionId,
inspectionDecisionId, roomNumber, roomTypeCode, roomTypeName, cleaningKind, sourceKind,
fieldCompletedAt, feeSnapshot, attemptStatus, submissionStatus, inspectionDecision`.
없는 submission·검수·보존 snapshot metadata는 null이며 catalog로 추측해 채우지 않는다.
attempt에 타입 key 자체가 없을 때만 frozen target snapshot을 참조하며 명시적 null/비문자 값은
보수적으로 unknown/null로 둔다. 정상 문자열은 그대로 보존하고 HTTP projection은
공백·tab·줄바꿈·NBSP만 있는 label을 unknown/null로 정규화한다.
메모·사진/Drive locator·고객·PIN·다른 메이드 보상 정보는 반환하지 않는다.

| stream | 추가 필드와 의미 | 전체 페이지 합계 기준 |
|---|---|---|
| earnings | `earningId, earnedOn, earningSource(cleaning/compensation), baseAmount, bombRoomBonus, totalAmount, itemContributionAmount, lateContributionAmount, alreadyClaimed, lateCarried` | `totalAmount` 합 = summary `accrualAmount`; item/late contribution 합은 각각 summary `totalAmount/lateEarningAmount` |
| workflow | `earningId/baseAmount/bombRoomBonus/totalAmount=null`, `expectedBaseContributionAmount, expectedBombContributionAmount, expectedContributionAmount, pendingContributionAmount, includedInPendingCount` | expected base+bomb = expected contribution; expected contribution 합 + accrual = expected; pending contribution 합 = pending; included count = pendingCount |

earnings는 실제 earning의 immutable submission FK에서 attempt/assignment/target을 연결한다.
compensation은 실제 earning의 확정 금액이며 0원 보상도 원장 행이다. 지급 포함·late/carry 여부는
별도 축이다. 이미 이월된 수익을 adjustment와 다시 더하지 않는다.

workflow는 실제 attempt 중 earning이 없는 행이며 최신 submission pointer를 읽는다.
반려·무급 재청소·종료 이력도 정보로 제공하되 기존 aggregate predicate 밖의 금전 contribution은0이다.
기존 expected/pending predicate와 폭탄방 판단을 그대로 사용하고 보상 대기의 새로운 금액 정책은
추가하지 않는다. 아직 attempt가 없는 통보 업무는 이 endpoint에서 만들지 않는다.
지급 잠금·PAID·earning·기존 receipt·사진 retention은 바꾸지 않는다.
새 DB read RPC는 실패도 업무 원장을 쓰지 않는다. Edge의 기존 공통403 처리에 따른
bounded authorization-denial 감사는 유지하며 이를 새 조회의 업무 mutation으로 보지 않는다.

## 페이지와 시각

earnings의 `entryDate/entryId=earnedOn/earningId`, workflow는
`coalesce(fieldCompletedAt의 KST 날짜, target.effective_service_date)/attemptId`다.
각 stream은 `(entryDate ASC, entryId ASC)` keyset으로 순회한다. workflow 포함 주차도
기존 집계의 이 날짜와 동일하며 예정일·업로드일·검수일로 확정 earning 날짜를 바꾸지 않는다.

새 HMAC family/domain은 actor ID·role·session·주차·maid·kind·정렬·last key를 묶는다.
기존 `PAYROLL_CURSOR_HMAC_SECRET`을 도메인 분리해 사용하며 기존 cursor와 상호 거부한다.
DB 한 statement 안의 page와 summary는 같은 MVCC snapshot을 읽는다. 여러 HTTP 페이지 사이에는
검수·지급·담당 변경이 가능하므로 영구 snapshot이나 across-page 합계 보장을 하지 않는다.
실시간 변경을 감지한 UI는 첫 페이지부터 갱신하고 서로 다른 조회 시점의 두 stream을 합산하지 않는다.

## 검증 상태

- 기준97의 `npm ci`, `npm run ci:quality`: PASS (Node1010/61, typecheck/build/명세/secret/lint).
- 설치 시 기존 의존성 경고3개(fast-uri High, Fastify High, ip-address Moderate)는 #334 후속 조사다.
- 초기 구현 `npm run ci:quality`: PASS (Node1098/63, typecheck/build/명세134paths·144ops).
- 마지막 adapter freeze의 `npm run ci:quality`: PASS (Node1106/63, typecheck/build,
  명세134paths·144ops, secret/lint). `npm run edge:check`: PASS (388 tests,
  pinned Deno/Edge 검사·bundle17,395,182bytes). 실제 Python ruff/format226·mypy25·
  pytest95·full business client 생성·package source check: PASS. 기존 #355 생성 경고는 별도다.
- `db:reset` fresh98 / 5개 manifest / 신규 SQL145: PASS. 초기 fixture 변수 오류와
  정상 attempt 생성 전 noncurrent assignment 설정은 각각 FAIL(0 subtests), 페이지 누적 helper의
  `||`/`->` 우선순위는 FAIL(52/145)이었다. fixture만 보완한 네 번째 실행145/145는 PASS이며
  migration98 SHA256 `6e2e419155bb18bd7095d0f7e2d3ee8e21a90af37036ae3b22555473b099b527`은
  바뀌지 않았다. Edge 초기376PASS/5FAIL은 mock의 기존403 감사 RPC 구분 오류였고 보완 뒤
  전체388PASS다. 실패 이력·제약 조건·검증 강도·기존 authorization-denial 감사를 보존한다.
- 정확97→98 전체 row/function/ACL/RLS/index/receipt 보존과 실제 지급 시작·세션 폐기
  겹침 검증은 초기 실행 PASS다. 독립 검토의 로컬 project_id 일치와 fixture 주차 고정 보완을
  추가했으며 보완 뒤 전체24 upgrades·SQL·KST·동시성의 최종 gate는 진행 중이다.
  로컬 advisors/history·최종 source 합성 복구·실제 조회 계획 검토는 이 checkpoint에 NOT RUN이다.
- exact-head required CI·독립 QA·dev 통합: NOT RUN.
- production 적용·프런트 UAT·main 릴리스: 범위 밖, NOT RUN.

위 내용은 PR 생성 전 실행 checkpoint다. 전체 회귀·보완된 실행기·최종 source/hash/QA·
required CI·dev 통합 결과는 [Issue #324의 연결 PR](https://github.com/wrongstory/room-management-system-backend/issues/324)에
실제 완료 순서대로 기록하며 사전 PASS로 표시하지 않는다.

Supabase/Postgres 변경 기록은 2026-10-03 확인했다. 최근
[PG15.19/17.11 변경](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes)의
ltree/legacy PGP/float btree_gist/custom operator 재검토 대상은 이번 read API에서 추가하지 않는다.
runtime/extension/CLI 업그레이드는 이번 범위에 포함하지 않는다.
