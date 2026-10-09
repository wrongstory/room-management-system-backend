# #378 strict decoded history / bounded CLI logical token source 단위

> 상태: **source-only / 실행 불가**. 운영 driver, PostgreSQL history read/write, 실제 CLI parity, 실제 approved-ref positive, DB/TLS/full-state/백업/배포는 구현·실행하지 않았다. 모든 공개 결과는 `executionAllowed=false`, `operationalApproval=false`, `DBHistoryVerified=false`, `fullStateVerified=false`, `cliParityVerified=false`다. 모델 일치는 실제 migration 적용·이력 원자성·owner 승인 증거가 아니다. #378 전체 완료 또는 병합·운영 승격을 선언하지 않는다.

## 범위·독립 구현·근거

새 세 파일은 `scripts/lib/migration-history-codec.mjs`, `tests/migration-history-codec.test.ts`, 이 문서다. 기준 HEAD는 `f32d757b20fcc387012f9a79d84c3045b7e1961d`이며 끝까지 읽은 제품 가이드 SHA `dc82fe3ffc74633a207defcc0870f70f73f996a436a3af3a4a976bdaa4200334`가 그대로임을 재확인했다. 기존 policy/parser/bundle·dependency/lock·SQL·manifest·DB·Git/index·원격은 변경하지 않는다. 이 작성자는 이전 foundation의 reviewer였으나 이번 codec에는 **author**이므로 별도 non-author QA가 필수다.

Supabase skill에 따라 changelog의 관련 PG15/17 변경을 확인했다. 이 단위는 서버 version 검증이나 업그레이드를 수행하지 않는다. 동작 조사 기준은 pinned CLI **2.115.0**, exact commit **`18ae43a34a2257458197b62f74e2a97e2b5cf7f9`**다. 아래 primary source는 연구 근거이며 원문 FSM/class/함수를 복사·vendor/import하지 않고 별도 conservative lexer를 작성했다. 현재 upstream tree의 라이선스가 확인되지 않았으므로 MIT라고 주장하지 않는다.

- [CLI logical splitter](https://github.com/supabase/cli/blob/18ae43a34a2257458197b62f74e2a97e2b5cf7f9/apps/cli/src/legacy/shared/legacy-sql-split.ts)
- [Migration file의 BOM/pg-delta metadata](https://github.com/supabase/cli/blob/18ae43a34a2257458197b62f74e2a97e2b5cf7f9/apps/cli/src/legacy/shared/legacy-migration-file.ts)
- [Apply와 authored transaction/history 순서](https://github.com/supabase/cli/blob/18ae43a34a2257458197b62f74e2a97e2b5cf7f9/apps/cli/src/legacy/shared/legacy-migration-apply.ts)
- [History DDL·full-row read](https://github.com/supabase/cli/blob/18ae43a34a2257458197b62f74e2a97e2b5cf7f9/apps/cli/src/legacy/shared/legacy-migration-history.ts)
- [Driver text-array wire encoding](https://github.com/supabase/cli/blob/18ae43a34a2257458197b62f74e2a97e2b5cf7f9/apps/cli/src/legacy/shared/legacy-db-connection.sql-pg.layer.ts)

CLI history는 `version text primary key`, nullable `name text`, nullable `statements text[]`이며 checksum column이 없다. 기존 CLI fetch의 name coalesce/문자열 coercion·NULL-array→빈 배열 변환은 엄격한 검증 경로로 재사용하지 않는다. 이번 local SHA는 DB에 이미 저장된 checksum이 아니다.

## API와 소유권 경계

`createMigrationHistoryModel({version,name,sqlBytes,sourceBinding})`는 bytes를 복사하고 ordered logical tokens를 private WeakMap에 보관한다. 공개 모델에는 hash/count/비밀 없는 migration 이름과 출처만 있으며 SQL accessor·statement string getter·실행 API가 없다.

- `sourceBinding=null`: 항상 `UNTRUSTED_INPUT_MODEL`, `parserEvidenceBound=false`다. 유효 SQL·Git·DB 출처를 인증하지 않는다.
- `sourceBinding={bundle,path}`: 현재 bundle 모듈의 실제 owned handle만 받는다. exact file path/version/name, 실제 bundle-owned parser plan의 whole SQL hash·byte length와 입력 bytes를 묶는다. clone·외부 `VERIFIED` flag·mock AST·같은 이름의 다른 파일은 통과하지 못한다. 결과는 `OWNED_LOCAL_SOURCE_BOUND_MODEL`일 뿐이며 local bundle의 caller-claimed project/history identity·remote/approval 미검증 경계를 그대로 이어받는다.
- `createExpectedMigrationHistorySnapshot({models})`는 실제 owned model handle만 사용한다. ordered version 중복·역순을 거부하고 SQL 원문을 공개하지 않는다. 실제 DB expected snapshot을 수집한 것이 아니다.
- `createDecodedMigrationHistorySnapshot({expectedVersions,rows})`는 이미 decoded된 caller 자료다. 기대 version 집합 또한 caller claim이며, 실제 authenticated DB accessor는 없다.
- `compareMigrationHistorySnapshots({expected,observed})`는 opaque snapshot의 정확한 decoded serialization을 비교한다. `matches=true`도 운영 권한이나 `DBHistoryVerified=true`가 아니며 observed rows는 계속 caller claim이다.

## SQL logical token의 한정 지원

CLI와 같은 순서로 token의 trailing semicolon을 제거한 뒤 주변 whitespace를 trim한다. 주석·token 내부 CRLF·Unicode·dollar body는 보존한다. BEGIN/COMMIT은 **history token 배열에 포함**한다. comments-only EOF token도 trim 후 비어 있지 않으면 포함하며 separator-only/whitespace-only token만 제외한다. 이 lexer는 AST validator나 source-reviewed executable allowlist가 아니다.

지원 범위는 일반 single/double quote와 doubled quote, LF/CRLF line comment, bounded nested block comment, bounded parentheses, exact dollar delimiter와 opaque body다. E-string/문자열 내부 backslash, top-level backslash, positional dollar parameter/달러-containing identifier, malformed dollar tag, unquoted ATOMIC/BEGIN ATOMIC, unmatched delimiter는 fail-closed한다. 지원하지 않는 구조를 upstream과 같을 것이라고 추측하지 않는다. BOM과 pg-delta marker는 위치에 관계없이 이 단위에서 거부하며 nontransactional 실행 metadata를 구현한 것으로 표시하지 않는다. lone CR도 지원하지 않는다.

입력 최대2MiB, tokens 최대10,000, block/parenthesis depth 최대64, history 최대512 rows/32MiB text다. tag 길이도 bounded다. 오류는 `HISTORY_CODEC_*` fixed code만 반환하고 native cause·SQL·path·연결 정보를 붙이지 않는다. 이 bounded synchronous codec은 DB 실행 전체의 real monotonic supervisor나 secure memory를 대체하지 않는다.

## strict decoded PostgreSQL 배열과 hash 영역

row는 정확히 `{version,name,statements}`다. version은 이 프로젝트의 14자리 문자열이며 expectedVersions와 전체 길이·순서·원소가 같아야 한다. duplicate/unknown/missing/extra/reordered row, getter/symbol/sparse array/추가 key/잘못된 prototype·타입을 거부한다.

`statements`는 `null` 또는 `{dimensions,values}`다. `dimensions=[]/values=[]`는 명시적인 empty decoded array다. 비어 있지 않으면 정확한 한 차원의 `{length,lowerBound}`와 순서 보존 string/null values를 받는다. lower bound는 signed int32이며 upper bound overflow·shape 불일치·2차원 이상은 거부한다. nonstandard lower bound를 normalize하지 않으며 CLI 예상1-based 배열과 일치하지 않는다. 이름 NULL/빈 문자열, 배열 NULL/빈 배열, 원소 NULL/빈 문자열/문자열 `NULL`, CRLF/Unicode/원소 순서를 구분한다. SQL text literal/PG wire array 문자열은 decode했다고 가정하지 않고 거부한다.

future driver는 실제 column NULL·array dimensions/lower bounds를 별도로 보존하여 제공해야 한다. plain JS string[]나 CLI fetch 결과만으로 이 자료를 재구성하면 누락된 metadata를 검증할 수 없다. 이번 단위는 PG text/binary wire codec이나 실제 DB read query를 제공하지 않는다.

hash는 UTF-8 `JSON.stringify({format,value})` SHA-256이며 다음 세 domain을 분리한다.

- `cli-history-logical-statements-v1`: wrapper 포함 ordered logical string tokens.
- `decoded-pg-history-row-v1`: version/name/nullable array와 dimensions/lower bound/value 전체.
- `decoded-pg-history-snapshot-v1`: 전체 ordered decoded rows.

기존 parser의 `exact-byte-statements-v1`/`statementsSha256`는 wrapper를 제외한 raw body slice hashes라 위 history hash로 재사용하지 않는다. CLI wire text-array escape 표현이 달라도 exact decoded strings와 dimensions가 같아야 모델이 일치한다. wire representation 자체를 history digest로 쓰지 않는다.

## 검증과 후속 gate

최초 checkpoint는 targeted **94 PASS/1 FAIL(95건)**, typecheck FAIL, Biome1 error/1 warning이었다. 원인은 테스트의 `expect(...).sort()` 괄호 위치와 import 정렬/optional-chain 진단이었으며 assertions를 삭제하거나 기준을 낮추지 않고 보완했다. 뒤 source checkpoint의 targeted96/typecheck/Biome2파일/node syntax/build/diff는 실제 PASS다. 이 source checkpoint의 전체 `npm test`도 **2,172건/74파일 PASS**, exit0이었다. 이후 typed-array intrinsic bound와 object-key-order 회귀2개를 보강했다.

최종 source에서 실제 재실행한 결과는 targeted **98/98 PASS**, 전체 `npm test` **2,174건/74파일 PASS**(exit0), `npm run typecheck`, `npm run build`, 두 새 코드 파일의 `npx biome check`, `node --check`, `git diff --check` PASS다. typed-array 본래 byteLength/buffer/offset을 사용하여 caller가 metadata getter를 위장해도 호출하거나 크기 제한을 우회하지 않는다. source module SHA는 `033ef02f0597c097849b4e6ca110e1115f08006e3d2114a60327439200abbbe7`, test SHA는 `3419527d543496aa296f8749b4d1a408487c51125d592b1a791eb6d50ed9f030`다. 검사 출력은 실제 tool 실행 결과이며 author가 별도 로그 파일을 생성한 것은 아니다. 전체 `ci:quality`(secret/OpenAPI/full lint를 포함한 단일 chain)는 이 author가 실행하지 않았고 root 후속이다.

root가 같은 신규 source에서 전체 `npm run ci:quality`를 실제 실행했고 **2,174건 / 74파일**, secret/OpenAPI/lint/typecheck/test/build 모두 PASS(exit0)다. 기존 lint informational5건은 유지했다. 비추적 검증 로그 `.tmp/qa378-history-codec-quality.log` SHA256은 `c6885f9f1f82f85b47614267f614c6d2f573cfc74cd9e96cc63c64f686fdb82f`다. 이 결과는 실제 Windows application/source 검증이며 DB/TLS 검증이 아니다.

후속 non-author QA가 P2 한 건을 재현했다. 문서상 unsupported인 `SELECT E'plain';`, `SELECT e'';`, `SELECT $1$x$1$;`, `SELECT $١$x$١$;`가 unbound 모델에서 수락됐다. 모든 flags는 계속 false였고 DB 실행 우회는 아니지만, 명시한 conservative 지원 범위와 불일치하므로 single-quote 직전 E/e prefix와 dollar tag 첫 Unicode Nd를 fail-closed하도록 보완했다. 최초98/전체2,174 PASS는 이 P2 발견 전 checkpoint로 보존한다. 기존 검사를 삭제·skip하거나 지원 명세를 완화하지 않고 네 재현을 회귀 검사에 추가했다.

보완 후 root의 실제 targeted **102/102**, syntax/Biome 두 파일 및 전체 `npm run ci:quality` **2,178건 / 74파일**, typecheck/build까지 PASS(exit0)다. 신규 source module SHA는 `566eda9f1cffec3967e6180387a24c08327e7068e3cfff6c80d3a938173deb0f`, test SHA는 `20804bc78e1d44e60c355322892513a8d01f7fd928d177ca4366d33ee081c6cc`다. 비추적 root 로그 `.tmp/qa378-history-codec-repair-quality.log` SHA는 `feeaf9a3abb377d47e704a8045bdab63ef1ec9447a9cfbae2ede6489ba20cdf8`이다.

non-author는 보완된 source/test를 재검토하고 실제 no-cache targeted102/102, 네 재현 및 supplementary Unicode Nd 거부, 기존 positive5개, syntax/Biome/diff PASS와 신규 P0/P1/P2=0을 확인했다. 두 guard/네 회귀를 역산한 최초 raw hash도 일치하여 다른 코드 변경·검사 약화가 없음을 대조했다. root 전체2,178 로그는 reviewer의 별도 whole 실행으로 표시하지 않는다. 최종 문서-only QA는 후속이다. synthetic immutable Git object driver + 실제 owned bundle/pinned PG parser의 positive source-link 테스트는 실제 approved local ref positive나 CLI/PostgreSQL parity가 아니다. source-linked 모델도 `DBHistoryVerified=false`를 유지한다.

기존 foundation HEAD `f32d757b20fcc387012f9a79d84c3045b7e1961d`의 exact-head CI `37255429560`은 application/migration 모두 SUCCESS로 완료됐다. 이 CI에는 아직 커밋하지 않은 신규 codec3파일이 포함되지 않는다. 신규 source의 exact-head CI·최신 dev 통합·최종 독립 QA는 후속이다. 첫 CI `37254403700`의 application FAIL 이력은 유지한다.

실제 CLI 2.115.0과 controlled PostgreSQL history payload/null/dimension/order readback parity, source-bound 실제 approved-ref positive, baseline legacy NULL/unknown history의 fail-closed cutover, DB schema/권한/TLS/backend identity/full-state coverage, SQL/history 동일 transaction 및 wrapper 실행 정책, finite driver/loss reconciliation, 실제 Supabase-only 백업/복원·release/CI/독립 QA·운영 gate는 모두 후속 **NOT RUN**이다. 원 history를 repair/coalesce/backfill하거나 이력 원문을 rewrite하지 않는다.
