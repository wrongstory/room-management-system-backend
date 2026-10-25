# #396 내부 읽기 전용 snapshot 수집 경로

`snapshot-read-plan.ts`와 `snapshot-read-source.ts`는 기존 내용 snapshot builder에 검토된
catalog-v2 기반의 실제 SQL **소스**와 전용 연결 포트를 연결한다. 공개 API, 환경 변수, 자격 증명,
기본 DB connector, CLI 실행 진입점은 추가하지 않는다. `#378`의 history export 포트도 확장하지 않는다.
실제 DB 실행은 0회이며 `liveDatabaseVerified=false`, `executionEnabled=false`는 항상 유지한다.

## 신뢰와 쿼리 범위

입력 catalog와 project/source/catalog/classification binding은 서버가 별도로 검토한 값이어야 한다.
외부 요청의 SQL이나 테이블 목록을 그대로 실행하는 기능이 아니다. 기존 catalog-v2 validator,
명시된 row-candidate 규칙 지문, PK/FK/컬럼 계약이 일치해야 연결 포트를 연다.
Auth는 `auth.users.id`만 읽고 나머지 Auth 컬럼은 쿼리와 예상 metadata에서 제외한다.
공개·비공개 업무 관계는 검토된 컬럼의 typed text를 내부에서 처리하므로 실제 연결 시에는 민감
내용을 취급하는 전용 backend 경계가 필요하다. 로그·반환값·파일로 원문을 내보내지 않는다.

연결 owner는 TLS/대상 프로젝트를 검증한 **새 전용 연결**, 읽기 전용 기본값,
누적 wire 예산과 text-only(OID25) decoding을 제공해야 한다. pool의 사용 중 연결이나 외부 호출자가
제공한 client는 허용되는 신뢰 근거가 아니다. 현재 합성 port 테스트는 이 실제 transport 또는
developer 권한의 증명이 아니며 실제 connector/auth/운영 연결 검증은 별도다.

## snapshot와 스키마 고정

순서는 `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, 고정 `SET LOCAL` utility 묶음,
모든 검토 관계의 `LOCK TABLE ONLY ... IN ACCESS SHARE MODE`, 최초 SELECT다.
`SELECT set_config(...)`처럼 lock보다 먼저 RR snapshot을 고정하는 방식은 사용하지 않는다.
PostgreSQL의 `PlannedStmtRequiresSnapshot`은 transaction/SET/LOCK utility를 snapshot 불필요로
분류한다([PostgreSQL source](https://doxygen.postgresql.org/pquery_8c_source.html)). 이는 소스 근거이며
이 저장소의 PostgreSQL/hosted 실행 검증 결과를 뜻하지 않는다.

최초·최종 backend PID, database, role, nonce, RR snapshot, READ ONLY, RLS bypass,
text 표현 설정과 timeout을 비교한다. 초기·최종 catalog 지문과 관계 이름/OID 목록도 비교하고
각 관계의 실제 ACCESS SHARE lock 관측을 요구한다. ordinary table만 허용하며 partition,
inheritance/foreign table, custom type output/cast, 안전성이 확인되지 않은 FK equality는 차단한다.
FK는 실제 PostgreSQL equality로 참조 대상 PK를 조회한다. NULL/MATCH와 복합 키는 기존 checker가
검사하며 JS 문자열 equality로 SQL 참조를 추정하지 않는다.
FK 배열은 명시 `ROWS FROM`의 단항 `pg_catalog.unnest`로 정렬해 함께 읽는다. PostgreSQL17은
비한정 multi-array `unnest`만 특수 변환하므로 스키마 한정 다중 인자 함수로 호출하지 않는다
([PostgreSQL17 parser source](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/parser/parse_clause.c)).

빈 관계를 포함한 독립 COUNT, 후보·FK·내용 행 조회, 독립 내용 재조회는 각각 별도 SELECT다.
한 관계당 왕복을 반복하지 않고 각 단계의 검토된 쿼리를 UNION ALL로 묶는다. COUNT가 모두 한계
이하인 경우에만 실제 내용을 읽는다. 반환 결과는 strict field/OID/텍스트 형식·건수·바이트 검사를
거친다. 같은 건수의 내용 변경, 마지막 세션/스키마/OID 변경 또는 누락을 부분 성공으로 반환하지 않는다.

내용 검증 후 `roomBaseline`, `templateSource`, `unresolved`가 있으면 각각 구체 blocker를 반환한다.
이 그룹을 임의 keep/remove로 바꾸지 않는다. 사진 HOLD는 보존 후보이며 일반 resetCandidate도
가상의 영향 분석 표시에 불과하다. 실제 삭제 allowlist나 실행 승인이 아니다.

## 상한과 정리

최대 1,000관계, 전체 10,000행(독립 pass별), 누적 text 16MiB, source 전체 4.5초,
개별 쿼리 4초, 서버 lock 1초, 연결 종료 350ms 상한을 사용한다. 서버 statement/idle timeout도
4초로 설정하지만 이 숫자를 hosted 강제 취소 실측으로 표시하지 않는다. 포트가 반환하기 전에
wire를 무제한 버퍼링하면 이후 바이트 검사는 메모리 상한을 보장하지 못하므로 owner의 wire 상한이 필수다.

성공은 ROLLBACK과 bounded close까지 성공해야 한다. 오류·취소·초과·늦게 열린 연결은 destroy하고
고정 오류만 반환한다. 원격 서버가 실제로 멈췄다는 증명은 transport/hosted 검증이 필요하다.
원문 배열의 참조를 해제하고 builder의 일회 key를 폐기하지만 JS heap 복사본의 물리적 삭제는 보장하지 않는다.
순수 builder의 5초 예산은 source 반환 후 canonical/HMAC 검증도 포함한다.

## 검증과 남은 경계

합성 연결은 정상 RR 흐름, count/content drift, 빈 census 누락, role/설정 변경, type/FK/lock 거부,
OID 교체, byte/row 상한, 취소·늦은 open·실패한 rollback·무응답 close와 민감 오류 비노출을 검사한다.
실제 생성된 전체 쿼리를 PostgreSQL 17 parser로 구문 검사한다. 이 과정에서 기존
`scripts/reset-catalog.sql`의 예약어 alias `deferrable`을 인용하도록 고쳤으며 JSON 키는 그대로다.
parser 실행은 SQL 실행이나 권한·동시성·DB 통합 테스트가 아니다.

실제 연결/SQL/pgTAP/호스팅 취소/백업/복구/초기화/삭제는 NOT RUN이다. 명시 논리 참조 registry,
템플릿 재등록 계획, admission/receipt와의 결합은 각각 별도 단위다. D01 보호 방법과 템플릿 상태
선택, 사진 HOLD, 실제 권한·승인·최종 DB 검증은 이 수집기가 대신하지 않는다.

개발 검증: `npm run ci:quality` 165파일/4,544 tests PASS, focused collector/snapshot/catalog
4파일139 tests PASS, manifest129 PASS다. 컴파일된 Node 모듈 import도 DB 연결 없이 확인했다.
Edge/Python/public API/migration 입력은 이 단위에서 변경하지 않았으며 별도 실행하지 않았다.
dev8b40ef(130/131 및 관측 원장 포함) 정상 통합 후 `ci:quality`는170파일/4,736 tests PASS다.
manifest131와 admission/atomic source 생성 검사 PASS, collector 고유 변경10파일을 유지했다.
최종 dev9abe806(worker132) 정상 통합 후 `ci:quality` 172파일/4,765 tests, manifest132,
worker source 생성 검사 PASS다. Edge/SQL/worker 입력은 해당 dev와 동일함을 확인했다.
