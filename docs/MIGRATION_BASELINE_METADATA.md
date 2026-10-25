# H1 hash-only 관측과 source122 checkpoint

기준 prefix는122(`post_approval_memo_only`)로 고정한다. 최종 검증 대상은 실행 시점에
승인된 **정확한 전체 source/manifest tip**이다.135를 영구 상한이나 완료 조건으로 두지 않는다.
이 구현은 관측 자료를 만드는 경로이며 기준 수용, 운영 migration, 초기화, 배포를 허가하지 않는다.
실제 DB/SQL/TLS/Full DB 및 workflow dispatch는 이번 개발에서 **NOT RUN**이다.

## 수집과 연결 경계

`scripts/lib/migration-baseline-metadata.mjs`는 고정 SELECT와 엄격 decoder다.
public/private/auth catalog, 기본·객체·컬럼·함수 ACL, RLS/policy 양축, 역할 속성/멤버십/
설정, extension metadata를 서버에서 hash한다. 객체 identity도 JSON tuple hash다.
정의·주석·설정 원문은 서버 밖으로 반환하지 않는다. 업무 행, sequence 현재값,
Auth session/AMR/token/password 값은 읽지 않는다. history는122개 version/source name 대응, 원소별 순번·길이·SHA256,
배열 차원/하한을 수집한다. 알 수 없는 name은 source 이름 hash 대조에서 거절한다.

카탈로그100,000행/정의 합계32MiB, history 원소당2MiB/총32MiB/배열당10,000원소,
드라이버 wire40MiB 상한을 유지한다. limit+1·전체 census·합계·정렬·중복·필드 타입을
대조하며 부분 결과를 전체 성공으로 조립하지 않는다. 일반 decoder/fake query는 plain
검토 자료만 만들며 live ownership이나 승인 capability를 발급하지 않는다.

`observePostgresBaselineMetadata(connection, ownedSourceBundle)`은 기존 native pg/TLS
경로 안에서만 관측한다. H1 helper가 owned Git source를 다시 확인하며 project claim과
명시된122개 history version mapping을 검사한다. 기존 schema/census/byte 검사는 유지하고
원문 `statement_values` query는 호출하지 않는다. 한 owned READ ONLY/REPEATABLE READ
snapshot, 전후 backend/TLS identity, rollback 응답과 연결 종료 뒤에만 별도 WeakSet 관측을
만든다. clone은 owned 관측이 아니고 기존 history codec 성공 모델로 바꿀 수 없다.

두 경로는 TimeZone UTC, DateStyle ISO/YMD, IntervalStyle postgres, extra_float_digits3,
bytea_output hex, standard_conforming_strings on을 고정하고 전후 readback한다.
이 설정도 query 지문에 포함한다. PG/deparser/extension/platform 표현 차이를 허용하는
정규화 규칙은 추가하지 않았다. 전체30초/query5초 안에 종료를 확인하지 못하면 UNKNOWN이다.

## 최종 Full DB 안의 fresh 분할

기존 quality workflow의 full=true 최초 fresh 단계만 다음처럼 나눈다.

1. 테스트 merge SHA/입력 지문과 release/hotfix→main route를 확인하고 정본 파일·전체
   migration/manifest/config의 실제 byte를 Git blob에 대조한다.
2. 고정 CLI2.115.0의 `db reset --local --no-seed --version 20261022135443`을 한 번 실행한다.
   정확한 version/name122개를 확인하며 원본 migration을 이동/숨김/변경하지 않는다.
3. 단일 로컬 psql Unix-socket RO/RR 세션에서 같은 hash projection을 수집한다.
   전후 identity/GUC, rollback 응답, subprocess 정상 종료와 해당 backend 부재를 확인한다.
   이 관측은 disposable local oracle이며 운영 TLS 관측이라고 주장하지 않는다.
4. 같은 frozen source의 `migration up --local`로123부터 정확한 최종 tip까지 적용한다.
   최종 **version/name identity 목록**과 기존 fresh 조건을 대조한다. 이 마지막 대조를
   history statements의 source 대응이나 역사 실행 증명으로 표현하지 않는다.
5. 기존 template/TLS/lint/backup dry-run/전체 SQL·upgrade/clock/concurrency/cleanup을
   그대로 수행한다. 정확110→111 실험도 불변이다. 전체 성공·cleanup 후 artifact 업로드까지
   성공해야 기존 Full DB proof에 도달한다. 일반 dev/reused 경로에서는 DB를 실행하지 않는다.

CLI2.115.0의 실제 [native reset source](https://github.com/supabase/cli/blob/v2.115.0/apps/cli/src/legacy/shared/db-bootstrap/recreate-local-database.ts)
(blob `a6f79c3c305f761fd972850604e86a1618a9b164`)는 PG15+의 로컬 DB container/volume을
재생성한다. 따라서 성공 직후 한 번만 새 ID에 결합한다. 이전과 다른 ID, 같은 image/daemon/
endpoint/name/project/ports, reset 구간 내 Created 시각, 불변 config/runtime/source를 요구한다.
실패/timeout 뒤 재추종·자동 재시도는 없으며 이후 capture/up/artifact는 새 ID가 고정돼야 한다.

CLI가 읽을 수 있는 root/supabase `.env` 계열과 SUPABASE/PG/DOCKER/Node preload override가
있으면 거절한다(예시 `.env.example`/`.env.template` 제외). 해당 dotenv 파일 내용/키는 읽지 않는다.
실제 CLI 직전, 관측 후, artifact 직전에도 입력과 로컬 identity를 재검사한다.
이는 신뢰하는 CI/로컬 owner 경계이며 악성 동일 owner나 위조된 전체 실행 환경을 인증하지 않는다.

## 증거와 남은 수용

`.tmp/baseline122-oracle.json`은 새 파일로만 기록한다. merge SHA/전체 입력 지문,
prefix/manifest/전체 파일 지문, 최종 count/head, query 지문과 PG·안전 metadata를 담는다.
SQL/credential/업무값은 담지 않는다. artifact명은 `baseline122-oracle-<tested SHA>`이며
보존 기간은 저장소 기본을 따른다. JSON 자체는 성공 proof가 아니다. 원 GitHub run/attempt/
head·필수 검사·cleanup·artifact 출처와 digest를 별도로 확인해야 한다.

baselineAccepted/executionAllowed/operationalApproval/fullStateVerified는 false다.
범위 밖 schema·전역 dependency·extension 내부 객체·동적 함수 호출의 완전성이나 과거
DML/backfill/삭제/외부 효과는 증명하지 않는다. domain/range/aggregate/operator 등의
미지원 class는 count/hash로 남기고 수용을 차단한다. 세 schema의 관측을 전체 DB coverage로
승격하지 않으며 H1 선택만으로 baseline 수용이나 운영 D04 승인이 완료되었다고 하지 않는다.

D03의 정확 실행 범위에는 최초 로컬 container/volume 재구축1회,122 capture, pending exact
tip 적용, 기존 upgrade별 재구축/fixture와 오류 시 always() stop을 포함해야 한다.
한 CI run은 DB 명령/transaction 한 번이라는 뜻이 아니다. 실패·종료 불명·source drift는
artifact/Full DB PASS를 만들지 않는다. 새로운 별도 reset/fixture를 추가하지 않았다.

검증은 PG15/17 AST, ownership·변조·상한·timeout/cleanup 합성 회귀, 실제 runner의 fake child
I/O/메모리 artifact를 사용했다. 최초 field-name 정규식/CRLF/mock-call 초기화 fixture를
보완했고 same-ID 초안은 실제 CLI source를 확인한 뒤 한정 전환으로 고쳤다. 실제 DB 결과와
native 종료·권한 효과를 합성 PASS로 대체하지 않는다.
