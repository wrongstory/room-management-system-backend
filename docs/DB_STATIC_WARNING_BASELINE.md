# #363 DB 정적 경고 보완과 #373 정확 호환 기준

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
