# 프런트엔드 계약 snapshot

이 문서는 `makee-ham/room-management-system`의 배포 정본과 차기 개발 후보를 백엔드 계약에 대조한 재현 가능한 기록이다. 제품 정책의 최종 우선순위는 [AI 백엔드 제품·도메인 가이드](./AI_BACKEND_PRODUCT_GUIDE.md)를 따른다.

## 2026-09-16 확인점

| 구분 | commit | 용도 |
|---|---|---|
| 프런트 `main` | `8c1c14da93294a36ce5fc842143bf668ad9cf373` | 현재 배포 정본. 백엔드 `v0.2.0` 연동을 포함한다. |
| 프런트 `dev` | `a0d6c07f5bd6cc86e02b2644abc4addc414adfc5` | `main`보다 2 commit 앞선 차기 후보. 선택형 청소시간과 미퇴실 사건 UI는 기능 플래그 OFF 상태다. |
| 백엔드 `dev` | `c32aa9eec3945334ddda956afc62cc92d801c410` | 이번 대조 기준. source OpenAPI `0.2.0`, 109 paths / 117 operations다. |
| 백엔드 `main` | `6604b2215e06b9e9ebf0b3138e3716a000c57ddb` | 예상 청소시간 선택화를 포함한 GitHub release source 정본이다. |

프런트 `dev`의 기능 또는 문서를 `main` 배포 상태로 표현하지 않는다. 백엔드 source, production Edge 배포, 운영 secret/provider 활성화도 서로 다른 완료 단계로 기록한다.

## 프런트 문서 분류

| 문서 | 원문 표기 | 백엔드에서의 해석 | 처리 |
|---|---|---|---|
| `DOCS/17_ROOM_CATALOG_LONG_STAY_DECISIONS.md` | 현재 정본 | 객실 마스터·점유·수동 체크아웃의 확정 정책. 객실 수와 초기 점유값은 운영 초기값이지 영구 불변식이 아니다. | 정책 근거로 사용하되 복합 화면 상태는 독립 DB 축으로 유지한다. |
| `DOCS/18_TYPE_PHOTO_TEMPLATE_POLICY.md` | 구현 정본 | 타입별 고정 슬롯과 작업 snapshot 정책. 프런트 fixture의 슬롯 수를 production 게시 완료로 해석하지 않는다. | immutable template version과 작업 snapshot 계약으로 사용한다. |
| `DOCS/19_EVENT_NOTIFICATION_POLICY.md` | 원칙/정적 데모 범위 | 알림 분류 정책과 데모 범위가 혼재한다. | 수신자·원장·outbox 정책만 근거로 사용하고 데모 발송은 운영 완료로 보지 않는다. |
| `DOCS/19_ROOM_PIN_SHEET_CLEANING_HISTORY_DECISIONS.md` | 확정 | PIN 접근·브라우저 비저장 규칙은 일치한다. 사진 보관 시작점은 기존 사용자 확정 계약과 충돌했다. | 사진은 `uploaded_at + 7일`로 정합화하고 검수 시각으로 연장하지 않는다. |
| `DOCS/19_TEMPLATE_PARITY_AUDIT.md` | 감사 보고서 | 과거 오류를 설명하는 근거 문서다. | 현재 타입/슬롯 정책의 보조 근거로만 사용한다. |
| `DOCS/21_PRODUCTION_API_PWA_INTEGRATION.md` | 운영 연결 기록 | 실제 소비 계약과 당시 운영 snapshot을 기록한다. 시간이 지나면 stale할 수 있다. | 아래 호환표와 exact commit을 함께 갱신한다. |
| `WIREFRAME/*` | 현재 구현·QA | 고충실도 UI와 fixture다. | API·DB 정본이나 production seed로 승격하지 않는다. |

## 사진 보관 충돌 결정

- 기존 사용자 확정 계약은 검수 상태와 무관한 `purge_after = uploaded_at + 7 days`다.
- 최초 업로드 성공시각은 서버가 검증한 provider의 immutable 생성시각을 사용한다.
- 재시도, 전체 제출, 승인, 반려는 보관기한을 다시 시작하거나 연장하지 않는다.
- 7일이 검수 전에 지나면 사진은 삭제될 수 있으며, 제출·검수 텍스트 이력은 유지한다.
- 프런트의 과거 “검수 결정부터 7일” fixture와 QA 기록은 당시 데모 증거일 뿐 현재 정책 근거가 아니다.

## API 소비·제공 호환표

| 영역 | 프런트 `main` 실제 소비 | 프런트 `dev` 차기 후보 | 백엔드 `dev` 제공 | 판정 |
|---|---|---|---|---|
| 인증·세션 | login, me, password, Supabase refresh | 동일 | 제공 | 호환 |
| 계정·개발자 상태 | account CRUD 일부, developer 상태/로그 | 동일 | 제공 | 호환. 역할·상태는 매 요청 최신 서버값 사용 |
| 가능일 | 제출·변경 요청·결정·후보 | 동일 | 제공 | 호환. KST·CAS·멱등 키 유지 |
| 예약·객실 | 예약 CRUD/취소/체크아웃, 객실 projection·운영 명령 | 동일 | 제공 | 호환. `stateVersion`/`version`과 409 재조회 필수 |
| 청소 템플릿·수행·미퇴실 사건 | 미소비 | 기능 플래그 OFF, intercepted fixture로만 검증 | 제공 | source 후보. production 활성화 완료가 아님 |
| 배정·사진·제출·검수 | 데모 화면 | 일부 조회/수행 후보 외 대부분 미소비 | 제공 | 연동 대기. #13/#173 범위 |
| 알림·Web Push | 권한/PWA shell만 사용 | 동일 | source 제공 | hosted provider 활성화와 실제 소비는 별도 |
| 주급·컴플레인 | 데모 화면 | 동일 | 제공 | 연동 대기 |
| PIN·Sheets | legacy 상태 기록만 소비 | 신규 PIN/Sheets API 미소비 | source 제공 | 민감정보 경계 유지, hosted 활성화와 소비는 별도 |
| 검수 대기열 pagination | 미소비 | 미소비 | PR #176 후보 | 병합 뒤 generated client 갱신 대상 |

프런트 `main`의 `scripts/check-api-integration.mjs`는 39 paths / 43 operations의 운영 `v0.2.0` subset을 고정 검사한다. 프런트 `dev`의 청소 후보는 백엔드 PR #166 exact source를 기준으로 만든 수기 후보 타입과 intercepted API fixture이며 generated client 정본이 아니다.

## 공통 연동 불변식

| 축 | 프런트 요구사항 |
|---|---|
| 역할 | 응답과 UI 상태가 아니라 access token actor와 서버의 최신 role/status/capability를 정본으로 사용한다. 401/403에서 다른 역할로 자동 재실행하지 않는다. |
| 상태 | 점유·청소 필요·배정·수행·업로드·제출·검수·입실 준비·지급을 단일 status로 합치지 않는다. |
| 오류 | HTTP status와 안정된 `error.code`, `requestId`만 사용자 분기·진단에 사용한다. 서버 message와 request body를 화면/로그 정본으로 사용하지 않는다. |
| 멱등성 | 모든 mutation에 `Idempotency-Key`를 보낸다. timeout/응답 유실 때 같은 actor·path·정규화 body에만 같은 키를 재사용한다. Service Worker가 mutation을 캐시하거나 자동 반복하지 않는다. |
| 버전 | 서버 응답의 `version`, `stateVersion`, assignment revision, execution version, impact fingerprint를 그대로 CAS 입력으로 사용한다. 409는 관련 projection을 다시 읽고 사용자가 재확인한다. |
| 민감정보 | PIN, token, 고객명, 전화번호, Drive/Sheets locator를 URL, 알림, analytics, console, 오류 수집, Service Worker cache, 영구 browser storage에 넣지 않는다. |

## 변경 감시 규칙

1. 연동 작업 시작과 PR 준비 직전에 프런트 `origin/main`과 `origin/dev` SHA를 각각 기록한다.
2. `main`만 현재 배포 정본으로 취급하고 `dev`는 차기 후보로 분리한다.
3. `AGENTS.md`, `DOCS/16~22`, `FINAL_UX_AUDIT.md`, `WIREFRAME/README.md`, API client/check script 변경을 우선 대조한다.
4. 새 프런트 정책이 기존 사용자 확정 계약과 충돌하면 조용히 승격하지 않고 양 저장소 Issue에 충돌과 처리 결정을 기록한다.
5. 백엔드 OpenAPI의 path 수만 비교하지 않고 role, status, error code, idempotency, CAS, nullable 의미를 함께 비교한다.
6. generated client와 breaking diff CI 구현은 #173, 전체 adapter 전환과 browser E2E는 #13에서 진행한다.

