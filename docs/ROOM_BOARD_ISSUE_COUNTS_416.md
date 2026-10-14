# #416 객실 특이사항 중복 집계 최적화 후보

## 상태와 범위

2026-10-11, PR #420 dev squash `de15bbe` 후속. **소스 후보이며 운영 미반영**이다.
실제 DB migration/reset/SQL/EXPLAIN/benchmark는 사전 승인 대기로 NOT RUN이다.
기존 진단의 dev111 측정값을 이 후보의 속도 개선 근거로 사용하지 않는다.

`get_room_board_projection(uuid,uuid,date,uuid)` 내부에서 객실마다 수행하던
`room_board_issue_count_at(..., false)`와 `(..., true)`를 하나의 lateral aggregate
`count(*)`, `count(*) FILTER (WHERE blocks_guest_assignment)`로 합친다.
실제 실행계획의 스캔/loops/BUFFERS 감소와 화면 체감 개선은 아직 확인하지 않았다.

## 보존하는 계약

- 제품 가이드의 날짜별 객실 현황 및 최신 actor/session 권한 검사를 유지한다.
- `reported_at <= evaluated_at`, `resolved_at IS NULL OR resolved_at > evaluated_at` 유지.
  현재 resolved 상태여도 평가 시점 이후에 해결했다면 포함한다.
- GROUP BY가 없는 집계이므로 해당 issue가 없는 객실에도 0/0의 한 행을 제공한다.
- 기존 함수 본문 MD5 `dbcb3d36a8ee29447ca04854b6ad8909`가 다르면 적용을 중단한다.
  두 치환 위치가 각각 한 번인지 검사하고 pg_proc의 prosrc 외 전체 메타데이터를 보존한다.
- 기존 helper는 삭제하지 않는다. API 36개 필드·Swagger·프런트 연결 변경이 없다.
- RLS/권한/최신 세션 확인·한국 날짜·LIVE statement clock·상태 판정·명령·멱등성 변경 없음.
- 테이블/인덱스/원장/개인정보/사진/PIN/환경 변수 변경 없음.

## 변경 목록

- 미적용 migration114 `20261010153508_room_board_issue_counts_single_scan.sql`.
  이미 적용된 migration은 수정하지 않는다.
- dev manifest114와 정확한 파일명/해시 허용 목록을 동기화한다. 112/113 검사는 유지하며,
  임의 미래 migration이나 본문과 manifest를 함께 바꾼 우회는 허용하지 않는다.
- 개발자 진단 API의 기대 schema head를 동일하게 변경한다. 미적용 DB는 준비 완료가 아니다.
- Node source 검사는 원본과 compatibility 4개 치환으로 정확한 기준 본문을 재구성해,
  후보 두 치환을 되돌린 결과가 원본 전체와 동일한지 검사한다. 이는 SQL 실행 검증이 아니다.
- `supabase/tests/room_board_issue_counts.sql`은 승인 후 전체 SQL suite에 포함할 fixture다.
  빈 객실/복합 이슈, 발생·해결 시각의 정확한 경계, 과거/LIVE/미래 5개 날짜에서
  이전 RPC 전체 36필드와 후보 결과를 같은 statement에서 비교한다. 현재 실행하지 않았다.

## 검증 및 릴리스 gate

소스/application 및 독립 QA 결과는 아래 checkpoint와 PR에 실제 실행 후 기록한다.
최종 DB 검증 전에 사용자 승인을 받으며, feature→dev CI는 manifest-only 정책을 유지한다.
승인 전 release→main PR로 전체 DB 검사를 자동 실행시키지 않는다.

필수 후속:

1. 승인된 최종 fresh local reset/전체 SQL/권한·RLS·경합 및 기존 회귀 검증.
2. 실제 dev113→114 적용 시 본문/메타데이터 guard, 36필드 동등성 검증.
3. 합성 규모별 room board RPC EXPLAIN/BUFFERS·반복 측정. 기존 진단 실행기의111 fingerprint
   제한을 무작정 풀지 말고 별도 검토된113/114 비교 경로를 준비한다.
4. 읽기 개선과 쓰기 회귀가 없는지 확인 후 릴리스 후보 포함을 결정한다.
5. 승인된 운영 pending migration 및 스모크. 프런트 담당은 API 재연결 없이 실사용 확인.

롤백: 미적용 상태에서는 후보를 릴리스에서 제외한다. 적용 후에는 원본 파일/history를
수정하지 않고, 검토된 기준 본문 복구용 후속 migration을 별도 승인받아 적용한다.
현재 운영 rollback을 실행하거나 준비 완료로 판정하지 않았다.

## 실행 결과 checkpoint

- Migration manifest114 소스/해시: PASS (DB 접속 없음).
- 실제 DB/SQL/upgrade/성능/운영 배포: NOT RUN, 승인 대기.
- `npm run ci:quality`: PASS, 118파일/2,970 tests, typecheck/build 및 OpenAPI151 paths/163 operations.
  lint exit0(기존 warning1/info37); 새 경고를 숨기거나 기준을 완화하지 않았다.
- `npm run edge:check`: PASS, 후보 전체 bundle19,297,593 bytes(<20,000,000).
- 독립 소스 QA: 신규 P0/P1/P2 없음, targeted Node2파일/114 tests PASS.
  실제 SQL compile/ACL/MVCC/경합/EXPLAIN/성능은 NOT RUN임을 별도 확인했다.
- `git diff --check`: PASS. 원래 존재하던 Edge 줄바꿈 변경은 포함하지 않는다.
- PR/원격 CI는 후속 확인이며 이 기록을 DB 실행 증거로 사용하지 않는다.

### 2026-10-11 후속: 비교 검증의 미적용 통과 방지

PR #445의 d4307f8은 원격 CI38064746029의 application/manifest-only 모두 PASS다.
실제 DB 단계가 skipped임도 확인했다. 이후 SQL 비교 fixture를 보완했다.

- 비교 전에 설치된 후보 본문 MD5 `5feb3200aab310af19244723ee3c0c0f`를 요구한다.
  미적용 기준 함수가 자기 자신과 비교되어 PASS하는 것을 막는다.
- 단건뿐 아니라 `p_room_id=null` 전체 목록을 과거/LIVE/미래5날짜에서 FULL JOIN으로
  비교해 누락/추가 객실을 검출한다. 빈 fixture 객실5행도 별도 검사한다. SQL 계획6개.
- Node가 후보/기준 본문 hash, 역치환 literal, guard의 선실행, 전체 필드·시계 보존,
  SQL assertion 개수와 rollback 구조를 검사한다. SQL 실행을 대체하지 않는다.
- 보완 후 `ci:quality`: 118파일/2,971 tests·typecheck/build PASS.
  독립 소스 QA2파일/115 tests PASS, 신규 P0/P1/P2 없음. diff check PASS.
- migration114와 그 해시는 변경하지 않았다. 실제 DB/SQL/성능은 계속 NOT RUN이다.
  이전 CI를 새 head의 성공으로 재사용하지 않고 추가 push의 필수 CI를 다시 확인한다.

#431에 따라 개발 소스의 dev 통합과 최종 DB 검증은 분리한다. dev 통합 후에도 이 문서의
릴리스 gate가 남으며, 준비된 SQL fixture나 원격 manifest PASS를 운영 사용 가능으로 표시하지 않는다.
