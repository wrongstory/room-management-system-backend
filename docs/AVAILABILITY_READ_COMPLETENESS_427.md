# #427 가능일 조회 완전성과 성능 후속 순서

## 사용자 승인 순서

2026-10-09 프런트 `makee-ham/room-management-system@e2b95d8bddee808b590187c544fb33b69d37354e`
의 DOCS/32·33과 #206/#207 인계를 범위 한정 대조했다. 전역 제품 snapshot이나 UI 정책 변경이 아니다.

1. #427 가능일 누락 위험 확인·단기 방어를 먼저 처리한다.
2. 이미 배포된 사진 snapshot/nullable/timing의 지정 계정·객실 정상 업로드 UAT는 별도 트랙이다.
   실제 null을 안전하게 재현하지 못하면 NOT RUN으로 기록하고 fixture 검증과 구분한다.
   운영에서 오류를 강제로 만들거나 이 희귀 경로를 모든 개발의 차단 조건으로 삼지 않는다.
   프런트 snapshot 옵션은 담당자의 실제 정상 업로드 검증·활성화 전까지 현 상태를 보존한다.
3. 공통 계측 #417, 송금 표시 batch #418, 배정 조회 대기 감소 #419를 최신 dev와 통합·검증한 뒤
   별도 릴리스로 배포한다. 계측 자체를 속도 개선으로, HTTP 감소를 DB 조회 감소로 주장하지 않는다.
4. 실제 1/5/20장·첫 표시·전체 표시 측정 결과에 따라 #411 썸네일·안전한 병렬 업로드를 추진한다.
   전체 백업/복원·DB 초기화 후속은 이미 배포된 업무 기능의 사용 선행조건으로 묶지 않는다.

## 확인된 문제와 1차 후보 계약

운영 source v0.9.2의 Node/Edge 가능일·변경 요청·후보 목록은 count를 요청하지 않고
DB 응답 배열을 성공 처리했다. 실제 운영 누락이 발생했다고 확정한 것은 아니지만,
PostgREST의 실제 row cap보다 결과가 많으면 조용한 부분 성공이 가능하다.

- 기존 access-token RLS client, 본인/관리자 범위와 필터를 그대로 사용한다.
- 같은 SELECT에 `count: exact`, `limit(1000)`을 적용한다. 별도 service-role count나 두 번의
  count/data 요청으로 권한 또는 snapshot 범위를 다르게 만들지 않는다.
- 유효한 exact count와 반환 수가 같고 기술상한 1,000 이내일 때만 전체 성공이다.
  실제 remote cap이 1,000보다 낮아도 count 불일치를 거부한다. unknown count, 잘림,
  상한 초과를 빈 배열·부분 성공으로 바꾸지 않는다. 배열 0/count 0은 정상 성공이다.
- current version에 포함된 일별 row도 해당 주의 서로 다른 7일/boolean인지 검사한다.
  부모 count가 맞아도 nested row가 잘리면 성공으로 반환하지 않는다.
- 실패는 기존 HTTP 500 `AVAILABILITY_COMMAND_FAILED`다. 오류 메시지에 DB count·개인정보를
  넣지 않는다. 프런트는 오류/재시도를 표시하고 미제출·근무 불가·후보 없음으로 해석하지 않는다.
- 정상 DTO/성공 envelope, 제출·승인 command, CAS/멱등성, SQL/RLS는 불변이다.
  새 migration, 운영 max_rows 변경, 자동 전 페이지 조회, cursor/total 필드는 추가하지 않는다.

이는 **조용한 누락 방지**이지 대규모 목록을 끝까지 제공하는 pagination 완성은 아니다.
변경 요청은 주차/상태/메이드 필터로 범위를 줄일 수 있다. 장기적으로 1,000건 초과 활용이
필요하면 별도 페이지 계약과 프런트 연결로 처리한다. count 집계 비용은 실제 환경 측정 대상이다.

## 운영 설정 확인과 검증 경계

- 운영 DB의 읽기 전용 `current_setting('pgrst.db_max_rows', true)`는 null,
  pg_db_role_setting의 해당 override는 0건이었다. 이는 실제 PostgREST 설정 조회가 아니므로
  **운영 cap=1,000 확인 완료가 아니다**. repository config=1000과 구분한다.
- Supabase 공식 select 문서의 exact count/기본 행 제한을 확인했다:
  https://supabase.com/docs/reference/javascript/select
- 수정 전 main 32c100e: Node 2,713 PASS. 후보는 dev 5787158에서 분리했다.
- 수정 후 `npm run ci:quality` PASS: secrets/OpenAPI/lint/typecheck/Node 2,737/build.
  관련 Node 검증은 27 PASS(기존 3 + 새 24)다.
  실제 supabase-js fetch adapter에서 Prefer count=exact/limit 요청 및 Content-Range 잘림·
  count 누락을 확인한다. 합성 응답이며 실제 운영 RLS 또는 부하 검증은 아니다.
- `npm run edge:check` PASS: 기존 Edge 515 + report runtime 65,
  실제 후보 bundle 19,222,261 bytes로 20,000,000 byte 한도 이내다.
- 독립 QA: 소스·문서 검토와 Node 27/Edge 32 직접 재실행 PASS, P0/P1/P2 차단 결함 없음.
  SQL/schema/RLS 변경 0, 새 migration/reset/실제 운영 계정 UAT/실 DB 부하 검증은 NOT RUN.
- exact-head 원격 CI·dev 병합·릴리스는 후속이다. source 후보이고 미배포다.

## 남은 작업

- [x] 후보 전체 검증·독립 QA
- [ ] PR/CI·dev 병합
- [ ] 명시적인 목록 pagination/total/cursor 후속 계약
- [ ] 실제 PostgREST row cap 확인 또는 승인된 실제 계정의 완전성 확인
- [ ] #417/#418/#419 최신 통합·릴리스
- [ ] 사진 지정 대상 UAT와 프런트 옵션 활성화(프런트 담당)
