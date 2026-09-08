# 사진 슬롯·제출 기반 모델 — Issue #30

## 범위와 현재 상태

- 작업 기준: `dev@9ed843ca570d1fccaa95fdb672fb8dc20fe91107`.
- 상태: feature 구현·로컬 검증 완료. 독립 exact-head 리뷰·required CI·dev 병합은 별도 대기 gate다.
- 제품 정본: `AI_BACKEND_PRODUCT_GUIDE.md` §7, §10, §11과 고정 프런트 정책 `DOCS/18_TYPE_PHOTO_TEMPLATE_POLICY.md`.
- #30은 versioned slot, target snapshot, attempt별 사진 연결, 불변 제출본과 current pointer, 증빙 완전성 검증 기반만 소유한다.
- 실제 Google Drive 업로드·바이너리 검증·삭제 worker는 #9, 전체 제출·검수 command는 #31이다. 이번 단계에서 새 HTTP API나 운영 배포를 추가하지 않는다.

## 반드시 유지할 경계

1. target 생성 시 사진 슬롯을 고정한다. 현재 활성 template을 과거 target/attempt/submission에 재계산하지 않는다.
2. 현재 사진의 범위는 `(attempt, target slot)`이다. 인계된 이전 담당자의 증빙은 새 회차 사진이나 제출본에 섞이지 않는다.
3. 제출본에 연결한 사진 version은 이후 재촬영·pointer 교체로 바뀌지 않는다. 과거 제출과 증빙 연결은 삭제하거나 덮어쓰지 않는다.
4. 사진 완전성은 제출 권한과 다르다. 완전한 증빙도 `evidence_upload` 한정 회차에 전체 제출 권한을 주지 않는다.
5. `field_completed`는 사진 0장에서도 가능한 물리적 완료 선언이다. 이 모델만으로 검수 승인, room ready, earning, payroll을 생성하지 않는다.
6. 사진 크기 한도는 300KiB, 파일 보존은 업로드 후 정확히 7일이다. 모델 검증을 실제 파일·Drive 검증 완료로 표현하지 않는다.

## 템플릿·기존 데이터 처리 원칙

- 확정된 새 퇴실 template v7+는 타입별 10/11/13/15개, 필수 9/10/12/14개이며 필수 `tv-on`이 정확히 하나다.
- 과거 v6 이하 snapshot에 `tv-on`을 소급 추가하지 않는다.
- 연박·재청소 슬롯과 예상시간의 프런트 데모 값을 운영 정본이나 seed로 승격하지 않는다. 추가 청소의 미확정 구성을 추측하지 않는다.
- legacy JSON은 실제 저장된 근거를 보존한다. 빈 배열이나 불명확한 snapshot을 현재 v7로 자동 채우지 않는다.
- 미설정·불완전한 snapshot은 새 전체 제출의 완전성 검증에서 실패해야 한다. 기존 물리 수행과 예약 lifecycle의 의미는 바꾸지 않는다.
- template의 과거 `duration_minutes`와 #29의 별도 confirmed duration policy는 서로 다른 계약이다.
- 내부 projection 검증의 자원 상한은 슬롯 100개, stable key 80자, 표시 순서 0–99의 중복 없는 값이다. 이는 미확정 청소 종류의 필수 사진 수를 정하는 제품 정책이 아니다. 기존 자료가 이 상한이나 지원 형식 밖이면 값을 버리거나 바꾸지 않고 미설정 상태로 보존한다.
- 필수 슬롯이 하나도 없는 자료는 사진 0장으로 제출 가능한 템플릿으로 인정하지 않는다. 임의 필수 슬롯을 추가하지 않고 완전성 검증에서 거부한다.

## 검증 계획

- NULL·다른 target/attempt/slot 연결과 중복 current pointer 차단.
- 사진 교체·제출 pointer CAS·동시 재시도 및 과거 binding 불변.
- 미검증·처리 중·실패·purged·7일 만료 사진을 새 제출 증빙으로 인정하지 않음.
- RLS와 명시적 GRANT/REVOKE, 원장 직접 DML 차단, 안전한 내부 helper 권한.
- 기존 29 migrations 불변, 새 append-only migration만 허용.
- Node/Deno 계약 테스트, fresh DB/RLS/동시성, DB lint/advisor, Python generated contract, exact-head GitHub CI.

## 공통 검증기의 의미

`photo-submission-contract.ts`는 플랫폼 중립의 **validation projection**만 처리한다.
`projectPhotoTemplateForValidation`은 서버가 보관한 전체 불변 슬롯 snapshot에서 검사 필드만
추출하며, 구역·항목명·촬영 설명·반복 정보가 있는 원본을 수정하거나 대체하지 않는다.
정규화된 DB 슬롯도 전체 `slot_snapshot`을 보존한다.

`assessPhotoCompleteness`의 `complete`는 제출 권한이 아니다. 필수 사진이 없으면
`missingRequiredSlotKeys`, 현재 선택된 사진이 처리 중·실패·만료 상태이면
`invalidCurrentSlotKeys`로 구분한다. 선택 슬롯을 비워 두는 것은 허용하지만, 선택된 유효하지
않은 사진을 제출 증빙에 끼워 넣지는 않는다. 시각은 PostgreSQL과 맞춘 microsecond 정밀도로
비교한다. client가 전달한 `verified`나 업로드 시각을 실제 검증 증거로 신뢰해서는 안 된다.

DB helper는 owner-only 내부 기반이며 Auth/session·파일·Drive 검증을 수행하는 공개 command가
아니다. #9/#31에서는 이 helper를 단순히 service-role에 개방하지 말고, 최신 session과
role/status·capability·assignment/version 검증, scoped idempotency, audit/outbox를 포함하는
서버 command를 별도로 검증해야 한다. #30 모델의 CAS 검증과 실제 HTTP retry 보장은 구분한다.

운영 Supabase·recovery·main·Edge·Pages·Cron·Vault·tag/Release는 이번 작업에서 변경하지 않는다.

## 로컬 검증 기록 — 2026-09-09

- fresh 30 migrations 재적용 및 DB/RLS 1,020 tests PASS. 기존 29 migration 파일은 변경하지 않았다.
- `db:test:concurrency` PASS: 기존 업무 경합과 사진 초기/교체 CAS, replace↔binding 봉인 양순서,
  제출 pointer CAS의 실제 별도 연결 lock wait 및 loser 잔여 없음 검증.
- `edge:check` 127 tests, `ci:quality` 136 tests와 lint/typecheck/build PASS.
- Python ruff/format/mypy/pytest 36 tests/generated contract/build check PASS. HTTP/OpenAPI 변경이 없어 생성 client 변경은 없다.
- DB lint warning/error 0, 로컬 Security/Performance Advisor warning/error 0.
- 정규화 슬롯 손상 방어 회귀는 로컬 테스트 savepoint 안에서만 새 테이블의 보호 trigger를
  일시 제거하여 재현하고 rollback으로 복원한다. migration이나 실제 접근 권한을 완화하지 않으며,
  복원 후 원장 DELETE 차단도 재검증한다.
- 이 기록은 GitHub required CI·독립 exact-head 승인·병합 또는 실제 이미지 업로드 검증을 대신하지 않는다.
