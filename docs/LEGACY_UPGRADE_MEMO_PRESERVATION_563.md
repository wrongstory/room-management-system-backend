# #563 과거 배정 보존 검사와 신규 메모 열

FINAL-147-R1 run41366963854 attempt1은 cleaning-overdue upgrade에서 실패했다.
85번까지의 합성 배정행 JSON과147번까지 적용한 JSON을 비교할 때140번이 추가한
`instruction_memo: null`도 과거 업무 변경으로 취급했다. 집계 hash만 기록돼 있어
이것이 실제 차이의 전부였다는 주장이나 과거 값 무변경을 아직 증명하지 않는다.

## 보완 범위

다음6개 pre140→latest 검사만 같은 read-only helper를 사용한다.

| 검사 | 기준 migration | 기존 보호 테이블 수 |
|---|---:|---:|
| cleaning-overdue |85|7|
| cleaning-started |87|8|
| cleaning-overdue-preview |88|14|
| cleaning-overdue-commit |89|14|
| manual-cleaning-cancel |92|20|
| assignment-target-read |93|23|

첫 fixture snapshot은 메모 열이 없는 기준과 비어 있지 않은 배정 ID 집합을 고정한다.
설치 이후에는 정확한 nullable text 메모 열이 있어야 한다. 모든 후속 snapshot에서
기존 ID 잔존과 그 메모 NULL을 검사한다. 기존행의 새 메모 키만 기존 필드 비교에서
분리하며, 새 행의 메모는 비교에 포함한다. 새 command 뒤 기준 digest를 새로 잡아도
최초 ID 집합은 재캡처하지 않는다. 열이 사라지면 과거 기준으로 되돌아가지 않고 실패한다.

기존 #95의 schedule snapshot 예외는 해당2테이블에만 유지한다. 알 수 없는 열과
기존 필드, 행 추가/누락, type/nullability 차이는 비교에 남는다. 전체 NULL 키 제거는
사용하지 않는다. 기존 fixture·RPC·도메인 assertion·경합 순서·reset·정리·시간 상한은
유지하고, 각 기존 snapshot 자리에 단일 SELECT만 사용해 연결/reset 수를 늘리지 않는다.

비교 결과는 테이블별 count/digest/schema/field digest다. 실패 시 테이블·행수·digest·
변경 필드명·schema 변화 여부를 출력하며 메모/행/PIN 원문과 배정 ID를 로그에 남기지
않는다. query 오류도 고정 코드로 처리한다. field digest는 위치를 좁히는 진단이며
전체 row digest와 행수 비교를 대체하지 않는다.

## 검증과 경계

DB 없는 회귀는 과거 필드 변경, 기존행 누락, 새행 추가, 기존 메모 non-NULL,
열 누락/잘못된 type/nullability, 중복 ID, 빈 fixture, 알 수 없는 열, 반복 snapshot의
최초 ID 보존, 실패 로그 비노출을 검사한다. 실제 생성 SQL은 PG15/17 parser로
단일 SELECT 문법을 검사한다. 이는 실제 PostgreSQL 실행 결과가 아니다.

제품 API·업무 계약·147개 migration·118개 SQL 회귀 파일·실행 workflow는 변경하지 않는다.
제품 가이드 #534 메모 보존/초기값, #431 실행별 승인, `FINAL_DB_VALIDATION.md`를 따른다.
실제 SQL/upgrade/경합/Full DB는 **NOT RUN**이다. 실패한 이전 run은 그대로 보존한다.
새 후보의 PR553 동기화·격리 검증1회는 USER_DECISIONS D03의 정확한 새 승인 후 수행하고,
운영 migration은 별도 승인이다. source CI/독립 QA를 전체 DB proof로 사용하지 않는다.
