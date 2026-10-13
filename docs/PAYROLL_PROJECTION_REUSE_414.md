# #414 주급 집계의 단일 SQL 호출 내 재사용 후보

2026-10-13: PR448 인계문서 병합 후 dev4e6ae57 기반. 운영 미배포·전체 DB NOT RUN.

최신 통합: devd92eb35의 #416/PR449가 송금표시 basis를116번째로 먼저 구현했다.
그 파일·동등성 회귀를 보존하고 #450의 중복 basis 변경을 제거했다. #450은117번째의
before_workflow wrapper만 담당한다. 아래 최초 두 함수/116 설명은 통합 전 기록이다.
이미 실행된 SQL을 수정한 것이 아니라 미적용 #450 후보만 축소했으며 실제 DB는 NOT RUN이다.

## 확인한 경로

- work-details는 페이지마다 project_payroll_cycle_bounded(...,1)을 호출한다. 페이지별 최신
  summary는 현재 응답 계약이므로 앞 페이지 금액을 캐시해 생략하지 않는다.
- 이 projector의 before_workflow wrapper는 projected.value를 본문/조건/cycleId에서 읽는다.
- remittance_basis는 같은 projected.value에서 금액 필드8개를 읽는다.
- PostgreSQL의 단일 참조 CTE 인라인 처리로 무거운 함수 식이 재평가될 가능성이 있다.
  실제 횟수/속도는 실행계획으로 확인 전이며 소스 참조 수를 실제 실행 횟수로 표현하지 않는다.

## 최소 변경

두 함수의 한 행짜리 projected CTE에 MATERIALIZED만 추가한다. 동일 호출 안에서 결과를
재사용할 뿐 요청 간·사용자 간·페이지 간 캐시가 아니다. 매 RPC의 actor/session 검사,
금액 계산식/PAID/송금표시 fingerprint/멱등성/잠금/후속 재검증은 유지한다.
기존 before_workflow는 과거 payment wrapper의 복제본임을 소스 검사로 고정한다.
본문 MD5·치환1회·OID와 prosrc 외 전체pg_proc 동등성 검사로 예상과 다른 DB에서 중단한다.
이미 적용된 SQL은 변경하지 않고 CLI로 생성한116번째 파일을 추가했다. 실행하지 않았다.

## 프런트 인계

새 endpoint/필드/요청 방식 없음. 기존 batch 최대10명·동시3 RPC와 페이지별 summary를 유지한다.
각 페이지/송금표시가 동일 snapshot이라고 가정하지 말고 CAS·금액 변경 재확인을 계속 사용한다.
배포 전 연결 변경은 필요 없다. UI 체감 개선률은 아직 미확인이다.

## 최종 릴리스 gate (실행 전 사용자 승인)

기존 전체 payroll/marker/work-details/지급·권한·경합 회귀와 두 함수의
기존/후보 JSON·금액·fingerprint 동등성을 확인한다. cycle없음/open/check/paid/상계완료/
늦은수익/정정/미승인workflow를 포함한다. 1/10/20명 규모에서 같은 입력·환경의
EXPLAIN(ANALYZE,BUFFERS) 및 p50/p95·호출횟수를 비교한다. 쓰기 command도 이 private
basis를 사용하므로 금액/오류 우선순위/동시성 회귀를 생략하지 않는다.
MATERIALIZED의 추가 비용이 이득보다 크면 릴리스에서 제외한다. 실측 전 성능 완료로 닫지 않는다.
전체 DB 검증은 최종 릴리스에서1회, 별도 승인 없이 release PR/push로 실행시키지 않는다.

참고: [PostgreSQL CTE materialization](https://www.postgresql.org/docs/current/queries-with.html#QUERIES-WITH-CTE-MATERIALIZATION).
Supabase 성능 스킬에 따라 추측 기반 속도 수치/권한 캐시 대신 좁은 후보와 실행계획 검증을 분리했다.

## 소스 검증 checkpoint

Node119파일2,992개/typecheck/build/manifest116/secret scan PASS.
독립 소스 QA6파일391개 PASS, 확정P0/P1/P2없음. 함수 복제 이력과 단일 CTE 치환,
catalog 보존·exact-tail/hash 변조 거부를 검토했다. 이 결과는 SQL 동등성·실측 성능의
대체가 아니다. Edge/Python 전체 회귀는 PR CI에서 확인하며 DB/SQL/마이그레이션 실행0회다.
