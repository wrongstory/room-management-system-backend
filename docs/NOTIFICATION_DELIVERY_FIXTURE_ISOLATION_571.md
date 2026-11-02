# #571 알림 전달 경합 fixture 격리

## 실제 R6 결과

FINAL-147-R6 후보3478018/run41398130690 attempt1은 FAIL이다. 초기 설치·28개 upgrade,
최종 SQL118파일/6482개, 역사적 static100→101과 KST5시점×29는 PASS다.
첫 직접 경합 프로그램 안에서 배정 메모10/객실 고정 메모8을 포함한 선행 경합은 PASS다.
하지만 notification delivery의 시험 데이터 준비가100회 후 LIMIT_EXHAUSTED로 실패했다.
마지막 집계는 pendingJobs70, 나머지10개 집계0이다. 최초 집계·호출별 변화·조인 완전성은
기록되지 않아 최초1070건, 단순 용량 초과 또는 정체의 유일 원인으로 단정하지 않는다.
1000회 권한 거부 호출은 알림 생성이 아니며 이 수량의 근거가 아니다.

첫 프로그램의 이후 password/PIN/PIN bootstrap/candle/incremental Sheet 검사와 뒤11개
직접 경합 프로그램, oracle/proof는 NOT RUN이다. artifact0이며 Stop PASS·volume 보존이다.
전체 잔여0 census나 실패 뒤 추가 reset/재시도/운영 적용은 없었다.

## 최소 보완과 유지 계약

전달 경합은 자체 maid/Auth/session/subscription과 notification을 만들고 기존 admin만
참조한다. 다른 업무 fixture가 만든 누적 outbox가 이 시험의 첫 fanout을 밀어내서는 안 된다.
관리자 fixture 생성 직후, 다른 업무·템플릿 fixture보다 먼저 이 검사를 정확히1회 호출한다.
기존 시험을 삭제하거나 경합 횟수·실패 조건을 바꾸지 않는다.

기존 첫 summary SQL을 확장해 같은 snapshot에서 outbox/jobs/targets/attempts/events의
전체 행 수를 읽는다. 차단/terminal 상태도 포함한 전체5종 행 수와 기존11개 집계가 모두0인
명시적 빈 시작 상태를 요구한다. 결과를 캐시해 bounded helper의 첫 read에 재사용하므로
DB 왕복은 추가하지 않는다. pending뿐 아니라 blocked/future/live/invalid 상태도 거부한다. 예외에는
고정 코드와 유한 count만 포함한다. 예상외 작업을 삭제·숨김·강제완료하거나 부모 조인을
바꿔 잔여를 누락하지 않는다. 준비 한도100회/claim10, 각 SQL15초, 실제 fanout/takeover/
stale settle/parent block/resume/6회 cross-race, reset과 DB 연결 수를 유지한다.

이는 이전 실행의 정확한 미처리 원인을 확정한 수정이 아니라, 독립적인 전달 시험에서
불관련 fixture 누적에 대한 의존성을 제거하고 시작 전제를 명시하는 보완이다.
제품 API·147 migration·권한·전송 worker·운영 정책은 바꾸지 않는다. 실제 provider 호출이나
settle 성공을 주장하지 않으며 사진 HOLD·공개 초기화 비활성·기존 예약 백업을 유지한다.

## 검증 경계

독립 QA에서 기존 claim 분류11개만으로 operator_blocked-only 잔여를 놓칠 수 있음을 발견해
전체5종 census를 추가했다. 부모 누락·terminal 이력도 전부 비어 있어야 하며 기존 분류를
조인으로 줄이거나 다른 작업을 숨겨 통과시키지 않는다.

DB 없는 회귀는 빈 초기 상태와8개 claim 분류 잔여·7개 전체행 잔여·잘못된 census,
단1회/관리자 이후/업무 이전 호출,
기존100회 한계·SQL 경계·비밀 없는 오류 처리를 검사한다. 소스 검사·독립 QA·feature CI와
실제 DB 경합 결과는 구분한다. 새 입력의 Full DB는 NOT RUN이며 실행 전 새 정확 승인이
필요하다. R6의 부분 성공을 새 전체 성공 증거로 재사용하지 않는다.

최종 DB 없는 `ci:quality`는 Node6213/228·typecheck/build/lint/OpenAPI/secrets PASS다.
독립 재검토의 전용87검사와 PG15/17 구문 검사도 PASS이며 초기 census 누락 지적은
보완 후 해소됐다. 실제 SQL/경합 성공은 이 결과에 포함하지 않는다.
