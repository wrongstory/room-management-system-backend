# #378 실행 경로 후보와 검증 경계

상태: **실제 driver/CLI 구현, source·합성 검증 단계**. 이 변경에서 DB 연결, TLS DB fixture, migration/reset, Docker 실행은 **0회 / NOT RUN**이다. 운영 적용 완료나 #378 전체 완료를 뜻하지 않는다. 이전 정책/AST/history/read-only 문서는 해당 모듈과 당시 단계의 기록이고, 전체 실행 경로의 현재 상태는 이 문서를 따른다.

## 실제 실행 순서

1. `migration:plan -- --request <절대 경로>`는 비밀 없는 JSON 요청과 immutable Git object를 결합한다. 승인/DB 자격증명/DB 연결 없이 안전한 digest 요약만 반환한다.
2. `migration:apply -- --request <절대 경로> --approval-id <UUID>`만 실행 후보가 된다. 공개 CLI는 pg를 import하지 않는 parent watchdog이며 고정 private child를 fork한다. 다른 인자, 기본 인자, 알려지지 않은 입력은 거부한다. 정상 Node 실행 외 loader flag, `NODE_OPTIONS`, `NODE_PATH`도 거부한다.
3. 현재 실행 checkout의 CLI/child/watchdog, 모든 first-party migration 모듈, DB validation gate, package/lock 22개 파일을 승인된 main Git blob과 byte 단위로 비교한다. module 초기화 때와 적용 직전 파일을 모두 비교한다. 다른 checkout, symlink, 변경된 driver, CRLF checkout이 Git LF blob과 다른 경우도 거부한다. 실행용 checkout은 승인 소스와 같은 LF bytes로 준비해야 하며 검증기가 자동 변환하지 않는다.
4. source/integrity 확인 뒤 child가 INPUT_READY를 요청해야 parent가 password, CA PEM, GitHub token을 표준입력 pipe로 전달한다. argv/URL/환경 변수/자격증명 파일/IPC 메시지에 비밀을 넣지 않는다. 입력은 192 KiB/30초 제한이고 초과·오류 때 stream을 파기한다. 원문·DB 행·SQL·native error는 출력하지 않는다. immutable JS 문자열의 완전한 메모리 소거까지 보장하지는 않는다.
5. GitHub read-only 확인은 고정 저장소 `wrongstory/room-management-system-backend`, 운영 프로젝트 `aodikrxcczbogjpsjwjt`, protected main HEAD/tree, 병합된 `release/vX.Y.Z → main`, 관리자 우회 금지/PR/대화 해결/required application·migration check와 최신 성공 check를 확인한다. 기존 `db-validation-gate.mjs`의 `planValidation`을 재사용해 동일 검증 입력의 실제 full DB proof를 확인한다. manifest check만 성공한 경우는 거부한다. 마지막에 main HEAD를 다시 확인한다.
6. 아래 owner-protected 승인 receipt를 검증하고 durable exclusive consumed marker를 fsync한 뒤에만 `pg.Client`를 만든다. 승인 없이 `plan` 결과만으로 실행할 수 없다.
7. 프로젝트별 advisory lock을 잡고, 소유 backend tuple을 기록한다. migration마다 repeatable-read transaction에서 실제 전체 history와 선언한 상태를 다시 읽고 정확한 pre-state를 확인한다.
8. parser가 승인한 각 SQL byte slice를 순서대로 실행한 뒤, 같은 connection/transaction에서 정확한 `version/name/statements` history row를 parameter로 넣고 COMMIT한다. 원래 파일의 승인된 바깥 BEGIN/COMMIT은 별도의 실행 transaction으로 대체하지만 history의 CLI logical tokens에는 보존한다.
9. 독립 connection의 committed snapshot에서 history·catalog·data·sequence와 원래 backend 상태를 확인한다. exact post-state일 때만 다음 migration으로 진행한다. exact pre-state와 원래 backend 소멸 증거가 있어야 NOT_APPLIED, 나머지는 UNKNOWN이다. COMMIT 응답만으로 APPLIED를 선언하지 않는다.

DB 실행은 하나의 monotonic deadline(최대 120초), 양수 statement/lock/idle timeout을 사용한다. 다음 migration에서 전체 예산을 재시작하지 않는다. 응답 유실 때 SQL/history/COMMIT을 다시 보내지 않고 본인 socket만 종료한다. readback도 같은 전체 예산 안에서 한 번만 시도한다. PID만으로 다른 backend를 cancel/terminate하지 않는다.

별도 parent process는 preflight 최대 240초를 감시한다. child의 EXECUTION_READY(request hash, 승인 요청의 overallMs)를 한 번만 받아 타이머를 arm한 뒤 ACK해야 승인 소비/DB 연결 단계로 넘어간다. 실행 deadline은 요청 예산(최대 120초)이며 결과 수신으로 늘리지 않는다. 전체 invocation은 launch 시점의 preflight+execution 상한도 넘지 않는다. 완료 결과를 받아도 child의 정상 exit 확인 전에는 반환하지 않는다.

deadline, IPC 손실, 잘못된 메시지, 예상하지 않은 stdout/stderr, SIGINT/SIGTERM 때 parent는 **자신이 fork한 ChildProcess handle만 SIGKILL**하고 최대 500ms 동안 종료를 확인한다. caller PID, process tree, 다른 DB backend는 종료하지 않는다. child 내부 event loop의 busy loop도 이 외부 타이머를 막지 않는다. 강제 종료/비정상 종료/종료 미확인 결과는 항상 `UNKNOWN`, `retryAllowed=false`, `backendTerminationVerified=false`, `stateReadbackVerified=false`다. OS child 종료는 PostgreSQL rollback·backend 종료·독립 readback 증거가 아니다. 새 구체 승인과 조사 없이 자동 재실행하지 않는다.

정상 parent가 감시할 때의 유한 종료와 실제 합성 busy-loop child 종료를 검증했다. watchdog 자체의 SIGKILL, OS/전원 장애 또는 관리자에 의한 runtime 변조까지 생존한다고 주장하지 않는다. child도 IPC disconnect 시 종료하지만 event loop가 정지한 child의 부모 동시 장애를 해결하는 OS job/container 정책은 이 범위가 아니다.

## 검토할 요청

최상위 JSON은 `requestInput`, `bundleInput`, `coverage`, `target`만 받는다. 비밀 값을 포함하지 않는다.

| 입력 | 필요한 내용 |
| --- | --- |
| `requestInput.policy` | exact project/ref/HEAD/tree/manifest/history, 전체 ordered baseline, ordered pending source/statement/hash, 각 pre/post history 및 coverage/catalog/data/sequence digest, 유한 예산 |
| `requestInput.remote` | 같은 source, 병합 release PR 번호, application PASS, FULL_DB_PASS, independentReview PASS |
| `requestInput.validationFingerprint` | 기존 DB gate가 계산하는 검증 입력 digest |
| `requestInput.recoveryEvidenceSha256` | 검토한 복구 증거 artifact digest. 값 자체는 백업의 실제 존재/복구 성공 증명이 아님 |
| 선택 `requestInput.historySourceMappings` | 아래 설명의 명시적 기존 history 대응표. 요청 digest와 1회 승인에 포함됨 |
| `bundleInput` | `MIGRATION_SOURCE_BUNDLE.md`의 immutable source/manifest/parserMajor/planPaths/wrapper/LF mapping/유한 Git·parser 예산 |
| `coverage` | pending마다 `{version,before,after}`. 각각 아래 serializer coverage. 정책 pre/post의 coverage hash와 실제 일치 필요 |
| `target` | 기존 read-only TLS profile의 SUPABASE direct 또는 session 5432, 고정 운영 project/ref와 postgres role. transaction pooler/복구 프로젝트는 적용 불가 |

`independentReview: PASS`, recovery hash, source body review와 expected post-state는 **사람이 검토한 입력**이다. JSON 문자열이나 digest 자체를 암호학적 QA·복구 증명으로 부르지 않는다. 원격 verifier는 실제 source/보호/CI/full DB proof만 별도로 확인한다. 예상 pre/post 상태는 정확한 대상·범위의 승인된 조사/검증에서 얻어야 하며 현재 DB를 확인하지 않고 채워 넣지 않는다.

기존 운영 도구가 filename과 다른 version을 기록한 경우 `historySourceMappings`의 각 항목은 `{sourceVersion,historyVersion,name,sqlSha256,statementsSha256}`이다. baseline에만 적용하며 local source model 소유권, 원문 hash, logical history tokens hash와 name을 모두 확인한다. version만 바꿔 **예상 비교 모델**을 만든다. 실제 DB history는 수정하지 않는다. 대응표 누락, 중복, 원문 불일치, 순서 불일치, legacy NULL name/statements는 fail-closed다. name만 같은 파일을 자동 추측하지 않는다. 파일 개수나 마지막 migration 번호는 하드코딩하지 않는다.

## 1회 승인 receipt

사용자의 **구체 실행별 명시적 승인 이후에만** operator가 다음 고정 위치에 receipt를 만든다. 이 CLI에는 receipt 생성 기능이 없다.

`$HOME/.codex/approvals/room-management-migrations/<approvalId>.json`

필드는 `approvalId`, `requestSha256`, `projectRef`, `headSha1`, `manifestSha256`, `issuedAtMs`, `expiresAtMs`, `action: APPLY_EXACT_MIGRATIONS_ONCE`, `humanDecision: {threadId,turnId}`이다. UTF-8 `JSON.stringify(value,null,2)`와 마지막 LF의 canonical 형식만 받는다. 모호한 중복 key/다른 serialization을 허용하지 않는다. 유효기간은 최대 15분이고 남은 실행 예산도 포함해야 한다.

경로 및 파일의 owner/쓰기 ACL, regular file/no symlink, 파일 identity와 크기를 확인한다. Windows에서는 본인/SYSTEM/Administrators 외 쓰기 allow ACE를 거부한다. Unix에서는 본인 소유 및 group/world write 금지를 요구한다. marker는 `wx`로 한 번만 만들고 fsync한다. 실패하거나 적용 여부가 불명확해도 marker를 지우거나 같은 요청을 자동 재시도하지 않는다.

**이것은 owner-protected operator receipt다. `threadId/turnId` 문자열을 실제 대화 API로 조회하거나 사람 승인을 암호학적으로 인증하지 않는다.** 신뢰하는 operator가 실제 사용자 승인과 exact 요청의 일치를 확인해야 한다. 일반 자동 개발 승인이나 과거 다른 SQL 입력의 승인을 이 receipt로 승격하면 안 된다. 입력이 달라지거나 새 실행이 필요하면 새 구체 승인이 필요하다.

## 선언한 상태 범위와 지원 한계

`migration-state-snapshot.mjs`는 PG15/17, 명시한 schemas, 12개 catalog kind, 모든 dataRelations/ordered typed columns, sequences를 versioned serializer에 묶는다. 객체 key/row 순서를 canonical 정렬하되 NULL, 빈 문자열, Unicode/CRLF, 중복 행, bigint text, sequence `last_value/is_called`는 보존한다. digest 결과는 원문 값/행을 공개하지 않는다.

collector는 선언 schema 안의 실제 ordinary/partitioned tables와 sequence 목록/column types를 exact 비교하고 빠진 table을 거부한다. catalog는 schema/table/column/constraint/index/function/owner/ACL/default ACL/RLS/policy/trigger/enum·composite·array type/sequence metadata/view/rule/inheritance와 관련 comment를 수집한다. 내부 OID 대신 logical name/definition을 사용한다. 데이터는 ONLY table의 text cells를 모두 읽는다. 100,000행/32MiB 등 기술적 상한을 넘으면 중단한다.

이는 **선언한 schema와 지원한 catalog의 exact state**이고 전체 Supabase 프로젝트, Auth, Storage bytes, 전역 role/extension/database 설정 또는 모든 PostgreSQL catalog의 완전한 복구 증명이 아니다. foreign/materialized data, domain/range/custom base type, aggregate/operator/opclass/opfamily/collation/text-search 설정은 지원 범위를 주장하지 않고 거부한다. 함수/DO body, 다른 schema/전역 객체/외부 side effect와 sequence 비원자 효과는 source review가 필요하다. AST 허용 목록은 부작용 없음의 증명이 아니다. 범위 밖 효과를 포함한 source를 승인하지 않는다.

function 선언 위치의 `SET search_path`와 양수 literal `lock_timeout`/`statement_timeout`(ms/s, 최대 120초)만 parser 예외로 허용한다. top-level SET, 0/음수/default/from current/무제한 timeout은 계속 거부한다. #396 reset 함수의 2초/7초 선언을 지원하지만 timeout 정책을 일반적으로 완화하지 않는다.

serializer의 예상값 비교는 동시 업무 쓰기로도 달라질 수 있다. 필요한 중지 범위/실제 운영 facts/expected-state 수집·리허설은 구체 실행 승인 자료에 포함해야 한다. 현재 구현이 임의로 운영 중단 정책을 정하지 않는다.

first-party byte 검사는 stale checkout/실행 경로 차이를 검출한다. 이미 변조된 Node runtime, package 설치물, 메모리, 악의적인 같은 owner가 검증기 자체를 변조하는 상황까지 인증하는 sandbox가 아니다. 신뢰하는 설치 환경에서 승인된 lock 기반 설치를 사용해야 한다. 이 신뢰 경계를 source hash 검증만으로 해결했다고 주장하지 않는다.

## 남은 운영 검증과 기존 기록

- 실제 PG15/17에서 same transaction history, pre/post catalog/data/sequence, exact existing hosted history/명시적 mapping, positive/negative TLS 및 loss fault matrix를 확인해야 한다. 이번에는 실행하지 않았다.
- required application/migration check 이름과 최신 DB gate를 보존한다. feature → dev는 manifest/source이며 Full DB NOT RUN이다. release → main의 최종 전체 DB 검증, 이후 운영 pending 적용은 각각 해당 실행 승인이 필요하다.
- 사용자 2026-10-24 결정의 **예약 및 연결 일정·체류·객실 이동·점유 이력 백업**이 현재 정본이다. Auth/PIN/photo/cleaning/payroll 전체 복구를 자동 추가하거나 이전 full DB clone 요구를 재도입하지 않는다. `RESERVATION_AUTO_BACKUP.md`와 해당 릴리스의 복구 범위 gap을 함께 검토한다.
- 기존 PR392 CI run `37262541980`: application 및 과거 TLS 19건 PASS, migration FAIL (`reservation_room_move_during_stay.sql:824 SOURCE_ROOM_VERSION_CONFLICT`), 뒤 검증은 미실행이었다. 이 이력을 현재 합성 검증으로 성공 처리하지 않는다.
- 현재 새 테스트는 메모리 PG/HTTP/FS/authority adapter, 실제 parser/local source 및 DB를 import하지 않는 합성 OS child를 사용한다. 실제 child의 preflight/실행 event-loop 정지와 강제 종료를 검증한다. 초기 합성 fixture/기존 export assertion 실패를 수정한 후 재검증했으며 실제 DB 성공 증거로 사용하지 않는다.

이 문서는 실행 승인이 아니다. 승인 자료는 한 문서에서 exact 후보를 검토할 수 있게 모으되, 승인 전에 이 CLI의 apply 경로를 실행하지 않는다.

## 최종 격리 DB 시험 준비 — 아직 실행하지 않음

기존 `db:test:migration-readonly-tls`의 소유권이 확인된 PG17 tmpfs 컨테이너 안에
atomic writer 시험 8건을 추가했다. 최종 Full DB gate가 true인 기존 단계에서만 수행하며,
일반 application/manifest 검사에는 실행되지 않는다. 이 하네스 추가 자체는 DB 실행 승인이
아니다. 이번 개발에서는 테스트 등록·구문·일반 품질 검사만 수행했고 실제 PG 시험은 NOT RUN이다.

- SQL과 history를 한 번씩 같은 transaction에 반영하고 별도 연결에서 실제 상태를 확인
- history 전 연결 손실 및 COMMIT 전 연결 손실에서 실제 SQL rollback 확인
- 서버 COMMIT 성공 응답을 시험 adapter가 숨긴 뒤 재실행 없이 APPLIED 판정
- 실제 제약 위반에서 history 미반영, committed readback 손실에서는 UNKNOWN 유지
- 실제 잘못된 CA와 프로젝트 advisory lock 충돌에서 SQL 실행 전 중단

테스트 전용 Vitest 설정은 `atomic-pg.fixture.mjs`만 명시적으로 수집한다. 가상 프로젝트
`aaaaaaaaaaaaaaaaaaaa`의 transport는 이미 확인한 컨테이너의 loopback 포트로만 연결하며
다른 host·role·port 입력은 거부한다. 외부 주소로의 fallback은 없다. source-bundle 소유권과
remote/approval 입력은 명시적인 합성 adapter이며 실제 GitHub 승인·Full DB proof를 만들지 않는다.
SQL parser·history codec·state collector·pg/TLS·원자 실행기·supervisor는 실제 소스를 사용한다.
따라서 이 시험의 향후 PASS도 운영 CLI 전체 권한 검증이나 실제 운영 migration 성공의 증거가 아니다.
연결 손실은 실제 연결을 닫고 adapter 응답을 숨기는 통제된 fault이며 모든 네트워크 분할이나
서버 crash를 포괄하지 않는다. 해당 추가 장애는 실제 실행 계획에서 별도로 구분한다.

운영 코드·CLI의 SUPABASE 고정 대상, 소스 지문·1회 승인 receipt 조건은 변경하지 않았다.
기존 격리 컨테이너 소유권·이미지 digest·volume 없음·유한 timeout·정리 조건과 workflow의
실행 승인 gate를 유지한다. Docker 시작이나 제품 migration/reset은 개발 중 실행하지 않았다.
