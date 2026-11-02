# #563 과거 배정 영향 응답의 메모 가산 계약

FINAL-147-R2는 앞19 upgrade PASS 후 target-read upgrade의 응답 비교에서 실패했다.
실제 실패 행 차이는 기존 로그에 없어 유일 원인은 확정하지 않는다. 소스상140번의
instructionMemo 추가를 기존13 metadata 제외목록이 처리하지 못하는 결함을 확인했다.

pre140 합성 fixture는 assigned 행의 명시 NULL 메모와 unassigned 행의 키 부재를
검증한 후 기존 필드 전체·행 순서·개수를 비교한다. 알려진 metadata 외 추가 키는
계속 거부한다. 새 commit receipt도 NULL 메모를 검사한다. 기존 receipt exact replay,
history, fingerprint, read-only/RPC/권한 검사와 reset/cleanup 호출은 유지한다.
로그는 고정 collection/reason 코드만 허용하며 행 값·메모·SQL·오류 원문을 출력하지 않는다.

DB 없는 회귀는 추가 NULL 허용, 값 변경/필드 누락/예상 밖 키/개수 변경/누락 메모/
unassigned NULL 키/메모 backfill 거부를 검사한다. 실제 PostgreSQL 결과는 별도 승인된
최종 릴리스 전체 DB 실행에서 확인해야 한다. 이번 보완은 migration 또는 제품 API 변경이 아니다.

FINAL-147-R3에서 위 target-read 검사는 실제 PASS했지만 다음 schedule upgrade의
baseline94 전체 impact 비교가 실패했다. 실제 차이 값은 로그에 없어 유일 원인은 미확정이다.
baseline94에는 기존13개 metadata가 이미 있으므로 이 값들을 제거하면 안 된다.
이 경로는 metadata와 fingerprint를 포함한 모든 top-level 필드를 그대로 비교하며,
assigned NULL/unassigned 키 부재만 별도로 검증한다. 기존 history·schedule snapshot·
old/new receipt replay·RPC·read-only·reset/cleanup은 유지한다. 새 DB 재실행은 별도 승인이다.
