# #396 S1 템플릿 인계 효과 준비

2026-10-25 사용자가 선택한 R1/T1/S1을 위한 실행 소스다. **전체 초기화 완료, 실제 DB 검증,
보호·복구 실증, 실행 활성화는 아니다.** migration136은 신규 append이며 기존 적용 이력을
수정하지 않는다. 기존 ERD/DBML의 template version·slot·개발자 관계와 source135 원장을
사용하고 새 table/public HTTP API/일반 관리자 권한을 추가하지 않는다.

## 현재 닫힌 실행 경계

`template-handover-effect.ts`의 공개 준비 adapter는 owned revalidation handle만 받아 계획을
옮긴다. `execute()`는 **RPC, 승인 소비, 원장 쓰기 전에 `ACTIVATION_REQUIRED`로 거절**한다.
환경변수/호출자 Boolean/임의 hash로 해제하는 옵션은 없다. 내부
`template-handover-protocol.ts`는 검토할 고정 효과 순서를 담으며 운영 HTTP/CLI에서 호출하지
않는다. 테스트는 합성 RPC와 가짜 승인 consumer만 사용한다. 실제 승인 파일/marker를
작성하거나 소비하지 않는다.

고정 SQL 함수와 세 private helper는 PUBLIC/anon/authenticated/service_role의 EXECUTE를
명시적으로 회수한다. owner/superuser는 PostgreSQL상 예외이므로 이 권한 회수를 만능 실행
금지라고 표현하지 않는다. 단순 GRANT도 우리 공개 runtime을 활성화하지 않는다. 실제 대상의
보호/복구·잔여 blocker 처리·유효한 exact 승인 authority issuer와 실행 연결은 후속 필수
작업이며, 현재 supplied backup/policy hash는 **의도 결합값**일 뿐 보호 증거가 아니다.

## 보존·선택·실제 시각

T1의 현재 published만 신규 대상이다. 기존 draft/retired를 새 게시 대상으로 승격하지 않는다.
owned collector의 전체 template와 slot 목록 및 정확한 PostgreSQL text 값을 보존하고,
별도 census/content/FK 검증과 두 관측의 동일성 확인을 마친 handle만 일회 전달한다.
일반 consume/dispose/만료와 효과 전달은 서로 재사용할 수 없다. 원본/새 ID/사진 내용은
공개 준비 응답에 포함하지 않고 내부 bounded closure에만 둔다. 폐기 때 참조를 해제하며
JavaScript heap의 물리적 zeroization을 주장하지 않는다.

기존 행의 내용·수량·표시 설정·작성자·작성 시각·과거 FK/JSON 참조는 그대로다. 기존 게시본의
**published→retired**만 기존 게시 계약에 따른 전이로 허용한다. 과거 provenance를 새 개발자로
덮어쓰거나 기존 참조를 새 ID로 바꾸지 않는다. 선택 계획의 새 ID·버전·계획 시각은 재생성하지
않지만 계획 시각은 `plannedAt`이라는 의도이며 실제 작성 시각으로 저장하지 않는다.

실제 APPLY는 STARTED 뒤 DB clock을 밀리초로 한 번 고정해 모든 새 행의 `created_at`에
동일하게 쓴다. `expectedPostconditionFingerprint`는 정확한 payload와 “실제 등록 시각은
STARTED..OBSERVED 사이의 DB clock이며 모든 새 행에 동일”이라는 계약에 결합한다.
OBSERVED의 evidenceHash는 그 계약과 실제 `registrationTime`에 결합한다. READ는 신규 행의
동일 시각·계획 이후·원장 시간구간·불변 원본을 다시 검사한다. 검토/승인 대기 시간을 실제
등록 시각으로 위장하지 않는다. `published_at`은 기존 의미대로 실제 게시 시각이다.

기존 append-only `public.audit_events`에 신규 template마다
`cleaning_template.operational_handover`를 정확히 1개 추가한다. 고정
`OPERATIONAL_HANDOVER_INITIALIZATION` 사유, 원본→신규 ID, 계획/실제 등록 시각, 버전과
policy/command/payload 지문을 기록한다. 원본 사진 내용·이름·전화·PIN은 포함하지 않는다.
READ도 같은 감사 행의 actor·사유·매핑·시각·정확한 JSON을 대조하므로 raw 계획이 폐기된 뒤에도
등록 이유와 원본 연결이 남는다. 기존 감사 이력과 참조는 수정하지 않는다. 전체 초기화 실행을
후속 연결할 때 허용하는 자체 쓰기는 이 정확한 신규 감사 행까지이며, 기존 감사 relation 전체를
drift 검사에서 제외할 권한은 아니다.

source136의 행 분류는 **정확한 event_type만** preserve로 둔다. 사유/actor/내용이 잘못돼도
삭제 후보로 내리지 않고 후속 review를 차단한다. 일반 업무 감사 분류는 기존 그대로다.
source135 generator 입력은 `reset-row-impact-baseline135.json`으로 동결해 기존 SQL 바이트를
유지하고,136 생성 원본에 disposition/row-impact 함수를 append한다. 현재 지문과 Node/Edge
preview 생성물만 갱신한다. `template-handover-effect.sql.in`이136의 정본이다.

논리 registry27의 감사 entity_id/before_state/after_state는 역사값 전체를 보존한다.
이미 같은 RR에서 독립 census/content로 확보한 감사 행과 전체 template 목록을 사용해 두 명시
template ID의 존재·서로다름, 새 행의 creator/실제시각/버전 및 동일 내용을 검사한다.
S1은 정규화한 배열로 원본을 변환하지 않는다. 저장 전과 readback에서 slots의 PostgreSQL
jsonb text를 정확히 대조해 숫자 `1.0`/`1` 같은 동등값의 표기 변경도 거절하며, 다음 역사 검사의
동일 text 계약과 일치시킨다. 기존 normalizer는 현재 형식과 배열 순서의 확인에만 사용한다.
이는 새 숫자 정책이 아니다. source129는 원본을 v8 normalizer에 전달하고, 그 정본의
displayOrder/maxPhotos 정수 문자열 검사가 `1.0`을 이미 거절한다. 해당 T1 등록 형식 blocker는
composition에 남는다. Node의 숫자 파싱만으로 원래 표기가 검증됐다고 보지 않는다.
잘못된 사유·매핑·시간·알 수 없는 shape는 고정 blocker다. 기존129의7개 참조 수집기를
다시 구현하지 않고, 역사 ID를 현재 pointer나 자동 재연결 권한으로 바꾸지 않는다.

## 내부 효과 순서와 실패

1. PRECHECK: 최신 developer/Auth/session/password를 전후 재검증하고 정확 대상/control version,
   PROVISIONING/유지보수 REQUESTED, 미완료 업무·Auth·worker admission 0을 검사한다.
   R1 READY receipt의 actor/session/nonce/password/target/policy/control과 300초 TTL·probe session
   폐기를 확인한다. 전체 template/slot 원본, 모든 status를 포함한 그룹 최대 버전,
   현재 checkout 형식/maxPhotos와 계획 내용을 대조한다. 신규 원장/업무 쓰기는 없다.
2. 정확한 owner 승인 일회 소비 후 기존 source135 CREATE/STARTED를 CAS로 기록한다.
   준비 모델의 미검증 blocker는 이 단계로 자동 승격하지 않는다. 공개 활성화가 닫혀 있다.
3. APPLY: 동일 검증을 반복하고 control→template/slot→receipt 순서로 잠근다. 정확한
   binding/header/STARTED head와 payload→postcondition hash를 확인한다. 계획의 새 ID로
   draft를 등록하고 내용/현재 형식을 검증한 뒤 기존 게시본을 retired로 바꾸고 새 draft를
   게시한다. 기존 trigger가 slot을 materialize한다.
4. 전체 보존/신규 행·slot readback, 실제 등록 시각, R1 일회 소비 및 OBSERVED를 하나의 SQL
   transaction에 묶는다. 어느 검증이든 실패하면 draft·퇴역·게시·slot·신규 감사·소비·OBSERVED가 모두
   rollback된다. 먼저 별도 기록한 STARTED는 남는다. FINAL_VERIFIED는 기록하지 않는다.

예외/timeout/불명확한 응답은 UNKNOWN이다. 동일 adapter는 APPLY/승인을 자동 반복하지 않는다.
명시 READ는 이전 STARTED prefix에서 최신 APPLIED와 정확한 현재 행을 다시 관찰할 뿐이다.
폐기·메모리 기한 이후에는 해당 adapter의 READ도 불가하다. 별도 정확한 조사 없이 새로운
효과를 재시도하지 않는다. abort는 응답 대기를 제한하며 원격 rollback 증명은 아니다.

원본 관계 각각 10,000행, 선택 1,000개, SQL payload 4MiB, 쿼리 설정 7초·lock 2초,
loop/전체 경과 검사 5초, Node 각 RPC 최대 7초를 사용한다. PostgreSQL 함수 내부의
statement_timeout이 이미 시작된 hosted 요청을 정확히 끊는지와 실제 lock/cancel 의미는
최종 DB 검증 대상이다. 승인 I/O도 기존 명시 상한을 사용한다. 부분 완료를 PASS로 반환하지 않는다.

## 검증과 남은 경계

합성 Node 검사는 실제 owned builder/닫힌 collector 경로, 공개 비활성, 일회 전달/소비,
PRECHECK·CREATE·STARTED·APPLY 실패, payload 변조, 응답 유실/timeout→READ, 폐기와 비밀 비노출을
확인한다. PG15/17 parser는 migration 및 rollback-only pgTAP의 바깥 SQL 구문을 검사하며,
문자열로 저장된 PL/pgSQL 본문의 전체 컴파일을 대신하지 않는다.
pgTAP 소스는 역할 권한, NULL/nonce/actor/CAS/내용·버전 차이, 게시 후 실패 전체 rollback,
old provenance 보존, 실제 DB 시각 및 일회 결과를 검증하도록 준비했다.

**수정본 SQL 설치/pgTAP/Full DB/hosted RPC/Auth/provider/실제 승인 소비는 NOT RUN이다.** 실제 복구 보호,
사진 HOLD/FK 부모 보존 및 전체 초기화 범위 완전성, 실제 유지보수 drain·운영 상태 확인,
정확한 대상·최종 소스 승인과 활성화 연결은 이 S1 효과 준비로 대체하지 않는다.
정기 예약 백업은 Auth/PIN/템플릿/사진 등 전체 복구의 증거가 아니다.

개발 검증: 최신 dev `8f32a7d` 통합 후 application 197파일/5,337 tests, typecheck/build,
manifest136, compiled module import 및 4개 정본 generator 검사 PASS. 실제136 파일의
PG15/17 AST16 statements와 변경 source/upgrade138 검사도 PASS다. Edge 정본 65/560/68 및
report candidate 19,906,630 bytes/backup99,006 bytes PASS로 기존20MB 한도를 유지했다.
독립 검토에서 dispose/slot metadata와 역사 참조 보호를 보완했고 최종 관련85tests,
숫자 원문 대조 보완 뒤7tests 및 source 검토에서 차단 finding이 없었다. 이 수치는 실제 DB
결과가 아니다. 이전135 manifest entry와 source135 바이트는 그대로다.

### #528 R2 설치 실패와 미적용 source136 수정

2026-10-25 별도 승인한 D03-P R2는 source `ad76ddb05bda7753dcbd9e16e8369e87593fb82f`의
migration136 statement1(두 번째 문장)에서 SQLSTATE42601로 설치 실패했다. 기존 행을 대조하는
`assert_reset_template_handover_rows`의 IF 조건에 괄호 없는 CASE 표현식이 있어,
PL/pgSQL이 CASE 내부 THEN을 바깥 IF 조건의 끝으로 읽는 문제가 드러났다.
후속 metadata와 고정14개 SQL 회귀는 NOT RUN이며 승인된1회는 소모했다. 자동 재시도는 없다.
정리 후 이번 소유 자원·호스트 프로세스0개, 기존10개 container·5개 volume·5개 network와
동일 Docker daemon 보존을 대조했고 독립 검토도 PASS였다. 설치 실패를 rollback/효과 검증
성공으로 바꾸지 않는다.

수정 전 원격 읽기 확인에서 production history122·recovery73이며136/137 적용은0건이었다.
실패한 격리 자원도 정리되어, 이미 적용된 이력 대신 **미적용 source136 후보**를 고친다.
정본 `scripts/template-handover-effect.sql.in`의 CASE 양쪽에 괄호2문자만 추가하고136을
재생성했다. 상태 비교의 의도·권한·보존·효과 순서는 바꾸지 않으며 manifest와 기존 upgrade의
정확한 소스 지문을 함께 갱신한다. 수정136의 UTF-8 LF SHA256은
`2d087c3d4db572fefd32b8068f7a0c5956ea8a3d4ae494f1f4d9a9f1c14b8cca`다.

좁은 IF 조건 경계 회귀2개는 수정 전 실패를 재현하고 수정 후 PG15/17 SELECT parser를
통과했다. 관련3파일41 tests, 전체200파일/5,385 tests·typecheck/build 및 과거/dev137
manifest 검사는 PASS다. 이 회귀는 PL/pgSQL 컴파일러나 실제 설치 검사가 아니므로 수정본의
DB 설치·14개 SQL 회귀·최종 Full DB는 여전히 NOT RUN이다. 새 고정 소스·대상·정리 범위의
다음 실행은 별도 승인이 필요하며, 공개 실행·실제 초기화·사진 삭제 HOLD 경계는 그대로다.
