# #396 승인된 운영 인계 정책 연결

2026-10-25 사용자가 R1(재인증 5분), T1(현재 게시본만 새 등록 후보), S1(새 초안 후
내용·현행 형식 검증을 거쳐 게시)를 선택했다. 이 문서는 구현 계약이며 실제 실행 승인서가
아니다. 정책의 고정 값과 지문은 `approved-handover-policy.ts`가 소유한다.

## 실제 연결

기존 closed RR collector → 독립 census/content/FK 검사 → review composition 흐름을 유지한다.
현재 composition은 명시적 `CURRENT_PUBLISHED`만 수용한다. 선택 생략(null)은 불완전한
진단으로 남고, 과거 대안 `ALL_VERSIONS`는 실제 composition에서 거절한다. 범용 순수
template builder의 대안 검사 모드는 별도로 남으며 승인된 모드에서 대안을 선택할 수 없다.

승인된 builder는 완전한 모든 상태의 inventory를 먼저 검증하고 게시본만 새 후보로 만든다.
기존 내용·slot 수·표시 순서·작성 이력은 그대로다. 최초 새 ID/시각/개발자/사유를 보존하고
각 `(roomTypeId, cleaningKind)` 그룹 전체의 최대 version보다 높은 새 draft를 계획한다.
기존 SQL과 같은 canonical flat v9는 최소9, 그 외는 최소8이다. 숫자 상한/중복 version을
거부한다. 버전 숫자를 정했다고 내용이 새 게시 형식에 적합하다는 뜻은 아니다.

모든 원본 ID를 보존 대상 목록에 남긴다. 기존 게시본을 retire하거나 과거 참조를 새 ID로
옮기는 명령은 만들지 않는다. 기존 source129의 동일 snapshot 결과에서 **선택된 게시본**의
새 등록 형식·게시 경로·version 가능 여부를 검사한다. 미선택 초안/퇴역본의 새 등록 부적합을
T1의 새 게시본 부적합과 혼동하지 않으며, 읽기 불가 이력·슬롯 불일치·작성자 누락·참조 보호
문제는 전체 inventory 기준으로 계속 차단한다. 일반 preview의 모든 상태 진단은 그대로다.

새 draft 계획과 정책 지문도 기존 일회성 계획 재관측 commitment에 포함한다. ID/시각/내용이
같아도 status/version/정책 계획이 바뀌면 폐기한다. 원본을 자동 변환하여 비교를 맞추지 않는다.

R1은 수집된 `developer_operation_control.reauth_ttl_seconds`를 300과 비교한다. 행 없음은
설치 미확인, 다른 값은 정책 불일치다. 일치해도 최근 재인증 성공·유지보수 drain·실행 권한이
생기지 않는다. 기존 Auth 임시 세션 폐기·최신 권한·기한 검사와 실제 owner 설정 실행은 유지한다.
기존 SQL/정책 seed를 수정하거나 실제 control을 초기화하지 않았다.

## 실행 전 남는 조건

- 사용자의 L1은 현재 시험 자료라는 사실 확인이다. 실제 target/source 고정과 실행 직전
  운영 상태 재확인, 정확한 DB 실행 승인이 필요하며 PROVISIONING/STARTED를 자동 기록하지 않는다.
- D01의 전체 보호 계획과 실제 백업·readback·복구 증거, 유지보수·admission·외부 직접 접근 중지,
  실제 최신 developer/session/재인증, 영속 승인 소비·receipt/CAS를 구체 실행에 결합해야 한다.
- 실제 draft 등록 및 검증 후 게시·참조 보호·초기화 효과는 실행하지 않았다. 기존 관리자 게시
  API의 권한을 개발자에게 넓히거나 원장 불변 제약을 우회하지 않았다.
- 사진 삭제 HOLD는 유지한다. 정책 선택이나 준비 결과가 실제 삭제 권한을 주지 않는다.

`executionEnabled=false`, `liveDatabaseVerified=false`, `completeResetCoverage=false`는 계속 유지한다.
실제 DB/SQL/TLS/Auth/provider/승인 소비/등록·게시·삭제는 이번 개발에서 모두 NOT RUN이다.
공개 API, migration manifest, 환경 변수, DB·운영값 seed 변경은 없다.

이번 소스 검증은 `ci:quality` 188파일/5,133 tests, 관련6파일125 tests, manifest135,
기존 reset 생성 정본 검사, compiled policy/collector import 및 폐기 핸들 smoke PASS다.
독립 QA는 관련5파일116 tests와 정책·SQL 정본 비교를 실행해 차단 결함을 찾지 않았다.
Edge/Python/OpenAPI/SQL/package 입력은 기존 dev와 같아 이 단위에서 재실행하지 않았다.
