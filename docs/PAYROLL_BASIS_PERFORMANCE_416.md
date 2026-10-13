# #416 주급·송금 표시 반복 집계 최적화 후보

## 상태 (2026-10-13)

소스 후보, 운영 미반영. 실제 migration/reset/DB SQL/EXPLAIN/속도 측정은
사용자 사전 승인 전 **NOT RUN**이다. 파일 생성은 DB 적용이 아니다.
최종 릴리스 DB 검증을 모아서 실행하는 #431 정책을 유지한다.

## 변경과 근거

`private.payroll_remittance_basis(uuid,date)`는 동일 주급 projection의 8개 금액을
읽는다. 기존 단일 참조 CTE는 planner가 펼칠 수 있어 비싼 projection이
여러 표현식에서 재평가될 가능성이 있다. 실제 기존 실행 횟수는 측정하지 않았다.

신규 미적용 migration115 `20261013063440_payroll_remittance_basis_materialized.sql`은
해당 CTE에 `MATERIALIZED`만 추가하여 helper 한 번 호출 안에서 집계 결과를 재사용한다.
요청 간 캐시가 아니며 주급 목록 전체나 별도 RPC 호출 간 중복을 없애는 변경은 아니다.
[PostgreSQL 공식 CTE 설명](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-CTE-MATERIALIZATION).

기준 본문 MD5 `76783f5e09455472ee2774ba6d3e9766`, 후보
`5bb5b63b12c4055efeb00057859eb6bc`. 실제 적용 시 기준 본문·치환 개수를 확인하고
본문 외 pg_proc 메타데이터 및 OID/ACL/owner/서명/volatility/search_path를 보존한다.

## 보존 계약

- 제품 가이드 §9 수익·지급 및 #331 확정 표시 정책: 금액 변경 후 표시 유지,
  `needsReconfirmation`으로 재확인 요구. 실제 PAID/원장과 표시 축 분리.
- 8개 금액 필드, JSON null/zero/signed 금액, 잠금액, 지연 수익·이월 및 fingerprint 동일.
- 최신 actor/session/메이드 본인 접근, 관리자 명령 권한, CAS·멱등성·잠금 순서 동일.
- 테이블/인덱스/RLS/원장/사진/PIN/Auth 데이터 변경 없음. 날짜 predicate는 별도 후속.
- API/Swagger 요청·응답 변경 없음. 프런트 재연결 불필요, 운영 적용 전 사용 가능으로 표시 금지.
- ERD/DBML 관계는 변경하지 않는다. 개발자 진단 schema head/manifest만115로 동기화.

## 검증 계획과 한계

- Node source 검사: 정확히 한 치환, 8개 필드, metadata guard, SQL 후보 미적용 실패 확인.
- 기존 송금 표시 SQL 회귀 전체를 유지하고 원본 helper 임시 복제본과 모든 fixture 메이드의
  -6~0주 basis 및 관리자/메이드 전체 표시 DTO를 비교하는 검사를 추가한다.
  이 fixture는 승인 후 실행하며, 준비된 SQL을 실행 PASS로 계산하지 않는다.
- feature→dev CI는 application/manifest만. release→main 전체 DB 자동 실행도 사전 승인 필요.
- 승인 후 fresh DB/전체 SQL·권한·경합과114→115 guard/metadata 보존 검사,
  합성 규모별 basis 및 실제 목록/RPC의 EXPLAIN(ANALYZE,BUFFERS)·반복 측정이 필요하다.
  읽기 개선·명령 지연/쓰기 회귀 없음 확인 전 성능 향상률이나 운영 준비 완료를 주장하지 않는다.

롤백: 미적용 후보는 릴리스에서 제외. 적용 후에는 기존 migration을 수정하지 않고
기준 본문 복구용 후속 migration을 검토·승인받아 적용한다.

## 검증 기록

- 변경 전 Node 전체: 118파일/2,971 tests PASS.
- 변경 후 `ci:quality`: PASS, 119파일/2,975 tests·typecheck·build·OpenAPI151 paths/163 operations.
  lint exit0, 기존 warning1/info37. 추가 SQL 비교대상49개 확인 후 targeted116 재검사 PASS.
- `db:manifest:verify`: PASS, dev115 파일명/내용 해시 검증만 수행.
- `edge:check`: PASS, 전체 후보 bundle19,297,597 bytes(<20,000,000). DB 실행 없음.
- 독립 소스 QA: PASS, P0/P1/P2 없음. 대상4파일267 tests PASS,
  최신49개 조합 보완 후116 재PASS, manifest/diff 검사 PASS. 원격 CI는 후속 확인.
- 실제 DB·SQL·성능·운영: NOT RUN.
