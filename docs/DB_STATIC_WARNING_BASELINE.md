# #363 DB 정적 경고 보완과 #373 정확 호환 기준

## 2026-10-07 v0.9.0 최신 dev 통합 checkpoint

후속 확정: PR377/source83e7122의 CI37603160916 application/migration 모두 PASS 후
독립 QA·미해결 리뷰0·보호 규칙을 확인하고 devbec3dbe로 squash했다. 아래 후보/CI 대기
문구는 당시 checkpoint다. 동일 source의 v0.9.0 통합 중이며 운영 적용 완료는 아니다.
사용자의 최신 우선순위는 프런트 요구 기능의 빠른 운영 승격이다. 실제 백업·복원과
#396 초기화 개발은 후속으로 분리한다. 아래 과거의 백업 선행/101개 수치는 당시 기록이며,
이번 #376 호환 수정과 필수 CI·독립 QA를 생략한다는 뜻은 아니다.

- `dev@8bdaec3`에 PR #377의 검증 source `2e05c03`을 별도 작업 브랜치에서 정상 통합한다.
  다른 작업공간의 미커밋 변경과 v0.8.0 후보는 보존한다.
- 최신 manifest는 111개이며 순서102 `db_static_warning_remediation`의 SHA만
  `9f6eab7b...`에서 `3a1e8ac0...`로 변경한다. 다른110개 SQL·이름·순서와 마지막
  `post_approval_room_issue_ledger`는 그대로다. 기존100→101 runner는 역사 구간 검사다.
- 운영85/head `20260928095656`, recovery73/head `20260919230733`을 읽기 전용으로
  재확인했다. 두 곳 모두 remediation 이력0·snapshot helper 없음이다. 원격 적용·repair는 없다.
- 최초 application 검증은 #336 upgrade의 이전110개 prefix pin 때문에 FAIL했다.
  exact pin을 새 prefix로 갱신하고, remediation SHA 하나만 복원하면 이전 두 prefix hash와
  정확히 같아야 하는 회귀를 추가했다. 임의 manifest 변경을 허용하지 않는다.
- 수정 후 `npm run ci:quality`: 105파일/2,664 tests·typecheck·build·OpenAPI150 paths/162
  operations PASS. 기존 lint INFO18은 유지한다. manifest5종도 PASS다.
- 원본을 보존한 LF 임시본의 `npm run db:reset`은 fresh111 PASS다.
- 독립 read-only QA: targeted109·diff 검사 PASS, P0/P1/P2=0. DB 실행은 루트 담당으로 구분한다.
- CRLF 실제 runner는4조합·15거부·CLI 마지막 실패의 원자 rollback·OID/ACL/RLS/행/receipt
  보존·최종 fresh111 cleanup까지 exit0 PASS다. raw strict FAIL9와 exact9 PASS를 구분한다.
- #336 실제110→111 upgrade도 기존 원장·OID/ACL/RLS·receipt replay/거부·새 typed 신고·
  최종 fresh111 cleanup·원본 hash 보존을 PASS했다. `edge:check` 전체 exit0이며 실제 후보
  번들19,229,571 bytes로20,000,000 byte 제한 이내다.
- 전체 실제 SQL 회귀도88파일/5,572 assertions PASS다. 다른27개 역사 upgrade·전체 경합의
  이번 통합본 재실행은 새 exact-head CI에서 확인한다. 이전 source CI를 새 CI로 대체하지 않는다.
- PR #377을 정상 fast-forward로 갱신할 후보이며 새 required CI·dev 통합·release PR #403의
  main 충돌 해소와 최종 운영 승격은 후속이다. 운영 배포 완료는 아니다.

## #376 운영 CRLF 호환 보완 후보 — 2026-10-04

릴리스 preflight에서 운영의 검수 목록·developer catalog 두 함수만 기존 source와 같은 내용의
전체 CRLF 본문임을 확인했다. 원본101은 raw MD5에서 중단되며, MD5만 추가해 허용하면
검수 목록의 LF fragment가 여전히 일치하지 않는다. 이를 별도
[#376](https://github.com/wrongstory/room-management-system-backend/issues/376)에서 보완한다.

| 설치 함수 | 관측 raw CRLF MD5 | CRLF→LF 후 요구 MD5 |
|---|---|---|
| `public.list_cleaning_inspections_page(uuid,uuid,timestamptz,uuid,integer)` | `a5105bb901c8f1f507965e9b04f52911` | `af65520fb460db7dc858645f13246450` |
| `public.get_developer_room_catalog(uuid)` | `62d346e27ad148f7f4807ac536e9197b` | `d75eefbe637fb17d942f0f89a626b5f7` |

기존 LF raw 지문은 그대로 허용한다. LF raw 지문이 다르면 **위 두 함수의 정확한 raw CRLF 지문과
정확한 canonical LF 지문을 모두** 검사한 뒤 작업 본문만 LF로 바꾼다. `pg_get_functiondef` 교체
anchor에는 원래 raw 본문을 사용한다. 다른5개 함수의 CRLF, 혼합 줄바꿈, bare CR, 알 수 없는
본문·의미 변경은 계속 `DB_STATIC_REMEDIATION_SOURCE_DRIFT`로 실패한다. 기존 fragment 횟수와
definition anchor 검사는 유지한다. 승인된 exact9 경고의3개 함수는 raw 지문 그대로 검사하며
이 예외를 적용하지 않는다.

현재 원격 history 확인은 운영85/head `flat_cleaning_evidence_history_payroll`, recovery73/head
`generated_room_pin_confirmation`이다. 두 프로젝트 모두101의 name/local version 및
`private.assert_active_developer_snapshot(uuid)`가 없다. 현재의101 미적용 근거이며 과거의 모든
수동 실행·부분 drift가 없었다고 단정하지 않는다. 이 확인에 따라 **미적용101 파일만** 정상
후속 Git commit으로 보완한다. 기존100개 SQL·history는 불변이고 Git amend/rebase나 remote
history repair는 하지 않는다. 새 append를101 뒤에 넣으면 먼저 실패하는101을 해결하지 못한다.
dev manifest는101 hash만 갱신하고 count101·기준78·pending23·순서/head는 유지한다.

검증 후보는 LF/LF·LF/known CRLF·known CRLF/LF·둘 다 known CRLF의4조합과 거부 matrix다.
같은 DB session 안에서 적용 결과를 관찰하고 전체 catalog/행/history/receipt·replay를 비교한다.
마지막 catalog 함수의 의미 drift를 transaction 밖에 준비한 실제 CLI upgrade 실패도 검사하여
앞6개 변경·CRLF 정규화·새 helper·migration history가 모두 rollback되는지 확인한다.
서명/default/type/owner/ACL/OID/STABLE/security definer/search_path/RLS·업무 원장은 보존한다.

구현 착수 checkpoint(과거): 변경 전 `npm test`1432/67파일 및 manifest5개 PASS. 새 SQL 구현·test 보완 중이며
4조합/negative/원자 rollback·fresh reset/전체 SQL·독립 QA·exact-head CI는 아직 NOT RUN이다.
기존 #363/#373 및 release79146d3의 PASS를 새 보완 결과로 사용하지 않는다.
운영/recovery DB·API·Auth/키·PIN·태그/Release는 변경하지 않았다.

후속 working checkpoint: `ci:quality`의 secret scan843·OpenAPI137/148·lint(기존 INFO5)·typecheck·
Node1432/67·build는 PASS다. 첫 DB 실행과 진단 재실행은4조합/15거부를 통과했지만 실제 CLI 오류
검사에서 FAIL했다. pinned CLI가 agent-mode 오류를 stderr가 아닌 stdout의
`LegacyMigrationApplyError` JSON으로 반환한 것이 확인됐다. 전체 SQL 문맥에서 서명을 검색하지
않고 실제 오류의 첫 줄만 정확히 대조하도록 보완했다. stderr의 실제 ERROR 첫 줄도 동일하게
검사하며 signal/transport error/성공 status·다른 오류/tag/code/malformed JSON은 거부한다.
독립 보완 QA의 비DB38건·syntax/diff 검사 PASS, 정적 미해결 P0/P1/P2=0이다. 두 실패 실행의
latest fresh101 cleanup은 성공했다. 이 checkpoint 당시 최종 runner의 실제 재실행·전체 SQL·새 CI는 진행 전/중이었다.

최신 local checkpoint: 보완한 runner의 실제100→101 전체 실행 exit0이다.4개 LF/known CRLF조합·
15개 비허용 본문·마지막 함수 실제 CLI 거부의 원자 catalog/행/receipt/history rollback·known raw
CRLF prestate 보존·실제 happy upgrade·모든 OID/ACL/속성·기존 receipt replay·latest fresh101 cleanup
모두 PASS다. 원본 strict FAIL9/exit1과 별도 exact9/catalog3 PASS는 구분한다. 같은 source의 전체
SQL79파일/4722 assertions(기존4718+canonical4), 역할별 실제 DB 검사와 local Security Advisor
WARN/ERROR0은 PASS다. 새 exact-head required CI·최종 QA/dev 통합·release 전체 재검증은 후속 gate다.
Windows LF 검증본은101 canonical hash 및294개 원본 raw hash를 보존한다. 운영/recovery·Auth/키·
API·PIN·태그/Release는 미변경이며 실제 운영 백업이나 복원 검증으로 확대하지 않는다.

후속 CI checkpoint: PR #377의 `c0c655b` / run37193302636은 application PASS, migration FAIL이다.
4조합·15거부·전체 `db:test`는 통과했지만 `last-source-drift-cli-atomic-rollback`에서
stdout JSON parse가 중단되어 이 CI의 rollback 후 상태 비교와 후속 KST/경합은 미검증/skip이다.
고정 CLI2.115.0은 agent auto-detection에 따라 기본 text/JSON을 달리한다. 실제 captured 원문을
CI 로그에 출력하지 않아 정확한 text 형태는 단정하지 않는다. negative CLI 호출에
`--output-format json --agent no`를 명시해 non-agent runner 경로의 JSON을 고정했다.
정확한 첫 오류·tag/code/signature/SQLSTATE 검사는 변경하지 않았고 SQL 문맥 검색으로 완화하지 않는다.
근거: [pinned CLI 출력 우선순위](https://github.com/supabase/cli/blob/v2.115.0/apps/cli/src/shared/cli/agent-output.ts).

보완 후 local 재검증: `ci:quality`1432/67·manifest5·syntax/diff PASS, 독립 parser20/CLI 출력 옵션3
PASS(P0/P1/P2=0). 명시 non-agent JSON의 실제 static runner는4조합·15거부·마지막 CLI 실패의
전체 rollback·known CRLF prestate·happy100→101·receipt replay·최종 fresh101 cleanup까지 exit0이다.
원본 strict FAIL9/exit1과 exact9/catalog3 PASS는 그대로 구분하며 SQL101개 raw aggregate hash는
검증 전후 동일하다. 기존 SQL·manifest·API·workflow를 수정하지 않았다.
같은 LF 검증본의 전체 SQL79파일/4722 assertions도 재실행해 PASS였다.
새 exact-head required CI는 별도 gate이며 이전 실패를 PASS로 덮거나 운영 배포 근거로 사용하지 않는다.

## 사용자 결정과 범위

2026-10-04 KST 사용자가 Decision [#373](https://github.com/wrongstory/room-management-system-backend/issues/373)의 A안을 승인했다.
기존 로그인 재진입 #329 또는 고정한 v0.8.0 릴리스와 섞지 않고 `dev@e9fcc564`/100 migrations에서 별도 개발한다.
의도적인 호환 인자 9개는 서명·이름·원문을 유지하고 나머지 경고 8개를 먼저 보완한다.
원본 strict lint의 **FAIL/exit 1**은 숨기거나 PASS로 바꾸지 않는다.
정확히 승인된 9개 경고와 설치된 함수 fingerprint가 모두 일치할 때만 별도 비교 gate가 PASS다.
이 결정은 병합·운영 DB/API 배포·Auth 설정·프런트 수정 승인이 아니다.

## append-only 보완

CLI로 만든 `20261003231702_db_static_warning_remediation.sql` 한 건을 추가한다.
기존 적용 SQL, 원장, receipt, 테이블/컬럼/FK/index/RLS/테이블 grant는 변경하지 않는다.
7개 기존 함수의 본문만 바꾸며 OID, named signature, defaults, return type, owner,
EXECUTE ACL, SECURITY DEFINER, search_path 및 volatility를 보존한다.
정확한 이전 본문 MD5와 fragment 횟수가 다르면 migration 전체를 실패시킨다.

- overdue 알림의 unused `notice_id`만 제거하고 emitter를 `PERFORM`으로 계속 실행한다.
- generated PIN 두 함수의 unused room row만 제거한다. `PERFORM 1 ... FOR UPDATE`로 같은 객실 잠금과 바로 뒤 `IF NOT FOUND`를 유지한다. advisory/actor/session/replay/CAS/lease/실물 확인 조건은 그대로다.
- 검수 목록의 unused actor row만 제거한다. 기존 권한·세션 guard는 같은 위치에서 `PERFORM`으로 계속 실행한다.
- 청소 이력 list/detail은 한 번 캡처한 `statement_timestamp()`로 기존 clock 비교만 바꾼다. legacy fallback, retention-v2 availability 우선순위, NULL expiry, 만료 `<=` 경계와 불변 snapshot은 그대로다. 실제 사진 접근 허가·purge worker의 wall-clock 검사는 변경하지 않는다.
- developer catalog의 generatedAt은 statement 시각이다. 같은 predicate의 새 private `assert_active_developer_snapshot(uuid)`만 STABLE/owner-only로 추가한다. 기존 공용 명령 guard는 VOLATILE·원문·ACL을 그대로 유지하며 다른 호출은 변경하지 않는다.

STABLE 조회는 호출 statement snapshot을 사용하고 기존 VOLATILE 명령 guard는 내부 조회에서 fresh snapshot을 사용한다.
요청 시작 snapshot의 권한 검사이지 실행 도중 철회까지 즉시 관찰한다는 보장은 아니다.
transaction 시작 시각인 `now()`로 대체하지 않는다.
근거: [PostgreSQL 17 volatility](https://www.postgresql.org/docs/17/xfunc-volatility.html),
[현재 시각 함수](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).
developer catalog의 현재 HTTP live-session guard 및 history DB session 검사는 유지한다.

## 정확한 9개 호환 경고

| 설치 함수 | 의도적으로 unused인 인자 | 원문 MD5 |
|---|---|---|
| `public.confirm_assignment_duration_policy(uuid,bigint,integer,integer,integer,integer,text,text)` | actor를 제외한 7개 인자 | `5536dad130df79162031d85929d32133` |
| `private.assignment_preview_source_reason(public.cleaning_targets,integer,timestamptz)` | `p_duration_minutes` | `0a1a56ddfb864a1f4709af5a82075f00` |
| `private.assignment_preview_source_reason_before_stay_segments(public.cleaning_targets,integer,timestamptz)` | `p_command_at` | `6645c7dc97faadd39c752bb4846cce0c` |

폐기한 duration/기한 정책을 부활시키거나 dummy 참조를 넣지 않는다.
각 warning은 qualified function, `warning extra`, SQLSTATE `00000`, 정확한 unused parameter 메시지가 일치해야 한다.
그룹/개수/필드/중복/새 오류도 검사한다. 함수 overload, 인자 타입·이름·default·OUT/variadic,
return type, volatility, owner, ACL, SECURITY DEFINER/search_path, language 등 catalog drift도 거부한다.
원문 MD5는 설치한 원본 그대로 비교하고 줄바꿈을 몰래 정규화해 허용하지 않는다.

## 실행과 CI

`npm run db:lint:baseline`은 고정된 local project/DB container, 검증한 local Docker endpoint와
CLI `2.115.0`만 사용한다. config의 `db.port`가 해당 container의 실제 `5432/tcp` 공개 포트와
일치하는지 검사하고 CLI의 workdir·Docker context/endpoint를 고정한다. 호출자의
`SUPABASE_WORKDIR`, `SUPABASE_PROJECT_ID`, `SUPABASE_DB_PORT`, `SUPABASE_SERVICES_HOSTNAME`
및 외부 Docker target override와 remote URL/linked/schema/baseline override를 받지 않는다.
CLI 자식 프로세스에는 검증한 project/DB port와 loopback hostname을 명시적으로 고정한다.
프로젝트 `.env`에서 config 대상이 바뀌는 경로도 shell 환경변수 우선순위로 차단한다.
근거: 고정 CLI [v2.115.0 config/env 로더](https://github.com/supabase/cli/blob/v2.115.0/apps/cli/src/legacy/shared/legacy-db-config.toml-read.ts),
[hostname 선택](https://github.com/supabase/cli/blob/v2.115.0/apps/cli/src/legacy/shared/legacy-hostname.ts).
원본 명령은 `supabase db lint --local --schema public,private --level warning --fail-on warning --output json`이다.
stdout/stderr와 실제 종료 상태를 먼저 표시하고 별도 catalog 조회와 비교한다.
JSON 파싱/누락/확장 필드/unknown stderr/실행 실패/timeout/signal/예상 밖 종료는 FAIL이다.
전체 warning 17개나 local-only 수정 상태의 13개를 예외로 허용하지 않는다.
평가 기준 변경은 SQL 보완과 별도 커밋으로 구분하며 Decision #373을 참조한다.

required migration CI에 fresh DB 이후 비교 gate와 `npm run db:test:static-warning`을 추가한다.
기존 application/migration 회귀·SQL·KST·경합·cleanup은 삭제하거나 skip하지 않는다.
새 upgrade는 다른 후속 migration을 제외한 정확한 100→#363/101 구간에서 원문 drift의 원자 롤백,
모든 기존 테이블/정책/인덱스/제약/트리거/타 함수·행·receipt의 보존과 재시도를 검사한다.
끝나면 root의 최신 local migration 전체를 fresh로 복원한다.

Windows의 기존 migration93 CRLF 검증 장애는 원본을 고치지 않고 사용자가 승인한
해시 동등 LF 임시 검증본에서 실행했다. migration101개의 manifest canonical SHA를
대조하고 복사 대상 원본293개 파일의 raw SHA도 변경되지 않았음을 확인했다.
이 검증본·실행 로그·합성 데이터는 Git에 포함하지 않는다.

## 실제 검증 checkpoint

- PASS: 변경 전 Node 1,229/65 files, fresh local100, 원본 strict17 재현.
- PASS: 100→101 upgrade, source drift 강제 실패 후 전체 rollback, 기존 row/catalog/ACL/RLS/receipt·replay 보존, 종료 후 latest fresh101 cleanup.
- PASS: 업그레이드 후 원본 strict는 FAIL/exit1·9개, 별도 exact9/catalog 비교는 PASS.
- PASS: 최종 비교 validator/runner mock138개(로컬 endpoint/workdir/실제 공개 포트 및 CLI env override 포함), targeted Biome/Node syntax/typecheck/build, 모든 migration manifest.
- PASS: 최종 application `ci:quality` Node1,367/66 files·typecheck/build·OpenAPI137 paths/148 operations·secret scan840, Edge470/format99·bundle17,520,454 bytes. 기존 Biome INFO5개는 보존한다.
- PASS: Python95·ruff/format226·mypy25·ephemeral business codegen/build check. 기존 binary content type 등의 생성기 경고는 그대로이며 그 경로를 생성 완료로 주장하지 않는다.
- PASS: focused 실제 pgTAP77개(시간 경계·snapshot/fresh guard·권한/세션·실제 역할·전체 행 불변).
- 초기 application은 developer 진단의 이전 migration head 때문에 1건 FAIL했다. 실제 head와 Edge assertion을 함께 갱신한 뒤 위 최종 검사를 통과했다. 초기 focused SQL도 wrapper의 parameter SET 권한 때문에 28개 후 중단됐다. 권한을 올리지 않고 최상위 transaction-local 합성 구간으로 고친 뒤77개 모두 통과했다. 두 실패 이력을 숨기지 않는다.
- PASS: 기존26개 upgrade 전부 통과. 최초 `npm run db:test`의 full SQL은 developer 진단 이전 head 기대값3건 및 객실 이동 test63/109 `SOURCE_ROOM_VERSION_CONFLICT`로 FAIL했다. head 기대값만 새 append에 맞게 보완한 뒤 targeted2 files/142 및 full SQL79 files/4,718은 PASS다. 객실 이동 fixture·production CAS는 변경하지 않았으며 기존 [#362](https://github.com/wrongstory/room-management-system-backend/issues/362)의 원인 미확정 재현으로 별도 추적한다. 최초 전체 명령 자체를 PASS로 다시 표시하지 않는다.
- PASS: `db:test:long-stay-clock` KST5×29=145 assertions, `backup:dry-run` local-synthetic101/head 검증. 운영 백업을 수행했다고 주장하지 않는다.
- PASS: `db:test:concurrency` 6개 suite 전체 exit0. PIN bootstrap/prepare/confirm/reveal/sheet 경합·취소·급여 조정/상세/송금 표시의 actor/session/CAS/동일 key/replay를 검사하며 no-deadlock·표시로 인한 금전 효과 없음도 확인했다.
- PASS: CLI env 고정 최종판의 실제 gate. 임시 LF 검증본의 `.env`에 존재하지 않는 project/port9/다른 loopback을 넣어도 검증된 local project/54322/127.0.0.1을 사용하고 strict FAIL9/별도 exact9 PASS였다. 실제 원본 `.env`나 운영 target은 건드리지 않았다.
- PASS: 최종 독립 read-only source QA98/100, P0/P1/P2=0. 확인된 CLI env target override P2를 보완 후 재검토했으며 QA는 비DB negative138/138과 두 runner syntax를 직접 실행했다. QA 기본 loader EPERM은 BLOCKED로 기록하고 installed runner loader로 검증했다. 사람의 GitHub 승인·DB/CI 실행을 대신 주장하지 않는다.
- PASS: 최종 env 고정 `db:test:static-warning` 전체 exit0. exact100→101/source drift rollback/row·catalog·receipt replay·latest fresh101 cleanup 모두 통과했으며 합성 `.env` probe 파일은 삭제했다.
- NOT RUN: exact-head required application/migration CI는 push/PR 생성 뒤 별도로 확인한다.
- 미실행: 운영 적용, hosted smoke, 실제 PIN/송금/Drive/provider, 프런트 UAT, 병합·태그/Release.

## 운영/rollback 경계

아직 원격에 적용하지 않은 독립 append 후보다. #329와 고정 release PR에는 추가하지 않았다.
운영 승격이 필요하면 검증된 dev 통합 후 별도 release/main 절차와 승인 범위를 다시 확인한다.
문서나 로컬 비교 gate PASS만으로 #363 종료 또는 기존 Draft PR 병합 가능을 선언하지 않는다.
현재는 운영 rollback 자체가 필요 없다. 향후 운영 함수 복구는 적용된 SQL 수정이 아니라
검증된 후속 append로 수행하고, 이전 런타임/DB 계약과 호환성을 확인한다.
