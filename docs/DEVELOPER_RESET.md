# #396 운영 인계 전 초기화

## 2026-10-25 source 128: 운영 잠금·재인증·admission

[운영 안전 장치 계약](DEVELOPER_OPERATION_GATES.md)에 control marker, 최근 비밀번호
재인증과 임시 세션 폐기 확인, nonce/CAS에 묶인 전환, 유지보수 admission을 설명한다.
marker와 TTL seed는 없으며 미설정은 UNKNOWN이다. 4개 신규 private 보안 관계는
보존 후보에 명시하여 총 189개 관계를 진단한다. 신규 gateEvidence는 기존 일관 snapshot에
합류하며 실제 실행 권한을 주지 않는다. 전 경로 admission hook과 coverage 검증은 후속
독립 개발이다. 실제 DB·Auth·운영 활성화·삭제는 NOT RUN이다.

## 2026-10-25 v1 준비: 실행 없는 공통 진단 확장

PR402의 관계별 독립 행 수 검사를 보존하고 dev `96ec94b`와 통합한 소스를 기준으로
아래 catalog-v2·일관 snapshot·템플릿 inventory 검사와 읽기 전용 개발자 preview API를 추가했다.
삭제 권한은 추가하지 않았다. `executionEnabled=false`이며 정상 진단 결과도 실행 승인·백업
증거가 아니다. 122개 migration 기준 위에 신규 `20261025021139_developer_reset_preview.sql`을
준비했으며 이번 작업에서 DB를 연결하거나 SQL을 실행하지 않았다. 병렬 변경과 최종 통합 시
manifest 순번을 다시 계산한다.
아래 2026-10-07의 로컬111 수치·지문·SQL 결과는 당시 기록이며 최신 DB 검증으로 재사용하지 않는다.

현재 백업은 예약과 연결 일정·투숙·객실이동/점유만 보호한다. Auth/PIN/사진/청소/주급 및
템플릿 전체 이력 보호를 증명하지 않으므로 전체 초기화의 복구 근거로 사용할 수 없다.
초기화 보호 범위를 별도 마련할지 또는 초기화를 보류할지는 통합 결정 문서의 D01에 남긴다.
`RESET_RECOVERY_SCOPE_UNDECIDED`로 실행을 차단하며 기존 백업 범위를 임의 확대하지 않는다.
사진 삭제 개발은 HOLD이며 `PHOTO_DELETION_ON_HOLD`를 유지한다.

이와 별개로 안전하게 가능한 메모리 내 계약·합성 검사는 구현한다. 실제 유지보수/worker drain,
최신 개발자/세션/재인증·운영 시작 전 상태·행별 삭제 정책이 검증되지 않은 상태는 각각 별도
blocker이며 미확인을 통과로 간주하지 않는다. CLI 요약에는 고정 blocker 코드와 건수만 출력한다.

## 2026-10-07 #336 dev 통합 후 재대조

#336/PR401은 source0cc368c → dev f1d1f6d로 보호 squash됐다. required CI37579027245
application/migration PASS, 독립 기능·빌드·staged QA PASS와 source/CI/dev tree 동일성을
확인했다. #336/#400은 source/dev 완료로 종료했으며 운영 배포는 하지 않았다.

#396 진단 foundation에 이 dev를 정상 merge하며 제품 가이드의 두 추가 절을 모두 보존했다.
기존 로컬111 DB를 읽기 전용 재대조한 결과 관계183·FK474·사용자 trigger333·외부 schema
FK2·unsupported0, inventory 누락0·미분류0이다. preserve3/mixed10/reseed2/clear43/review125
분류 후보는 변하지 않았다. catalog fingerprint는
`2946481ddaf3576bd5c7c4e0b963e8455e2b4ccaa095711c5f9b2c9d329049a8`이다.
행/컬럼별 정책 완료나 삭제 순서 검증을 뜻하지 않는다. executionEnabled=false를 유지한다.

계정 집계는 빈 로컬 DB의 모든 건수0이며 개발자 단일성/연결 필요조건을 올바르게 차단했다.
계정을 생성하거나 Auth/PIN/업무 행을 바꾸지 않았다. 이번 단계 fresh reset/전체 SQL은
NOT RUN이며 PR401의 CI 성공을 #396 새 head의 성공으로 대신하지 않는다.
통합본 `ci:quality`105파일/2,663 tests·typecheck/build·secret988·OpenAPI150/162 PASS,
manifest111 PASS다. 별도 독립 QA가 기존 진단 source 보존·두 정책 절·실행 비활성을 확인하고
전용6파일/139 tests를 재실행해 PASS했다. 새 exact-head CI는 후속이다.
아래 미게시 #336 설명은 과거 기록이다.

## 확정 정책

개발자 계정·DB 구조·migration history·검토된 객실/요금 기준정보를 유지한다.
관리자/메이드 계정과 테스트 업무 데이터는 초기화 대상으로 분류한다.
객실 PIN은 미설정으로 돌리되 물리 도어락을 변경했다고 표시하지 않는다.
템플릿 내용·수량·표시 설정은 유지하고 이전 작성 이력은 검증 백업에 보존한다.
개발자의 새 운영 인계 설정으로 새 ID/시각을 등록하며 과거 작성자를 소급 변경하지 않는다.
이는 기능 개발 승인이지 실제 초기화 실행 승인이 아니다.

## 1단계: 내부 분류 검사 (공개 API 아님)

`src/modules/developer-reset/reset-impact.ts`는 서버 수집기가 제공할 manifest와
완전한 catalog snapshot의 관계명 집합·schema fingerprint·행 수 분류를 비교하는 순수 함수다.
미분류/누락/중복 관계, 불완전 snapshot, schema 차이, 음수/소수/overflow,
보존·삭제·재등록 건수 합계 및 처리 방식 불일치를 차단한다.
혼합 테이블(개발자를 보존할 profiles 등)은 행 단위 분류가 필요하다.
실제 보존 대상의 정당성은 이 건수 검사만으로 증명되지 않는다.

결과의 `classificationValid`는 분류 일관성만 의미한다.
`executionEnabled`는 항상 false다. fingerprint는 건수 기반 진단값이며
동일 건수의 행 내용 변경을 감지하지 못하므로 실행 token/CAS/백업 증명으로 사용하면 안 된다.
입력은 클라이언트가 아니라 검증된 서버 수집기에서 받아야 한다.
오류에는 원문 payload/개인정보/임의 relation 이름을 반사하지 않는다.

## 2단계: 템플릿 재등록 계획 검사 (공개 API 아님)

`template-reseed-plan.ts`는 유지할 원본 목록과 새 등록 후보의 일대일 연결,
새 ID 중복/원본 ID 재사용, 개발자·등록시각·인계 사유 일치, 내용 동등성을 검사한다.
객실 타입·청소 종류·duration·각 사진 슬롯의 모든 허용 속성을 비교한다.
배열 위치만 다른 경우는 displayOrder로 정렬해 동등하게 처리하며 실제 표시 순서 변경은 차단한다.
입력을 수정하지 않고 UUID 대소문자를 정규화한다. 오류에는 원문이나 ID를 반환하지 않는다.
보존 참조 목록의 구→신 ID가 계획과 다르면 차단한다.

이는 전달된 목록에 대한 일관성 검사이지 실제 DB의 완전성 증명이 아니다.
sourceComplete/referencesComplete는 향후 서버 catalog 수집기의 사실이어야 하며 클라이언트가
자기 신고하는 값으로 사용하지 않는다. 빈 목록 통과도 DB가 비었다는 증명이 아니다.
이 기본 검사만으로 버전 번호 할당·게시 자격·전체 DB ID 충돌·원 작성자 이력 백업·FK 누락은
검증하지 않는다. 독립 수집 목록과의 ID 충돌·누락 검사는 아래 10단계에서 추가한다.
legacy의 새 게시 지원을 열거나 v7/v8/v9 계약을 재해석하지 않는다.
진단 fingerprint는 서명 token/최근 재인증/백업/TTL/CAS 증명이 아니며 실행은 항상 비활성이다.

## 3단계: 로컬 DB 구조 수집기

`node scripts/read-reset-catalog.mjs`는 고정된 로컬 Supabase 컨테이너만 읽는다.
Docker default context의 로컬 socket/pipe, 컨테이너 이름·project label·실행 상태·포트를
검증하고 컨테이너 내부 PostgreSQL Unix socket으로 접속한다.
CLI 인자와 Docker 대상 환경변수 override는 거부한다. 운영 URL/비밀번호는 받지 않는다.

`reset-catalog.sql`은 REPEATABLE READ READ ONLY transaction에서 pg_catalog만 조회하고
ROLLBACK한다. public/private base table·partitioned/foreign table의 종류와 RLS,
양방향 외래키(외부 schema 연결 포함), 사용자 정의 trigger의 상태·정의/function hash를 읽는다.
statement/lock/process timeout과 출력 크기 상한을 둔다. 업무 행·사진·PIN·Auth 사용자는 읽지 않는다.
원문 catalog와 subprocess stderr는 출력하지 않고 건수·진단 hash만 반환한다.

이 catalogFingerprint는 전체 schema fingerprint가 아니다. column default/type modifier/check,
전체 index/policy/ACL,
함수의 전이 의존성·view/rule/외부 provider 자원은 아직 포함하지 않는다.
실행용 manifest를 만들기 위한 조사 도구다. 4단계 후보 목록을 대조하지만 실행을 허용하지 않는다.
partitioned/foreign table은 unsupported로 표시하며 어떤 경우에도 실행을 허용하지 않는다.
기존 로컬 DB를 읽은 검증이며 fresh DB reset/migration 검증을 대신하지 않는다.

## 4단계: 명시적 테이블 분류 후보

`scripts/reset-relation-classification.mjs`는 관찰한 로컬111 migration의183개 테이블을
이름별로 명시한다. 이름 prefix/wildcard나 새 테이블의 자동 분류는 없다.
새 관계는 unclassified, 명시한 관계가 사라지면 missing으로 표시한다.
그룹/행을 동결하고 분류 version과 manifest fingerprint를 결과에 포함한다.

| 분류 | 수 | 의미 |
|---|---:|---|
| preserve | 3 | room_types, 알림 이벤트 카탈로그, PIN nonce 재사용 방지 원장 |
| mixed | 10 | 개발자/계정 보안 상태 및 객실 기준정보와 파생값 분리 필요 |
| reseed | 2 | 템플릿/슬롯 내용 보존 후 새 인계 설정 등록 |
| clear | 43 | 승인된 테스트 업무 범위의 초기화 후보. 삭제 권한/순서가 아님 |
| review | 125 | 외부 작업·사진·PIN 동기화·감사·권한 등 후속 검토 필수 |

inventoryCoverageComplete=true는 이름 목록의 일치만 의미한다.
review125개와 mixed10개의 행/컬럼 처리 정책은 미완성이며 classificationComplete 및
executionEnabled는 항상 false다. preserve에도 FK/기준정보 승인 검증이 필요하다.
nonce 원장은 저장 PIN이 아니며 같은 암호키의 nonce 재사용 방지 근거이므로
저장 PIN 초기화를 이유로 함께 삭제하지 않는다.

이 목록을 처음 만들 때는 dev110에 없는 #336 후보 관계를 missing으로 차단했다.
#336은 이후 dev에 통합됐지만 최신 실제 DB catalog/분류 정책의 재검토는 여전히 필요하다.
실제 DB 행 수 수집/삭제 SQL에
이 목록을 곧바로 연결하지 않는다. 기존 원장 보호 trigger는 그대로 유지한다.

## 5단계: 개발자 계정 보존의 필요조건 진단

`node scripts/read-reset-accounts.mjs`는 3단계와 동일한 고정 로컬 대상 검증을 거쳐
`reset-accounts.sql`만 실행한다. 인자/원격 연결 override는 허용하지 않는다.
REPEATABLE READ READ ONLY transaction과 시간 제한을 사용하고 ROLLBACK한다.
profiles, login_aliases, auth.users의 ID 연결, auth_password_versions의 존재 여부를
DB 안에서 집계한다. 계정 ID·이름·이메일·비밀번호·토큰은 출력하거나 수집하지 않는다.

개발자 단일성, 활성·잠금·기본 로그인 식별자 상태, Auth 연결, 유지 가능한 활성 별칭,
비밀번호 버전 연결을 검사한다. 관리자/메이드 profile은 초기화 후보 건수로만 구분한다.
연결 없는 Auth 사용자나 미분류 role은 자동 삭제 대상으로 간주하지 않고 차단한다.
개발자의 모든 별칭은 보존 후보 건수에 포함하되 활성화/퇴역 상태를 변경하지 않는다.

`necessaryConditionsMet`는 이 제한된 연결 조건만 의미한다. 실제 로그인 성공,
Auth identity/provider 설정·ban·세션·최근 재인증, 전체 FK 보존, 백업 또는 삭제 권한의
증명이 아니다. 분류 완료 및 실행은 항상 false다. resetCandidates도 Auth 삭제 목록이 아니다.
Auth 계정 삭제만으로 기존 JWT가 즉시 무효화되지 않으므로 실행 단계에서는 별도 세션
차단이 필요하다([Supabase 사용자 관리 문서](https://supabase.com/docs/guides/auth/managing-user-data)).

기존 로컬111 DB에서 읽기 전용 실행 결과 모든 계정 건수가 0이었다.
개발자 필요조건을 차단하는 음성 경로를 확인했으며 계정을 생성하지 않았다.
양성 경로는 단위 fixture로 검증했고 실제 계정 보존·초기화·로그인 시험은 아직 하지 않았다.

## 6단계: 계정 보안 상태 및 FK 경계

계정 진단 형식은 `reset-accounts-v2`다. 새 보안 집계를 생략한 v1 snapshot은
기본값 0으로 통과시키지 않고 거부한다. 다음은 실행 allowlist가 아닌 보존 설계 기준이다.

| 대상 | 보존·분리 기준 | 실행 전에 필요한 확인 |
|---|---|---|
| profiles / login_aliases | 개발자 행과 모든 별칭의 기존 상태 보존, admin/maid는 삭제 후보 | 전체 inbound FK 및 Auth 대응 |
| auth.users / auth_password_versions | 개발자 연결·현재 version 유지, 미연결 Auth 자동 삭제 금지 | Auth API·identity·session 별도 검증 |
| password_verification_rate_limits | 개발자 제한 상태 유지, 다른 계정은 계정별 분리 | 초기화로 개발자의 인증 시도 제한을 우회하지 않음 |
| login_rate_limit_windows | 계정으로 귀속할 수 없는 제한 상태는 일괄 삭제하지 않음 | 해시값 역추적·개인정보 출력 없이 별도 범위 검토 |
| password_change_commands | 미완료 상태가 하나라도 있으면 차단 | 외부 Auth 결과 확정 및 연결 command receipt 검토 |
| password_reset_auth_markers | prepared가 하나라도 있으면 차단 | actor와 target을 모두 확인; 한쪽만 개발자인 기록은 FK 검토 |
| command_executions / audit | 개발자 보안 receipt의 참조를 무조건 삭제하지 않음 | 전이 FK·백업·초기화 감사 증거 분리 |

`auth_pending`, `inconsistent`, `reset_pending`의 password change와 `prepared` reset은
전체 계정 범위에서 집계해 `AUTH_OPERATION_NOT_DRAINED`로 차단한다. lease 만료만으로
외부 Auth 효과가 없었다고 판단하지 않으며 이 진단은 실패 상태를 강제로 완료 처리하지 않는다.

개발자와 다른 계정을 동시에 참조하는 reset marker, 개발자 password change의
reset_command_execution_id 및 개발자 관련 marker의 command 연결이 있으면
`DEVELOPER_RECEIPT_FK_REVIEW_REQUIRED`로 차단한다. 완료된 기록도 검사한다.
developerCommandLinks는 참조 edge 수이며 고유 command/행 수가 아니고,
developerCrossAccountMarkers와 겹칠 수 있으므로 합쳐서 삭제 건수로 사용하면 안 된다.
기존 작성자·대상을 개발자 ID로 바꾸거나 CASCADE/trigger 해제로 통과시키지 않는다.

실제 로컬 DB에서 새 네 집계는 모두 0이었다. 비어 있는 DB의 읽기 실행만 확인했으며,
진행 중/교차 참조가 존재하는 양성 SQL fixture 검증 및 전체 FK 폐쇄 검사는 미완료다.
진단 직후 새 요청이 시작되는 경쟁을 막는 유지보수 잠금·worker drain도 아직 미구현이다.
따라서 이 단계 역시 실행 권한, 전체 계정 정합성 또는 삭제 순서를 제공하지 않는다.

## 7단계: 행 단위 참조 계획 검사

`reset-reference-plan.ts`는 서버 수집기가 전달할 관계·FK 목록과 행별 keep/remove,
각 FK의 대상 행 연결을 검사하는 내부 순수 함수다. 보존 행이 삭제 행을 참조하면
`PRESERVED_ROW_REFERENCES_REMOVED_ROW`로 차단한다. CASCADE/SET NULL이더라도
보존 행을 암묵적으로 삭제·변경하는 것을 허용하지 않는다.
누락된 FK 표현/대상 행, 미등록 관계·constraint, 중복 관계·행·FK·참조,
불완전 snapshot 및 catalog fingerprint 불일치도 차단한다.

행 identity는 수집기 내부의 불투명 키다. 실제 PK 구조나 복합 FK를 문자열로 추측하지 않는다.
nullable FK도 명시적인 null edge가 필요하며, SQL MATCH 규칙에 따라 참조가 없다는 사실은
수집기가 먼저 검증해야 한다. 재등록은 구 ID를 자동 대체하지 않는다. 새 행 및 참조 변경의
검증된 계획을 별도로 생성해야 하며 이 입력에서 reseed disposition은 거부한다.

순환 참조는 각 행·edge를 한 번씩 검사한다. keep/keep 또는 remove/remove 순환의 정합성
통과는 삭제 순서·deferrable constraint·trigger·transaction 실행 가능성의 증명이 아니다.
결과에는 건수와 고정 오류 코드만 포함하고 행 키·원문 payload는 반환하지 않는다.
관계 1,000개, FK 10,000개, 행 10,000개, 행당 참조 200개의 입력 상한을 둔다.

`referencesValid`는 전달된 그래프 내부 정합성만 의미한다. 완전성 flag와 fingerprint를
클라이언트 자기 신고로 받아서는 안 된다. 현 catalog 수집기는 실제 행 그래프를 생성하지
않으므로 전체 실제 DB FK 보존 검증은 아직 완료하지 않았다. 합성 단위 fixture의 충돌,
누락, 순환 경로를 검증했으며 실제 업무 스키마의 데이터 fixture·전체 수집 검증은 후속이다.
항상 executionEnabled=false이며 API·DB mutation·삭제 SQL 생성에 연결하지 않는다.

### #396 후속: 관계별 행 누락 검출

내부 입력 `relationRowCounts`는 모든 관계(빈 관계는 0 포함)의 독립 `COUNT(*)`를
요구한다. 수집된 행의 길이에서 역산하지 않고 행 그래프와 같은 trusted transaction
snapshot에서 수집해야 한다. 관계별 고유 행 수가 다르면 `ROW_COUNT_MISMATCH`,
집계 누락·중복·미등록 관계이면 각각 `MISSING_RELATION_COUNT`,
`DUPLICATE_RELATION_COUNT`, `UNKNOWN_RELATION_COUNT`로 차단한다.
음수·소수·문자열·안전 정수 범위 밖 값과 집계 없는 과거 내부 입력도 거부한다.
따라서 다른 행에서 참조하지 않는 keep/remove 행의 누락도 검출한다.

이는 행 내용 지문이나 완전한 수집기 구현이 아니다. 같은 수의 다른 행으로 바꾸거나
행과 집계를 동시에 조작한 입력을 증명할 수 없으며, trusted 수집기의 snapshot·내용
검증을 대체하지 않는다. 공개 API 계약·실행 권한·삭제 정책은 변경하지 않는다.

2026-10-07 후속 검증: `npm run ci:quality` PASS(105파일/2,680 tests,
typecheck/build/secret scan/OpenAPI 150 paths·162 operations 포함; lint는 기존 info 18건,
오류 없음), 독립 QA reset 6파일/156 tests PASS 및 검토 범위 P0/P1/P2 없음.
`npx tsx scripts/test-reset-reference-fixture.ts`의 충돌·보존·독립 집계 누락 검사 PASS.
DB migration/RLS 변경 없음. fresh DB reset·전체 SQL 회귀·원격 CI는 이 기록 시점 NOT RUN이며
임시 fixture 결과를 실제 초기화·백업/복구 검증으로 승격하지 않는다.

## 8단계: PostgreSQL 임시 fixture 연동 검증

`npx tsx scripts/test-reset-reference-fixture.ts`는 기존 로컬 대상 안전 검사를 재사용하고
고정 `reset-reference-fixture.sql`만 실행한다. 별도 세션의 TEMP 테이블 2개에 합성 행 4개를
넣고 실제 pg_constraint에서 FK 이름·정의 hash를 수집한다. 임시 테이블 행과 FK를
7단계 검사기의 입력으로 변환해 보존 receipt→삭제 maid 충돌 차단을 검증한다.
nullable FK는 명시적 null edge로 전달한다. 실제 application/Auth 테이블은 조회하지 않는다.

이 fixture만 쓰기 transaction을 사용한다. public/private/auth DDL·DML, trigger 변경,
DB reset은 없다. ON COMMIT DROP과 최종 ROLLBACK, 세션 종료로 임시 객체를 정리한다.
실패 시에도 연결 세션이 종료되며 원문 DB 오류/fixture 행 키는 출력하지 않는다.
CLI 인자와 Docker 대상 override를 거부하고 시간·출력 상한을 그대로 적용한다.

로컬 PostgreSQL에서 충돌 차단 PASS를 확인했다. 같은 합성 입력의 모든 행을 보존하는
메모리 내 계획 변형도 PASS지만 SQL의 보존 실행이나 실제 삭제 시험은 아니다.
fixture hash는 합성 FK 정의에 대한 진단 hash일 뿐 전체 실제 schema proof가 아니다.
후속 fixture는 같은 SQL statement에서 TEMP 관계별 독립 COUNT(*)를 함께 수집한다.
참조받지 않는 optional 행만 메모리에서 제거한 변형이 ROW_COUNT_MISMATCH로 차단되는지도
검증한다. 실제 업무 행 누락 재현이나 DB 삭제 검증으로 표현하지 않는다.
이 결과를 실제 업무 DB 전체 행 수집기 완성으로 간주하지 않는다. 복합 FK/MATCH FULL,
최종 분류 predicate, 운영 스키마 전체 적용, 유지보수 잠금과 실제 초기화는 여전히 후속이다.

## 9단계: 구조화 catalog와 일관 snapshot 계약

`reset-catalog.sql`과 `reset-catalog-contract.mjs`의 내부 형식은 `reset-catalog-v2`다.
컬럼명·위치·PostgreSQL 타입명(배열 타입 포함)·nullability, PK/참조 대상 unique index의
컬럼 순서·유효성, FK source/target 컬럼 쌍·대상 key·MATCH/삭제/갱신 규칙·검증/지연 상태를
수집하도록 확장했다. 정의문을 파싱해 컬럼을 추측하지 않고 `conkey/confkey`와 catalog를 사용한다.
참조 대상 index의 순서가 FK 대상 컬럼 순서와 다를 수 있으므로 집합은 비교하되 FK 쌍의 순서는
보존한다. public/private와 직접 연결된 외부 관계의 key/column metadata도 별도 경계로 받는다.
이는 외부 schema 전체의 FK 폐쇄나 Auth 데이터 수집을 뜻하지 않는다.

v1/메타데이터 누락/중복/미등록 컬럼·key/잘못된 경계를 거부한다. 미검증 FK·MATCH PARTIAL,
unsupported key·PK 부재는 별도 건수로 드러낸다. 기존 고정 로컬 연결·READ ONLY·출력 제한은
유지했다. 신규 SQL은 소스·합성 계약 검사만 수행했으며 실제 PostgreSQL 실행은 NOT RUN이다.
정의 기준: [PostgreSQL pg_constraint](https://www.postgresql.org/docs/17/catalog-pg-constraint.html),
[pg_index](https://www.postgresql.org/docs/17/catalog-pg-index.html).

`reset-snapshot.ts`는 기존 PR402 그래프 검사를 감싸는 내부 순수 함수다. 서버 수집기에서
서로 독립적으로 얻은 행 목록·관계별 census·행 내용 token·FK NULL 증거가 같은 snapshot에
속하고 정확히 일치하는지 검사한다. project/source/catalog/classification binding 차이,
동일 건수의 다른 행 내용, 빈 관계의 잘못된 census, 누락/중복/알 수 없는 행·FK·증거를 차단한다.
복합 FK는 MATCH SIMPLE의 일부 NULL과 MATCH FULL의 전부 NULL/일부 NULL을 구별하고,
NOT NULL 위반 및 실제 edge와 NULL 증거의 모순을 차단한다. 그래프 FK 대상도 지문에 포함한다.

이 함수는 trusted collector가 아니다. self-reported snapshot ID/count/hash는 진실을 증명하지
않으며 신뢰되지 않은 요청 본문을 그대로 연결하면 안 된다. 실제 collector는 하나의 READ ONLY
REPEATABLE READ snapshot에서 independent census를 구하고 SQL의 equality/collation으로
대상 행을 해결해야 한다. contentToken에는 실데이터나 저엔트로피 비밀의 재사용 hash를 넣지 않고
해당 snapshot 전용 keyed digest를 사용해야 한다. 이 token 생성기와 실제 행 수집은 미구현이다.
진단 fingerprint는 TTL/서명/권한/CAS/백업 증명이 아니며 실제 전체 DB 완전성으로 보고하지 않는다.

`reset-review-requirements.mjs`는 기존 mixed10/review125의 **135개 모두**를 명시적으로
다음 조사 그룹에 연결하고 누락·중복이면 실패한다. 행의 최종 keep/remove 정책은 아니다.

| 조사 그룹 | 관계 수 | 주요 미충족 근거 |
|---|---:|---|
| ACCOUNT_SECURITY | 14 | 개발자 보존, Auth 작업 종료, 전이 FK, 보호 범위 |
| ROOM_AND_RESERVATION | 11 | 기준정보 보존, 파생값 분리, 전이 FK, worker 종료 |
| WORK_AUTHORIZATION | 10 | 세션/권한 철회, 전이 FK, worker 종료 |
| NOTIFICATION_DELIVERY | 21 | 외부 발송 차단, worker 종료, 전이 FK |
| PAYROLL_HISTORY | 3 | 불변 이력 보호, 전이 FK, 보호 범위 |
| PIN_AND_SHEET | 11 | nonce 보존, Sheet 재유입 경계, worker 종료 |
| PHOTO_AND_EVIDENCE | 65 | 사진 삭제 HOLD, provider identity 보존, 전이 FK |

이 분류는 현재 source inventory에 대한 검토 의존성 목록이다. 개발자/기준정보 보존과 테스트
업무 초기화의 제품 방향은 확정이며, 이 135개 항목은 주로 행 predicate·참조·보호 조건의
엔지니어링 검토 대상이다. 135개 모두가 인간 정책 결정을 기다린다는 뜻이 아니다.
새 테이블을 prefix로 자동
포함하지 않으며 classificationComplete=false다. 테이블마다 행 predicate·보존 edge·실행
순서가 확정됐거나 보호 trigger를 우회할 수 있다는 뜻이 아니다.

## 10단계: 템플릿 독립 inventory 대조

`template-reseed-inventory.ts`는 기존 2단계의 내용·표시 순서·새 provenance 검사를 재사용하고,
같은 snapshot/catalog에 묶인 독립 source ID 목록·참조 ID/원본 연결 목록·모든 기존 template ID
목록과 독립 count를 대조한다. 후보에서 source/참조가 빠지거나 잘못 연결되면 실패하고,
보존 선택 밖의 퇴역 template을 포함해 기존 template ID를 새 ID로 재사용하면 차단한다.
정렬 차이와 UUID 대소문자는 의미 없는 차이로 처리한다. 결과는 건수·지문·고정 코드만 반환한다.

inventory는 승인된 보존 source 선택과 실제 모든 기존 ID를 trusted collector가 따로 수집해야
한다. 후보에서 역산한 목록이나 빈 fixture 성공은 DB 완전성을 증명하지 않는다. source 버전 선택,
새 version 할당·게시 가능성·원 작성자 이력 백업·실제 재등록은 미구현이며 임의로 결정하지 않는다.
legacy 템플릿을 새 게시 가능 상태로 바꾸거나 관리자 전용 게시 권한을 확장하지 않는다.

## 미구현 gate

- 실제 최종 DB catalog/FK/trigger inventory, source-controlled 전체 분류 allowlist,
  행 단위 보존 predicate 및 일관된 transaction snapshot 수집
- 실제 DB에서 템플릿/보존 참조 완전 수집, 버전/게시 검증 및 새 provenance 재등록
- 최신 singleton developer/session/최근 재인증, provisioning/go-live 영구 잠금
- actor/project/schema/내용 revision에 묶인 짧은 TTL preview와 멱등 실행 receipt
- D01 초기화 보호 범위 결정과 그 범위의 실제 백업·복원 근거(예약 전용 백업으로 대체 불가)
- 사진 삭제 HOLD 해제 및 외부 사진 복구 범위 결정·검증(현재 삭제 개발/실행 금지)
- 유지보수 잠금, API/RLS/worker 경합 차단, Auth 세션·계정·Drive·Sheet 단계별 처리
- 실제 삭제 RPC/실행 API, 독립 보안 QA, CI, 배포

1·2·7·9·10단계 순수 모듈에는 DB/SQL/provider 호출이나 public route가 없다.
3·5단계 개발용 CLI만 위 고정 로컬 SQL을 읽으며 공개 API에 연결되지 않는다.
기존 관리자 전용 템플릿 게시 권한·append-only trigger·RLS는 변경하지 않는다.
DB reset/복구 검증은 아직 수행하지 않았으며 최신 통합 schema는 승인된 최종 DB 검증에서 재대조한다.

## 11단계: 읽기 전용 developer preview 연결

`GET /v1/developer/reset/preview`를 Fastify/Edge/OpenAPI에 동일한 계약으로 연결했다.
기존 사용자 인증·developer role·비밀번호 변경 조건을 재사용하며 client가 actor/project/table을
선택할 수 없다. service-only `get_developer_reset_preview`는 기존 `get_active_auth_context`로
최신 profile과 session을 수집 전후 순서대로 검증한다. revoked/변경된 역할이면 결과를 반환하지
않는다. 관리자가 일반 계정 관리 권한으로 이 API에 접근할 수 없다.

private STABLE collector는 하나의 calling SELECT snapshot에서 pg_catalog의 public/private
base table 목록과 각 관계의 독립 count를 읽는다. 일반 heap만 ONLY 조회하고 foreign table 및
partition은 query하지 않는다. 테이블당 10,001행에서 중단해 10,000 초과는 exact=false인
하한으로 표시한다. 관계 1,000개 초과는 거부하고 lock timeout은 2초다. 루프 전체 5초 deadline을
각 조회 전후 확인하며 초과 시 부분 결과를 반환하지 않는다. 공개 RPC의 function-level
statement timeout 7초는 PostgREST 호출의 서버 측 제한 의도를 설정한다. 이미 실행 중인 호출의
실제 중단·hosted 취소 전파는 검증하지 않았다. 양쪽 HTTP adapter의 8초 응답 실패와 abort 신호,
루프의 5초 전후 경계 검사는 별도 한계이며 서버 SQL 중단 성공을 증명하지 않는다.
설정 값/효력은 최종 승인 DB 검증 대상이다.
[Supabase function timeout 계약](https://supabase.com/docs/guides/database/postgres/timeouts)을 따른다.
실제 업무 값/ID/원장
본문은 수집하지 않는다. 고정 schema와 catalog가 반환한 식별자를 `%I`로 quoting하며 caller SQL,
URL, table override나 외부 호출을 받지 않는다. 함수의 readOnly는 모든 작업이 조회라는 계약이지
volatile 권한 wrapper transaction의 PostgreSQL read_only 설정을 의미하지 않는다.

응답은 후보 그룹별 관계 수·observedRows·exact, snapshot 시각/ID와 coverage·blocker만 포함한다.
관찰된 누락/새 관계/상한/미지원 타입이 없으면 diagnosticComplete=true를 반환할 수 있다.
따라서 D01 미결정이어도 수집 결과를 확인할 수 있다. mixed/review/clear의 숫자를 확정 삭제
건수로 사용하면 안 된다. 개별 테이블명이나 계정 ID는 응답/에러에 넣지 않으며 no-store다.
오류·SQL 미적용·불완전 server payload는 고정 코드로 실패하고 원문 provider 오류를 출력하지 않는다.

이 census 수집기는 위 9단계의 전체 행/내용 token/FK graph collector와 다르다. 전체 행별 보존
규칙·템플릿 version/게시 검증·운영 시작 잠금·유지보수 전환은 아직 남아 있다. 실제 실행 승인,
최근 재인증, 백업/복구 및 사진 HOLD는 자동 충족되지 않는다. 실행 경로는 없고 false를 유지한다.
신규 SQL의 권한·snapshot 구조 및 합성 client 경로를 검사했으며 pgTAP 보안 회귀 소스도 준비했다.
DB/pgTAP/운영 API 실행은 NOT RUN이다.

## 검증 기록 정정

2026-10-25 preview 단위: `ci:quality` PASS(138파일/3,395 tests, typecheck/build,
OpenAPI155 paths/167 operations 포함), migration manifest 정적 검사 PASS(이 독립 worktree123개,
병렬123/124 통합 뒤 순번 재생성 필요). pinned native Deno2.1.4의 실제 api/index.ts 타입 검사와
OpenAPI/developer 기존 회귀41건 PASS. 새 Edge adapter의 권한·session·입력·오류는 Node 합성
fixture5건으로 실행했다. Docker 전체 Edge bundle/통합 검증, 실제 SQL/pgTAP/DB reset/복구,
운영 배포·실제 사용자 검증은 NOT RUN이다. 독립 QA는 소스/권한/계약을 검토해 차단 결함 없음,
별도6파일/109 tests PASS를 확인했다. 원격 보호 CI·병합은 이 기록 시점 후속이다.

2026-10-25 dev a355ba0 통합 후: `ci:quality` PASS(141파일/3,462 tests, lint/typecheck/build,
OpenAPI156 paths/168 operations), manifest 정적 검사 PASS(125개, head developer_reset_preview).
`edge:check` 전체 PASS: pinned Deno format/typecheck/합성 회귀 및 실제 배포 entrypoint
bundle 19,105,177 bytes, report source+artifact 진단 bundle 19,940,970 bytes,
backup monitor bundle 91,678 bytes. 진단 bundle은 20,000,000-byte 상한에 가깝기 때문에
후속 API 추가도 같은 상한 검사를 통과해야 한다. 실제 SQL/pgTAP/DB reset/복구/운영 배포는
계속 NOT RUN이다. preview 기본 단위에 대한 독립 QA 결과를 유지하며 dev 충돌은 양쪽
기능과 migration123/124/125 정확한 source hash 검증을 보존해 해결했다.

기존 GitHub 기록에서 secrets checker가 추적 파일만 검사한다고 설명했지만,
실제 `scripts/check-secrets.mjs`는 git ls-files --cached --others --exclude-standard로
미추적 신규 파일도 검사한다. 출력 문구의 tracked는 정확한 대상 설명이 아니다.
패턴 기반 검사이며 모든 종류의 민감정보 부재를 증명하지는 않는다.

## 2026-10-25 batch126 metadata 분류 보완

새 `private.photo_upload_batches`와 `private.photo_upload_batch_members`는 사진 HOLD의
종속 metadata로 review/PHOTO_AND_EVIDENCE에 명시적으로 추가했다. 현재 source 목록은
185관계(preserve3/mixed10/reseed2/clear43/review127), mixed+review137관계이며 사진 의존성은
67관계다. 앞선 단계의183/135/65 수치는 해당 checkpoint의 기록이다. 이 추가는 실제
clear 승인·삭제 구현·사진 purge 활성화가 아니다. 기존125 SQL은 catalog 기반 동적 census이므로
수정하지 않는다. generated preview 목록만 source에서 재생성하고 운영/DB 검증과 구분한다.

## 2026-10-25 후속 행 후보·FK 영향 수집 — source 후보, 운영 미적용

`scripts/reset-row-policy.mjs`는 명시된 관계마다 후보 규칙을 연결한다. wildcard는 없으며
새 관계·알 수 없는 역할·고아 계정 연결은 분류 완료로 처리하지 않는다. 이는 실제 삭제 predicate나
승인 목록이 아니다. 관리자·메이드·테스트 업무 초기화와 개발자·기준정보 보존이라는 확정 요구를
검토 가능한 영향표로 만든다. D01 복구 범위, 실제 실행 승인, 사진 HOLD는 별도로 유지한다.

| 대상 | 조회 시 행 후보 | 보존/충돌 의미 |
| --- | --- | --- |
| 개발자 profile·별칭·password version·연결 보안 기록 | preserve | 현재 연결 role로 판단하며 역할 snapshot을 최신 권한으로 사용하지 않음 |
| 관리자·메이드 profile·연결 기록 | resetCandidate | 일반 계정 삭제 권한을 부여하지 않음 |
| 객실 기준 행 | roomBaseline | 행 삭제 없음. 점유·PIN 등 업무 상태의 후속 patch/전환 계획과 구분 |
| 템플릿 version·slot | templateSource | 내용 보존 후 새 출처로 재등록할 원본 후보; 게시·새 ID 할당은 후속 |
| 사진 및 submission 사진 바인딩 | photoHold | provider 객체와 종속 metadata 보존 후보 |
| nonce registry·전역 로그인 제한·미상 로그인 보안 집계 | preserve | 비식별 보안 상태의 임의 초기화를 피함 |
| 업무 command receipt·audit 및 기타 테스트 업무 | resetCandidate | developer가 작성했어도 업무 후보이며 보존 보안 기록과의 FK 충돌은 별도 계수 |

후속 STABLE collector는 기존 census와 동일한 calling statement snapshot에서 각 행 후보 건수를
집계한다. HTTP adapter는 관계별 독립 count, 후보 count의 합, 같은 snapshot ID와 정확한 규칙 지문을
확인한다. 클라이언트가 행 선택, SQL, scope 또는 source 역할을 제공하지 않는다.

FK 영향은 실제 `conkey/confkey/conpfeqop` 순서를 사용한다. 검증된 FK와 즉시 유효 unique key,
pg_catalog equality의 정확 operand type 및 같은 collation만 지원한다. MATCH SIMPLE의 NULL과
MATCH FULL의 일부 NULL, 없는 target, 보존 후보가 reset/template 후보를 참조하는 건수를 구분한다.
지원하지 않는 equality·키·foreign/partition·외부 schema는 검증 통과로 처리하지 않는다.
Auth 경계는 `auth.users.id` 연결 조회와 bounded ID-only census만 사용한다. profile 없는 Auth계정도
별도 unresolved 건수로 표시하며, 비밀번호·Auth 전체 행·파생 hash를 읽거나 내보내지 않는다.
공개 응답에는 테이블명·constraint명·행 ID·원자료가 없고 합계와 고정 code만 있다.

`rowImpact.diagnosticComplete`는 이 **건수 기반** 수집의 완전성이다. `referencesValid`도 지원된
실제 FK 영향 검사만 의미한다. 동일 건수 행 교체/내용 변경, 논리 JSON 참조, row-content snapshot,
복구 증거, 승인 TTL/CAS, 삭제 순서 또는 실행 가능성을 증명하지 않는다. 기존 내부 snapshot checker는
별도로 유지하며 실제 내용 snapshot/유효 승인 연결을 완료했다고 표시하지 않는다.

전체 loop의 5초 경계, RPC의 7초 설정 의도와 adapter의 8초 응답 한계를 유지한다. hosted cancel/현재
query의 실제 timeout 효력은 SQL 검증 전 미확인이다. 아직 전체 DB·pgTAP·운영 실행은 NOT RUN이다.

검증 입력은 batch126 `1828806` tree와 동일한 통합 기준에 row-impact127을 추가한 것이다.
`ci:quality` PASS(143파일/3,522 tests, lint/typecheck/build/secrets/OpenAPI157/169),
manifest 정적 검사127 PASS, Python3.12 임시 codegen 및 ruff PASS,
전체 `edge:check` PASS(65/540/68 합성 회귀, actual bundle19,150,558 bytes,
report 진단19,986,351 bytes, backup91,678 bytes). 첫 Edge 검사에서는 생성 지문 줄바꿈이
format 검사에 걸려 generator를 수정했고 최종 전체 재검증은 PASS다. PostgreSQL/pgTAP,
hosted timeout/취소, DB 복구·운영 배포는 NOT RUN이다. 독립 QA는 source/권한/합계/동일 snapshot/
Auth ID-only census/사진 HOLD를 검토해 차단 사항0, 별도3파일47 tests PASS를 확인했다.

최종 dev `f25e5b6`(#378/#493/#494/#495) 정상 통합 후 application159파일/4,389 tests,
manifest127 및 row/preview/report generator 검사가 PASS했다. 전체 Edge65/543/68 회귀와
실제 API bundle18,989,717 bytes, report 후보19,655,418 bytes, backup99,006 bytes가 PASS다.
report 생성물은664,758 bytes이며 기존20MB 상한을 유지했다. Python codegen/ruff는 dev60cd6af
통합 입력에서 PASS했고 이후 f25e5b6까지 OpenAPI/Python 입력 변경0을 확인했다.
이번127 변경의 실제 PostgreSQL·pgTAP·hosted 호출·reset/복구 실행은 여전히 NOT RUN이다.
