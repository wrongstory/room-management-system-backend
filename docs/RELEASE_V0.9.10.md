# v0.9.10 이번 주 근무가능일 승인

## 범위와 승인

2026-11-02 사용자는 메이드도 이번 주 근무가능일을 수정 요청하되 관리자 승인을
받도록 결정했고, 구현·dev 병합 뒤 DB 검증과 운영 반영 진행을 명시적으로 승인했다.
첫 격리 검사 실패 뒤 미사용 인자를 제거한 수정본의 전체 DB 검증1회 재실행도 승인했다.
이번 실행은 기존 fresh/upgrade/경합/정리를 포함하는 CI run1회이며 운영 반영은
앞서 승인한 이번 기능 범위로 제한한다. 실제 업무 요청·다른 v1 기능 배포는 포함하지 않는다.

재실행 준비 중 개발팀의 #559/commit1370c6a가 병합된 것을 확인했다. 그 수정은 같은
미사용 인자를 후속 migration으로 제거하고 기존 SQL/경합 fixture의 승인 정책을 정합화한다.
운영/개발 이력의 원문이 갈라지지 않도록 별도 직접 수정본0d6f4d8 대신 검토·병합된
원문 두 파일과 관련 fixture를 그대로 사용한다. 제품 정책/업무 함수의 최종 의미는 같다.

운영 main `d3ecff164d99eba8837d14d302ca213e4be17353`의 기존124개 원문을 보존하고
이번 기능과 미사용 인자 수정2개를 더한126개 hotfix다. source 순번과 운영 실행 timestamp를
혼동하거나 기존 이력을 repair하지 않는다. 별도 PR553의 v1.0.0 미배포 기능은 포함하지 않는다.

| source | SHA-256 |
| --- | --- |
| 20261101230757_current_week_availability_approval.sql | 7b4b70d2a506dd028aa02469369429c5971eb160769e168438cf6f8fa61aa70c |
| 20261101235415_availability_guard_unused_parameter.sql | a3d9e37ce45ebe1f1f6b5ad68e63feb79b401ffb4eb26c389520e9c18aec7d3f |

## 동작과 검증

이번 주 직접 제출은409 AVAILABILITY_APPROVAL_REQUIRED로 차단하고 관리자 승인으로 반영한다.
최초 미제출 주도 sourceVersion0으로 요청하며 승인 전 기존 가능일/배정 후보를 유지한다.
지난 날짜 변경, 메이드 자기 승인, 오래된 CAS, 통보 배정 충돌을 차단한다. 다음 주 직접 제출과
기존 이력·감사·멱등성·RLS를 보존한다. #559의 fixture는 현재 주 승인/다음 주 직접 제출,
과거 가능일 보존, 정확한 배정 충돌 오류를 실제 경합 검증에 반영하며 기존 검사를 생략하지 않는다.

PR557/run41364004498 attempt1은125개 설치·템플릿 계약 PASS 뒤 strict lint에서
미사용 p_week_start 경고로 FAIL했다. 후속 backup·SQL/upgrade·clock·경합·Full DB proof는
NOT RUN이며 Supabase stop은 성공했다. 기존 허용 경고·workflow·gate는 변경하지 않는다.

새126개 최종 입력의 required application/migration과 Full DB proof를 확인하고 보호 병합한다.
main에서는 같은 입력 증거만 확인하며 전체 DB를 반복하지 않는다. 운영124개 이력·pending2개와
Security Advisor를 대조한 뒤 새 SQL/이력만 적용하고 함수·제약·권한을 읽기 검증한다.
API→Swagger/프런트 배포 뒤 health/OpenAPI/CORS·정적 byte 및 합성 브라우저를 확인한다.
실제 메이드/관리자 업무 UAT는 실행하지 않는다. 성공 증거 전에는 운영 적용·Full DB PASS로 표시하지 않는다.

개발 소스는 이미 #559의 동일 원문/fixture이므로 중복 수정 PR560은 대체 종료한다.
main hotfix 병합 뒤에는 별도 dev PR로 병합 이력과 이 배포 기록을 통합한다.
