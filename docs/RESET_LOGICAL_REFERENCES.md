# 초기화 논리 참조의 유한 registry (#396)

`logical-reference-registry.ts`와 `logical-reference-inspector.ts`는 실제 FK 밖의
참조를 해석하는 Node 내부 검증기다. source135 영속 receipt 4경로와 source136 인계 감사의
entity_id/before_state/after_state 3경로를 포함한 27개 경로만 등록하고 알 수 없는
관계·경로·종류·대상·형식은 차단한다. DB/외부 조회, 삭제·rewrite, 공개 API 및 운영 설정은 없다.

## 세 가지 의미

| 의미 | 현재 등록 예 | 검사 |
|---|---|---|
| CURRENT_POINTER | 개발자 catalog preview의 `entity_id` | `preview_kind`별 정확한 객실/객실유형 대상, 같은 UUID, 보존 상태 필요 |
| HISTORICAL_SNAPSHOT | 활동 이력의 예약 ID, 객실/일정 snapshot, 사진 삭제 명령의 과거 응답, 사진 저장 당시 객실번호, 영속 receipt의 actor/binding/header/entry | 같은 원래 값 보존. 현재 행 재조회나 ID·이름·기본값 보충 금지 |
| EXTERNAL_LOCATOR | Drive 파일/폴더 ID, 저장 파일명 | 위치 값의 원본 보존과 형식만 확인. 실제 객체 존재·복구·삭제 권한을 추론하지 않음 |

과거 예약이나 객실유형이 현재 목록에 없다는 이유로 역사 snapshot을 dangling current pointer로
판정하거나 값을 삭제하지 않는다. 반대로 현행 preview의 대상이 제거 후보이면 차단한다.
history의 원문 보존 성공은 화면에서 읽을 수 있음, 최신 권한, 복구 가능한 archive를 뜻하지 않는다.
사진 HOLD를 유지하며 예약 전용 백업을 사진·Auth 등 전체 초기화의 복구 근거로 쓰지 않는다.

JSON 값은 같은 PG codec의 손실 없는 text 그대로 비교한다. JSON object root의 구문만 확인하고
JS number로 다시 직렬화하지 않는다. 큰 정수, legacy NULL, 알 수 없는 과거 nested field를 그대로
보존한다. nested field를 새 current 권한으로 해석하지 않는다. 의미 없는 순서 재직렬화도 하지 않도록
실제 adapter는 두 pass에서 동일한 PG JSON text codec을 사용해야 한다.

## 독립 입력과 실패 처리

예상 목록은 검토된 catalog에서 **모든 보존 후보의 비FK/JSON 표면**을 독립적으로 수집해야 한다.
registry에 있는 것만 골라 목록을 만들면 안 된다. 새 표면은 행 수가 0이어도 미등록으로 차단한다.
프로젝트, source, catalog, 분류, 내용 지문, snapshot ID와 registry 지문을 모두 고정한다.
관계·경로별 독립 보존 행 count와 observation을 비교하며 중복/누락/불완전 입력은 실패한다.

observation의 rowToken은 snapshot 안의 비공개 opaque identity다. 실제 보존 후보 값과 target의
동일 snapshot 해석은 신뢰된 서버 adapter가 공급해야 한다. 이 함수는 입력 정합성을 검증하며
직접 SQL의 일관성, count의 독립성 또는 원문 관측의 진실을 증명하지 않는다. 같은 건수로 행을
바꿔 공급하는 공격까지 방지하려면 기존 content snapshot builder의 독립 내용 검증과 결합해야 한다.
`contentFingerprint` 문자열의 자기 신고만으로 그 결합이 성립하지 않는다.

[같은 스냅샷 조립 경로](RESET_REVIEW_COMPOSITION.md)는 독립 내용/census/FK 검사를 통과한
행에서 이 입력을 구성한다. 원문 보존 검사는 이전 actor가 현재 존재한다거나 영속 receipt의
과거 event를 다시 실행할 수 있다는 뜻이 아니다. 새 source135의 actor/binding/header/entry는
모두 역사 자료이며, `events.receipt_id`의 실제 FK는 기존 FK 검사가 담당한다.

source136의 정확한 인계 감사 이벤트도 역사 JSON 전체와 entity_id를 그대로 보존한다.
같은 capture의 전체 template 목록에서 원본·신규 ID와 등록 사유·내용·시각을 대조하는
추가 검사는 composition이 소유한다. 누락·변형·삭제 후보 부모는 차단하며 과거 ID를 현재
pointer로 승격하거나 재연결하지 않는다. source129의 기존 7경로 수집은 그대로 유지한다.

최대 1,000표면·10,000관측·8MiB 입력·12단계 구조를 허용한다. getter, cycle, custom object,
sparse array, 추가 필드는 거부하고 오류에는 원문을 넣지 않는다. 반환값은 고정 blocker,
합계, source registry 지문뿐이다. 원본 객체를 변경하거나 원문·ID·locator를 보관/로깅하지 않는다.
JavaScript 문자열 heap의 확정 삭제를 보장하지 않는다.

## 기존 검사와 남은 범위

기존 실제 FK 검사, row-content snapshot, 템플릿129 collector는 각각 계속 필요하다.
129의 7개 template 참조 경로는 `summarizeResetTemplateEvidence`가 단독 소유하며 여기서 다시
수집·검사하거나 그 선택/상태/역사보호 blocker를 지우지 않는다. 이 registry에 template 경로를
잘못 입력하면 미등록으로 차단한다. 현재 pointer 대부분은 기존 실제 FK collector가 처리한다.
post-approval report의 두 actor provenance ID도 기존 5컬럼 composite FK에 포함되므로 여기서는
제외한다. 최초 후보에 포함했던 두 경로를 독립 QA에서 확인해 제거하고 해당 FK 소유권 회귀를 추가했다.

`photo_upload_operations`/`photo_upload_admissions.collection_item_id`는 아직 생성 전인 item의
예약 identity일 수 있다. 이를 무조건 existing-current-pointer로 등록하지 않는다. 업로드 단계,
고정 operation/member identity 및 finalize/취소 의미를 검증하는 별도 유한 adapter 전까지 미등록이다.
developer preview의 request/impact payload, 기타 새 보존 payload도 등록 전에는 차단한다.
이 제한은 해당 자료를 무시하거나 초기화 가능하다고 표시하는 fallback이 아니다.

따라서 성공은 `coverageScope=registered-nontemplate-surfaces`의 정합성만 나타낸다.
`completeResetCoverage=false`, `externalObjectsVerified=false`, `executionEnabled=false`는 항상 유지한다.
서버 내부 collector 조립은 연결했지만, 전체 catalog의 비 FK 표면 조사, 실제 DB 검증,
template/FK 보호, 백업, 정책, 실행 승인, 유지보수 종료 증거가 없으면 전체 초기화 참조 검증
완료나 실행 허가로 사용할 수 없다.

검증은 합성 회귀와 source 대조로 수행한다. 실제 DB/SQL/Auth/Drive 조회·수정·삭제는 NOT RUN이다.

최초 PR506의 검증 기록: worker132와 내용 collector·템플릿 builder를 포함한 dev a97c84를 정상 통합한
`ci:quality` 174파일/4,818 tests, manifest132,
typecheck/lint/build가 PASS다. 관련35 tests 및 독립 QA의35 tests도 PASS이며 차단 finding은 없다.
초기 fixture의 nullable 타입과 제어문자 정규식 lint 오류는 수정 후 재검사했다.
당시4파일은 Node 내부만 변경했다. Edge/SQL/API 입력은 당시 incoming dev와 같아 별도 실행하지 않았다.
후속 composition/24경로 검증과 한계는 위 조립 문서 및 해당 PR에 기록한다.
