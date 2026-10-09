# #378 고정된 로컬 Git 소스 묶음 검증 후보

> 상태: **source-only / 실행 불가 / 보완 후 독립 software QA PASS**. 이 문서의 구현은 Git 원문·manifest·선택한 실제 parser 계획을 결합한다. 운영 승인, 원격 Git 정본·보호된 병합, DB history/full state, DB driver/TLS, migration 실행, 백업·복원·배포는 검증하지 않는다. 결과는 항상 `executionAllowed=false`, `operationalApproval=false`, `DBHistoryVerified=false`, `fullStateVerified=false`다. #378 전체 완료 또는 배포 허용 근거가 아니다. 아래 작성자 검토 대기 표현은 당시 checkpoint다.

## 범위와 유지한 foundation

새 `scripts/lib/migration-source-bundle.mjs`, `tests/migration-source-bundle.test.ts`, 이 문서만 추가한다. 작성자는 직전 parser의 독립 source reviewer였으나 **이 새 bundle 구현에는 author**이므로 새 독립 QA가 필요하다. 기존 policy/parser/package/lock/문서/manifest/SQL은 변경하지 않는다. 제품 가이드 전체·AGENTS·관련 review-draft 경계를 확인했고 제품 정책·RLS·권한·PIN·Auth TTL을 바꾸지 않는다.

기준 checkout HEAD는 `c2b56185949cb2a860df5735dd579c8f5e768b80`, tree는 `3ee9e20418bada4570e1e26168390020f95dcba3`, 원문 목록은 103파일이다. 기존 [parser 후보](./MIGRATION_SQL_PLAN.md)의 최종 source hash `b047755807f1409f3ad558a97448df7aecafe5186e9b725c05dac26679fdef6f`와 test hash `6446a9dfbf0eefe4b1df88cdf68e77d5f2e666bf836e9a11cd1f96067619492d`를 유지한다. 직전 targeted 99 / 전체 1,938 checkpoint는 **새 bundle의 검증이 아니다**. [순수 실행기 정책](./PRODUCTION_MIGRATION_EXECUTOR.md) 역시 실제 driver가 아니다.

## 입력과 로컬 소스 의미

`createMigrationSourceBundle`은 정확히 다음 8개 필드만 받는다.

| 필드 | 의미 |
| --- | --- |
| `repositoryPath` | 실제 canonical absolute local repository/worktree 경로 |
| `expectedSource` | project/ref/HEAD/tree/manifest/baseline-history hash 6개 |
| `manifestPath` | `supabase/migration-manifest.dev.json` 또는 숫자 version manifest |
| `parserMajor` | 기존 파서가 지원하는 15 또는 17 |
| `planPaths` | manifest 파일 중 계획을 만들 명시적·중복 없는 원문 순서 부분집합 |
| `wrapperApprovals` | 파일별 model source/whole SQL hash/BEGIN·COMMIT exact extent/hash 자료 |
| `lfCopyApprovals` | 아래의 승인 자료가 명시적으로 제공된 temporary LF 매핑 목록 |
| `limits` | 양의 정수 `totalMs`≤120,000, `gitProcessMs`≤10,000, subprocess≤total |

getter/symbol/추가 key/잘못된 plain object·array·hash·path·ref를 거부하고 비동기 처리 전에 metadata를 복사한다. SQL byte buffer나 caller plan, `VERIFIED` flag를 받지 않는다. ref는 `refs/heads/main` 또는 `refs/heads/release/vX.Y.Z`만 가능하고 실제 **local HEAD와 ref의 commit이 같아야 한다**. 다른 개발 checkout에서 release 이름을 임의 붙여 source가 일치했다고 표시하지 않는다.

시작·끝에서 `rev-parse --show-toplevel`이 반환한 actual root의 canonical realpath가 입력 root와 정확히 같은지 확인한다. 저장소의 `scripts` 같은 하위 경로나 redirect/alias/symlink로 root를 줄여 LF outside-repo 경계를 우회할 수 없다. 다른 embedded 저장소의 root를 반환하면 입력·expected HEAD/tree/ref와 일치하지 않는 한 거부하며 다른 저장소로 fallback하지 않는다. Git 출력은 정확한 한 줄 + LF 또는 CRLF만 허용하고 공백·본문을 trim하지 않는다. 같은 observe에서 object format `sha1`, actual local HEAD, ref commit, HEAD tree를 다시 읽어 정확한 expected value와 비교한다.

tree는 `mode SP basename NUL 20-byte OID`의 실제 Git binary framing으로 디코드한다. **root raw object→root의 supabase entry OID→supabase raw tree→migrations entry OID→migrations raw tree→각 migration blob**과 **supabase tree의 exact manifest basename→manifest blob**을 단계마다 묶는다. 모든 tree body에 `tree <byteLength>\0<raw>` SHA-1을 계산해 부모 entry OID와 비교하고 basename/mode/중복/순서/UTF-8/20-byte framing을 검증한다. 별도 `ls-tree`의 경로나 OID를 parent proof로 신뢰하지 않으며 final 구현은 `ls-tree`를 호출하지 않는다. blob framing은 `blob <byteLength>\0<raw>`이고 manifest raw blob SHA-1/SHA-256, 모든 migration raw blob SHA-1/SHA-256과 LF canonical SHA-256을 계산한다. manifest와 migration의 regular non-executable blob만 허용하고, ancestor tree 누락/심볼릭 링크/submodule/중복/path traversal/다른 파일·추가·누락·동일 version·name/count/head/order/hash 불일치를 거부한다. 512파일, 2MiB 각 tree/단일 blob, 32MiB aggregate blob byte 상한을 둔다.

현재 manifest의 `sha256-lf-utf8`은 canonical 해시 규칙이다. 그 해시 검증용 CRLF→LF 계산과 **파서에 전달할 원문 변환은 다르다**. 기본 파서 입력은 Git blob raw bytes 그대로이며 CRLF·UTF-8·주석·semicolon·본문을 수정하지 않는다. manifest는 기존 generator의 exact pretty JSON + LF serialization을 요구해 duplicate JSON key나 비정규 표현을 거부한다. 새로운 serializer·manifest 형태는 자동 수용하지 않는다.

`sourceEvidenceVerified=true`는 **이 호출 시 로컬 Git 객체가 지정된 source와 일치했다는 뜻만**이다. `sourceEvidenceScope='LOCAL_GIT_OBJECT_MATCH_ONLY'`, `remoteSourceVerified=false`, `checkoutSqlVerified=false`, `historyHashIsCallerClaim=true`, `projectIdentityIsCallerClaim=true`를 함께 반환한다. project ref와 baseline-history hash는 형태·bundle binding만 확인한 caller claim이다. 운영 프로젝트, 실제 DB history, 서명된 owner 승인, 원격 보호 브랜치, 리뷰어/원문 body 검토를 인증하지 않는다.

mutable checkout의 SQL은 읽거나 실행 대상으로 사용하지 않는다. checkout SQL의 변경 유무나 untracked 파일 전체를 확인했다고 주장하지 않으며 immutable tracked Git tree 전체의 manifest 집합만 비교한다. 실제 release executor는 인증된 source-controlled 승인과 운영 target·baseline/history/원문 serializer 검증을 별도로 완료해야 한다.

## 명시적인 temporary LF 매핑

자동 LF 변환·기존 migration rewrite·새 파일 생성은 없다. `lfCopyApprovals` 각 행은 다음을 정확히 묶는다.

- original migration `path`, absolute `temporaryPath`, 전체 `modelSource`.
- `gitBlobSha1`, `gitRawSha256`, `canonicalSha256`, `temporarySha256`.
- 정확한 `normalization='CRLF_TO_LF_EXACT'`.

temporary 파일은 repository 밖 canonical path의 regular file이어야 하고 symlink/redirect/alias 경로를 거부한다. Git raw SHA, canonical SHA, temporary SHA를 비교하며 temporary bytes가 **원문에서 CRLF만 LF로 바꾼 결과와 byte-for-byte 같아야 한다**. 파일 handle 전후의 identity/size/mtime/ctime와 path identity, 원문 수량/UTF-8/독립 CR도 검사한다. 한 byte라도 다르거나 wrong source/blob/path/proof, implicit `AUTO_NORMALIZE`면 거부한다. temporary 파일은 읽기 전용으로만 연다. 이 매핑은 승인 **자료의 일치 모델**이며 누가 승인했는지 인증하지 않으므로 `operationalApproval=false`를 유지한다.

## 실제 parser 소유·동결·노출 경계

manifest 전체의 blob 증거를 확인하지만 actual parser plan은 `planPaths`로 명시한 부분집합만 만든다. 이는 DB에서 실제 pending을 계산한 집합이 아니다. 전체 103파일 중 기존 parser hard reject 3파일을 자동 승인하지 않는다. 계획이 없는 파일은 `plan=null`로 정확히 구분한다.

검증기가 자기 소유 raw bytes로 기존 `createMigrationSqlPlan`을 직접 호출한다. mock `inspectMigrationSqlAst`나 caller plan을 전달받아 parser-owned evidence로 승격하는 경로는 없다. public 결과는 allowlisted file/source hash, count, exact byte extents, AST 종류, frozen plan과 고정 flags만 포함한다. SQL 원문/temporary 경로/Git stderr/credentials는 반환하지 않는다. parser의 SQL accessor 없는 경계를 유지한다. source/body review와 wrapper exact binding을 해제하지 않는다.

bundle/rows/source/plan/statement metadata는 frozen이고 private WeakMap에 bundle identity와 자기 소유 bytes/plans를 보관한다. `isOwnedMigrationSourceBundle`은 **이 module instance가 만든 object identity만** 확인한다. clone/직렬화/다른 객체로 `VERIFIED` 값을 적어도 false다. 이 token은 실행·승인·DB 검증 capability가 아니다. bundle SHA-256은 versioned ordered JSON에 source/manifest/major/file blob/raw/canonical/input mode/plan SQL·ordered statement hash를 묶는다. SQL serializer나 Supabase history hash와 동일하다고 가정하지 않는다. debugger·메모리 dump·trusted module replacement를 막는 secret-memory 보장은 없다.

## 유한 Git 호출과 시간 제한

local Git subprocess는 fixed `rev-parse`, `cat-file` argv만 사용하고 shell을 열지 않는다. stdin ignore, stdout 크기 제한, stderr 폐기, Windows hidden, fixed safe `SOURCE_BUNDLE_*` 오류만 반환한다. 비밀번호·연결 문자열·token argv가 없고 환경변수도 OS executable 경로와 fixed Git 설정 allowlist만 전달한다. inherited credentials/Git trace/config env는 전달하지 않는다.

`--no-replace-objects`, `--no-optional-locks`, `core.fsmonitor=false`, system/global config 차단, prompt 차단과 **`--no-lazy-fetch` + `GIT_NO_LAZY_FETCH=1`**로 missing promisor object의 자동 원격 fetch를 막는다. 이 옵션을 모르는 Git은 실패하며 fallback/fetch하지 않는다. [Git 공식 문서](https://git-scm.com/docs/git)의 no-lazy-fetch 경계를 따른다. local repository config/설치된 Git executable을 악성 코드 격리 boundary로 간주하지 않는다.

실제 monotonic clock으로 aggregate deadline과 subprocess deadline을 검사하고, timeout/output overflow이면 해당 호출이 만든 child에만 한 번 kill을 요청한다. supplied PID나 다른 프로세스를 종료하지 않는다. 현재 구현은 kill 요청 뒤 고정 오류를 반환하며 kernel-level exit/readback 완료를 보장하지 않는다. retry는 없다. Promise total deadline은 filesystem lookup의 hang에서도 호출자를 유한 시간에 실패시킨다. 이미 시작된 OS filesystem I/O는 취소 API가 없으므로 늦게 종료될 수 있지만 다음 Git/parser 작업은 deadline 확인에서 거부되고 handle은 finally에서 닫는다. 이를 DB supervisor의 실제 cancel/rollback 증거로 쓰지 않는다.

existing parser는 실제 private worker의 10초 bound를 유지한다. parser 시작 전 그 10초와 actual root 포함 최종 Git readback 5회에 필요한 subprocess 예산을 예약하며 남은 시간 부족이면 시작하지 않는다. aggregate/per-process/parser deadline 상한은 그대로며 parser의 worst-case bound를 남은 예산에 맞게 줄이거나 무한 timeout으로 늘리지 않는다.

## 실제 검증과 실패 이력

새 targeted 첫 실행은 **85건 중 84 PASS / 1 FAIL**이었다. synthetic wrapper fixture의 COMMIT end가 실제 parser의 semicolon 제외 위치와 달랐고 그 테스트 byte extent만 보완했다. typecheck는 mock spawn overload의 타입 assertion 때문에 1 FAIL했고 `unknown`을 통한 정확한 테스트 경계 타입으로 수정했다. 첫 lint warning 2건은 optional-chain 문법으로 해소했다. 원문/기존 파서/기준/테스트 삭제·skip은 없다.

첫 author checkpoint 검증(독립 P2 발견 전, 최종 보완 증거가 아님):

- `node --check scripts/lib/migration-source-bundle.mjs`: PASS.
- `npx vitest run tests/migration-source-bundle.test.ts`: **85/85 PASS**.
- `npm run typecheck`: PASS.
- 새 module/test Biome lint: PASS, 경고 0.
- 전체 `npm run ci:quality`: **PASS**, 실제 2,023건 / 72파일. 직전 1,938 foundation + 새 bundle 85건이며 이전 checkpoint와 구분한다. secret scan 866파일, frontend OpenAPI 137 paths / 148 operations, lint/typecheck/test/build 모두 실제 완료됐다. lint는 기존 informational 5건을 유지했고 새 warning/error는 0이다. 이 결과는 application/source 검증이며 DB 검사나 exact-head GitHub CI가 아니다.
- `git diff --check`: PASS. 기존 parser code/test/docs와 정책 문서 hash는 직전 checkpoint 그대로다.

후속 독립 review에서 P2 두 건이 발견됐다. 첫 checkpoint는 root tree 자체 hash는 확인했지만 textual `ls-tree`의 nested OID/path/mode와 root raw body 사이 parent proof가 없었고, arbitrary synthetic root text fixture도 이 누락을 감췄다. 또한 `realpath(repositoryPath)`만으로 actual Git top-level을 증명하지 못해 `repo/scripts`를 root로 주고 repo 내부 파일을 outside로 볼 수 있었다. 실행 flag는 계속 false였지만 로컬 source evidence의 누락이므로 위 raw binary tree chain과 actual Git root 재확인으로 보완했다. 기존 85테스트를 삭제·skip하지 않고 실제 binary tree framing fixture로 바꿨으며 18회귀를 추가했다.

P2 보완 후 author targeted **103/103 PASS**, `npm run typecheck` PASS. 첫 P2 보완 lint 실행은 control-character regex 규칙 때문에 2 FAIL이었고 동일 control-character 거부를 code point 검사로 유지해 정리했다. 보완 후 새 Biome lint 경고/error 0, `node --check`, `git diff --check` PASS. 실제 전체 `npm run ci:quality`도 **2,041건 / 72파일 PASS**로 완료됐다(직전 foundation 1,938 + 보완 bundle 103). secret scan 866파일/OpenAPI 137 paths·148 operations/lint 기존 5 infos/typecheck/test/build 모두 PASS다. 원 checkpoint의 2,023 PASS와 이 P2 보완 후 결과를 분리한다. DB·exact-head GitHub CI가 아니며 새 독립 재검토는 여전히 대기다.

대부분의 positive source/mapping/fault test는 **실제 binary tree framing의 합성 Git 객체·합성 Git driver·합성 filesystem metadata + 실제 PG15/17 parser**다. 테스트는 Git ref/object/index나 temporary 파일을 만들지 않는다. 실제 설치된 local Git을 실행한 negative probe는 unrelated caller main/HEAD claim을 `SOURCE_BUNDLE_SOURCE_DRIFT`로, `repo/scripts` 입력을 `SOURCE_BUNDLE_REPOSITORY_UNSAFE`로 거부했다. 현재 codex checkout을 approved main/release로 바꾸지 않으므로 actual immutable approved-ref positive 통합 검증은 **NOT RUN**이다. 합성 Git PASS를 실제 Git source approval 증거로 쓰지 않는다.

파일/index/Git commit/push/PR/DB/Docker/Supabase/credentials/원격/SQL 실행은 이 author가 수행하지 않았다. 독립 QA는 대기다. 문서의 마지막 검증이 실행·배포 gate를 완화하지 않는다.

## 다음 필수 gate

첫 exact-head CI `37254403700`/source `ba00873`의 application은 **FAIL: 2,073 PASS / 1 FAIL**이다. 실제 Git negative probe가 local `main` ref가 없는 detached Linux checkout에서 `SOURCE_BUNDLE_SOURCE_DRIFT` 대신 `SOURCE_BUNDLE_GIT_FAILED`로 거부했다. 둘 다 실행을 허용하지 않지만 원래 테스트가 local main 존재를 암묵적으로 요구했다. 이미 expected source와 다른 실제 HEAD를 읽었으면 approved ref 조회 전에 정확한 drift로 중단하도록 보완하고, unrelated HEAD→missing ref 호출 없음과 matching HEAD→missing ref 여전히 fail-closed 두 회귀를 추가했다. actual negative는 정확히 root/object-format/HEAD의 세 read-only 호출만 수행한다. ref 검증 제거·오류 무시·테스트 skip·checkout/branch 생성은 없으며 flags false와 일치 source의 ref/tree 재검사는 유지한다. 아래 2,074 local PASS는 이 CI 실패 전 checkpoint이며 보완 후 전체 검증·독립 QA·새 exact-head CI는 아직 후속이다. 첫 migration CI가 진행 중이라는 사실을 application 전체 PASS로 표시하지 않는다.

보완1회 후 root의 실제 `npm run ci:quality`는 **2,076건 / 73파일 PASS**, typecheck/build까지 exit0다. `.tmp/qa378-detached-head-repair-quality.log` SHA256은 `bb90f75d3e2b974ce60ce7dc5611b087fd2ed046997bb9d354af3c7bd004ac1e`이며 로그는 커밋하지 않는다. 보완 후 bundle105건 중 새 두 회귀와 actual Git negative가 포함된다. 이는 Windows local 검증이며 Linux 새 exact-head CI는 아직 NOT RUN, 독립 수정 QA도 후속이다. 첫 CI 실패를 local PASS로 덮지 않는다.

후속 독립 보완 QA: non-author가 module `a437ba30d646634820d6870671604e374884e70c9f3e3cc94af3286232cef5bc`/test `80bcfdba3faee73f40b6db772925b05a974718b97d66f68cb2683a09076a6b14`와 문서를 검토하고 실제 targeted bundle105/105(`--no-cache --configLoader runner`), syntax/Biome 두 파일/diff check PASS, 신규 P0/P1/P2=0을 확인했다. root 전체2076/73/type/build 로그는 증적 대조이며 reviewer의 별도 whole 실행이 아니다. matching HEAD의 ref/tree·시작/끝 readback·flags false·timeout/no-lazy-fetch는 유지된다. 새 정확 head의 Linux CI와 실제 DB/운영 gate는 여전히 후속이며 이 QA를 사람 승인으로 표시하지 않는다.

2026-10-05 후속 local checkpoint: policy/parser/bundle을 각각 정상 커밋 `399165a`/`199ac7e`/`c25e99c`로 보존한 뒤, #388이 보호 병합된 `dev@12097563f30d694780c279440c79f12742672d04`를 정상 통합한 후보를 검사했다. 들어온 변경은 기존 offline 검증 runner·그 unit·문서 세 파일뿐이며 위 세 foundation의 실행 불가 경계와 hash는 유지된다. root의 실제 `npm run ci:quality`는 **2,074건 / 73파일 PASS**, typecheck/build까지 exit0다. 원 로그 `.tmp/qa378-offline-integrated-quality.log` SHA256은 `e38e9e9b7fa27b7bee99a76bd46b6df810eb81de7d0679b90f1275deed474aad`다. 직전 2,041/72 checkpoint와 구분하며 로그는 커밋하지 않는다. 이 새 통합 tree의 독립 QA·새 exact-head CI·Draft PR 공유는 후속이다. 실제 approved-ref positive·DB/TLS/history/full-state·백업/운영은 여전히 NOT RUN이며 source-only 단위를 #378 전체 완료로 표시하지 않는다.

보완 후 별도 non-author가 module `88ead3677607e9d60727fb4758ef6a3bd1346b4f13e0b7397a8137fbbbe6fc48`와 test `09b5528db99ba2e92898b08871cadb083182f3b686120a2f7b75f6d50f730b28` 및 당시 문서를 완독했다. 실제 bundle103 + parser99 + policy248, 3파일/450 unit과 node syntax/typecheck/Biome/diff check PASS, 신규 P0/P1/P2=0이다. root도 전체 `ci:quality`를 실제 재실행해 2,041/72와 build 완료(exit0)를 확인했고 `.tmp/qa378-source-bundle-root-quality.log`의 SHA256은 `aeb1ccd0550d86b3ced7c86d44550bc07688aa6b5799cfae7e97d8fc70fb1f3e`다. 이 로그는 커밋하지 않는다. reviewer는 전체 quality를 별도 실행한 것이 아니라 root 증적을 대조했다. 실제 approved-ref positive/DB/TLS/history/full-state/백업/CI/운영은 NOT RUN이며 이 문서 갱신은 기능 검증 범위를 넓히지 않는다.

인증된 owner/source approval·protected remote exact-head 검증, 실제 approved local source fixture 통합, wrapper/body/표현식/extension·role 설정 검토, 실제 history serializer와 full-state coverage, 실제 bounded driver/TLS/backend identity/cancel/readback, SQL/history 동일 transaction 및 commit 불확실성 reconciliation, 실제 local DB 실패 주입·복구는 각각 미완료다. 사용자 B안의 Supabase-only 백업·복원 증거와 release CI·review·merge/운영 smoke도 별도 미완료다. 이 단위는 source-only foundation이며 운영 배포는 NOT RUN이다.
