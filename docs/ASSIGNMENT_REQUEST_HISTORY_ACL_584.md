# #584 배정 변경 요청 이력 권한 보완

운영 배포 전 저장된 관리 관측과 소스를 대조해
`public.assignment_change_requests`의 `service_role` DELETE/TRUNCATE 권한이 남아 있음을 확인했다.
기존 UPDATE/DELETE 행 트리거는 TRUNCATE를 처리하지 않는다. 실제 삭제나 악용이 관측된 것은 아니다.

## 변경

- `20261104144746_assignment_change_request_history_acl.sql`을 추가한다. 기존 1~148개 migration은 그대로 보존한다.
- 이 테이블의 service_role DELETE/TRUNCATE만 회수한다. 데이터, 함수, RLS, SELECT/INSERT/UPDATE는 변경하지 않는다.
- 기존 요청 생성·승인·거절·supersede, 현재 배정과 과거 이력 계약을 유지한다.
- 다른 relation 및 provider default ACL의 정책 수용은 이 변경으로 처리됐다고 보지 않는다.
- API/OpenAPI·프런트 계약 변경은 없다.

## 검증과 배포 경계

`supabase/tests/assignment_prestart_change.sql`에 실제 service_role의 요청·결정 RPC 성공,
DELETE/TRUNCATE/TRUNCATE CASCADE 거부, 전체 요청 행·필드 보존 검사를 추가했다.
기존 승인·거절·supersede/RLS/멱등성 회귀도 유지한다.

소스·manifest·application 검사와 실제 DB 검증을 구분한다.
로컬 `npm run ci:quality`(Node 6,324건, typecheck/build/OpenAPI/secret/lint),
`npm run db:manifest:verify`, PG15/17 SQL 문법 파싱은 PASS다.
기존 148개 migration과 manifest 항목 불변을 확인했다.
초기 검사에서 새 head/허용 목록 미동기화가 드러나 이를 보완한 뒤 재검사했다.
로컬 Docker 엔진이 꺼져 있어 Edge 실행·실제 번들은 개발 PR의 DB 없는 CI에서 확인한다.
현재 실제 SQL·역할 전환·전체 DB·운영 적용은 **NOT RUN**이다.
기존 148개 입력의 성공 증거를 변경된 149개 입력에 재사용하지 않는다.
최신 통합 후보의 정확한 commit·검증 입력을 확정한 뒤 전체 DB 1회 실행을 별도로 승인받는다.
운영 적용도 실제 이력과 pending 목록을 재확인한 정확한 계획으로 별도 승인받는다.

이 변경은 기존 데이터를 변환하거나 삭제하지 않는다. 문제가 있으면 적용 진행을 멈추고
실제 권한·이력 관측으로 다음 보완을 정한다. 과거 이력을 삭제하거나 검증 없이
DELETE/TRUNCATE를 다시 부여하는 자동 rollback은 제공하지 않는다.
