# 운영 migration 유한 실행기 — #378 정책 모델 후보

> 상태: **부분 source 후보 / 운영 실행 불가**. `migration-executor-policy.mjs`는 입력 자료를 비교하고 상태 전이를 모형화하는 순수 모듈이다. 별도 [AST·원문 byte 계획](./MIGRATION_SQL_PLAN.md)은 실제 parser와 유한 worker의 source 검증만 추가한다. PostgreSQL driver, TLS 연결, 별도 DB process supervisor, 실제 출처·승인·DB 증거 수집·검증, DB 실행과 백업은 구현하거나 실행하지 않았다. 이 문서는 운영 명령 또는 승인 절차를 대체하지 않는다. #378은 완료하지 않는다.

## 승인 범위와 운영 경계

- 사용자 결정 B: 운영 Supabase와 복구 전용 Supabase의 두 프로젝트를 사용한다. 실제 백업은 모든 개발 이후 후속 작업이고 운영 migration·배포 이전 필수 gate다. 복구 프로젝트를 dev DB로 전환하지 않는다.
- 로컬 백업 파일, DPAPI, 비밀번호 재설정 또는 기존 recovery Auth·업무 데이터 교체를 이번 source 개발의 선행 요건으로 추가하지 않는다. 실제 백업·복구의 범위와 보존 승인, 검증 증거는 별도 #171 / PR379 및 release 절차가 담당한다.
- 보호된 feature → dev → release → main 흐름, exact-head application/migration CI, 독립 QA, 승인된 릴리스와 배포 전 백업·복원 검증을 우회하지 않는다. main에 릴리스가 병합되기 전 운영 pending migration을 적용하지 않는다.
- 문자열 `refs/heads/main` 또는 `refs/heads/release/vX.Y.Z`를 통과시켰다는 사실은 그 ref의 존재·보호·병합·승인·원격 HEAD를 확인한 증거가 아니다. `VERIFIED`라는 입력값도 실제 검증이 아니다.
- 이 후보에는 CLI, 실행 허용 token, connection string 입력, DB·Drive·Supabase 호출, 자동 retry/repair/rollback/termination이 없다. 모든 공개 결과의 `executionAllowed`는 `false`다. 생산 runner가 이 모듈의 결과만으로 실행을 허용해서는 안 된다.

## 파일과 입력 계약

| 파일 | 범위 |
| --- | --- |
| `scripts/lib/migration-executor-policy.mjs` | dependency-free 비교·예산·첫 pending migration 상태 모델 |
| `tests/migration-executor-policy.test.ts` | 합성 자료를 사용한 순수 unit/source-contract 회귀 |
| `scripts/lib/migration-sql-plan.mjs` / `tests/migration-sql-plan.test.ts` | 별도 실제 PG15/17 parser·원문 byte·유한 worker source 검사; 실행 불가 |
| 이 문서 | 부분 구현 경계, 후속 driver/parser/supervisor 요구사항 |

실제 파일·DB 내용을 hash로 만드는 구현은 없다. digest serializer와 coverage 정의도 이 후보가 정하지 않는다. future verifier는 byte encoding, LF 처리, 정렬, NULL·타입, schema/object/row·sequence 범위와 serializer version을 고정하고, source manifest와 실제 DB를 독립적으로 읽어야 한다. 누락 범위를 같은 hash로 표시해서는 안 된다.

### `createMigrationPolicyModel(input)`

plain data object만 받으며, 알려지지 않은 key, getter, symbol, sparse array, 잘못된 자료형과 숫자를 거부한다. 입력은 복사·freeze되며 opaque plan handle은 다른 object나 JSON으로 재구성할 수 없다. 이 handle은 모듈 내 모델 소유권을 확인할 뿐 운영 capability가 아니다.

- `expectedSource`, `observedSource`: `projectRef`, `sourceRef`, `headSha1`, `treeSha1`, `manifestSha256`, **baseline** `historySha256`의 정확한 일치. Git SHA-1과 SHA-256은 소문자·정확한 길이로 받으며 자동 정규화하지 않는다.
- `expectedHistory`, `observedHistory`: 전체 ordered history의 `version`, `name`, `statementsSha256` 일치. version은 14자리이고 중복·역순·누락·추가·내용 변경을 거부한다. hosted history version과 local filename의 차이를 임의로 repair하거나 재시각화하지 않는다. 별도 승인된 매핑이 있다면 실제 verifier가 명시적으로 검증해야 한다.
- `pending`, `observedPending`: 각각 `version`, `name`, 원 SQL `sqlSha256`, history statement payload `statementsSha256`, ordered `statementSha256s`, `preHistorySha256`, `postHistorySha256`, `preState`, `postState`가 같다. baseline 뒤의 순서와 name 중복, migration 간 pre/post 연결도 확인한다.
- `preState`, `postState`: `coverageSha256`, `catalogSha256`, `dataSha256`, `sequencesSha256` 전부 필요하다. sequence 변경도 불확실한 상태 변화이므로 history 부재만 보고 NOT_APPLIED로 판단하지 않는다. DDL이나 no-op migration의 pre/post catalog·data가 같을 수는 있으나 history digest는 달라야 한다.
- `budget`: `overallMs`, `statementMs`, `lockMs`, `idleTransactionMs`는 양의 safe integer다. server timeout 항목은 PostgreSQL integer millisecond 범위 안이며 전체 예산 이하, lock 예산은 statement 예산보다 짧아야 한다. `transactionTimeoutMs` 등 추가 key는 허용하지 않는다.

원 SQL hash와 parsed statement hash, DB history hash가 서로 일관되는지 **실제 계산하거나 parse하지 않는다**. 같은 허위 입력을 expected/observed에 넣으면 모델 생성이 가능하므로 이것을 운영 preflight PASS로 표현하지 않는다.

### `startMigrationPolicyModel(plan, ownedBackend, startedAtMs)`

첫 pending migration 하나만 모형화한다. 전체 pending stream을 실행하거나 다음 migration으로 이동하는 API는 없다. 여러 모델을 새로 시작해 전체 예산을 다시 부여하는 것은 실제 runner 구현이 아니다. future supervisor는 release 전체의 원래 deadline을 유지하고 각 다음 migration 전 exact committed state를 재검증해야 한다.

- 원래 backend의 `pid`, microsecond를 보존한 `backendStart`, `databaseOid`, `roleOid`, `runId`, `connectionMode` tuple을 보관한다. `direct`/`session`만 허용하고 transaction pooler는 거부한다.
- timestamp는 server identity의 opaque 자료로 형식·exact equality만 비교한다. 서버·연결·application name·취소 secret 소유권과 timestamp의 사실 여부를 인증하는 driver는 아직 없다. PID만으로 cancel/terminate하지 않으며 tuple이 다르거나 재사용 여부가 불확실하면 UNKNOWN이다.
- 외부에서 제공한 nonnegative safe-integer clock sample이 감소하면 중단한다. `startedAtMs + overallMs`의 overflow를 거부한다. 실제 monotonic clock을 읽거나 caller가 거짓 sample을 보내는 것을 방지하는 기능은 없다.

## phase·예산과 응답 유실

정상 순서는 다음과 같다. 각 ACK는 전이 입력일 뿐 실제 PostgreSQL 응답으로 검증하지 않는다.

```text
READY → BEGIN_SENT → SQL_READY
                   → SQL_SENT → SQL_READY 또는 SQL_COMPLETE
                   → HISTORY_SENT → COMMIT_READY → COMMIT_SENT
                   → READBACK_REQUIRED → READBACK_SENT → RESOLVED
```

SQL은 원래 statement index/hash 순서만 허용한다. 모든 SQL ACK 이후 정확한 version/name/statements digest의 history 기록, history ACK 이후 COMMIT을 요구한다. SQL과 history가 **동일 DB transaction**에 들어갔는지는 실제 driver가 보장해야 하며, 이 모델은 그 순서만 검사한다.

- BEGIN, 각 SQL, history, COMMIT, readback도 모두 remaining overall 예산으로 제한된 statement deadline을 갖는다. 정확히 deadline에 도달하면 만료이며, phase ACK로 전체 deadline을 재설정하지 않는다.
- `nextStatementBudget`는 양의 remaining·statement·lock·idle timeout 자료만 반환한다. 1ms 이하 남으면 멈추고 zero를 보내지 않는다. PostgreSQL에서 zero timeout은 무제한을 의미하므로 zero를 fallback으로 쓰지 않는다.
- **PG15에는 `transaction_timeout`이 없다.** `statement_timeout`은 transaction 전체 제한이 아니고 `lock_timeout`은 개별 lock 대기에 적용된다. future runner는 `SET LOCAL`의 양의 server timeout과 monotonic overall supervisor를 함께 써야 한다. idle-in-transaction timeout만으로 query·commit·연결·응답 유실 전체를 유한하게 만들 수 없다. [PostgreSQL 15 client settings](https://www.postgresql.org/docs/15/runtime-config-client.html)
- pre-commit loss와 ambiguous COMMIT loss 모두 readback이 필요하다. COMMIT ACK 자체도 APPLIED가 아니다. response loss 직후 추가 SQL/history/COMMIT은 금지한다.
- readback 시작·완료도 동일 overall/per-statement 예산 안이어야 한다. readback의 response loss·실패·만료는 UNKNOWN으로 영구 중단하며 자동 probe retry하지 않는다. terminal 결과를 다시 입력해 APPLIED나 NOT_APPLIED로 바꾸지 않는다.
- 연결 종료나 cancel 요청 전송을 rollback 확인으로 취급하지 않는다. PostgreSQL cancel은 직접 성공 응답을 제공하지 않으며 진행 중 연결 종료만으로 SQL의 미적용을 단정할 수 없다. [PostgreSQL 15 protocol flow](https://www.postgresql.org/docs/15/protocol-flow.html)

### 분류는 입력 관측의 모델 결과일 뿐 실제 적용 증거가 아니다

독립 committed snapshot이라고 표시된 관측에는 frozen source identity, **전체** history rows/digest, catalog/data/sequences/coverage digests와 원래 owned-backend tuple의 검증·상태가 모두 있어야 한다. 하나라도 missing/unverified/mismatch이거나 PID_REUSED/UNKNOWN/in-transaction이면 먼저 UNKNOWN이다.

| 결과 | 필요한 modeled evidence | 금지된 추론 |
| --- | --- | --- |
| APPLIED | 정확한 전체 post-history와 전체 post-state. 원 backend가 확실히 gone 또는 같은 backend·idle임을 검증 | history version 한 행이나 COMMIT ACK만 보고 성공 |
| NOT_APPLIED | 원 backend가 확실히 gone, 전체 baseline pre-history와 전체 pre-state가 정확히 동일 | history가 없다는 이유, client disconnect/cancel 전송만 보고 rollback |
| UNKNOWN | 위 모든 증거가 갖춰지지 않음, source/state drift, backend 재사용·미검증, deadline/phase 오류 | 자동 retry·다음 migration·history repair·PID-only termination |

APPLIED라도 `executionAllowed=false`, `retryAllowed=false`, `pidTerminationAllowed=false`를 유지한다. NOT_APPLIED도 자동 재시도 승인이 아니다. UNKNOWN은 원래 backend가 확실히 종료되고 자료를 다시 수집할 수 있을 때 별도 승인된 진단·복구 경로에서 판단해야 한다. 이 후보에 그 경로는 없다.

모듈의 오류 message/code는 `POLICY_*` fixed string만 사용하고 입력·native error·cause를 반환하지 않는다. future supervisor는 stack, SQL, 연결 문자열, provider token, secret, 업무·Auth·PIN 값을 console/Git/UI/log에 넘기지 않고 별도 고정 safe-code serializer를 사용해야 한다. 이 후보는 secure child IPC나 secret-memory 보호를 구현하지 않는다.

## 실제 실행기를 추가하기 전에 필요한 작업

1. **parser**: 별도 source 후보의 pinned package/version·실제 PG15/17 AST·원문 byte/outer wrapper·유한 worker 검사를 [기록](./MIGRATION_SQL_PLAN.md)했다. 새 독립 QA와 인증된 출처·승인·manifest/history serializer 매핑, body·표현식·호출 함수의 실제 side effect 검토는 후속이다. lexical split/regex만으로 production SQL을 허용하지 않는다. 외부 side effect, transaction control, transaction 밖 명령, unknown AST 종류를 fail-closed하고 pinned source·statement byte hash를 확인한다. 기존 SQL 원문은 변경하지 않는다.
2. **driver/TLS**: 실제 server/version/project·OID/backend_start·소유 연결과 SSL 인증서를 검증한다. migration은 direct 또는 허용된 session 연결을 사용한다. 인증 정보를 arguments, environment dump, URL, 로그에 남기지 않는다. [Supabase database connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres)
3. **secure supervisor**: source/history/whole-state verifier, real monotonic clock, overall deadline, 각 server timeout, 해당 연결만의 cancel·종료 확인, 유한 readback을 구현한다. PID만으로 다른 backend를 종료할 수 없으며 response loss 때 재전송하지 않는다. process exit/signal이 DB rollback 증거가 아님을 검증한다.
4. **actual local DB**: 준비·SQL·history·COMMIT 각각에서 loss/timeout을 주입하고 lock contention, 원 backend 지연 종료·PID 재사용·missing permissions·state/sequence drift를 실제로 검증한다. SQL/history 원자성, full pre/post catalog/data coverage, PG15 timeout 동작과 cleanup을 확인한다. pure unit PASS를 이 검증의 PASS로 재사용하지 않는다.
5. **release/B 백업 gate**: 모든 기능의 dev 통합·latest exact-head CI/QA, protected release→main, 승인된 실제 Supabase-only 백업·복원 검증과 안전한 소유 연결 준비, manifest/history 및 Security Advisor·release notes·smoke 계획을 완료한 뒤 별도 운영 단계로 진입한다. 현재 실제 백업·복원·운영 migration·배포는 NOT RUN이다.

## 검증 기록

최초 source 모델(READBACK_SENT 보강 전) targeted unit 227건 PASS였다. readback 자체의 유한 deadline/no-retry를 추가한 현재 후보는 `node --check scripts/lib/migration-executor-policy.mjs` 및 `npm test -- tests/migration-executor-policy.test.ts`에서 **248/248 PASS**했다. 이는 합성 자료의 순수 unit 검사 결과다.

baseline `npm ci`는 0 vulnerabilities, 변경 전 `npm test`는 1,437건/68파일 PASS였다. 현재 후보의 `npm run ci:quality`는 실제 exit 0으로 통과했다: secret scan 852파일(새 세 파일 포함), frontend OpenAPI 137 paths / 148 operations, lint(기존 info 5건, 수정 없음), typecheck, 전체 Node **1,685건/69파일**, build 모두 PASS다. `git diff --check`도 PASS이며 기존 추적 파일·migration·package/lock·API 변경은 없다.

독립 source QA, parser·driver·실제 DB·shared DB·Docker·Supabase·credentials·운영 백업·원격 적용·GitHub CI는 이 작업에서 NOT RUN이며 정책 모델 PASS로 대체하지 않는다. 변경 세 파일은 아직 로컬 미추적 후보이며 commit/push/PR/merge/배포하지 않았다.

위 문단은 최초 순수 정책 모델 작성 시점의 기록이다. 이후 정책 세 파일의 exact hash를 대상으로 구현하지 않은 별도 에이전트가 독립 source QA를 수행해 신규 P0/P1/P2 0건을 확인했다. 최신 dev `c2b5618` 통합 시 실제 `ci:quality`는 **1,839건/70파일** PASS였고, parser source 후보 97건을 추가한 root 실제 재검사는 **1,936건/71파일**, secret scan 863파일, typecheck/build를 포함해 PASS였다. 최초 모델의 1,685건과 구분한다. 새 parser 독립 QA에서 concurrent DROP 분류 누락 P2 1건을 발견해 보완했고 두 major 회귀를 추가한 root 재검사 **1,938건/71파일**도 PASS였다. 최초 FAIL 및 보완 이력은 [AST 문서](./MIGRATION_SQL_PLAN.md)에 보존하며 독립 보완 재검토의 신규 P0/P1/P2는 0건이다. 이는 source-only QA이며 실제 driver/TLS/DB 실패 주입·출처/전체 상태 검증·백업/복원·운영 적용·exact-head GitHub CI는 여전히 NOT RUN이다. source 모델과 parser의 모든 결과는 계속 `executionAllowed=false`다.
