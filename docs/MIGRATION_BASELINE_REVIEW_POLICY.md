# #14 H1 — 기존 migration 이력을 보존하는 별도 baseline 검증 설계

## 승인 범위와 현재 상태

H1은 **검증 기준을 설계하라는 결정**이다. 기준 수용, 운영 baseline PASS, 과거 SQL의
실제 실행 인정, 원격 조회/변경 또는 D04 실행 승인이 아니다. 기존122개 history와 적용된
source는 보존한다. history repair, 재적용, 이름만으로 대응, 관측 SQL 정규화는 금지한다.
현재 runtime codec의 세 표현과 확인된110건 범위를 바꾸지 않는다.

이 문서·증거 JSON·검토 설계 모듈은 실행기 입력이나 승인 capability가 아니다.
`createHistoricalBaselineReviewDesign`은 기존 owned immutable Git source bundle만 받는다.
모든12개의 현재 source path/name/order/raw bytes/hash를 고정한 뒤8개 표현을 메모리에서
재현한다. 결과는 hash/byte 수/근거/미완료 검사만 포함하며 원문 SQL을 반환하지 않는다.
`baselineAccepted`, `executionAllowed`, `operationalApproval`, `DBHistoryVerified`,
`fullStateVerified`, `remoteSourceVerified`, `liveObservationCollected`는 모두 false다.
새 codec model·CLI·연결·일반 SQL callback·승인 발급·소비·migration은 없다.

source bundle의 ownership은 이 프로세스가 검증한 로컬 Git 객체라는 뜻이다. 원격 저장소
보호 상태, 실제 프로젝트 신원, 사람 승인, 악성 동일 owner 방어를 증명하지 않는다.
출력은 복사 가능한 검토 문서이며 복사본을 실행 권한으로 사용하는 경로가 없다.

## 재사용할 과거 증거와 아직 수용하지 않은 대응

정본 metadata는 [증거 JSON](../scripts/migration-baseline-review-evidence.json)이다.
2026-10-25 production `aodikrxcczbogjpsjwjt`에 대한 제한된4회 SELECT에서 얻은 과거 기록이다.
모든12행은 단일 원소 배열 `[1:1]`이었다. 관측은 현재 live snapshot이나 cryptographic
attestation이 아니다. JSON 자체의 pinned digest와 source 검사는 그 출처 한계를 바꾸지 않는다.

| 구분 | 건수 | 확정된 내용 | 새 기준 수용 전에 필요한 것 |
|---|---:|---|---|
| v0.9.5 timeout wrapper |7|당시 main329a8a3와 현재7개 source가 동일. 본문에 유한 timeout/transaction을 결합한 전체 raw SHA가 history와 일치|정확한 byte 재현·구문/권한/부작용 독립 리뷰, 새로운 표현을 수용할지 별도 기준 결정|
| restrict_non_active_data_api_access |1|고정 source의 full-line 주석과 끝 공백 제거 결과1,179B가 raw SHA까지 일치|이 **한 source**의 주석/문자열 경계 리뷰. 일반 comment-strip 규칙으로 확대 금지|
| harden_data_api_grants |1|과거 Git b3b3ae2의1,745B blob+끝CRLF가1,747B history와 일치|commit→tree→path→blob 원문 출처를 owned Git artifact로 재확인하고 이후73B DROP POLICY 추가의 영향 대조|
| room_event_effective_lookup_indexes |1|#425 기록의1,800B 실제 wrapper SHA가 history와 일치;691B source와 구별|문서 hash만으로 wrapper 원문이 검증됐다고 하지 않음. 당시 exact wrapper artifact와 guard/DDL/transaction 독립 검토|
| initial_core_schema |1|현재31,295B와 history30,730B 불일치. 알려진 Git3종과 raw 대응 미확정|당시 원본 artifact 또는 별도 현재-state 기준 수용에 필요한 독립 증거|
| complaint_deadlines_non_blocking |1|source16,119B에 비해 history99B. 전체DDL/정본 source SHA를 담은 기록이 아님|당시 적용 artifact. 없으면 원본 실행 증명은 불가능하다고 유지하고 별도 현재-state 기준을 검토|

앞8건만 이 모듈이 현재 owned source로 재현한다. 뒤4건을 현재 source로 대신 만들지 않는다.
그중 옛 Git blob/문서 wrapper2건은 조사에서 설명됐지만, 이 모듈이 그 별도 artifact를
소유·검증했다고 주장하지 않는다. 따라서 **원인 설명10/원본 불확정2**와
**이 모듈의 재현8/별도 artifact 필요4**는 서로 다른 수치다.

initial의 주석·빈 행을 제외한654개 history 행 중650개가 현재 source의 행 hash와 대응했다.
세 Git 원본 어디에도 없는62B CREATE POLICY 행1개가 있었으나 이 비교는 순서·중복이나 내부
표기 차이의 의미를 검증하지 않는다. 현재 권한 결함 또는 schema 동등성으로 단정하지 않는다.
complaint의 배포/function readback 기록도99B 이력을 전체 적용 SQL로 복원하지 못한다.

근거: [#425 실제 wrapper](https://github.com/wrongstory/room-management-system-backend/issues/425#issuecomment-6080544897),
[#458 v0.9.5 배포](https://github.com/wrongstory/room-management-system-backend/issues/458),
[#309 complaint 배포](https://github.com/wrongstory/room-management-system-backend/issues/309#issuecomment-5844084725).
원시12개 hash/version/길이와 옛 Git commit/blob/hash는 JSON에 보존한다. SQL·키·개인정보는 담지 않는다.

## 독립 비교의 기준점

현재 운영에 적용됐다고 알려진 prefix는122/head `post_approval_memo_only`다. 최종 후보의
pending123+를 적용한 catalog를 운영122의 예상값으로 쓰지 않는다. `manifest.pending`의
과거baseline78 숫자도 운영 pending 수가 아니다. 확인된110건의 exact 검사도 유지한다.

예상 catalog는 production을 복사해 정답으로 만들지 않는다. 정확한 승인 후보의 immutable
source1~122, PG/extension/runtime 버전과 초기 Supabase managed-schema 기준을 고정한다.
별도 승인된 D03 최종 검증 계획에 **prefix122 관측 checkpoint**를 넣을 수 있는지 먼저 정한다.
최종135 등의 검증 결과만으로122 catalog를 역산하지 않으며, checkpoint 없는 성공 proof를
해당 증거로 재사용하지 않는다. 이 설계 때문에 별도 fresh DB/Full DB를 자동 실행하지 않는다.

source와 실제 catalog의 객체 identity는 schema/name/정확한 함수 인수 등으로 정한다.
OID는 서로 다른 DB의 비교 키로 쓰지 않는다. PG major/deparser/extension 버전이 다르면
표현 차이를 임의 정규화하지 않고 비교 준비 미완료다. 승인된 platform 차이도 exact identity,
source/관측 hash, 이유, 독립 검토를 가진 별도 목록으로 관리하며 wildcard 예외는 금지한다.

## 읽기 전용 검사 명세 — 현재는 NOT RUN

검사 ID는 검토 설계 모듈에 고정한다. 실제 collector는 아직 연결하지 않았다.
기존 full-state collector는 업무 row 원문을 읽는 경로도 있으므로 이 H1 조사에서 그대로 호출하지 않는다.

| 검사 | 입력/읽기 범위 | 출력과 차단 조건 |
|---|---|---|
| EXACT_HISTORY_122 |동일 snapshot의 supabase_migrations.schema_migrations; 정확한 version/name/array 차원·하한·원소수·bytes/hash 전체122행|ordered 전체 지문과 행별 안전metadata. 추가/누락/중복/재정렬/NULL/배열변경/출처불명은 차단. raw SQL은 서버 밖으로 반환하지 않음|
| HISTORIC_ARTIFACTS |고정 Git commit/tree/path/blob 및 당시 wrapper artifact; 외부문서는 URL와 별도 내용 digest/수집 출처|옛source와 현재source의 hash 구분. 문서 요약·caller hash·이름 일치만으로 actual raw source 소유를 승격하지 않음|
| BASELINE_122_CATALOG |pg_catalog의 namespace/relation/column/constraint/index/function/trigger/type/view/rule/sequence 구조. 업무 table 행·sequence last_value는 읽지 않음|source-derived122 catalog와 exact identity별 definition hash 비교. unknown/누락/중복/상한초과는 차단|
| EFFECTIVE_AUTHORITY |객체 owner, role membership/inherit/bypass/superuser 속성, schema/default/object/column/function ACL, RLS 강제·policy command/permissive/roles/using/check, 함수 SECURITY DEFINER/search_path/실행ACL|역할 폐포를 포함한 유효 접근권한 비교. ACL 배열 순서만 비교하거나 PUBLIC/default grant를 누락하지 않음. Auth 비밀번호/token/session/AMR 원문은 읽지 않음|
| FOLLOWUP_EFFECTS |source1~122에서 각 객체의 생성·변경·삭제·권한·호출 의존성; 별도 검토된 마지막 정의와 운영 catalog|후속 변경의 정확한 파일/hash/객체/전후 효과 목록. 단순 같은 문자열이나 마지막 파일명을 덮어쓴 최종값을 근거로 삼지 않음|
| CATALOG_COVERAGE |source와 실제 inventory의 모든 관련 schema/class; extension/platform 소유 객체는 명시 경계|domain/range/multirange/base type/operator/opclass/opfamily/collation/aggregate/text-search/partition/FDW/event-trigger 등 누락을 확인. 미지원이 존재하면 차단하고 범위에 조용히 제외하지 않음|
| OBSERVATION_LIFECYCLE |고정 target/PG/TLS/role/driver/query version, 한 owned READ ONLY RR snapshot, 종료 확인과 후속 drift 재확인|명시적인 유한 실행·query 예산. timeout/부분결과/응답유실/cleanup불명은 UNKNOWN. 새 시도는 새 관측이며 이전 승인으로 자동 실행하지 않음|
| SEPARATE_BASELINE_ACCEPTANCE |완료된 정확한 증거목록·검사 코드/source 지문·차이·남는 불확실성과 독립 QA|H1 설계 승인과 분리된 수용 판단. 모든 검사가 설명돼도 자동 PASS·D04 실행 허가를 생성하지 않음|

읽기는 고정 SELECT와 pg_catalog의 읽기 함수만 사용한다. 업무 RPC, DO, DDL/DML, SET ROLE,
임의 SQL callback, 원격 file/OS 접근, FDW 조회, credential 조회는 범위 밖이다.
함수/정책 정의와 주석은 서버측 hash로만 반환하며 raw definition을 로그·artifact에 넣지 않는다.
대상별 identity allowlist와 정확한 serializer/query hash를 먼저 검토한다. 전역 데이터 내용 hash나
임의 error body는 출력하지 않는다. 집계만으로 schema·권한·데이터 효과가 같다고 주장하지 않는다.

실제 예산은 기존 read-only driver 상한(전체30초/query5초) 이내에서 실행별 명시한다.
결과 행/bytes도 기존 최대100,000행/32MiB 이내의 사전 census와 limit+1로 감시하고,
초과 시 분할결과를 전체 성공으로 조립하지 않는다. 분할이 필요하면 별도 snapshot 일관성
설계를 검토한다. 관측 종료/cleanup과 target 재확인 전에는 검토용 관측을 발급하지 않는다.

## 권한과 후속 migration에 필요한 구체적 대조

1. **initial/grants:** initial의 public core 전체가 출발점이다. notifications뿐이라고 범위를
   축소하지 않는다. 현재 source에 추가된 DROP POLICY가 실제 후속 migration에 의해 보완됐는지,
   기존 정책과 권한의 마지막 정의가 무엇인지 source1~122 전체에서 확인한다. current catalog의
   policy 이름/command/roles/using/check, owner, table/column ACL와 default ACL을 함께 비교한다.
   현재 policy가 안전해 보인다는 이유로 과거 실행을 증명하거나 불명 history를 승인하지 않는다.
2. **complaint:** 고정84번 source의 affected 함수 identity/signature/owner/ACL/security/search_path,
   함수 정의 hash와 이에 의존하는 policy/trigger를 수집한다. 이후122까지의 재정의·rename/drop을
   검토한 변천표로 연결한다.30일/7일 비차단 기능 smoke 기록은 exact definition 대조를 대체하지 않는다.
3. **index112:** 두 대상 index의 정확한 key/order/predicate/include/opclass/unique/valid/ready와
   기존 index 보존을 비교한다. wrapper의 timeout/SHARE lock/guard는 실행 당시 조건이며 현재
   catalog에서 복원할 수 없다. 당시 wrapper artifact 검토와 현재 index 대조를 분리한다.
4. **wrapper113~119/주석 차이:** 본문 bytes 재현이 확인돼도 schema/권한/함수 부작용은 별도다.
  120~122를 포함한 후속 변경이 현재 정의를 바꿨는지 확인한다. wrapper의 임시 설정은 현재 DB
   영속 설정을 바꾼 증거로 취급하지 않는다.

source에는 동적 DDL/DO/function body 또는 data backfill이 있을 수 있다. AST의 최상위 객체
목록만으로 effects coverage를 완료하지 않는다. 재귀 호출·동적 식·미지원 구문은 개별 검토한다.
현재 catalog가 같아도 과거 DML, 삭제, backfill, 외부 효과는 증명되지 않는다. 별도 원장/복구 근거가
없으면 그 한계를 수용 문서에 남기며 current-state 동등성을 historical-execution proof로 바꾸지 않는다.

## 수용 자료와 실패 처리

향후 수용 요청은 project, 정확한 main 후보/manifest/prefix122 source 지문, 전체 history 지문,
12행의 원시 metadata와 출처, baseline122 oracle 생성 proof, 현재 관측의 snapshot/시간/collector
지문과 종료 증거, 객체·권한·후속변경 대조, 미지원 목록, 차이 목록, 독립 QA를 한 문서에 묶는다.
현재 helper는 이 proof를 생성하거나 사람 turn을 검증하지 않는다. 새 관측이 stale해지거나
source/history/query/범위가 바뀌면 다시 평가하며 기간 기본값을 임의로 만들지 않는다.

원본2건을 복구할 수 없다면 '전체 raw history 재현'을 수용 조건으로 쓸 수 없다.
어떤 current-state 증거와 잔여 역사 불확실성을 인정할지는 별도 사용자 판단이다.
H1 선택만으로 이 판단을 이미 받았다고 하지 않는다. 미해명 차이·coverage 공백은 BLOCKED,
관측 실패/상한/중간 종료는 UNKNOWN이며 둘 다 적용 진행을 막는다.

정확한 별도 baseline 수용이 이루어져도 D03 최종 검증, source/main/protected CI, 복구 근거,
D04 실행별 승인, 유한 실행/실패·손실 판정은 유지한다. 데이터/backup/사진삭제 정책도 바뀌지 않는다.
현재 runtime codec 확장이나 수용 경로 구현은 이 설계의 범위가 아니다.

## 검증 경계

후속 [hash-only collector와 prefix122 checkpoint](MIGRATION_BASELINE_METADATA.md)의 소스·합성
검증이 추가되었다. 실제 운영/로컬 관측이나 기준 수용은 별개이며 아래 NOT RUN 경계를 유지한다.

새 합성 검사는 frozen source/hash 재현8건, 변경된12개 source 거부, clone/getter/다른대상/
pending혼입 거부, 오류 비노출, 결과의 false 권한, 기존 runtime 표현3종 불변을 확인한다.
ownership seam은 메모리 double이며 기존 source bundle의 실제 immutable Git 경계 회귀와 구분한다.
운영 SQL/DB/TLS/Full DB/원격 관측/기준 수용은 이번 작업에서 **NOT RUN**이다.
실제 source·권한·catalog 대조 완료 또는 baseline PASS로 보고하지 않는다.
