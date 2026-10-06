# #396 운영 인계 전 초기화

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
버전 번호 할당·게시 자격·전체 DB ID 충돌·원 작성자 이력 백업·FK 누락은 아직 검증하지 않는다.
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

이 catalogFingerprint는 전체 schema fingerprint가 아니다. 전체 column/default/index/policy/ACL,
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

이 목록에는 아직 dev에 병합되지 않은 #336 테이블이 포함되어 있다.
따라서 dev110에 없는 후보 관계는 missing으로 차단하는 것이 정상이다.
최종 통합본에서 전체 catalog/분류 정책을 재검토해야 한다. 실제 DB 행 수 수집/삭제 SQL에
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
이 결과를 실제 업무 DB 전체 행 수집기 완성으로 간주하지 않는다. 복합 FK/MATCH FULL,
최종 분류 predicate, 운영 스키마 전체 적용, 유지보수 잠금과 실제 초기화는 여전히 후속이다.

## 미구현 gate

- 실제 최종 DB catalog/FK/trigger inventory, source-controlled 전체 분류 allowlist,
  행 단위 보존 predicate 및 일관된 transaction snapshot 수집
- 실제 DB에서 템플릿/보존 참조 완전 수집, 버전/게시 검증 및 새 provenance 재등록
- 최신 singleton developer/session/최근 재인증, provisioning/go-live 영구 잠금
- actor/project/schema/내용 revision에 묶인 짧은 TTL preview와 멱등 실행 receipt
- Supabase B 백업·복원 근거 및 외부 사진 복구 범위 검증
- 유지보수 잠금, API/RLS/worker 경합 차단, Auth 세션·계정·Drive·Sheet 단계별 처리
- 실제 삭제 RPC, Fastify/Edge/OpenAPI, 독립 보안 QA, CI, 배포

1·2단계 순수 모듈에는 DB/SQL/provider 호출이나 public route가 없다.
3·5단계 개발용 CLI만 위 고정 로컬 SQL을 읽으며 공개 API에 연결되지 않는다.
기존 관리자 전용 템플릿 게시 권한·append-only trigger·RLS는 변경하지 않는다.
DB reset/복구 검증은 아직 수행하지 않았으며 #336 후보 schema는 최종 통합 뒤 재대조한다.

## 검증 기록 정정

기존 GitHub 기록에서 secrets checker가 추적 파일만 검사한다고 설명했지만,
실제 `scripts/check-secrets.mjs`는 git ls-files --cached --others --exclude-standard로
미추적 신규 파일도 검사한다. 출력 문구의 tracked는 정확한 대상 설명이 아니다.
패턴 기반 검사이며 모든 종류의 민감정보 부재를 증명하지는 않는다.
