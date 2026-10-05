# #330 촛불 공동 관리: 프런트 연동과 검증

상태: 백엔드 source 후보. 운영 DB/API 및 프런트 변경은 이번 작업에 포함하지 않는다.

## 2026-10-05 최신 dev 통합 — 검증 진행 중

최신 실행 결과: Node1,826/80·Edge490·Python95/전체codegen·manifest108·fresh108·전체27 upgrade/
SQL86파일5,266개·static upgrade·KST145·전체10경합/cleanup·최종fresh108/exact9 baseline PASS다.
원본489 hash drift0이며 기존dev106 SQL과 사용자 EOL4파일을 보존했다. raw strict FAIL9/exit1은 유지한다.
독립 소스 QA102건 PASS 뒤 최종 staged QA·새 exact-head CI·PR337 보호 병합은 후속이다.
전체 SQL 로그 SHA256: `fcdcc2086fffb28c15b6cf1346a9552652464d849a771b4f7f1c80f3dfe92141`.
전체 경합 로그 SHA256: `525c5356c41c32f24cd6f1fec111a4589dca26dba35cbbd41413a7b386e0be31`.
아래 진행 중 표기는 각 실행 당시 이력이다. 운영/실제 백업/프런트 UAT 완료는 아니다.

#318은 source25cfb80의 required CI37303164280 두 항목과 독립 QA 통과 후 PR321로
dev `cf22727248e991034d1cca21eb74386bb7254284`에 병합됐다. #330의 로컬 `8860189`에
이 dev를 정상 통합한 새 후보는 migration108개, source OpenAPI139 paths/150 operations다.
head/previous는 `room_candle_session_hard_expiry`/`shared_room_candle_adjustment`이며 원 SQL은 보존한다.
제한 세션·사진 저장명·촛불 경합을 모두 유지한 전체10개 경합 명령과 최신 generated client 검사를 유지한다.
이 후보의 Node1,823/79·typecheck/build/품질, Edge490/bundle, manifest108, 실제 LF fresh108과
촛불·세션 만료·날짜 조회·개발자 진단 SQL5파일176개는 PASS다. 최초 Node6건과 Edge1건의
이전 API 개수/진단 head 기대 실패를 실제139/150 및 최신 head로 정합화한 뒤 재실행했다.
기존dev106 name→SHA drift0을 확인했다. 전체 SQL86파일5,266개 및 생성 TS client의6순열/
잘못된 입력 거부도 실제 PASS다. 후속 전체27 upgrade와 SQL86파일5,266개 재실행도 PASS다.
10경합·최종 독립 QA·exact-head CI는 후속이다.

### 후속 검증 진행

Python은 Windows hardlink 설치 오류 후 `UV_LINK_MODE=copy`로 복구해 ruff/format/mypy·pytest95·
전체 client 생성·package source 검사를 통과했다. 독립 소스 QA7파일102개 PASS·신규 P0/P1/P2 없음이다.
전체27 upgrade는 별도 LF 임시본에서 실제 exit0로 완료했고, 마지막 전체 SQL도86파일5,266개 PASS다.
앞선 사진 runner가 fresh cleanup한 뒤 촛불 standalone가 실행되는 순서를 위해 CLI 분기에만
로컬 endpoint/환경 override/project/정확한 fresh manifest 검증, 합성 developer 준비,
성공·실패 모두의 finally reset 및 fresh 재확인을 추가했다. aggregate import/실제 경합은 그대로다.
이 보완의 source 회귀와 실제 standalone CAS/replay/정지/철회/room·Auth lock hard-expiry 및
fresh108 cleanup은 PASS다. 원본489 hash drift0과 승인 exact9/catalog3 baseline PASS도 확인했다.
raw strict FAIL9/exit1은 유지한다. 정적 upgrade·KST·전체10경합·최종fresh/baseline을 순차 실행 중이며
전체 경합 및 최종QA/CI 완료를 주장하지 않는다.
아래104개 checkpoint의 PASS를 새108개 후보의 PASS로 사용하지 않는다. 운영·프런트는 변경하지 않았다.

## 2026-10-05 전용 DB·경합 검증 완료 — bb4 기반104 checkpoint

아래의 기존 bb4 통합 후보에서 실제 LF fresh104와 촛불/세션 만료 pgTAP2파일·70개가 PASS다.
기존 runner를 변경하지 않고, 빈 로컬 DB에 합성 developer bootstrap만 준비한 뒤 실행했다.
동시 증가/감소/초기화 CAS, 동일 key replay/다른 hash 거부, 계정 정지, 세션 철회,
객실/Auth row 잠금 대기 중 실제 hard-expiry 거부와 전체 원장 불변 경합이 모두 PASS다.
실패 여부와 무관하게 실행하는 마지막 fresh104 cleanup도 실제 exit0로 완료했다.

- `npm run ci:quality`: PASS, 1,466개/70파일 및 typecheck/build/lint/secret/OpenAPI.
- `npm run edge:check`: PASS,477개와 bundle17,542,122 bytes.
- `npm run db:manifest:verify`, 전용 `db:verify`, 두 pgTAP 파일과 실제 candle runner: PASS.
- `npm run db:lint:baseline`: PASS, 승인된 exact9/catalog3. 원 strict lint FAIL9/exit1은 유지한다.
- 최종 history104/head `room_candle_session_hard_expiry`, 객실121, profile/Auth user/session0,
  RLS누락0, 원본468개 raw hash drift0을 확인했다. 원본 SQL·검증 기준은 변경하지 않았다.
- 전체 upgrade/SQL aggregate와 최신 #329/#318·사진·템플릿 통합 검증, 새 독립 QA/CI/PR337
  보호 병합은 별도 후속이다. 위 전용 검사를 최신 dev 전체 PASS 또는 운영 완료로 표시하지 않는다.

후속 독립 소스 QA는 tree `78463d1a6de01f5dc0aa3ab418b8ab267da27098`에서 신규 P0/P1/P2 없음,
no-cache 소스 회귀26/26·runner 문법·diff 검사 PASS를 확인했다. root의 SQL70·경합 로그 SHA도
대조했으나 reviewer가 DB를 재실행한 것은 아니다. root `ci:quality` 재실행도1,466/70 PASS다.
이 판정은 위 bb4 checkpoint 범위이며 최신 dev 통합·전체 SQL·새 CI는 여전히 후속이다.

로그는 `.tmp/qa330-owned-*`에 보관하며 Git에는 넣지 않는다. SQL 로그 SHA256은
`596c1bbdefc66c53977b3bc280dd937a6bcb627b2f7c9a05a4e2500d1199316c`,
경합 로그 SHA256은 `f318f43b42b78584e9d18d37604b9bc2f2a36acfb7a659b18d4d1f2d746d3923`이다.

## 기존 통합 준비와 계약

2026-10-05 최신 dev 통합 준비는 기존 PR #337/source `95033682`와 `dev@bb4fa40` 정상 merge 기준이다.
원본 `20260930135538_shared_room_candle_adjustment.sql`은 미적용 확인 후 CLI가 생성한
`20261005011849_shared_room_candle_adjustment.sql`로 byte 그대로 이동했다. LF SHA
`0f2d86b199831e446a5a3d06a78caeca7ccad21b62223395224de94087734579`를 보존하며,
아래 기존85+1/86개 설명은 최초 후보 checkpoint다. hard-expiry 보완을 포함한 현재 후보 manifest는104개, source OpenAPI
목표138 paths/149 operations이고 최신 head는 `room_candle_session_hard_expiry`, previous는 `shared_room_candle_adjustment`다.
#383/#382/#329/#318 후속 dev 재통합·fresh/전체 DB·독립 QA·새 exact-head CI는 root 후속 gate다.
기존 CI의 application ECR rate-limit 실패를 새 통합 PASS로 재사용하지 않는다.
원본 strict FAIL9와 #373 exact9 비교 gate를 구분한다. 실제 백업/복원은 모든 개발 뒤,
운영 배포 전에 필수이며 현재 source/dev·운영·프런트 UAT 완료가 아니다.
제품 근거: 사용자의 “다른 메이드랑 관리자도 가능”, “촛불 수량 조정은 아무나” 결정. 여기서 누구나는 비밀번호 변경을 마친 활성 관리자·메이드이며 익명·개발자·비활성·퇴사·제한 계정은 제외한다.

## HTTP 계약

두 endpoint 모두 Bearer 인증을 사용하고 성공 응답은 `Cache-Control: no-store`다. actor/session은 서버가 검증한 token에서 추출하며 클라이언트가 지정하지 않는다.

- `GET /v1/rooms/candles`: `{items:[{roomId,roomNumber,count,roomStateVersion}],nextCursor}`. 기본/최대 `limit=50`, 1~50의 canonical decimal 문자열만 허용한다. `cursor`는 응답의 UUID를 그대로 넘긴다. UUID 오름차순이며 마지막 page는 `nextCursor:null`이다.
- `?roomId=<uuid>`는 정확한 객실 한 곳만 조회하며 없는 ID는 빈 items다. `roomId`와 `cursor`를 함께 보내지 않는다. PIN·예약자·작업·사진·전체 객실 상태·event actor를 포함하지 않는다.
- `POST /v1/rooms/{roomId}/candles`: 기존 경로와 요청을 유지한다. `Idempotency-Key` 필수. JSON은 `{expectedRoomVersion:7,reasonCode:"CANDLE_ADJUSTED",count:0,physicallyVerified:true}` 형태다. 예시 version은 실제 조회값으로 교체한다. count는 0~2147483647 정수, version은 1 이상의 안전한 정수다.
- 감소/0 초기화 시 실제 회수한 처리자가 `physicallyVerified:true`를 보낸다. 이는 현장 회수 확인이며 별도 관리자 승인이나 PIN 물리 확인이 아니다. false/생략 상태에서 감소하면 400 `VALIDATION_ERROR`다. 증가에는 확인이 필요 없다.
- 성공은 기존 `{operation:{entityId,roomId,roomStateVersion,recordedAt}}` 응답이다. 최신 수량은 최소 조회로 갱신한다. 일반 객실 상세는 여전히 관리자 전용이며 메이드가 이 응답 대신 조회하면 안 된다.
- 409 `STALE_VERSION`: 최신 수량·version 재조회 후 사용자가 의도한 수량을 다시 확인하고 새 key로 요청한다. 동일 요청의 네트워크 재시도는 같은 key/body를 사용한다. 같은 key를 다른 수량에 재사용하면 409 `IDEMPOTENCY_KEY_REUSED`다.
- 인증/세션 및 권한 오류는 401/403, 잘못된 입력은 400, 변경 대상 부재는 404다. message 문자열이 아닌 안정적인 error code로 분기한다.

## 보존·보안 경계

배정자·원 수행자·제출/승인 상태·최근 7일 제한을 검사하지 않는다. 승인 후 다른 메이드도 처리할 수 있다. DB는 매 요청 최신 profile role/status/password 상태와 해당 사용자의 유효한 session을 확인하며, 완료 receipt 재시도도 폐기/만료 세션으로 허용하지 않는다.

현재 수량 0은 `CANDLE_PRESENT`만 없앤다. 별도 운영 차단·이슈·점유·청소 의무가 남으면 여전히 배정 불가일 수 있다. 제출/사진/검수 결정/수익/지급 snapshot을 변경하거나 청소 승인을 취소하지 않는다. 제출·승인 이후 새 특이사항 신고는 사용자 결정대로 별도 #336에서 추가하며, 신고 주체와 독립 사건·증빙의 세부 범위 확인은 #330에 포함하지 않는다. 범용 객실 변경 RPC와 일반 상세/PIN 권한은 확대하지 않는다.

## DB와 배포

최초 후보는 `20260930135538_shared_room_candle_adjustment.sql` 한 건을 추가했다. 이 원본을 CLI 생성 시각 `20261005011849`로 이동했으며 내용과 기존 데이터·RLS·원장 UPDATE/DELETE 금지·FK index를 보존한다. 전용 service-role RPC 2개와 비공개 guard/trigger를 추가하며 anon/authenticated 직접 실행은 금지한다. 기록 시각은 room lock 후 기존 최댓값보다 뒤로 정하여 동시/동일 transaction의 최신 수량을 보장한다. 과거 시각을 덮어쓰거나 backfill하지 않는다. 아래 hard-expiry 보완은 별도 후속 append 후보다.

### #391 미적용 source 시각 정합화

root가 두 hosted 프로젝트를 새로 읽기 전용 검사했다. 운영 history85/head `flat_cleaning_evidence_history_payroll`, recovery73/head `generated_room_pin_confirmation`이며 기존 촛불 두 이름/시각과 actor/read/write 함수는 모두 미적용이었다. Auth hard-expiry와 #329 strict installer는 촛불 함수 존재·시각에 의존하지 않는다. 원본이 역사86에 끼어드는 대신 기존 exact96~101/before100 검증 구간 이후에 위치하도록 pinned CLI 2.115.0의 `migration new`가 생성한 두 경로로 이동했다.

- `20260930135538_shared_room_candle_adjustment.sql` → `20261005011849_shared_room_candle_adjustment.sql`: raw SHA256 `69fcf42af7de71a80ed69db132b4a434e8221c2a1da2701b55a3e0b615aeeab6`, 위 canonical LF SHA 그대로.
- `20261005003056_room_candle_session_hard_expiry.sql` → `20261005011912_room_candle_session_hard_expiry.sql`: raw/LF SHA256 `ab46f199a5b6e38a21c8c685d29487cd162cb071df17357fbc82f03dbb7d13e6` 그대로.

CLI 생성 empty placeholder만 정확한 원본으로 교체했으며 SQL/strict caller count/역사 upgrade assertion은 수정하지 않았다. source test URL·공식 manifest·진단 current/previous만 정합화한다. 실제 최신 DB/upgrade/촛불 경합·독립 QA·새 CI는 후속이며 remote history repair/DDL/업무 데이터 변경은 실행하지 않았다.

릴리스 승인 후 순서는 DB migration → API → 프런트 연동이다. 환경 변수·비밀키·PIN 변경은 없다. rollback은 직전 API bundle을 복원하고 새 DB 함수/이력은 보존한다. 이때 새 메이드 촛불 UI를 비활성화해야 하며 관리자 기존 경로는 호환된다. 기능 branch에서 운영 migration 또는 배포를 실행하지 않는다.

## 재현 가능한 로컬 검증

Docker 엔진은 AGENTS의 Safe Start 규칙을 따른다. 명령은 저장소 루트에서 실행한다.

1. `npm run db:reset` → 전체 migration과 seed 재적용.
2. `npm run db:manifest:verify`, `npm run db:test` → upgrade 및 전체 rollback-only pgTAP.
3. `npm run db:test:concurrency` → 기존 전체 경쟁 검증과 촛불 CAS/멱등/계정·세션 경합 포함. synthetic 행을 남기므로 SQL 회귀보다 뒤에 실행한다.
4. `npm run db:verify`로 초기화한 정확한 fresh 로컬 DB에서 `npm run db:test:candles`를 단독 실행한다. CLI가 환경·프로젝트·manifest·빈 fixture를 확인한 뒤 합성 developer를 준비하고 성공/실패 모두 finally reset과 fresh 재확인을 수행한다. 기존 fixture가 남은 DB는 거부한다. 함수를 import하는 aggregate runner만 자신의 fixture와 cleanup을 소유한다.
5. `npm run ci:quality`, `npm run edge:check`, backend-console의 `uv run python scripts/check_business_openapi_codegen.py`.

새 pgTAP은 다른 메이드 감소·초기화, 감소 확인, 다른 차단 보존, 과거 관리자 receipt 호환, live session/role, 실제 DB 역할별 RPC·DML 거부를 검증한다. 기존 승인 제출 fixture에서도 제3 메이드 조정 후 제출/사진 연결/검수/수익 보존을 확인한다. 운영 실사용 성공으로 확대 해석하지 않는다.

### 2026-10-05 최신 dev 통합 준비 local checkpoint

- `npm ci`: PASS, 0 vulnerabilities. 충돌 전 clean baseline은 package/manifest 충돌로 BLOCKED였다.
- `npm run ci:quality`: 첫 검사1452 PASS/4 FAIL은 자동 병합된 기존137/148 inventory 기대값과 새 촛불 GET의138/149 사이 차이였다. exact 기대값만 갱신한 두 번째 검사는1456 tests/69 files·typecheck·build PASS다. 고정된 Swagger 릴리스 workflow의137/148 계약은 수정하지 않았다.
- `npm run edge:check`: fmt99·477 tests/0 FAIL 및 pinned bundle17,542,136 bytes PASS. 원본 SQL·권한/RPC/runtime 동작을 새로 수정한 결과가 아니다.
- Python: Ruff check/format226·mypy25·pytest95·전체 OpenAPI 임시 codegen·build check-only PASS. 기존 binary 사진 endpoint/response와 lifecycle duplicate-model codegen 경고를 보존했으며 모든149개 Python 동작 생성 완료라는 뜻은 아니다.
- TypeScript: pinned `openapi-typescript@7.13.0` 임시 생성본과 strict consumer의 최소4필드·nullable cursor·필수 version·금지 actor/PIN 및 수량 타입 검사 PASS. `--default-non-nullable false`를 사용해 OpenAPI의 선택 `physicallyVerified`를 그대로 보존한다. 도구 기본값은 default가 있는 선택 필드를 필수 타입으로 생성하므로 프런트 담당자가 재생성 설정을 확인한다. 초기 tsc CLI/config 및 기본 생성 옵션 실패 로그도 보존했다.
- manifest 정식 생성·검증 및 `git diff --check`: PASS. 로컬 안전한 `.tmp/issue330-*.log`는 진단 파일이며 Git에 포함하지 않는다.

이 checkpoint는 #383/#382/#329/#318 최신 dev 재통합, 전체 실제 DB/동시성·strict/exact9 gate,
독립 QA·새 exact-head CI·보호된 dev 병합·릴리스/운영·프런트 UAT를 대체하지 않는다.

### #330 P1 잠금 대기 중 세션 hard-expiry 보완 후보

독립 source QA는 최초 guard 이후 `rooms FOR UPDATE`에서 대기하는 동안 `auth.sessions.not_after`가
지나도 촛불·CAS·감사·receipt를 기록할 수 있음을 발견했다. SHARE lock은 행의 UPDATE/DELETE를
막지만 시간 경과를 막지 않는다. 기존 Auth query의 WHERE 시각 검사만으로 실제 SHARE 획득 뒤의
만료 여부도 증명하지 못한다. 이는 아직 실제 운영 재현을 확인했다는 뜻이 아니다.

CLI로 만든 후 byte 그대로 이동한 `20261005011912_room_candle_session_hard_expiry.sql`은 원 SQL을 수정하지 않는다.
원 guard/RPC 전체 LF `prosrc` MD5, 정확한 replacement/호출 수, 고정 owner·ACL·VOLATILE·definer·
search_path·반환형 등 선행 조건이 다르면 55000의 고정 코드로 전체 DO statement를 실패시킨다.
`pg_get_functiondef`의 CREATE OR REPLACE를 사용하고 `prosrc`를 제외한 전체 `pg_proc` row를
전후 비교하여 OID·owner·ACL·함수 속성을 보존한다. 첫 함수 뒤 두 번째 precondition이 실패해도
같은 statement의 DDL은 rollback되며 성공으로 숨기지 않는다.

- guard는 exact user/session의 `not_after`를 SELECT INTO/FOR SHARE로 가져온 뒤 현재 DB clock으로 검사한다.
- 변경 RPC는 기존 receipt→actor/session→room 순서와 CAS/namespace/hash/receipt replay를 유지한다.
  객실 잠금 직후/CAS 전에 다시 guard를 호출하고 최종 `complete_command` 직전에도 재검사한다.
  마지막 거부는 이미 생성한 촛불·감사·객실 version과 해당 command의 변경을 함께 rollback한다.
- 수량·감소/초기화·처리자 회수 확인·공동 조정 권한·다른 차단·과거 승인 자료는 변경하지 않는다.
  #336 승인 이후 신고의 확정 가능 여부와 별도 신고 주체/사건/증빙 확인 항목은 섞지 않는다.

새 pgTAP은 NULL/미래 deadline 정상·같은 receipt 재생, 과거 deadline의 read/new command/replay 거부,
다른 사용자/NULL/누락 session, 함수 catalog/ACL을 검사한다. 합성 command 하나의 audit INSERT 이후에만
rollback-only 지연 trigger로 실제 DB 시간을 흘려 최종 guard가 event/audit/CAS/receipt를 모두
rollback하는지 검사한다. Auth row를 trigger로 변조하거나 runtime clock/TTL을 완화하지 않는다.
기존 candle 경합 runner에는 객실 row와 Auth session row를 각각 version/내용 변경 없이 잠그는
두 시나리오를 추가했다. 실제 holder/contender PID와 `pg_blocking_pids`를 확인하고 동일 잠금이
유지된 상태에서 live→expired DB deadline을 관찰한 뒤에만 release한다. 거부 후 수량·version·
event/audit/receipt 개수 및 전체 row digest를 비교한다. 합성 session의 12초 deadline은 실제 제품 TTL
또는 Auth 설정이 아니며, 대기 중 연장·재시도·skip은 없다. 프로세스/SQL/관찰 timeout은 유한하며
오류는 고정 allowlist 코드만 반환하고 native stderr는 출력하지 않는다.

현재 source 검사: `node --check scripts/test-room-candle-concurrency.mjs`와 focused Vitest
2파일/26검사, `npm run typecheck`, `npm run build`, `git diff --check`는 PASS다.
추가 두 파일 Biome 검사는 첫 import 순서 오류1개/문자열 placeholder 경고1개를 의미 변경 없이
보완한 뒤 PASS했으며 focused26/typecheck/build도 재실행 PASS했다.
첫 `npm test`는 1,465 PASS/1 FAIL(70파일): 새 append가 아직 정식 manifest에 추가되지 않아
`tests/edge-runtime.test.ts:259`에서 manifest103과 실제 source104가 불일치했다. 기대값을 낮추거나
manifest를 수동 수정하지 않았다. 이 최초 실패 checkpoint 이후 정식 생성·검증으로104개를
확정하고 `npm run ci:quality`를 재실행해70파일/1,466 tests·typecheck·build PASS를 확인했다.
로그 SHA256은 `ea1452e28161e5a6832cedaf415496ec4de24bd020591e743a0ba345ab2b5958`다. source mock은 source
drift·fragment 중복·호출 수·catalog 변화를 실제 DB 없이 검사하는 제한된 모형이다.
미적용 원본의 byte-preserving 이동·manifest104·현재 guard/runner/source 테스트에 대한 별도
독립 source QA는 신규 코드 P0/P1/P2 0건이다. 실제 staged tree·DB·CI 승인이 아니다.
새 migration의 실제 적용/원자 rollback·pgTAP·두 actual 경합은 **NOT RUN**이며
최신 dev 통합·전체 DB gate·새 CI는 root 후속이다.
위 1,456/477/95 PASS는 이 append 이전 checkpoint이며 현재 새 DB 보완의 PASS로 재사용하지 않는다.
