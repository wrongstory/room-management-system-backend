# #396 최종 DB 검증의 실제 catalog 연결

승인된 최종 `quality` migration 작업에서 prefix122 체크포인트와 최신 목록 설치가 성공한 뒤
`db:test:reset-final-catalog`를 한 번 수행한다. feature → dev에서는 실행하지 않는다.
같은 run/attempt/merge source/input의 체크포인트, 고정 local project/container/port와
Docker endpoint를 확인하고 기존 READ ONLY REPEATABLE READ catalog SELECT만 사용한다.
업무·Auth 행 조회, migration/reset, 데이터 생성·삭제, 외부 호출은 추가하지 않는다.

2026-11-01 #14의 #396 범위 결정대로 진단·안전 검사만 연결한다. 실제 초기화 완성과 실행은
운영사 인계 전 후속이며, 이 검사가 새 삭제·보존 정책이나 초기화 권한을 정하지 않는다.

현재 source144에는 `private.room_fixed_memo_revisions`가 있다. #551 계약에 따라 이 원장은
**미분류 차단 대상으로 유지**한다. 전체 catalog의 명시적 관계 목록, 이 테이블의 5개 컬럼·타입·
nullability·순서, 복합 PK, RLS 상태, 객실/작성자 FK 두 개의 RESTRICT·키·검증/지연 속성을
확인한다. 예상 밖 inbound FK, 다른 미분류 관계, 누락 관계는 거부한다. guard trigger의
정확한 이름·활성 상태와 기존 두 digest도 확인·바인딩한다. catalog-v2는 함수 본문·trigger
이벤트/실행 의미를 제공하지 않으므로 **이력 불변성의 실제 SQL 의미를 증명하지 않는다**.
그 검증은 기존 #551 SQL/경합 검사이며, 이 검사로 대체하거나 생략하지 않는다.

전체 catalog는 기존 `createResetReadPlan`에서 `RESET_READ_PLAN_REJECTED`, 기존
`inspectResetProtectionPlan`에서 `RESET_PROTECTION_RELATION_COVERAGE_INCOMPLETE`로
계속 차단되어야 한다. 이 두 거부를 확인한 뒤에만 별도 검토 범위의 사진 HOLD 검사를 수행한다.
전체 입력을 받아들인 읽기 계획이나 전체 보호 계획이 준비됐다고 보고하지 않는다.

사진 HOLD 검사는 기존 검토 완료 191개 관계와 `auth.users`만을 별도 catalog 지문으로 묶는다.
새 원장과 그 두 outgoing FK/trigger를 포함하지 않는 명시적 진단 투영이며, 새 원장으로 향하는
FK가 있으면 이 분리 자체를 거부한다. 기존 compiler가 이 범위의 읽기문을 구성하지만 실행하지
않는다. 실제 FK의 identity/대상으로 **메모리 합성 행**을 구성해 기존 보호 검사의 사진 HOLD →
청소 → 계정 → Auth 부모 보호와 삭제 후보 충돌을 확인한다. 기존 여섯 검사(보호 충돌, 빈 관계,
관계 누락, 다른 snapshot, 참조 누락, 부모 누락)를 유지한다. 빈 관계도 보호/복구 성공으로
바뀌지 않아야 한다. 추가 DB fixture나 초기화는 없다.

합성 행은 실제 업무행·SQL 값·독립 census가 아니다. 이 검사는 구조/컴파일과 그래프 검사의
연결이며 실제 row collector, 논리 참조, 전체 초기화 범위, Auth/PIN/사진 복구·현장 보호를
증명하지 않는다. 기존 Node/pgTAP/실제 SQL·경합 검사는 별도로 유지한다.

출력의 `catalogFingerprint`·`relationCount`·`foreignKeyCount`는 전체 관측 catalog에 해당한다.
`reviewedCatalogFingerprint`·`reviewedRelationCount`·`reviewedForeignKeyCount`와
`compiledPlanSha256`·`compiledStatements`는 별도의 검토 완료 범위에만 해당한다.
현재 전체 관계 수193(앱192+Auth1), 검토 관계 수192(앱191+Auth1), deferred 관계1이며,
`fullCatalogReadPlan=BLOCKED_UNCLASSIFIED_551`,
`fullCatalogProtectionPlan=BLOCKED_RELATION_COVERAGE`,
`compiledScope=REVIEWED_RESET_RELATIONS_ONLY`, `triggerSemantics=NOT_PROVEN_BY_CATALOG`를 기록한다.
DB 없는 PostgreSQL17 문법 파서는 migration의 실제 table 선언과 명시적 검토/deferred 목록을
대조하므로, 목록 자체에서 만든 합성 fixture만으로 새 테이블 누락을 놓치지 않는다.

그 밖의 출력은 source/input 지문·검사 수와 명시적인 합성 경계뿐이다.
원문 catalog·행·SQL·프로세스 오류를 로그에 출력하지 않는다. `executionEnabled`,
`completeResetCoverage`, `backupVerified`, `restoreVerified`는 계속 false이며,
CI gate와 체크포인트 확인도 사람의 실행 승인을 대신하지 않는다.

전체 작업의 기존 40분 상한 안에서 이 단계는 최대 1분, catalog 프로세스는 최대 15초다.
실패하면 다음 단계로 진행하지 않으며 기존 `always()` 정리와 Full DB proof 조건을 따른다.
실패 메시지는 `RESET_FINAL_CATALOG_REJECTED [고정 단계 코드]`다. `INPUT`,
`CATALOG_STRUCTURE`, `DEFERRED_STRUCTURE`, `FULL_CATALOG_BLOCK`, `REVIEWED_PLAN`,
`PHOTO_HOLD`, `NEGATIVE_FIXTURES`, `ENVIRONMENT`, `CHECKPOINT`, `CATALOG_READ`,
`SOURCE_RECHECK`만 사용하며 알 수 없는 예외는 `UNKNOWN`으로 처리한다. caller 값이나 원본
오류를 단계 코드로 복사하지 않는다.

2026-11-02 승인된 [CI41344850134](https://github.com/wrongstory/room-management-system-backend/actions/runs/41344850134)는
source122→144 격리 설치 단계와 application·Supabase stop이 성공했으나 이 단계에서 실패했다.
후속 SQL/경합·oracle 업로드·Full DB proof는 SKIPPED였다. 당시 메시지는 단계 구분 없이
`RESET_FINAL_CATALOG_REJECTED`만 남겨 실제 최초 실패 분기는 특정할 수 없다. 소스 대조와
DB 없는 재현에서는 #551 미분류 테이블을 전체 compiler에 전달하는 기존 harness의 불일치를
확인했다. 그 실행을 성공으로 바꾸지 않으며, 이 보완의 실제 catalog 연결·전체 DB 재실행은
새 최종 입력에 대한 별도 승인 전 **NOT RUN**이다.
