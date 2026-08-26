# 백엔드 작업 규칙

## 작업 전 필독과 정책 우선순위

1. `docs/AI_BACKEND_PRODUCT_GUIDE.md`를 끝까지 읽는다. 프런트엔드 저장소나 과거 대화를 볼 수 없어도 따라야 하는 제품·도메인 계약이다.
2. 변경 영역의 `docs/ERD.md`, `docs/room-management-system.dbml`, `docs/ARCHITECTURE.md`와 현재 migration/API를 함께 확인한다. 셋은 review draft이지 목표 계약이 아니다.
3. 정책이 충돌하면 `현재 사용자의 명시적 결정 → AI_BACKEND_PRODUCT_GUIDE의 [확정] → 그 가이드가 고정한 프런트 정책 → 설계 초안 → 현재 구현` 순서로 따른다. 같은 snapshot의 가이드와 원문이 충돌하면 가이드 오류/기획 충돌로 기록하고 되돌리기 어려운 구현 전에 질문한다.

가이드의 `[미확정]`은 추측으로 고정하지 않는다. `[데모]`, `[운영 입력값]`, `[현재 채택안]`, `[현재 구현]`도 `[확정]`으로 승격하거나 production invariant/seed로 사용하지 않는다. 현재 migration이나 와이어프레임 fixture가 존재한다는 이유만으로 제품 정본으로 간주하지 않는다. 프런트 기준 commit을 갱신하면 관련 가이드와 알려진 충돌도 같은 PR에서 갱신한다.

## 구현 규칙

- 모든 public base table은 RLS를 활성화하되 broad `FOR ALL`, 원장 DELETE, 메이드의 전체 컬럼 UPDATE를 허용하지 않는다.
- Supabase secret/service-role 키와 객실 PIN 원문은 클라이언트, URL, 로그, 알림, 감사 payload, Git에 넣지 않는다.
- service role command도 access token의 actor를 식별하고 최신 DB role/status, ownership, capability, version, transition을 매 요청 재검증한다.
- 예약·청소 요청·배정·제출·검수·수익·지급 명령은 DB 제약, 짧은 transaction, CAS version, idempotency key로 경쟁과 중복을 막는다.
- 감사 event·결정·수익·지급 snapshot은 덮어쓰거나 삭제하지 않고 revision, soft cancel, correction event를 추가한다. current pointer·projection·read state·CAS version은 과거 이력을 보존하며 갱신할 수 있다.
- UI의 복합 상태를 단일 DB `status`로 합치지 않는다. 점유·청소 의무·담당·수행·업로드·제출·검수·입실 준비·지급 축을 분리한다.
- 외부 Drive·push 호출을 DB transaction 안에서 기다리지 않는다. 본체와 outbox를 commit한 뒤 worker가 처리한다. 현재 제품은 송금 provider를 호출하지 않고 외부 송금 결과만 기록하며, 향후 연동이 확정되면 같은 원칙을 적용한다.
- FK 자식 컬럼과 RLS/조회 경로의 index를 확인한다. PostgreSQL은 FK index를 자동 생성하지 않는다.
- 이미 원격에 적용된 migration은 수정하지 않고 `supabase migration new <name>`으로 후속 파일을 만든다. 미적용 baseline은 실제 적용 여부를 확인한 뒤 amend/squash 또는 append 전략과 이유를 PR에 적는다.

## 검증과 보고

- 변경 뒤 `npm run typecheck`, `npm test`, `npm run build`를 실행한다.
- migration/RLS 변경은 Docker 환경에서 `npm run db:reset`과 역할별 실제 DB 검사를 추가한다.
- `db:reset`을 실행하지 못했으면 migration이 검증됐다고 말하지 않는다.
- PR에는 참조한 제품 규칙, 변경한 불변식·권한, migration 영향, 동시성/멱등성 처리, 실제 실행한 검증과 남은 미확정 사항을 적는다.
