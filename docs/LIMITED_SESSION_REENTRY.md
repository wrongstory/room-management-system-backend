# #329 기존 로그인 세션의 제한 업무 재진입

## 2026-10-05 #389 caller catalog / bb4fa40 통합 로컬 checkpoint

기존 source `8941039`에 `dev@bb4fa40`를 정상 merge한 미커밋 후보에서 실행했다.
원본 installer `20261003140716_limited_existing_session_discovery.sql`의 canonical LF SHA
`dadd5abddedb74e9e66f20f1b970e53d3398ddabf0764b926a713aeee6e8b603`는 그대로다.
#389는 installer를 완화하거나 새 runtime 권한을 추가하는 migration이 아니라,
기존 exact catalog 검사를 승인된 후속 두 signature에만 확장하는 회귀 fixture다.

- 실제 local LF fresh103 및 마지막 fresh103 cleanup: PASS.
- 원본 strict lint: FAIL9/exit1 유지. 정확한 warning9/catalog3 baseline: PASS.
- 전체 SQL `supabase test db supabase/tests --local`: 81 files / 4,942 assertions PASS.
- 실제 `test-limited-existing-session-upgrade.mjs`: 100→101의 격리 upgrade PASS,
  old whole rows/receipts/catalog 보존·legacy no-backfill·기존 세션만 freeze 검사 후 fresh103 복원 PASS.
- 실제 `test-limited-existing-session-concurrency.mjs`: 지연 session commit 제외,
  종료 replay/승계, 실제 revoke 및 잠금 뒤 hard expiry, receipt writer 뒤2h/24h TTL rollback,
  사진/제출 경합·동일 제출 수렴·잠금 순서 검사를 포함한 7개 PASS checkpoint.
- `npm run ci:quality`: 1,525 tests / 70 files, lint/typecheck/build/OpenAPI PASS.
  #389의 추가42 source/mock 검사는 실제 pgTAP 실행과 별개다.
- 승인된 LF 검증본의 원본304 hash와 대응 사본304: 실행 후 drift0.

증적은 `.tmp/qa329-catalog-{db-verify,baseline,whole-sql,upgrade,races,final-cleanup}.log`와
`.tmp/qa389-session-caller-quality.log`에 보존하며 커밋하지 않는다.
이번 실제 DB의 caller는 기존 snapshot6/fresh18/core2다. 후속 #318의 정확한
`public.get_room_board_projection(uuid,uuid,date,uuid)` STABLE snapshot과 #332의
`public.list_room_reports_page(uuid,uuid,uuid,integer,timestamptz,uuid)` VOLATILE fresh가
설치된 경우에만 각각7/18→7/19를 허용한다. overload·알 수 없는 caller·순서·body·
owner/ACL/security/search_path/language/volatility drift는 계속 거부한다.
7/18·7/19의 실제 DB 검증은 두 후속 기능 통합 후에 수행해야 한다.

최신 dev의 #383/#388/#382 재통합, 그 최종 source의 전체27 upgrade·Edge/Python·독립 QA·
새 exact-head CI·dev 병합은 아직 미완료다. 아래 최초101의 전체27 upgrade PASS를 이
새103 후보의 전체 upgrade 실행으로 승격하지 않는다. v0.8.0은 보존하고 최신 기능은
#387 v0.9.0으로 준비하며 main/운영 DB/API·백업/복원·프런트 UAT는 NOT RUN이다.
아래 이전 strict17/101 및 진단용 공유 경계는 해당 시점의 기록이다.

## 확정 정책과 작업 상태

사용자 A안: 유효하고 폐기되지 않은 기존 로그인 세션에서만 제한 업무를 허용한다.
2026-10-03에는 운영 준비 동안 별도 백엔드 개발 병행을 승인했다.
작업 기준은 `dev@e9fcc564dfb4acd2cc4e175df7d1421dbb6b07e5`의 100 migrations다.
고정한 `release/v0.8.0@5408c54`에는 이 작업을 포함하지 않는다.
그 후보의 CI37127623239는 application PASS / migration FAIL이며 별도 #371에서 알림 fixture를 보완한다.
그 실패나 실제 운영 백업·보안 DB 연결 gate를 #329 병행 승인으로 면제하지 않는다.
현재는 로컬 검증을 마친 진단용 Draft 공유 후보이며 source/dev 통합 완료·운영 배포·프런트 연결을 선언하지 않는다.

## 계정·세션·행위 계약

| 상태·상황 | 허용 경계 | 종료·복구 |
|---|---|---|
| active 일반 인계 | 본인 interrupted 회차의 기존 증빙 capability; 일반 active 권한은 별도 유지 | 기존 철회·24h hard expiry |
| deactivation_pending / finish_current | 최초 제한 전환의 기존 유효 세션, 같은 in_progress 회차 현장 완료만 | 발급 후2h; 완료·인계·철회 시 종료 |
| upload_only / upload_submit | 같은 field_completed/upload_pending 회차 사진 업로드·검증·전체 제출 | 발급 후24h; finish에서 이어진 세션 자격만 상속 |
| upload_only / evidence_upload | 인계로 interrupted된 원 회차 증빙 업로드·검증만 | 발급 후24h; current submission·검수·수익 연결 금지 |
| inactive/departed/role 변경/임시 비밀번호 | 제한 업무 불가 | 관리자 인계·재배정; 일반 계정 정리 유지 |
| session 폐기·hard expiry·정상 refresh 불가 | 새 요청과 안전한 receipt 재조회도 해당 세션으로 불가 | 새 로그인·복구 키·active 위장으로 우회하지 않음 |

최초 active→limited 전환 transaction에 실제 보이는 유효 Auth session 집합만
domain-separated digest로 private immutable evidence에 고정한다. session ID/token 원문을 저장하지 않는다.
`created_at <= issued_at` 같은 시간 추측이나 현재 세션 조회로 과거 eligibility를 backfill하지 않는다.
완료 후 upload grant는 최초 eligibility를 상속하며 새 세션을 포섭하지 않는다.
정상 완료에 따라 upload grant를 처음 발급할 때의24h 계약은 유지한다.
재진입·재시도·다른 command key로 이미 발급된 grant의 TTL을 갱신하거나 연장하지 않는다.
회수는 별도 이력이며 계정 재활성화나 다른 idempotency key로 과거 권한을 복원하지 않는다.

일반 login·`/v1/auth/me`·일반 업무 active-only guard와 일반 비활성화의 Auth ban/session 폐기는 유지한다.
제한 lifecycle command는 이미 보존한 세션을 이용하지만 expired/revoked session을 새 credential로 대체하지 않는다.
매 전용 요청은 최신 role/status·비밀번호 변경 완료·정확한 live session/`not_after`·최초 eligibility·
본인 attempt/assignment revision·허용 action·capability expiry/revocation을 재검증한다.
mutation은 잠금 대기 이후의 현재 시각으로 검사하며 provider 처리 뒤 accepted 수렴에서도 다시 검사한다.
성공 receipt 조회와 새 mutation 권한은 구분하고, receipt는 TTL·종료된 회차를 되살리지 않는다.

## Discovery 구현 계약

신규 `GET /v1/limited/attempts`는 기존 access token을 사용하고 query/body의 actor/session/시간을 받지 않는다.
envelope는 `profileStatus`, `evaluatedAt`, `items`이며 각 item은 아래9개 필드만 제공한다.

- `attemptId`, `assignmentId`, `assignmentRevision`, `executionVersion`, `status`
- `kind`, `allowedActions`, `issuedAt`, `expiresAt`

`finish_current`: `complete_field_work`.
`upload_submit`: `upload_evidence`, `validate_evidence`, `submit`.
`evidence_upload`: `upload_evidence`, `validate_evidence`.
exact 본인 업무만 반환한다. PIN/객실·고객 PII/사진 원본/다른 메이드/private grant UUID/
session/digest/raw snapshot은 반환하지 않는다. 정상 eligible 세션의 유효 업무가 없으면 빈 목록이다.
서버 기술 상한1,000과1,001번째 sentinel로 잘림을 검사하며 초과 시 부분 권한 목록 대신 안전한 오류를 반환한다.
일반 업무 권한이나 다음 mutation 성공을 보장하는 목록이 아니다. 응답·오류는 `Cache-Control: no-store`다.

기존 단건 조회·제한 완료의 공개 DTO는 호환 유지한다. Fastify 누락 등록과 Edge·OpenAPI·생성 client를 맞춘다.
제출은 서버가 검증한 session을 DB RPC까지 전달하며 session 없는 limited fallback을 허용하지 않는다.
사진 accepted receipt 수렴도 session-bound RPC로 처리한다. 일반 active 호출의 공개 요청 DTO는 유지한다.
이 receipt 경로는 finalize 응답 유실의 내부 accepted 수렴에 한정한다. 기존 공개
`GET /v1/photo-uploads/{operationId}` 상태 조회는 현재 `upload_evidence` 권한을 계속 요구한다.
pending/미수락 상태를 historical receipt 경로로 열거나 사진 원본 열람 권한을 추가하지 않는다.

## Migration·운영 경계

100개 기존 migration은 수정하지 않는다. 후속 append에서 private RLS/최소 grant·immutable eligibility와
좁은 service-only RPC를 구현한다. public base table 권한·일반 RLS를 폭넓게 열지 않는다.
운영 read-only aggregate(2026-10-03)는85 migrations/head `flat_cleaning_evidence_history_payroll`,
limited profile0/live limited grant0이었다. 실제 배포 직전에는 다시 확인해야 한다.
당시 기존 세션 자격이 없는 live legacy grant가 있으면 현재 세션을 추측 연결하거나 유예를 연장하지 않는다.
그 경우 별도 fail-closed cutover/관리자 인계 판단이 선행된다.
이 확인은 실제 운영 백업·DB 연결·deployment verification의 대체가 아니다.

이번 작업에서 main/release/운영·recovery DB/Edge/Auth 설정/키/PIN/송금/provider/Cron/프런트는 변경하지 않는다.
DB/API는 릴리스 순서와 상호 호환을 별도로 검증하고 기존 원장·사진·receipt는 삭제하거나 재작성하지 않는다.

## 프런트 인계와 검증 gate

프런트 main `d509b44`/dev `09ed284`의 scoped B04 요구사항에 한정한다. 이번 작업에서 원격 두 ref와
DOCS/28 B04를 읽기 전용으로 재확인했다. 전역 제품 snapshot은 유지한다.
token을 보존한 재진입은 discovery로 허용 업무만 표시한다. 최초 freeze에 포함된 여러 기기는
각자의 기존 유효 세션으로 접근할 수 있다. 로그아웃·token 삭제·최초 freeze에 없던 새 기기/새 로그인에서는
관리자 인계·재배정 안내가 필요하며 `/v1/auth/me` 오류를 일반 active 복원으로 처리하지 않는다.
프런트 source 변경과 실제 cold start/refresh/재진입 UAT는 프런트 담당자의 별도 작업이다.

구현 전 `npm test`: PASS, 1,229 tests/65 files. 신규 #329 기능의 검증 PASS가 아니다.

### 2026-10-04 재개 checkpoint — 로컬 기능 검증·독립 소스 QA 완료

사용자의 후속 진행 요청에 따라 새 repair cycle에서 기존 회귀2건을 보완했다.
101 canonical LF SHA는 `dadd5abddedb74e9e66f20f1b970e53d3398ddabf0764b926a713aeee6e8b603`다.
기존100 migration과 고정 release manifest는 수정하지 않았다. 미적용 feature 후보101만
좁게 보완하고 dev manifest를 재생성했다. 아래 f26 checkpoint의 실패 이력은 보존한다.

- Edge는 승인된3개 method/path exact set과 비승인 변형12개를 검사한다. 기존 권한·TTL·CAS·감사 검사는 유지했다.
- 기존 session helper는 STABLE/statement snapshot을 유지한다. private STABLE at-clock core와
  explicit SELECT를 실행하는 VOLATILE fresh helper를 분리했다. private helper3개는 runtime EXECUTE가 없다.
- 기존 public STABLE 조회6개의 signature·body·속성은 보존했다. 기존 VOLATILE caller15개는
  fresh helper로 연결하고 신규3개를 포함한 최종 direct fresh18개를 정확히 검사한다.
  known signature·호출 횟수·속성이 다르거나 호출이 누락되면 migration 적용이 실패한다.
- 단건 조회는 요청 snapshot이며 이후 mutation의 권한을 보장하지 않는다. 명령의 잠금·writer 전후
  fresh 검사와 2h/24h TTL rollback은 별도로 검증한다. 기존 모든 RPC의 post-lock gap을 해결했다는 뜻은 아니다.
- upgrade는 기존 catalog의 OID/owner/ACL/volatility/search_path/type를 보존한다. 이전 s→v 허용 예외를 제거했다.

| 검증 | 현재 실제 결과 |
|---|---|
| Node·OpenAPI | `npm run ci:quality`: PASS, 1,275 tests/66 files·138 paths/149 operations |
| Edge 전체 | `npm run edge:check`: PASS, format100·typecheck·477 tests·bundle17,552,393 bytes |
| Python | offline3.12 Ruff·226 format files·mypy25·pytest95·실제 임시 codegen·build source check: PASS; 기존 binary/handover 생성기 경고 유지 |
| Manifest·원본 보존 | manifest5개 PASS; LF gate 사본101 canonical SHA 및 원본291 file hashes 동일 확인 |
| Fresh·핵심 SQL | LF 임시본 fresh101 PASS, 핵심4 files/307 assertions PASS; same-statement 실제 Auth expiry·역할별 private helper 실행 거부 포함 |
| Strict DB lint | FAIL, 기존 #363의17 warnings/10 functions 유지·#329 신규0; 기준 완화나 정상 완료 승격 없음 |
| Advisor | local all WARN/ERROR0, INFO342(미인덱스 FK82·unused index157·RLS/no-policy103); #329 관련 INFO4(의도적인 private deny-policy3·unused index1), 누락 FK index 항목0 |
| 합성 복구 | `npm run backup:dry-run`: local-synthetic101/121 rooms PASS; dirty 후보 artifact이므로 최종 exact-committed-head 또는 운영 백업 증거가 아님 |
| 전체 SQL | 첫79 files/4,728 assertions 실행은 기존 예약 이동 fixture63/109에서 non-zero3·FAIL(assertion FAIL0). 동일 소스 단독109 PASS 후 전체79 files/4,774 assertions 재실행 PASS; 최초 실패 원인은 미확정으로 보존 |
| Upgrade·KST·동시성 | LF 사본에서 `npm run db:test`의 기존26+신규1 upgrade 및 전체 SQL PASS; `db:test:long-stay-clock` 145 assertions PASS; `db:test:concurrency` 기존6+신규1 script 모두 PASS |
| 추가 실제 권한 검사 | 신규 submission/accepted-receipt RPC2의 anon/authenticated 직접 EXECUTE 거부4건을 별도 임시 SQL로 실행: PASS. 기존79파일 suite와 분리한 local smoke이며 원본 회귀 파일을 수정하지 않음 |
| 독립 소스 QA | 최종 migration SHA·21 baseline signature·snapshot6/fresh18/core2·private ACL·upgrade29/신규13·Edge exact allowlist 및 실질 변경50파일/Issue 범위 검토: 새 확정 P0/P1/P2=0. 검토자는 DB·테스트를 실행하지 않았고 실제 실행 결과는 root 검증과 구분 |
| 최종 정리·품질 재검사 | LF fresh101 재복구 PASS: profiles/Auth users/sessions/roots/bindings=0·rooms121; 원본291 hashes 동일. 문서 갱신 후 `npm run ci:quality` 재실행 PASS(Node1275/66·기존 biome INFO5 유지) |

기존 upgrade harness는 import.meta.url 기준 원본을 참조하고 raw SQL을 복사하므로 cwd만 바꾸지 않았다.
승인된 `.tmp/329-lf-gates-*`에 동일 JS 로직·필수 fixture·manifest/config 사본을 준비해
사본 script에서 직렬 실행한다. SQL만 canonical LF이며 원본 파일의 hash 보존을 대조한다.
로컬 Advisor INFO는 WARN/ERROR0과 구분한다. private 테이블의 deny-by-default를 해제하거나
검사를 통과시키기 위해 broad RLS/grant를 추가하지 않는다.

위 결과는 새 SHA의 로컬 기능·경합 검증과 미커밋 소스의 독립 QA 결과다. required CI·dev 통합·
운영 배포·프런트 변경·UAT는 아직 완료하지 않았다. 사용자는 이번 #329에 별도로,
나머지 기능 검증·독립 QA 통과 후 기존 strict17 FAIL을 명시한 진단용 commit·push·Draft PR을 승인했다.
이는 #331/#352의 승인을 재사용한 것이 아니며 병합·운영 배포 승인은 포함하지 않는다.
이 절은 진단용 커밋 전의 검증 checkpoint다. 승인된 commit·push·Draft PR으로 exact-head CI를
확인하며 기존 strict17 FAIL을 숨기지 않는다. 병합·배포·Issue 종료는 포함하지 않는다.
GitHub #329 댓글 게시 승인은 별도 대기한다. 임시 LF 사본·권한 smoke·합성 복구 artifact·로그는 커밋하지 않는다.

### 과거 2026-10-03~04 KST f26 checkpoint — 당시 품질 gate FAIL

후속101 canonical LF SHA는 `f26b6c4494a531abd49eb11d01577b9e6827d213abfd6f84d5e41f6ce9d40bd7`다.
Windows 원본 CRLF로 기존93 적용이 실패한 이력은 보존한다. 사용자 승인에 따라 `.tmp/`에 만든
LF 검증본의 모든101 canonical SHA를 manifest와 대조했다. 기존100 SQL은 수정하지 않았으며
LF 임시본의 PASS를 원본 Windows checkout에서 `npm run db:verify`가 PASS한 것처럼 표현하지 않는다.

| 검증 | 실제 실행·결과 |
|---|---|
| Node 전체 품질 | `npm run ci:quality`: PASS, 1,275 tests/66 files; typecheck·build·secret scan·lint 포함(기존 INFO5 유지) |
| OpenAPI·Python client | 138 paths/149 operations source check 및 실제 임시 codegen: PASS; 제한 업무3개 API(신규 목록·기존 단건/완료)와 신규2개 DTO 필수 필드 확인 |
| Python | offline Python3.12 Ruff·226 format files·mypy25·pytest95·build source check: PASS |
| Manifest | `npm run db:manifest:verify`: 고정 manifest5개 PASS, 개발101 |
| Fresh DB | LF 임시본의 local reset101: PASS; 핵심4 SQL files/282 assertions PASS |
| 전체 SQL | 같은 LF 임시본의 전체79 files/4,749 assertions: PASS; 실제 anon/authenticated/service_role DML·권한·세션·소유권 검사 포함 |
| Upgrade | `node scripts/test-limited-existing-session-upgrade.mjs`: 실제100→101 PASS·fresh101 복원 PASS; 기존 Auth/업무 전체 행·receipt·ACL/RLS/catalog 보존, legacy no-backfill |
| 시간 경계 | `npm run db:test:long-stay-clock`: 5 scenarios/145 assertions PASS |
| 신규 동시성 | `node scripts/test-limited-existing-session-concurrency.mjs`: PASS; 늦은 세션 commit 제외·finish 상속·철회·post-lock session expiry·사진/제출 경합·동일 제출 수렴·writer 대기2h/24h TTL rollback |
| Edge | `npm run edge:check`: FAIL, format100/typecheck PASS·475 tests PASS/1 FAIL; bundle NOT RUN |
| Strict DB lint | `db lint --local --level warning --fail-on warning`: FAIL, 기존17/10 functions + 신규6/6 functions =23/16 functions |

codegen은 기존 binary photo upload/content 및 handover oneOf 생성기 경고를 그대로 출력했다.
신규 JSON 계약 검증 PASS이며 전체149 operations의 Python 생성 완료를 선언하지 않는다.
SQL targeted 초기 실패(source anchor·잘못된 legacy fixture·최종 guard replacement 누락)는 실제로
보완한 뒤 위 SHA에서 PASS했다. 검사를 삭제하거나 권한·TTL 기준을 낮추지 않았다.

### 다음 보완과 미완료 gate

1. Edge 기존 lifecycle regression이 limited path2개만 기대한다. 현재 승인된 discovery를 포함한
   정확한3개 method/path allowlist를 검증하도록 보완해야 한다: `GET /v1/limited/attempts`,
   `GET /v1/limited/attempts/{attemptId}`, `POST /v1/limited/attempts/{attemptId}/complete-field-work`.
   단순 기대 개수 완화로 끝내지 않는다.
2. fresh-clock helper를 VOLATILE로 변경하면서 기존 STABLE 조회6곳에 신규 경고가 발생했다:
   `get_limited_cleaning_attempt`, `get_cleaning_attempt_lifecycle_impact`,
   `get_offline_event_quarantine`, `list_offline_event_quarantine`,
   `list_checkout_cleaning_templates`, `list_room_type_catalog`.
   기존17 경고는 #363이고 신규6은 #329의 미해결 회귀로 별도 추적한다. blanket waiver를 적용하지 않는다.
   작성자의 후속 정적 권고는 기존 snapshot helper와 fresh post-lock helper를 분리하는 방향이다.
   이는 후속 설계·독립 검토 대상이지 확정·구현 완료가 아니다. 6개 속성 일괄 변경은 직접 RPC의
   GET/HEAD 호환성까지 바꿀 수 있으므로 lint만 없애는 변경으로 취급하지 않는다.
   [PostgreSQL snapshot 계약](https://www.postgresql.org/docs/17/xfunc-volatility.html),
   [PostgREST volatility/HTTP 계약](https://docs.postgrest.org/en/v12/references/api/options.html).
3. 기존26개 upgrade의101 재실행·전체6개 기존 concurrency chain·합성 backup·Advisor:
   이번101 후보에서 NOT RUN. 이전 v0.8.0의 검증을 이 후보의 PASS로 승격하지 않는다.
4. exact committed-head 독립 QA·required application/migration CI·dev 통합: 미완료.
   QA 보완 반복 상한 후 추가 구현을 멈췄으며 정상 완료 commit·push·PR은 생성하지 않았다.
   #331/#352의 별도 진단용 commit 승인을 #329에 재사용하지 않는다.
5. 운영 승격·프런트 source 변경·cold start/refresh E2E·사용자 UAT: NOT RUN, 이번 feature 범위 제외.

실제 #329 품질 gate가 FAIL이므로 정책·핵심 SQL PASS만으로 issue 종료나 병합·배포하지 않는다.

독립 읽기 전용 checkpoint 리뷰(2026-10-04)는 위 SHA와 실제 guard replacement·DTO coercion 보완·
accepted receipt/일반 GET guard 차이·결과 기록을 재확인했다. 검토 범위에서 새로운 확정 P0/P1은
발견하지 않았으나 위 미해결2건을 P2로 유지했다. 리뷰어는 실제 테스트/DB를 실행하지 않았으며
미커밋 source의 중간 검토다. exact committed-head 최종 QA 승인이나 품질 gate PASS가 아니다.

GitHub #329 checkpoint 댓글 게시 시도는 내부 구현·검증 기록의 외부 공유에 대한 구체 승인이
부족하다는 자동 안전 검토로 차단됐다. 댓글은 게시되지 않았고 `.tmp/329-issue-checkpoint-draft.md`에
로컬 초안을 보존했다. 비밀정보·실제 사용자 데이터는 없지만 검증 수치·migration SHA·미해결 항목을
외부 저장소에 기록하는 승인을 확인하기 전 다른 경로로 우회 게시하지 않는다.

Refs: [#329](https://github.com/wrongstory/room-management-system-backend/issues/329),
[#352](https://github.com/wrongstory/room-management-system-backend/issues/352),
[#364](https://github.com/wrongstory/room-management-system-backend/issues/364).
