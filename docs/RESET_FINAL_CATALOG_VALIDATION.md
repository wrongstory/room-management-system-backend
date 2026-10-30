# #396 최종 DB 검증의 실제 catalog 연결

승인된 최종 `quality` migration 작업에서 prefix122 체크포인트와 최신 목록 설치가 성공한 뒤
`db:test:reset-final-catalog`를 한 번 수행한다. feature → dev에서는 실행하지 않는다.
같은 run/attempt/merge source/input의 체크포인트, 고정 local project/container/port와
Docker endpoint를 확인하고 기존 READ ONLY REPEATABLE READ catalog SELECT만 사용한다.
업무·Auth 행 조회, migration/reset, 데이터 생성·삭제, 외부 호출은 추가하지 않는다.

이 실제 구조를 기존 `createResetReadPlan`에 넣어 전 관계의 읽기문을 구성한다. 읽기문 실행은
이 검사에 포함하지 않는다. 실제 FK의 identity/대상과 전체 관계 목록으로 **메모리 합성 행**을
구성해 기존 `inspectResetProtectionPlan`의 사진 HOLD → 청소 → 계정 → Auth 부모 보호와
삭제 후보 충돌을 검사한다. 관계 누락·다른 snapshot·참조 누락·부모 누락은 거절해야 하며,
빈 관계도 보호/복구 성공으로 바뀌지 않아야 한다. 추가 DB fixture나 초기화는 없다.

합성 행은 실제 업무행·SQL 값·독립 census가 아니다. 이 검사는 구조/컴파일과 그래프 검사의
연결이며 실제 row collector, 논리 참조, 전체 초기화 범위, Auth/PIN/사진 복구·현장 보호를
증명하지 않는다. 기존 Node/pgTAP/실제 SQL·경합 검사는 별도로 유지한다.

출력은 source/input/catalog/compiled-plan 지문·관계/FK/검사 수와 명시적인 합성 경계뿐이다.
원문 catalog·행·SQL·프로세스 오류를 로그에 출력하지 않는다. `executionEnabled`,
`completeResetCoverage`, `backupVerified`, `restoreVerified`는 계속 false이며,
CI gate와 체크포인트 확인도 사람의 실행 승인을 대신하지 않는다.

전체 작업의 기존 40분 상한 안에서 이 단계는 최대 1분, catalog 프로세스는 최대 15초다.
실패하면 다음 단계로 진행하지 않으며 기존 `always()` 정리와 Full DB proof 조건을 따른다.
현재 개발 검증은 DB 없는 합성 테스트다. 실제 catalog 관측과 Full DB는 별도 승인 전 NOT RUN이다.
