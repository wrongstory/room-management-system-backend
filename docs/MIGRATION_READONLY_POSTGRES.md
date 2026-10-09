# #378 실제 PostgreSQL 읽기 전용 adapter — 구현 후보

> 최신 CI 실패 checkpoint: source0f49dde/run37261192734에서 application은2,344 PASS/1 FAIL,
> migration은 고정 이미지 pull의 ECR rate limit으로 FAIL(TLS19·후속 DB suite NOT RUN)이었다.
> CI Node22.23.3과 로컬22.20.0의 native IPv6 SAN 판정 차이는 공식 upstream #64032와 일치한다.
> adapter의 기본 인증서 검사·SSL/CA/SAN/권한 코드는 수정하지 않는다. 테스트는 native IPv6
> 거부를 그대로 보존하고 모든 버전의 잘못된 IPv6 SAN을 별도로 거부한다. 새 exact-head CI는 후속이다.

최신 좁은 CI portability 보완의 로컬 실제 결과는 targeted128/128, `ci:quality`2,346/76,
typecheck/build/secrets/OpenAPI/lint(기존 INFO5), 실제 isolated PG17/TLS19가 모두 PASS다.
quality 로그 SHA-256은 `3722717278f9feceff6f7e14bc90473d6410380db02f85292567b029dafb17ae`,
TLS 로그는 `b1d648719b307364910b6397393d00af5ef933c41d24e71919e37f01c92afc49`다.
root의 실제 workflow body 메모리 전용 Bash probe5도 PASS했다(실제 pull/네트워크 결과 아님).
첫 test 보완의 TypeScript peer certificate fixture 타입 오류 두 차례는 FAIL로 남기고,
기존 native legacy certificate를 상속해 최종 typecheck를 재실행했다. production adapter는
SHA-256 `6befb0c233c3bb095420cbc66e33f160a5b78f85634ce1bac7fad49b67f0bb9e`로 불변이다.
독립 QA의 targeted128/typecheck/lint/syntax/diff, 실제 workflow body double7경로,
runner ownership/cleanup 순수메모리14경로는 PASS/P0·P1·P2=0이다. 독립 QA는 DB/Docker/TLS를
실행하지 않았으며 위 실제 TLS는 root 실행 증거다. CI Node22.23.3의 재검증은 아직 NOT RUN이다.

고정 image 준비는 exact-digest cache만 인정하고 최대3회 pull/5초·10초 backoff/3분 step을 사용한다.
최종 실패는 exit1이고 이미지 변경·검사 skip·임의 tag fallback은 없다. Docker Desktop의 OCI index ID와
Linux classic store의 platform config ID를 혼동하지 않도록 생성 전 exact RepoDigest/OS/amd64/ID를
읽고 container Image를 그 observed ID·고정 Config.Image·owner nonce에 결합한다. 원본 registry index
`694296…`의 linux/amd64 manifest `16c094…`와 config `660892…`를 실제 읽기 전용 확인했다.
이는 owned fixture portability 보완이고 원격 DB나 migration 실행 증거가 아니다.

> 최신 root checkpoint: 독립 리뷰 P1(physical column order)·P2(startup 수신 cap)를 보완했다.
> targeted127·전체 ci:quality2,345/76·실제 격리 PG17/TLS19는 PASS다. 아래 author123/2341과
> 처음 NOT RUN은 이전 시점 이력이다. 최종 non-author 재QA·새 exact-head CI와 실제 PG15/
> hosted direct/session/CLI parity·원자 migration 쓰기·전체 상태·운영/백업은 후속이다.

이 slice는 내부 `pg.Client`의 실제 I/O 코드를 구현한다. migration 실행기·운영 승인·전체 DB 상태
검증은 아니다. 소스 테스트의 hermetic driver double은 실제 DB 연결/TLS handshake 성공의 근거가
아니다. 실제 격리 PG17/TLS의 제한 검사는 아래 root 결과와 구분하고, Supabase direct/session pooler,
PG15·pinned CLI parity, backup/recovery,
release/main/production 검증은 후속 gate이며 이 문서에서 PASS로 선언하지 않는다.

## 고정 범위와 의존성

- 새 module: `scripts/lib/migration-readonly-postgres.mjs`.
- 런타임 `pg` **8.23.1**, 개발 타입 `@types/pg` **8.23.1** exact pin을 사용한다.
  2026-10-05 공식 npm registry에서 현재 version/license/Node engine을 확인했다.
  package/lock 설치·검증은 root가 담당한다. 다른 DB 드라이버는 추가하지 않는다.
- `pg` npm metadata의 source commit은 `0980cefebe0ae461da8883703be049fe13ca96cf`다.
  해당 Client/Connection/ConnectionParameters/Node stream 소스를 실제 읽었다. 내부 socket 접근은
  이 고정 버전에 종속되므로 버전 변경 시 연결 종료·TLS·타입 parser 경계를 다시 검증해야 한다.
- 기존 codec/policy/source bundle·SQL·manifest·Edge API·업무 데이터 계약은 변경하지 않는다.
  history에는 checksum 컬럼이 없다. 정확한 `version/name/statements` decoded model을 사용하며
  실행 parser의 body-only `statementsSha256`을 history hash로 재사용하지 않는다.

## 공개 경계

`observePostgresMigrationHistory(input)`만 연결을 만든다. input의 exact 필드는
`target`, `credential`, `caPem`, `expectedVersions`, `deadlineMs`, `queryMs`다.
`target`의 exact 필드는 `scope/mode/projectRef/host/port/database/role`, credential은 password 하나다.
추가 SQL·driver/factory/callback·connectionString·SSL override·VERIFIED/승인 flag를 받지 않는다.
getter, symbol, sparse array, 잘못된 순서/중복 version도 연결 전에 거부한다.

- `SUPABASE/direct`: `db.<20 lowercase-letter ref>.supabase.co:5432`.
- `SUPABASE/session`: Connect dialog에서 확인한 `aws-<index>-<region>.pooler.supabase.com:5432`.
  지역으로 주소를 추측하지 않는다. username은 서버 role과 project ref로 구성한다.
- transaction mode·6543·전용 transaction pooler·Unix socket·임의 host는 거부한다.
- `ISOLATED_LOCAL`은 project ref null, direct, localhost/127.0.0.1/::1, 명시된 비특권 포트만 허용한다.
  이는 격리 fixture 검사 용도이고 원격 프로젝트 신원이나 운영 승인으로 승격하지 않는다.
- database는 `postgres`로 제한한다. role은 ASCII PostgreSQL identifier 하나이며 실제
  `session_user/current_user`가 그 role과 같아야 한다.

hostname 형태와 session username은 연결 대상의 caller expectation이지 Supabase 프로젝트 관리
권한 증명은 아니다. `projectIdentityIsCallerClaim=true`, `remoteProjectVerified=false`를 유지한다.

## TLS와 비밀번호

CA는 메모리 입력의 현재 유효한 CA PEM 1–4개, 최대 128 KiB다. OS 파일·환경변수·비밀 저장소·
브라우저/clipboard를 module이 읽지 않는다. SSLRequest 방식, TLS 1.2 이상,
`rejectUnauthorized=true`와 Node 기본 `checkServerIdentity`를 강제한다. CA 또는 hostname
검사 실패 때 비암호화·무검증 연결로 fallback하지 않는다. 실제 connect 완료 뒤 owned Client의
native TLSSocket `encrypted/authorized/authorizationError`와 peer certificate hostname를 재검사한다.

host/port/database/user/password/encoding/application name/replication/options/TLS negotiation/timeouts는
모두 명시적으로 제공해 누락 입력의 PG 환경변수·pgpass fallback을 막는다. 비밀번호는 비어 있을 수
없으며 반환값·오류·감사·로그·파일·URL에 넣지 않는다. 종료 뒤 adapter와 owned driver의 password
참조는 지우지만 JS immutable string과 호출자의 메모리를 안전하게 zeroize했다고 주장하지 않는다.

## 유한 I/O와 연결 동일성

전체 monotonic deadline 250–30,000 ms, 개별 connect/query 상한 100–5,000 ms,
owned connection 종료 최대 500 ms를 사용한다. deadline을 갱신하거나 자동 재시도하지 않는다.
client deadline과 server statement/lock/idle-in-transaction timeout을 함께 설정하며 실제 설정을
readback한다. owned pg Connection의 `sslconnect`에 connect 이전 hook을 붙여 startup/auth부터
history까지 decrypted protocol data를 하나의 40 MiB counter로 감시한다. native TLSSocket 설치
시점에는 auth/authorized를 추측하지 않고, connect 완료 뒤 CA/SAN/owned socket 동일성을 검증한다.
lock timeout은 개별 query 상한의 절반으로 더 짧게 고정한다.

내부 고정 SQL 순서는 다음뿐이다.

1. `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`와 transaction-local timeout/search_path.
2. `pg_backend_pid()` + microsecond `backend_start` + 내부 CSPRNG application nonce + DB/role OID,
   role·PG 15/17·client/server UTF8·read-only/isolation/timeout 검사.
3. history catalog의 정확한 세 컬럼 이름·타입·nullability·version 단일 PK 및 ordinary/non-RLS table 검사.
   pinned CLI가 version → statements → name으로 생성하는 physical attnum 순서는 계약이 아니다.
   이름 기반 exact set을 검사하고 version PK도 실제 version attribute 번호로 확인한다.
4. 전체 count 최대 512·배열 1D/최대 10,000 원소/이름 상한 census. 이어 exact JSON 전송 bytes
   최대 32 MiB census. 두 census는 같은 snapshot이며 큰 결과를 받기 전에 실패한다.
5. 전체 history를 C-collation version 순서로 읽고, 같은 연결 식별 tuple과 peer certificate를 재확인.
6. 읽기 transaction `ROLLBACK` 응답과 connection 종료 완료 후에만 opaque observation 발급.

SQL accessor·일반 query 함수·PID-only cancel/terminate·migration/history write/repair API는 없다.
timeout/error/상한 초과 때 **이번 adapter가 만든 socket만** 파기한다. 소켓 종료·timeout·응답 유실이
서버 rollback, migration 적용 0건, 이후 full-state 일치의 증거라고 표현하지 않는다.
오류는 source-controlled 고정 code의 새 Error만 반환하고 native cause/message/stack/SQL/서버
notice/credential은 노출하지 않는다. network/TLS 오류 세부나 인증 실패 원문을 전달하지 않는다.

## 정확한 history 읽기와 증거 한계

`pg` 기본 text-array parser는 차원/하한을 보존하는 검증 경계가 아니므로 사용하지 않는다.
모든 응답 필드는 text OID/format의 array rowMode로 받고 query-local identity parser를 사용한다.
`array_to_json(statements)::text`의 ordered decoded string/null 값과 독립적으로 읽은
`array_ndims/array_lower/array_length/cardinality`를 결합한다. JSON 문자열의 표현 차이를 hash하지
않고 codec의 정확한 decoded row/snapshot을 hash한다. name null, statements null, 빈 배열,
빈 문자열/null 원소, CRLF/Unicode/주석/dollar body, 원소 순서와 lower bound를 보존한다.
2D 이상·metadata 불일치·잘린 행·unknown/missing/duplicate/reordered version은 실패한다.

관찰 handle은 module-private WeakMap에 등록된다. 복사·serialize/deserialize·synthetic VERIFIED
객체·codec caller-row snapshot을 관찰 handle로 취급하지 않는다. 공개 원문 SQL/배열 accessor는 없다.
`comparePostgresHistoryObservation`은 private actual readback과 owned codec snapshot의 exact equality를
비교하되 expected 모델의 source/approval 한계를 바꾸지 않는다.

`driverReadbackObserved/tlsPeerValidated/readOnlySnapshotObserved`는 내부 드라이버 경로의 제한된
관찰 값이다. `executionAllowed/operationalApproval/DBHistoryVerified/fullStateVerified/cliParityVerified`
는 항상 false다. history 값 일치만으로 과거 migration이 정말 실행됐거나 현재 업무 schema/ACL/데이터가
source와 같다고 증명할 수 없으며, CI 테스트 double의 true 관찰 값도 실제 DB/TLS 검증 PASS가 아니다.

## 후속 실제 검증 gate

Root가 별도 승인된 격리 fixture에서 현재 CA·SAN 일치 positive, 틀린 CA/SAN·만료 cert·TLS 불가
negative, actual PG 15/17/null/empty/낮은 하한/Unicode/CRLF/2D history, timeout/disconnect/늦은 응답,
동일 PID의 backend_start/nonce 불일치, history count/bytes 상한, 읽기 role/transaction 검사를 수행한다.
실제 direct/session과 pinned CLI history parity는 각 대상별 별도 근거다. 로컬 격리 proof를 운영
프로젝트 증거로 재사용하지 않는다. source binding/approved ref/TLS target/운영 전체 상태/backup/
release CI·독립 QA·사람 승인·배포/rollback gate는 아직 연결되지 않았다.

## 확인한 공식 근거

- [pg 공식 SSL 문서](https://node-postgres.com/features/ssl), [Client API](https://node-postgres.com/apis/client).
- [pg 8.23.1 npm metadata](https://registry.npmjs.org/pg/8.23.1),
  [types metadata](https://registry.npmjs.org/@types%2fpg/8.23.1).
- [고정 Connection/TLS 구현](https://github.com/brianc/node-postgres/blob/0980cefebe0ae461da8883703be049fe13ca96cf/packages/pg/lib/connection.js),
  [Client](https://github.com/brianc/node-postgres/blob/0980cefebe0ae461da8883703be049fe13ca96cf/packages/pg/lib/client.js),
  [ConnectionParameters](https://github.com/brianc/node-postgres/blob/0980cefebe0ae461da8883703be049fe13ca96cf/packages/pg/lib/connection-parameters.js).
- [Supabase direct/session/SSL](https://supabase.com/docs/guides/database/connecting-to-postgres),
  [현재 changelog](https://supabase.com/changelog),
  [PG 15.19/17.11 breaking changes](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes).
- [Node 22 TLS 검증](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlscheckserveridentityhostname-cert),
  [PostgreSQL 17 배열 metadata](https://www.postgresql.org/docs/17/functions-array.html).
- [Node 공식 IPv6 SAN regression #64032](https://github.com/nodejs/node/issues/64032),
  [22.23.0 native TLS source](https://github.com/nodejs/node/blob/v22.23.0/lib/tls.js).
  로컬 IPv6 literal의 연결 성공을 모든 Node patch에서 보장하지 않으며 native 거부를 우회하지 않는다.
- [pinned CLI history](https://github.com/supabase/cli/blob/18ae43a34a2257458197b62f74e2a97e2b5cf7f9/apps/cli/src/legacy/shared/legacy-migration-history.ts).

## 과거 author 소스 검증 checkpoint

Author가 다음 명령을 실제 실행했다. targeted 123/123, 전체 `npm test` **2,341건/76파일**
(session 9746, exit 0), `npm run typecheck`, `npm run build`, 새 module/test 두 파일 Biome,
`node --check`와 `git diff --check` 모두 PASS다. author는 전체 `ci:quality`·독립 QA를 실행하지
않았다. 이는 hermetic adapter 회귀이며 실제 DB/TLS/CLI parity·운영 검증으로 승격하지 않는다.

- module SHA256: `430cff58515752b6c9caa8ce4fc9280fd91420276671523d126819a1430029cc`.
- test SHA256: `00ac867a899b17778d03f9313078e4a4c761fd0867adbc634eaac7a4324617de`.
- 기존 codec 세 파일은 수정하지 않았으며 새 adapter/test/runbook 세 파일만 작성했다.
  pg package/lock과 dev 통합·기존 tracked 변경은 root 소유다. author는 Git/index/remote/DB/
  Docker/Supabase CLI/비밀 읽기·migration 실행을 하지 않았다.

초기 targeted checkpoint의 **119 PASS/4 FAIL**은 Vitest array-of-arrays parameter spreading
fixture 오류였다. 그 후 constructor mock의 class 변경은 **36 PASS/87 FAIL, unhandled 3건**으로
실패했다. typed constructor function, version object-table, assertion rejection의 즉시 처리를
보완했고 기존 검사 삭제·완화 없이 123 PASS로 재실행했다. 실패 이력은 보존한다.

독립 source QA·actual PG 15/17/TLS/direct/session/CLI parity·source/whole-state/백업·release/
production은 이 author checkpoint에서 NOT RUN이었으며 이 결과만으로 #378을 완료하지 않는다.

## Root 보완·실제 격리 PG17/TLS checkpoint

독립 source 리뷰가 공식 pinned CLI DDL 순서를 재현해 P1을 보고했다. catalog mock의
version/name/statements physical 순서에만 기대던 검사를 exact 이름 집합으로 고쳤다.
official version/statements/name와 다른 physical 순서 두 회귀를 추가해125 targeted PASS였다.
다음 P2는 connect 완료 후 cap listener를 붙이면 startup/auth 수신이 제외된다는 재현이었다.
owned `sslconnect` hook과 하나의 누적 counter를 추가하고 초기40MiB+1 및 초기20MiB+
history20MiB+1 두 음성 회귀로127 targeted PASS를 확인했다. typecheck·Biome·syntax PASS,
최신 `npm run ci:quality`는 **2,345/76 PASS**다. 이전2,341/2,343 결과는 이전 source 기록이다.

최종 module SHA256 `6befb0c233c3bb095420cbc66e33f160a5b78f85634ce1bac7fad49b67f0bb9e`,
test `5bca76d19b7ffbab10c6d5baf2be1ca5da6dfce2b729bf8856a933a85aa5b478`,
quality log `4907f51b6c3af3b90d4e0b3049f24bf85a806a40c9b75f8c6c4dc3f6d586f918`다.

Root가 실제 새 CA/SAN·SCRAM credential을 만든 별도 tmpfs-only PG17 컨테이너에서19개 검사를
실행해 exit0 PASS했다. 빈/null/name/ordered NULL·Unicode CRLF·음수 array lower bound,
owned PID/start/nonce, 잘못된 CA/password/SAN,2D/unknown/추가 row/4번째 column/RLS,
32MiB/512행 상한, mutation 없음·종료 후 session0을 검사했다. peer TLS handshake는 실제이며
소스 mock을 이 결과로 바꾸지 않는다. 원 migration·main/prod/recovery·Auth/PIN은 건드리지 않았다.
정확한 owner label/image와 bind/volume 없음/tmpfs 경로를 확인하고 생성한 컨테이너만 제거했다.
테스트 key/cert는 실제 운영 비밀이 아니며 ignored 임시 경로에 남고 Git에 포함하지 않는다.

재현 명령은 `npm run db:test:migration-readonly-tls`다. Docker 엔진(꺼져 있으면 AGENTS의
Safe Start만 사용), OpenSSL(Windows Git 배포 경로/Linux PATH), 다음 이미지를 먼저 준비한다:
`public.ecr.aws/supabase/postgres@sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb`.
runner는 remote host/env/connection string을 받지 않고 loopback 새 fixture만 사용한다.
CI source 연결은 별도 변경으로 migration job에 exact digest image pull과 실제19개 검사를
각3분 이내 step으로 추가한다. 기존 검사·40분 job deadline·Supabase cleanup을 유지한다.
새 exact-head required result는 아직 PENDING/미실행이며 로컬19 PASS를 Linux CI PASS로 바꾸지 않는다.

첫 임시 fixture는 Docker inspect의 tmpfs 표현(Mounts0/HostConfig.Tmpfs)을 잘못 기대했고,
archive copy를 tmpfs에 직접 보내 파일4개가 보이지 않는 환경 실패도 기록했다. /tmp archive copy
뒤 owned tmpfs로 실제 copy하는 방법을 사용했다. 4번째 column은 catalog rows 상한에서
`POSTGRES_RESULT_INVALID`로 정확히 거부됐지만 최초 fixture가 더 늦은 schema code를 기대해
FAIL했다. 소스 guard를 낮추지 않고 실제 fail-closed 경계를 정확히 기대하도록 fixture를 고쳤다.
이 실패들과 첫19 PASS를 보존하고 최종 source에서도19 PASS를 재실행했다.
최종 actual log SHA256 `00a85fd0eff244777540f5070d9ba67958cb57b80f048226fdfffe510ce38f5d`다.

실제 PG15/expired cert/SSL 불가/lock timeout·disconnect·늦은 응답·controlled tuple 변동,
Supabase hosted direct/session, pinned CLI parity·source-approved binding·full-state·원자 SQL/history
write·loss classification·supervisor·백업/복원·release/main/production은 NOT RUN/미완료다.
비작성자 재QA와 새 CI가 끝나도 이 slice만으로 #378 또는 운영 배포를 완료했다고 표시하지 않는다.
