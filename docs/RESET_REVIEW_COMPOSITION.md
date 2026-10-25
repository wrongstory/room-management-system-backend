# #396 같은 스냅샷의 초기화 검토 조립

`inspectResetNativeReview` → `inspectResetReadOnlyReview` → 일회용 `buildReview`는 서버 내부의 검토 경로다. 공개 HTTP, 초기화 명령, 삭제·게시·Auth 호출은 추가하지 않는다. 기존 기본 읽기 경로의 반환 계약과 keep/remove 계획 검사는 유지한다.

## 같은 데이터에서 결합하는 항목

- 기존 전용 TLS 연결의 READ ONLY REPEATABLE READ, 모든 대상 관계 잠금, 전후 catalog/연결/설정/스냅샷 검사를 사용한다. 첫 행 읽기와 별도의 내용 읽기, 관계별 COUNT가 일치해야 조립한다. 두 관측의 미세한 값 변경, 일부 목록, 중복 키, 다른 scope를 거절한다.
- 정책 미정 행도 실제 FK·NULL 의미·대상 존재·참조 누락/중복 검사를 먼저 통과해야 한다. `roomBaseline`, `templateSource`, `unresolved`를 임의로 keep/remove로 바꾸지 않는다. 이 구조 검사는 초기화 계획 유효성이나 실행 권한이 아니다.
- 보존 후보의 비 FK 참조는 24개 registry와 별도로 입력받은 검토 대상 목록을 비교한다. 기존 20개에 source135의 역사 actor/binding/header/entry 4개가 추가된다. 등록 경로 누락과 미등록 경로는 0행이어도 통과하지 못한다. 실제 행에서 이전 값/보존 값을 가져오고, 독립 내용 관측에서 보존 후보 수를 센다. 현재 UUID 참조는 단일 `id` 기본키에 한해서만 해석한다. 복합 키, 미정 대상, 제거 예정 대상을 안전한 참조로 승격하지 않는다.
- 기존 source129의 템플릿 7경로와 source128의 운영 gate 집계를 하나의 고정 STABLE SELECT로 읽는다. 연결의 RR 스냅샷과 statement digest를 재확인한다. 별도의 JSON이나 다른 시점의 집계를 붙이는 입력은 받지 않는다. 7경로 정본은 기존 검토기와 공유하고 동결한다.
- 템플릿 원본과 참조는 검증된 행 내용에서 기존 제안 생성기의 입력으로 투영한다. 현재 게시본/전체 버전 선택과 개발자 ID를 명시해야 한다. 새로운 작성 이력과 원래 내용/역사 보호를 구분하는 기존 제안 생성기를 사용한다. 새 상태·버전·게시 여부·역사 재연결 정책은 정하지 않는다. 원래 PostgreSQL 시간의 마이크로초는 보존한다.
- gate의 설정 존재/대상/version/lifecycle/maintenance 및 진행 중·기한 초과·미완료 Auth 개수를 같은 행 내용과 대조한다. 기한 초과는 종료 증거가 아니다. 기존 `NOT_INTEGRATED`, `NOT_EVALUATED`는 그대로 남는다.
- 개발자 provenance와 receipt actor는 동일해야 하며 같은 내용 스냅샷의 active developer/비밀번호 변경 요구 없음/Auth ID 존재를 확인한다. 이 대조는 최신 세션·재인증이나 실행 시점 권한 확인을 대체하지 않는다.

## 반환과 receipt 경계

반환은 집계, blocker, 같은 capture에 묶인 내용·계획 fingerprint 및 선택적인 기존 `reset-receipt-v1` PREPARED 후보다. 행 값, 원본 키, HMAC 키/행 토큰, provider locator, 사진 payload, 템플릿 원본·새 UUID·작성자 provenance를 반환하거나 기록하지 않는다. raw 관측은 호출 안에서만 사용하고 참조를 정리한다. JS 문자열의 물리적 메모리 삭제를 보장한다는 뜻은 아니다. builder는 성공/실패 후 모두 재사용할 수 없다.

`reviewPrepared=true`와 `contentVerified=true`는 내부 자료 조립/독립 내용 비교 성공을 뜻한다. 정책 미정이면 `snapshotValid=false`가 유지된다. `executionEnabled`, `completeResetCoverage`, `liveDatabaseVerified`는 항상 false다. coherent fake port가 실제 DB인지를 이 순수 검토기가 증명할 수 없으며, 합성 검증은 실제 DB 증거로 승격되지 않는다.

receipt의 TTL, 정책·승인 범위·백업·기대 사후조건 hash, actor/session/password binding, idempotency와 단계 목록은 명시 입력이다. 기본 정책값이나 성공 증거를 만들지 않는다. 호출 시각에 PREPARED 후보만 생성하며 어떠한 blocker도 해제하지 않는다. 결과 receipt에는 실행 이벤트가 없다. 영속 저장의 latest head/CAS/동일 입력 readback, 실제 실행 전 권한·승인·재검증은 별도 저장 어댑터와 실행 경계다. 이 경로가 저장 어댑터를 호출하거나 durable 승인 receipt를 발급하지는 않는다.

기술적으로 불완전한 FK/내용/sidecar 관측에는 부분 receipt를 돌려주지 않는다. 논리 참조 오류에는 receipt를 만들지 않는다. 원본 템플릿 형식이나 선택 계획을 생성할 수 없는 경우도 실행 가능한 대체 계획으로 바꾸지 않는다.

## 남는 실제 입력과 검증

보존/제거 행 그룹, 객실 기본값, 템플릿 선택·새 상태/버전·게시·역사 보호, 최근 재인증/TTL, 정확한 실행 승인 및 백업/사후조건 증거는 별도 입력이다. 실제 전체 schema/의존 관계 coverage, Auth/외부 효과의 종료, 운영 ingress 전환·drain, live 연결의 권한/실행 시간/용량 검증도 남는다. 작은 합성 catalog가 운영 전체 catalog를 대표하지 않는다. 모르는 관계·복합 identity·읽을 수 없는 값을 삭제 가능한 것으로 해석하지 않는다.

이번 검증은 실제 구성요소를 연결한 합성 Node 회귀, PostgreSQL 15/17의 고정 SELECT 구문 분석, 타입·정적 검사다. 실제 DB/SQL 실행, migration 적용, 운영 읽기·초기화, Auth/provider 호출은 NOT RUN이다.
