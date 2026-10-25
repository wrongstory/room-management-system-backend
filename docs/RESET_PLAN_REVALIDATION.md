# 초기화 검토 계획의 재관측 계약 (#396)

`plan-revalidation.ts`는 서버 내부에서 명시 기한을 가진 검토 세션을 만든다. 기존 closed
read-only collector와 builder가 각 관측의 독립 내용/census/FK 검사를 끝낸 뒤에만 비교한다.
이 비교 모듈은 정책을 선택하거나 승인 문서를 발급·소비하지 않으며 DB 쓰기·등록·삭제·복구를 실행하지 않는다.
`executionEnabled`, `liveDatabaseVerified`, `completeResetCoverage`는 항상 false다.

기존 일회 snapshot HMAC는 변경하지 않는다. 이 세션은 별도 key와 domain으로 source/catalog/
분류/요청, typed PK·값·행별 후보를 결합한다. RR 식별자·capture nonce가 달라도 같은 내용은
비교할 수 있지만 동일 건수의 내용 교체, 키·컬럼·관계·정책 intent·행 후보 차이는 거절한다.
카탈로그와 의도 입력은 최초 await 전에 strict bounded copy를 만들고 고정한다.

최초 템플릿 후보의 새 UUID 목록과 계획 시각을 내부 메모리에 보관한다. 재관측은 같은 값으로
기존 생성기/내용 검사를 다시 사용하고 원래 계획의 별도 HMAC와 대조한다. 새 UUID나 새 시각을
할당하지 않으며 최초 검토의 `reviewedPlanFingerprint`를 유지한다. source136부터는 S1에 한 번
전달할 검증된 템플릿·슬롯 원문과 계획도 제한된 내부 메모리에 유지한다. 공개 요약·HTTP 응답이나
로그로 원문을 반환하지 않는다. 계획 시각은 실제 DB 등록 시각이 아니며 S1이 둘을 구분한다.
기존 snapshot key와 행 token은 공개 계약에 노출하지 않고 원래 수명대로 폐기한다.

R1/T1/S1 선택 이후에는 [승인 정책의 draft lifecycle 계획](RESET_APPROVED_HANDOVER_POLICY.md)도
같은 의미 비교에 포함한다. status/version/정책 변경은 원래 내용·UUID가 같아도 거절한다.
재인증5분 정책은 이 비교 핸들의 수명을 자동으로 정하거나 연장하는 기본값이 아니다.

`prepare → recheck → consume`은 각각 한 번이다. 기한은 호출자가 반드시 지정하며 기본 TTL은 없다.
options는 정확히 expiresAt 한 필드만 strict copy하여 단일 정수로 고정한다. getter·추가 필드·
비정수는 거부하고 호출 이후 원본 객체의 변경이 세션 기한에 영향을 주지 않는다.
2,147,483,647ms 상한은 Node timer가 안전하게 표현하는 수명의 기술적 상한이며 운영 추천값이나
재인증 정책이 아니다. wall clock과 monotonic 기한을 함께 확인한다. 실패·취소·기한 만료·중복/
동시 호출·명시 dispose는 세션을 종료한다. process가 끝나면 원래 세션은 복원되지 않으며 새 세션이나
새 key가 이전 사람 승인을 재사용하게 하지 않는다. 재관측 성공 후 비교 key와 재생성용 UUID 목록을
폐기하고 안전한 비교 요약 및 일회 내부 전달용 S1 자료만 기한까지 유지한다. 일반 consume·S1 전달·
dispose·만료는 서로 재사용할 수 없으며 종료 때 원문 참조를 해제한다. JavaScript heap의 물리적
zeroization을 주장하지 않는다. 일반 consume은 **비교 결과의 수명 관리**이며 별도 사람 승인 소비나
초기화 실행 허가가 아니다.

관측 사이 원장/maintenance/재인증의 쓰기를 자동으로 예외 처리하지 않는다. 특히 새 receipt를
저장하면 보존 대상의 내용이 바뀌므로 재관측은 drift로 거절할 수 있다. 초기화 실행 연결은 그 쓰기의
정확한 허용 변화와 별도 current head/CAS 증거를 먼저 결합해야 하며, 전체 control/receipt 테이블을
비교에서 빼서 통과시키면 안 된다. 이 계약만으로 승인 이후의 모든 환경 변화나 복구 완료를 증명하지 않는다.

source136의 [S1 효과 준비](RESET_TEMPLATE_HANDOVER_EFFECT.md)는 두 관측을 끝낸 뒤
`takeResetTemplateHandover`로 핸들을 닫고 PRECHECK·승인 소비·원장·APPLY를 진행하는
내부 순서다. 쓰기 이후 이 핸들의 recheck를 호출하지 않으며 사후 결과는 전용 READ와
같은 원장의 정확한 후조건으로 검사한다. 현재 전체 내용 비교를 느슨하게 하거나 자체
쓰기 허용 목록을 추가할 이유가 없다. 향후 전체 초기화 연결에서도 관측 전 준비와
효과별 사후 검증을 구분해야 하며, 전체 관계를 drift 비교에서 제외하지 않는다.

모든 기존 정책·사진 HOLD·템플릿 상태/버전·보호/복구·admission coverage blocker를 보존한다.
같은 blocker 목록의 두 관측이 일치해도 실행 가능하다는 뜻이 아니다. 실제 승인·전체 범위·최신 권한/
재인증·유지보수 drain·D01 보호 근거·대상별 실행·중단/재조정·최종 사후조건은 별도 경계다.
신뢰된 내부 transport가 필요하며 coherent fake port의 합성 성공을 live DB proof로 승격하지 않는다.

이 개발에서 실제 DB/SQL/TLS/Auth/provider/삭제/백업/승인 소비는 NOT RUN이다. 합성 검증과 실제
closed collector 경로 연결 검증 결과를 PR에 별도로 기록한다.

2026-10-25 source 검증: dev a15c6cd 통합 후 `ci:quality` 187파일/5,104 tests, typecheck/build,
관련 4파일61 tests, migration manifest135, reset preview/row-impact generator 정합성 PASS.
빌드된 다섯 모듈의 순환 import와 닫힌 세션 smoke도 PASS다. Edge/Python/OpenAPI/SQL 입력은
dev와 동일하며 이 단위에서 Edge·Python·실제 DB를 재실행하지 않았다. 독립 QA는 연결61 tests와
options25 tests를 각각 실행해 통과했다. 최초 입력 상한 회귀의 실시간 clock 오차는 fake clock으로
고정했고, native 결과 union 타입 검사를 보완한 뒤 최종 검사를 통과했다. 이 결과는 운영 검증이 아니다.
