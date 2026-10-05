# #378 PostgreSQL AST·원문 byte 계획 후보

> 상태: **source-only / 실행 불가**. 실제 PostgreSQL parser와 유한 worker 격리는 구현했으나 DB driver, TLS, 운영 연결, 실제 승인·Git/manifest/history 검증, migration 실행과 백업은 구현·실행하지 않았다. 모든 결과는 `executionAllowed=false`다. 이 단계로 #378 전체를 완료하거나 배포를 허용하지 않는다. 기존 [정책 모델](./PRODUCTION_MIGRATION_EXECUTOR.md)의 운영 gate를 대체하지 않는다.

## 변경 범위와 근거

- 새 파일은 `scripts/lib/migration-sql-plan.mjs`, `tests/migration-sql-plan.test.ts`, 이 문서뿐이다. 작성자는 기존 순수 정책 모델의 독립 source reviewer였으며 **새 parser 구현에는 author**이므로 새 코드의 독립 QA는 별도다.
- 기준 HEAD는 `c2b56185949cb2a860df5735dd579c8f5e768b80`, 103 migrations / manifest head `photo_collection_provider_context_axis`다. 제품 가이드 전체와 AGENTS, 관련 ERD/DBML/architecture의 review-draft 경계를 확인했다. 제품 정책·권한·보존·Auth TTL을 변경하지 않는다.
- root가 별도로 고정·설치한 dev dependency `@pgsql/parser` **1.5.0**을 사용한다. registry integrity는 `sha512-a5Bn0eVj69g8ae9d0jGxfXpq9bhN6hx2DnU7uiQjoSZtpWLgq1aSA1y3qKkilb+Tm1EV9i56PbZBp5rclyeBAw==`이다. parser author는 package/lock, 기존 policy 세 파일, manifest, source SQL, index를 수정하지 않았다.
- 허용 major는 **15와 17만**이다. 실제 설치본 AST version은 각각 `150001`, `170004`다. README minor 예시는 assertion이나 서버 version 증거로 사용하지 않는다. 실제 운영 PG minor/server identity 검증은 후속 driver가 담당한다.
- Node 22.20.0에서 직접 ESM import는 패키지 내부 directory import 때문에 `ERR_UNSUPPORTED_DIR_IMPORT`로 실패했다. 패키지나 node_modules를 고치지 않고 공식 CommonJS export를 `node:createRequire`로 읽는 방식으로 보완했다. 설치된 `node_modules/@pgsql/parser/README.md` 전체와 [공식 parser 저장소](https://github.com/constructive-io/libpg-query-node)를 참고했다.
- Supabase 스킬에 따라 changelog의 PG15/17 전환 및 [15.19/17.11 변경](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes)을 확인했다. 여기서 실제 DB를 업그레이드하거나 extension을 재설치하지 않았다.

## 입력·출처와 byte 불변식

`createMigrationSqlPlan`은 원본 `sqlBytes`(Buffer/Uint8Array), major, expected/observed model source, 원문 SHA-256, nullable wrapper metadata만 받는다. getter·추가 key·잘못된 형태를 거부하며 자료를 복사한다. source는 project/ref/HEAD/tree/manifest/baseline-history hash 전체의 정확한 일치를 요구한다. raw bytes는 strict UTF-8, NUL 없음, 1~2,097,152 bytes다. 최대 관측 migration은 278,978 bytes였다. CRLF나 Unicode를 LF로 자동 정규화하지 않는다.

**출처를 일치시켰다는 사실은 실제 owner approval·원격 HEAD·보호된 main 병합을 검증한 것이 아니다.** source 결과는 `sourceEvidenceVerified=false`, `sourceReviewRequired=true`를 유지한다. 현재 dev manifest는 `sha256-lf-utf8`인 반면 이 모듈은 전달된 **raw bytes**를 hash한다. verifier가 승인한 정확한 입력 bytes와 그 manifest 매핑을 별도로 검증해야 한다. Windows 원문 또는 승인된 LF 검증본을 이 모듈이 임의 변환하지 않는다.

실제 parser의 `stmt_location`/`stmt_len`을 UTF-8 **byte offset**으로 사용한다. 위치는 safe integer, 범위 내부, UTF-8 경계이며 순서·비중첩·양수 extent를 강제한다. 생략된 0 location은 0, 마지막의 0 length는 EOF까지다. 마지막이 아닌 0 length와 잘못된 delimiter는 거부한다. 양수 length의 끝은 parser가 제외한 실제 `;` 위치여야 한다. PostgreSQL의 [RawStmt 원문 위치 규칙](https://github.com/postgres/postgres/blob/REL_15_STABLE/src/backend/parser/gram.y)을 따른다.

worker는 각 exact slice를 다시 parse해 정확히 한 개의 같은 AST 종류인지 확인한다. slice 사이 및 EOF의 나머지 bytes도 실제 parser에서 빈 문장/주석/구분자만 만들어야 한다. semicolon을 regex나 lexical split으로 분할하지 않는다. 주석·문자열·escape·dollar quote·DO·function body 안의 semicolon은 top-level 문장이 아니다.

whole SQL hash와 ordered exact-slice hashes를 별도로 보존한다. `statementsSha256`은 `{format:"exact-byte-statements-v1",statementSha256s:[...]}`의 UTF-8 JSON SHA-256이다. 이는 기존 Supabase history `statements` serialization/hash와 동일하다고 가정하지 않는다. 기존 history와 연결할 정확한 serializer/coverage verifier는 미구현이다.

public plan에는 hash·byte extent·AST 종류·고정 flag 및 비밀 없는 source metadata만 있다. 원문은 모듈의 private WeakMap에 parser-owned plan과 함께 메모리로만 보관한다. SQL accessor나 실행 API는 없다. GC/메모리는 보안 저장소나 secret-memory 격리를 보장하지 않는다. `inspectMigrationSqlAst`는 mock/untrusted AST codec이며 항상 `parserEvidenceVerified=false`다. 이를 실제 parser-owned 계획으로 승격하는 경로는 없다.

## BEGIN/COMMIT은 삭제하지 않는다

top-level outer BEGIN과 COMMIT은 정확히 한 쌍, 처음/마지막이어야 하며 사이에 실제 statement가 있어야 한다. nested BEGIN, START TRANSACTION, ROLLBACK, SAVEPOINT, 옵션 있는 BEGIN 및 COMMIT AND CHAIN은 거부한다. PG17이 추가한 비의미적 `location:-1`만 좁게 허용하고 다른 필드·옵션을 수용하지 않는다.

원문에 쌍이 있으면 `wrapperApproval`의 exact model source, whole raw SQL hash, 각 wrapper의 start/end/hash가 실제 AST 결과와 모두 같아야 한다. 누락·변경·wrapper 없는 파일에 잘못 첨부된 metadata는 거부한다. 이 입력은 승인 **자료의 일치 모델**일 뿐 실제 승인 주체를 인증하지 않는다. future executor의 인증된 source-controlled approval 및 독립 reviewer 검증이 필요하다.

쌍은 `plan.statements`와 별도 `plan.wrapper`에 원문 byte/hash 그대로 남긴다. 실행 대상 body의 ordered hash만 wrapper를 제외하며, raw bytes를 blind strip/재작성하지 않는다. 실제 DB BEGIN/history/COMMIT의 원자성은 후속 driver 책임이다.

현재 원문에 해당하는 쌍은 두 파일뿐이다. 아래 값은 현재 Windows raw bytes이며 remote history/LF manifest hash가 아니다.

| source | raw SQL SHA-256 | BEGIN `[start,end)` | COMMIT `[start,end)` |
| --- | --- | --- | --- |
| `20260913075134_room_pin_nonce_reservation_hardening.sql` | `b7b23e53a12ce9cd553509dfc37dde616a1b5d54c3fdf25eb8a3e16ef442704c` | `[0,615)` | `[8872,8882)` |
| `20260919230733_generated_room_pin_confirmation.sql` | `d1efc8d27f1d98efe96f6e40a0aa0903ade3913388ff0b53b863894c3ae92911` | `[0,5)` | `[23846,23856)` |

BEGIN slice hash는 각각 `ca299b4af5b55b360cb4d97879ca1731d4dd508986087f7c5d2a833edf5d7aef`, `e6f07d43b5c21db0fbb9a31feac2dc599787763393dd5acbfad80e247eb02ad5`다. 두 COMMIT slice hash는 `1f592581b6542ee5171dc35e0bffd3860ab35f0faf3324878c25d15bb9f0efaf`다. BEGIN 앞 원문 주석도 해당 slice에 포함한다.

## 실제 103-file AST inventory와 분류 이유

현재 103파일을 PG15와 PG17 parser로 **읽고 parse만** 했다. 두 major 모두 3,363 statements / 29 top-level AST 종류이며 syntax parse 실패 0이다. filename 순서의 raw SHA 목록 JSON `{format:"migration-raw-sha256-v1",files:[[filename,rawSha],...]}` hash는 `548b3e0310635d846ad072d61e667f01feddcf9f4ac81eb36f97e7929872e1d0`이다. SQL 실행·신규 원격 history 검증 결과가 아니다.

26종은 현재 source에서 관측된 transactional SQL **검토 후보 분류**다. source-reviewed executable allowlist가 아니다. 하위 AST/표현식/DB 함수/trigger·extension 의존성의 실제 side effect 및 권한은 아직 승인되지 않았다. 특히 SELECT도 arbitrary function을 호출할 수 있으므로 단순 AST 종류만으로 안전한 read로 판단하지 않는다. 모든 종류는 계속 `sourceReviewRequired=true`, 실행 불가다.

| top-level AST | 개수 | source 분류·검토 이유 |
| --- | ---: | --- |
| `GrantStmt` | 1061 | ACL 대상·역할·권한 원문 검토 필요 |
| `CreateFunctionStmt` | 868 | SQL/plpgsql만 분류; body·동적 SQL·권한 검토 필수 |
| `IndexStmt` | 344 | transactional 후보; concurrent는 별도 hard reject |
| `CreateTrigStmt` | 277 | 호출 함수·이벤트·원장 side effect 검토 필요 |
| `AlterTableStmt` | 264 | 세부 action·제약·이력·기존 데이터 영향 검토 필요 |
| `CreateStmt` | 157 | 관계·제약·default/expression·권한 검토 필요 |
| `CommentStmt` | 95 | 대상·내용·공개 범위 검토 필요 |
| `CreatePolicyStmt` | 66 | RLS role·predicate·우회 영향 검토 필요 |
| `DoStmt` | 45 | default/plpgsql만 분류; 본문 자체는 parse/승인하지 않음 |
| `InsertStmt` | 39 | seed/backfill·trigger·대상 원장 검토 필요 |
| `DropStmt` | 37 | 파괴적 대상·의존성 검토 필요; 외부 extension/server 등 거부 |
| `RenameStmt` | 35 | 대상·호환성 검토 필요 |
| `AlterObjectSchemaStmt` | 15 | namespace·소유권·노출 범위 검토 필요 |
| `CreateEnumStmt` | 14 | 값·제품 정책 정합 검토 필요 |
| `UpdateStmt` | 13 | 원장/current 구분·기존 데이터 영향 검토 필요 |
| `AlterDefaultPrivilegesStmt` | 6 | 미래 권한 노출 영향 검토 필요 |
| `ViewStmt` | 5 | expression/function 및 security_invoker 검토 필요 |
| `AlterRoleSetStmt` | 5 | **hard reject**: role/session 정책 별도 승인 경로 필요 |
| `TransactionStmt` | 4 | 원문 outer pair metadata가 정확히 묶인 경우에만 분리 |
| `CreateExtensionStmt` | 2 | **hard reject**: 외부 extension code 설치를 자동 허용하지 않음 |
| `AlterFunctionStmt` | 2 | 함수 설정·권한·동작 변경 검토 필요 |
| `SelectStmt` | 2 | arbitrary function side effect 검토 필요 |
| `CreateSchemaStmt` | 1 | namespace·권한 검토 필요 |
| `AlterEnumStmt` | 1 | 값·기존 자료 호환성 검토 필요 |
| `DeleteStmt` | 1 | 기존 원장·projection·보존 영향 검토 필요 |
| `LockStmt` | 1 | 동일 transaction·유한 timeout·잠금 순서 검토 필요 |
| `AlterOwnerStmt` | 1 | owner·권한 우회 영향 검토 필요 |
| `CreateSeqStmt` | 1 | sequence 불변식·snapshot coverage 검토 필요 |
| `AlterSeqStmt` | 1 | nontransactional state·재시도 영향 검토 필요 |

source codec 분류는 100파일에서 가능했고, 나머지 3파일은 알려진 hard reject다: 초기 schema의 btree_gist, weekly availability의 pgcrypto, readonly diagnostics의 role settings다. 전체 103 syntax inventory PASS를 전체 103 execution plan PASS로 표현하지 않는다. wrapper 두 원문은 exact synthetic model binding을 사용한 실제 worker 회귀에서도 검증했으나 운영 owner 승인은 아니다.

현재 관측 목록 밖 AST는 unknown으로 거부한다. CREATE/DROP INDEX CONCURRENTLY, 모든 REINDEX/VACUUM, DATABASE/TABLESPACE/ALTER SYSTEM, COPY(file/program/stdin 포함), foreign server/FDW/subscription, extension 설치/수정, role/global SET, CALL/TRUNCATE는 hard reject다. 추가 지원은 별도 정책·구현·독립 QA가 필요하다.

DO와 function body는 raw parser의 string 또는 nested definition일 수 있고 PL/pgSQL 내부·동적 SQL·외부 호출/transaction 제어 안전성을 입증하지 못한다. 해당 종류는 반드시 `requiresBodyReview=true`다. CREATE/ALTER FUNCTION의 **선언 옵션 위치**에 있는 `SET search_path`/`VAR_SET_VALUE`만 top-level SET과 구분한다. 다른 위치·timeout 설정·unknown language는 거부하며 함수 body·설정 검토 필요 상태를 해제하지 않는다.

## 유한 parser worker와 안전한 오류

WASM parse는 synchronous CPU 작업이므로 Promise.race만으로 제한하지 않는다. 동일 module의 private worker에서 package metadata 1.5.0을 재검사하고 actual parse·byte coverage 검사를 한다. parent는 실제 monotonic clock과 고정 **10초** timer, worker termination, 128MiB V8 old-generation/4MiB stack 제한을 사용한다. statement 10,000 및 단일 AST object 200,000 상한을 추가한다. 이 V8 제한은 전체 native/WASM memory를 완전히 제한한다는 뜻이 아니다.

worker stdout/stderr는 private pipe에서 버리고 원문을 console/log에 전달하지 않는다. native parser error의 message/stack/cause/sqlDetails는 반환하지 않으며 `SQL_PLAN_*` 고정 code만 남긴다. timeout/error 시 worker를 한 번 terminate하고 retry하지 않는다. 일반 parser 성공 및 production boundedParse 제어 경로에 합성 busy-worker payload를 주입해 10초 timer/단일 terminate/실제 exit 1을 검증했다. **실제 WASM 무한 hang, DB driver·프로세스 supervisor·PostgreSQL cancel/rollback/운영 deadline 검증은 아니다.**

## 검증 기록과 후속 gate

초기 검증 이력은 보존한다:

1. 직접 ESM import FAIL은 앞의 공식 CJS 경로로 해결했다.
2. 최초 targeted 89건 중 2 FAIL은 잘못 적은 inventory 수량과 PG17 transaction `location:-1` 차이였고, mock 타입 오류로 typecheck도 1 FAIL했다. 실제 3,363 기준·PG17 비의미 필드·정확한 mock 타입을 보완한 뒤 92 PASS였다. 초기 lint warning 2건은 좁은 문법 정리로 해소했다.
3. 실제 wrapper 두 원문을 추가한 95건 중 2 FAIL은 함수 선언의 `SET search_path` AST를 실행 SET과 동일하게 거부한 차이였다. 정확한 선언 위치 예외와 다른 timeout 설정 거부 회귀를 추가했고 원문/TTL/권한/assertion을 변경하지 않았다.
4. 독립 QA의 추가 실제 parser probe에서 PG15/17의 `DROP INDEX CONCURRENTLY`가 `DropStmt.concurrent`로 분류되어 source 계획에서 거부되지 않는 P2 1건을 발견했다. 실행은 계속 불가였지만 transaction 밖 명령 분류의 누락이므로 `IndexStmt`와 `DropStmt` 양쪽의 concurrent를 동일하게 거부하고 두 major 회귀를 추가했다. 재검사 targeted **99/99 PASS**. [PG15 공식 규칙](https://www.postgresql.org/docs/15/sql-dropindex.html)을 따른다. 보완 후 구현하지 않은 별도 에이전트의 독립 재검토는 P0/P1/P2 0건, 실제 targeted 99건과 추가 14 probe 모두 PASS였고 원문103 inventory hash도 동일했다. 최초 추가 probe의 10 PASS/2 FAIL은 보존한다.

최종 실제 source 검사:

- targeted parser **99/99 PASS**(실제 PG15/17 worker·원문 wrapper·UTF-8/CRLF·malformed position·unsafe AST·고정 오류·합성 busy-worker 종료·concurrent DROP 거부 포함).
- 보완 전 전체 `npm test`: **1,936건 / 71파일 PASS**. dev baseline 1,591 + 기존 policy 248 + 최초 parser 97이다. 독립 P2 보완 이후 root 실제 `ci:quality` 재검사는 **1,938건 / 71파일**, secrets/OpenAPI/lint/typecheck/build 모두 PASS였다(log SHA256 `36eb145580cc55ea14b2510a057abcfbf38e9a2cd4690b57aa035ab6ea7a822a`). DB 테스트가 아니다.
- `node --check`, 새 두 파일 Biome lint, `npm run typecheck`, `npm run build`, `git diff --check`: PASS.
- 최종 문서 포함 `npm run secrets:check`: 863파일 PASS.
- 실제 103파일 양 major syntax inventory PASS 및 현재 raw SQL 목록 hash를 별도로 위에 기록했다. 설치 root의 audit 0 기록을 parser 검증으로 대체하지 않는다.

parser author는 DB/Supabase/Docker/credentials/remote/Git index/commit/push/PR/운영을 실행하지 않았다. 새 parser 독립 source QA는 위 보완 후 PASS이며 exact-head CI는 아직 NOT RUN이다. 기존 policy·DB test checkpoint는 새 parser end-to-end 증거가 아니다.

운영 실행기 전에는 source-controlled owner approval와 exact release/main/manifest/history/원문 byte 매핑, body·표현식·extension/role 설정 검토, 승인된 serializer/full-state coverage, 실제 driver/TLS/backend identity 및 유한 cancel/readback, SQL/history 동일 transaction, 실제 local DB 실패 주입/복구, 사용자 B안 Supabase-only 백업·복원 검증, release/운영 smoke gate를 각각 완료해야 한다. 현재 실제 운영 배포는 NOT RUN이다.
