# #318 날짜별 객실 현황 읽기 계약

`GET /v1/rooms?serviceDate=YYYY-MM-DD`와 관리자 단건 읽기는 business admin의 최신 active/password-complete profile·유효 session을 검증한다. 생략/오늘은 LIVE, 과거는 KST 날짜 종료, 미래는 KST 날짜 시작이다. strict 달력 날짜와 단일 query만 허용하며 PIN 원문·고객명·연락처는 제공하지 않는다. 상세 조건 9종은 기존 제품 가이드대로 유지한다.

## 2026-10-05 dev58a 재통합 — 현재 106개 후보

검증된 checkpoint `0781d144a7d8e351846f0d20afe8ddd9e6e8a515` 뒤
`dev@58a58218e20c0f771b7ed979204fdff0c85ff1b5`를 정상 merge했다.
두 문서는 양쪽 사용자 결정과 과거 이력을 보존했고, developer status fixture의 이전 head는
실제 적용 순서대로 `room_board_date_filters`를 유지했다. manifest는 생성기로 106개를 반영했다.
기존 SQL 본문을 수정하지 않고 #329 → #318 설치 순서를 유지한다.

- 새 `ci:quality`: PASS — 1,794개/77파일과 typecheck/build/lint/secret/OpenAPI.
- 새 Edge487/bundle gate 및 관리 도구 ruff/format/mypy/pytest95/codegen/build source: PASS.
- fresh106, exact9 lint baseline, 로컬 합성 백업·복원: PASS.
- 실제 DB 템플릿6순열·동등 요청 replay·4타입·CAS·16malformed·v8 호환: PASS.
- 새 전체27 upgrade와 SQL84파일/5,193개, static-warning upgrade, KST5시각/145개,
  전체9경합 명령과 각 cleanup, 최종fresh106/exact9 baseline까지 실제 exit0 PASS다.
- 최종 읽기 전용 확인: history106/head 일치, 객실121, profile/Auth user/session0,
  public base table RLS누락0, 실제 snapshot7/fresh18/core2 catalog를 확인했다.
  #389의 #318 추가 단계가 실제 검증됐으며 #332 이후7/19 단계는 아직 아니다.
- 독립 소스 QA:155개/7파일·79,992 날짜·secret883 PASS, 신규 P0/P1/P2 없음.
  원본484개 hash drift0이며 원 strict lint FAIL9/exit1과 승인 exact baseline PASS를 구분한다.
- 이전104 후보나 #329 부모의 검증을 새 후보의 완료 결과로 대체하지 않는다.
- 실제 운영 백업·복원, PR321 최신-head CI/보호 병합, 운영/API·v0.9.0 승격은 후속이다.

현재 LF 임시본은 원본484개 해시를 보존하며 `.tmp/qa318-latest-*`에 실제 로그를 남긴다.
로컬 합성 백업 PASS는 실제 Supabase-only B 백업 완료가 아니다.
현재 전체 DB 로그 SHA256은 `84d2c823550ba15173ccb36b7cd0938cf3846234f71693eaee06c31d26875358`,
전체 경합 로그 SHA256은 `6e93dfc942721c232f4ef96b8b71f4e6adcfb7b5fe3d5d562420ac5c1f1d6b33`이다.
프런트 dev09ed284의 DOCS/30 B05·B06도 재확인했다. 날짜 UI는 문서상 활성화됐고 이 API의
연동은 후속이다. [scoped 관찰과 정책 차이](./FRONTEND_CONTRACT_SNAPSHOT.md#2026-10-05-318-연동-문서-재확인)를
전역 snapshot이나 운영 UAT 완료로 해석하지 않는다.

## 2026-10-05 #393 반영 재검증 — 이전 104개 통합 checkpoint

아래 04:54 후보에 `dev` 병합 완료 #393의 fixture/test/doc 3개 파일을 그대로 반영했다.
예약 이동 fixture의 세 평가 경계만 고정하며 109개 assertion과 실제 업무 RPC는 유지한다.
이 checkpoint는 여전히 `dev@bb4fa40` 기반의 104-migration 후보다. 최신 `dev@58a5821`의
#329·#382·사진 저장명과의 통합, 원격 CI, PR #321 보호 병합은 별도 후속 단계다.

- `npm run ci:quality`: PASS — Node 1,464개/71파일, typecheck/build/lint/비밀정보·OpenAPI 검사.
- `npm run edge:check`: PASS — 475개와 bundle size gate.
- 관리 도구 ruff/format/mypy/pytest/codegen/build source: PASS — pytest 95개.
- `npm run db:manifest:verify`: PASS — 동결된 릴리스 목록과 dev 104개.
- LF 임시본 원본 보존 검사: PASS — 원본 467개 hash drift 0. 원본 SQL 줄바꿈은 변경하지 않았다.
- 새 LF 임시본 `db:verify`: PASS. `npm run db:test`: PASS — 전체26 upgrade와
  SQL82파일/4,875개가 실제 exit0로 완료됐다. #393의 예약 이동109개도 포함한다.
- `npm run db:lint:baseline`: PASS — 승인된 기존 경고9개/함수 fingerprint3개와 정확히 일치.
  원 strict lint 자체는 FAIL(exit1)이며, Decision #373의 exact baseline으로만 수용한다.
  경고 목록을 넓히거나 신규 경고를 숨기지 않았다.
- 독립 소스 QA: PASS — 새 P0/P1/P2 지적 없음. 독립 no-cache 테스트 110개/6파일,
  날짜 79,992개 조합, secret scan 858개, 네 exact fragment의 in-memory 치환 검사 통과.
  원본 baseline/102개 prefix와 #393 3파일의 canonical hash 일치도 확인했다.
  이 소스 검토는 DB 설치·실제 RPC 검사나 최신 dev 통합의 승인으로 대체하지 않는다.
- 이 결과는 로컬 통합 checkpoint의 근거다. push·최신 dev 통합·원격 CI·운영 반영은 아직
  하지 않았다. static-warning upgrade/KST/경합/최종fresh 전체 후속 검증은 최신 dev 통합본에서
  별도로 실행하며 이 checkpoint에서 실행했다고 표시하지 않는다.

검증 로그는 `.tmp/qa318-393-*`에 로컬로 보관하며 Git에 포함하지 않는다.
전체 DB 로그 `qa318-393-db-full.log` SHA256은
`7515a097ef022455f7d1b978b723fd508966d3c5e38cd18714c0fc9d7f2b34f0`이다.

## 2026-10-05 04:54 UTC STABLE 요청 시각 보완 — 이전 검사 이력

이전 append의 전체26 업그레이드와 SQL82파일/4,874는 실제 exit0 PASS였다
(`qa318-bb4-reviewed-db-full.log`, SHA256
`8cd4a4352ad6ab3c777c8609a408f26b31279f8dce8e22821811f666066b9e08`).
그 뒤 exact baseline gate는 기존9개와 별개로 board의 STABLE/clock_timestamp 경고1개를
발견해 FAIL했다. 예외 목록·기준은 넓히지 않았고 당시 후속 static/KST/경합/최종fresh는 NOT RUN이다.

04:51 hosted read-only 재확인에서 production85/head20260928095656, recovery73/
head20260919230733 모두 board 두 migration0·RPC없음을 확인했다. 원 baseline SQL
SHA65acd2eb/원 prosrc MD5 7a4ca74a6410734ac72b251a2cf6c418는 보존하고,
**아직 미적용인 이 작업 소유 append**에 네 번째 exact-single fragment만 보완했다.
`v_server_time := clock_timestamp()`를 `statement_timestamp()`로 바꿔 요청 SQL 시작 시각을
사용한다. transaction 시작 시각으로 바꾸거나 VOLATILE로 속성을 바꾸지 않는다.
OID/ACL/owner/security/STABLE·signature guard, 과거/미래 KST 날짜 경계와 원장은 그대로다.
[PostgreSQL17 시각 함수](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)와
[STABLE snapshot 규칙](https://www.postgresql.org/docs/17/xfunc-volatility.html)에 맞춘 보완이다.
새 append의 canonical LF SHA256은
`95926a7344804a9fab778c5773115ff85778be443bf6bfff92f2cb6fd69e338a`이며 정식 manifest104에 반영했다.
기존 append SHA5bc54fff와 그 DB/26-upgrade 증거는 이전 source의 이력으로만 사용한다.

새 LF 검증본 original467/copy467 drift0(SQL199/raw268), fresh104, 20ms 지연 뒤에도
동일 statement start를 확인하는 LIVE51/51와 Node22 narrow/전체quality1,460/70·type/build는 실제 PASS다.
새 source의 exact9 baseline은 PASS이고, 독립 소스 QA의 clock/manifest 검토도 지적 사항 없이 통과했다.
전체SQL은 예약 이동 fixture의 `SOURCE_ROOM_VERSION_CONFLICT`로 FAIL했다
(82파일/4,829 tests, 해당 fixture는 109개 중 63개 이후 중단). 이는 #393으로 별도 처리한다.
로그 `qa318-bb4-clock-whole-sql.log` SHA256은
`ea6b8255d21de1d1a7f654d94eba86788ff8afcd8e03ca25bd66bf4f81a53eb3`이다.
후속 static/KST/경합/finalfresh는 NOT RUN이다. 최신dev 재통합/전체27 upgrade/CI/보호병합/운영은
후속이며 이전26 PASS를 새 append의 재실행으로 표시하지 않는다.

## 2026-10-05 04:18 UTC 보완 checkpoint — 이전 dev 통합 후보

이 checkpoint는 `dev@bb4fa40`를 합친 미커밋 104-migration 후보이며 최신 #329/#383/#382 재통합은 아직 아니다.
독립 QA의 날짜 P2를 보완해 Edge와 Fastify 모두 실제 4자리 AD 달력 날짜(0001–9999)를 받는다.
Edge는 `Date.UTC`의 0–99년 → 1900년대 변환을 사용하지 않고 `setUTCFullYear`를 사용한다.
PostgreSQL date가 지원하지 않는 연도0000과 잘못된 윤일은 두 경계에서 RPC 호출 전에 거부한다.
[PostgreSQL17 공식 입력 규칙](https://www.postgresql.org/docs/17/datetime-input-rules.html)의
4자리 AD1–99와 AD/BC의 연도0 없음에 맞춘 범위이며 ISO astronomical year0로 재해석하지 않는다.
실제 HTTP injection과 Edge helper의 Node16 및 기존 SQL-source5가 PASS이며 독립 QA 추가
5,544개 연도·월·일 경계에서 두 parser의 불일치는0/P0·P1·P2=0이다. 이는 실제 DB/Auth 성공 증거가 아니다.

원 SQL·append·manifest는 불변이다. 첫 실제 fresh104 적용은 PASS였으나 LIVE fixture는
30개 assertion 이후 service_role의 비공개 schema 조회가 거부돼 FAIL했다. 권한을 확대하지 않고
원장 readback만 fixture-owner로 분리하고 실제 correction/restore/replay/checkout은 service_role을 유지했다.
새 승인 LF 검증본에서 fresh104와 LIVE50/50가 실제 PASS다. 최초 FAIL 로그 SHA256은
`34fd7d504755b5177b2e84e7ce999369dd0dfc4ed4a1ee553013489c19c5cb51`,
새 LIVE PASS는 `9440bcf78752d47409b1176d43afcd8762ecc5d8a485691a8b69c58b32cf0c64`다.
original467/copy467 drift0(SQL/psql199·raw268)를 확인했고 원본 SQL/운영 DB는 수정하지 않았다.

최신 `ci:quality`1,459/70·typecheck/build/secrets/OpenAPI/lint(기존 INFO5), Edge475/0와
17,536,163-byte bundle, Python Ruff226/format/mypy(실제 출력21source files)/pytest95/
full ephemeral codegen/build-check는 실제 PASS다. quality SHA256은
`62067cc0f2e717c9f85fc0903ee10216fd13cb4b412d4351167453326a1db2df`, Edge는
`460ba3d544a31055744344c9251d4048c8db55a2cf13bbba84b9751dc0e9b7ed`다.
처음 새 Node fixture의 service 인자 기대값 오류7FAIL과 request decorator 타입 오류는
실제 `{serviceDate}` 인자·기존 hook 구조에 맞춰 보완한 후21/21/typecheck/lint PASS로 재검증했다.
단발 Deno2.9.6 실행은 테스트 파일 포맷만 했고 dependency/lock 변경은 없으며 실제 Edge 검증은
정본 스크립트의 고정 Deno2.1.4 image로 수행했다. 기존 binary/lifecycle Python generator 경고는 유지한다.

전체26 업그레이드/SQL suite는 진행 중이며 strict/baseline/static/KST/전체7경합·최종fresh·
최신 dev/329 재통합·exact staged tree QA·새 exact-head CI·병합·운영은 아직 PASS가 아니다.
아래 기존 source gate와 NOT RUN 문장은 작성 당시 이력이며 위 실제 narrow gate를 구분한다.

## 2026-10-05 최신 dev 통합 후보와 적용 순서

최초 PR #321 source `0fbf1e55`의 86-migration 실행 기록은 당시 이력이다. 별도 통합 후보 `codex/318-latest-dev-integration`은 `dev@bb4fa40`의 102개 migration과 최신 Fastify 5.12.5·#322/#371/#373/#384를 보존한다. #383/#382/#329 최신 재통합과 전체 DB·exact-head CI는 아직 후속이다.

Root의 원격 읽기 전용 확인에서는 production 85개·recovery 73개에 `room_board_date_filters`와 `limited_existing_session_discovery`가 없고 board RPC도 없다. 따라서 **미적용 baseline 재정렬**을 택한다. #329의 strict migration-time 21 caller·6 snapshot 검증을 먼저 실행한 뒤 새 board RPC를 추가하기 위해 정식 pinned CLI `migration new`로 만든 `20261004231650_room_board_date_filters.sql`로 원 #318 파일을 이동했다. 본문 LF UTF-8 SHA-256 `65acd2eb26b2605660750c84f1ef20a8d7027bdfe2107c733bfae2680e32a9c6`는 그대로다. 적용된 migration/history repair나 #329 guard 완화는 하지 않는다. #329의 원래21/6/18/2 migration-time inventory는 그대로 검증한다. 원 #318 RPC는 명시 STABLE이며 속성을 보존한다. 최신 #329 재통합 후 board의 단일 actor call만 명시적으로 더한 최종 exact7 snapshot caller와 모두STABLE/source 경계를 별도 gate로 검증해야 한다. 현재 source만으로 최종 inventory PASS를 가정하지 않으며 새 auth/fresh dependency를 추가하지 않는다.

이어 정식 CLI로 `20261004231704_room_board_live_projection_compatibility.sql`을 추가했다. 현재 후보는 총 104개, head `room_board_live_projection_compatibility`, 바로 이전 `room_board_date_filters`, 그 앞 `photo_collection_provider_context_axis`다. 이름 기반 runtime/developer 진단과 정식 generator manifest를 정합화한다.

## LIVE 호환 보완의 한정 범위

독립 source 검토에서 legacy verified event만 읽는 PIN 표시와 실제 materialization 없이 지난 계획만으로 청소 의무를 켜는 LIVE 회귀를 확인했다. 기존 helper `private.current_pin_sync_status(room.id)`와 `private.room_current_cleaning_required_at(room.id,evaluatedAt)`를 **LIVE raw-state 두 분기에서만** 재사용한다. PIN이 없거나 version이 다르거나 prepared/expired 변경 lease가 있으면 LIVE verified로 표시하지 않는다. 지난 planned checkout만으로 LIVE cleaningRequired를 활성화하지 않으며 실제 checkout/materialized 의무는 기존 계약대로 반영한다.

추가로 예정 checkout 경과 뒤 실제 입실·미퇴실 active stay를 공실로 낮추는 LIVE 회귀를 보완한다. 기존 `room_reservation_lifecycle_at`와 `room_block_reason_codes`의 실제active 분기를 참조하되, 가이드의 **실제active는 OCCUPIED / 실제checkout·관리자 공실 보정으로 닫힌 instant부터 false** 복합 계약을 함께 복원한다. active stay·평가 시각 이전 실제 입실·실제 퇴실 없음·non-retired 최종 객실 segment를 LIVE current-reservation 선택에 포함하고, immutable false-correction의 `successor_segment_id=segment.id`·`effectiveAt<=evaluatedAt` 정확한 이력 링크가 있으면 fallback 부활에서 제외한다. terminal reason을 일괄 차단하지 않아 합법적인 occupied=true 복원은 유지한다. 다른 endpoint/helper는 전역 변경하지 않는다.

기존 segment 반개구간/null end 선택은 그대로 남기고, 과거·미래에서는 이 실제-active 확장을 사용하지 않는다. 실제 `correct_room_occupancy(false)`·같은 receipt replay·occupied=true 복원과 lineage/퇴실시각 보존을 SAVEPOINT 분기에서 회귀 검증하도록 작성했으며, 분기를 rollback한 뒤 실제 checkout command의 VACANT/cleaning 의무를 검증한다. 초기 synthetic fixture 이외에는 실제 명령만 사용하며 예약·점유 원장 clock UPDATE나 guard 해제를 하지 않는다. 실제 DB 실행은 후속 gate다.

`CHECKOUT_INSPECTION_REQUIRED`는 **예정 checkout 시각 도달 이후 해당 퇴실 청소 현장 완료 전** 상세 조건이며 실제 cleaning materialization 여부와 다른 읽기 축이다. 따라서 LIVE에서 `cleaningRequired=false`이면서 inspection=true·actual occupancy=true일 수 있다. 이 시간 기반 조건을 materialization 필수로 좁히지 않는다. SQL 회귀에서 이 구분을 명시하며 미확정 수동 퇴실점검 완료 lifecycle을 구현한 것으로 해석하지 않는다.

원 RPC prosrc MD5 `7a4ca74a6410734ac72b251a2cf6c418`, 네 fragment(요청 시각1·LIVE 선택3)의 단일 일치와 definition 단일 일치를 확인한 후 `CREATE OR REPLACE`한다. OID·ACL·owner·volatility·security-definer·search_path·signature 속성도 검사한다. 과거/미래 event/planned projection, `CHECKOUT_INSPECTION_REQUIRED`를 포함한 상세 조건 계산식, actor/session 경계, 기존 history·권한·암호화는 변경하지 않는다. LIVE `VACANT` 등의 표시 값은 보완한 actual occupancy 선택을 반영한다. 날짜별 catalog는 여전히 최신 catalog를 사용하며, 퇴실점검 수동 완료 lifecycle은 미확정이다.

## 검증 상태

- 최초 103개 통합 후보의 실제 PASS: `npm ci`(0 vulnerabilities), `ci:quality`(Node 1,438/68 files), Edge 475/0, Python Ruff 226·mypy 25·pytest 95·codegen/build-check, TS generated client compile, 정식 manifest와 LF source integrity. 로그 `.tmp/318-*`에 이력을 보존한다.
- 104개 보완 후보의 manifest generate/verify는 실제 PASS(78 baseline/26 pending). Node source 계약 테스트와 SQL fixture를 추가했다. SQL fixture는 INSERT-only 합성 암호문/만료 lease/과거 점유 초기 상태를 rollback transaction에서 구성하고 실제 `manual_checkout_reservation`으로 materialize한다. 실제 provider·물리 PIN을 사용하거나 guard를 끄지 않는다.
- 104개 보완 후 실제 PASS: 신규 Node source 4건, Edge 475/0(17,536,029-byte bundle), Python Ruff 226·mypy 25·pytest 95·full codegen/정식 build-check, 생성 TS client strict compile, 원86/dev102 SHA·최신 dependency source integrity와 diff-check다. `.tmp/318-*-live-fix.log`와 `.tmp/318-node-live-contract.log`에 실제 출력을 보존한다.
- 104개 전체 `ci:quality` 첫 실행은 파일 이동 전 Git index의 삭제 경로를 secret scanner가 읽어 `ENOENT` FAIL/exit1이었다(`.tmp/318-ci-quality-live-fix.log`). checker/기준을 우회하지 않고 root가 의도한17경로를 명시 stage해 unmerged0/index 정합을 확인한 뒤 원 명령을 재실행했다. 최초 Python 명령의 `build.py` 경로 오입력/exit2도 별도 기록을 보존하고, 문서의 `scripts/build.py`로 전체 재실행 PASS했다.
- **현재 세 LIVE 분기/correction-aware 최종 source gate 실제 PASS**: `npm run ci:quality` exit0(secret855 files·OpenAPI137/148·Biome354/기존INFO5·typecheck·Node1,442/69 files·build), `npm run edge:check` exit0(fmt99/typecheck/475 PASS·0 FAIL·17,536,029-byte bundle), Python Ruff226/mypy25/pytest95/full codegen/정식 build-check exit0, 전체 생성TS client와 strict compile exit0. `.tmp/318-ci-quality-final.log`, `.tmp/318-edge-check-final.log`, `.tmp/318-python-final.log`, `.tmp/318-ts-client-final.log`에 실제 전체 출력을 보존한다. 기존 binary upload/response·lifecycle 모델 generator 제한은 그대로 공개하며 전체148 operation이 모두 Python generated endpoint가 됐다는 주장은 하지 않는다.
- 독립 읽기 전용 source QA는 SHA/MD5·최초 두 분기·OID/ACL/attributes와 synthetic fixture→실제 checkout 전제를 확인했고, 새 fixture 반환 컬럼 오류를 `id`로 보완했다. Inspection의 계획 시각 표시는 계약대로 유지하며 actual cleaning/occupancy와 구분하는 assertion을 추가했다. 이후 source QA가 찾은 관리자 공실 보정 successor 부활 회귀도 LIVE fallback exact 이력 링크 제외와 실제 correction/restore/replay 회귀로 보완했다. Root는 원 명시STABLE/OID/ACL와 최종 세 분기 source를 직접 확인했다. 최신 #329 재통합 후 최종 순차 독립 QA는 별도 gate며 현재 실제 DB·최종 QA PASS는 아니다.
- 전체 fresh migration·SQL/26 upgrades·경합·strict/baseline DB lint·advisors·#329 재통합 검증·exact-head required CI는 **NOT RUN**이다. source 테스트가 실제 DB PASS를 뜻하지 않는다.
- dev/main 병합·운영 DB/API·복구 DB·백업/복원·릴리스/태그는 이 로컬 후보에서 변경하지 않았다. 실제 백업/복원은 모든 개발 이후, 운영 배포 전 필수다.
