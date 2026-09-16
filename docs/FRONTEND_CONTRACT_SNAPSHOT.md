# 프런트엔드 계약 snapshot

이 문서는 `wrongstory/room-management-system`의 exact 제품 snapshot을 백엔드 계약에 대조한 재현 가능한 기록이다. 제품 정책의 최종 우선순위는 [AI 백엔드 제품·도메인 가이드](./AI_BACKEND_PRODUCT_GUIDE.md)를 따른다.

## 2026-09-17 확인점

| 구분 | commit | 용도 |
|---|---|---|
| 프런트 제품 snapshot | `165fed2d62a763d64ac62539e1475c1b3e42868f` | 이번 정합화의 exact 기준. 원격 `dev` ref는 삭제됐지만 commit은 재현 가능하다. |
| 프런트 현재 원격 `main` | `afeb0898879bf8d381ee2e218938dc3160fd6ac0` | 관찰 대상. 위 snapshot의 정책을 자동 대체하지 않는다. |
| 백엔드 `dev` | `70154e90eaa633dedbd872b394e4ca51ee25bdf6` | 이번 대조 기준. 62 migrations / OpenAPI 113 paths / 121 operations다. |
| 백엔드 저장소 `main` | `a12595edf68644b94215c4792e0d3aadd64772c6` | 저장소 release line. 마지막 검증된 production 배포 source와 구분한다. |

프런트 snapshot의 기능을 현재 원격 `main` 배포 상태로 추정하지 않는다. 백엔드 source, production Edge 배포, 운영 secret/provider 활성화도 서로 다른 완료 단계로 기록한다.

## 프런트 문서 분류

| 문서 | 원문 표기 | 백엔드에서의 해석 | 처리 |
|---|---|---|---|
| `DOCS/17_ROOM_CATALOG_LONG_STAY_DECISIONS.md` | 현재 정본 | 121개 객실과 타입별 22/51/13/35 분포는 확정 객실 카탈로그다. 최초 투숙 11실과 762호 확인 표시는 운영 시작 fixture다. | 고정 마스터와 초기 점유 fixture를 분리하고 복합 화면 상태는 독립 DB 축으로 유지한다. |
| `DOCS/18_TYPE_PHOTO_TEMPLATE_POLICY.md` | 과거 구현 근거 | v8+ Decision A의 타입별 9/10/12/14 slot은 이미 백엔드 `dev`에 반영됐다. | pre-A 10/11/13/15 snapshot은 이력 보존하고 backfill하지 않는다. |
| `DOCS/19_EVENT_NOTIFICATION_POLICY.md` | 원칙/정적 데모 범위 | 알림 분류 정책과 데모 범위가 혼재한다. | 수신자·원장·outbox 정책만 근거로 사용하고 데모 발송은 운영 완료로 보지 않는다. |
| `DOCS/19_ROOM_PIN_SHEET_CLEANING_HISTORY_DECISIONS.md` | 최우선 확정 | 사진 보존 기산점과 PIN entitlement 수명주기가 현재 백엔드 source와 충돌한다. | 최신 사용자 결정과 함께 아래 계약으로 고정하고 후속 append-only migration/API로 수정한다. |
| `DOCS/19_TEMPLATE_PARITY_AUDIT.md` | 감사 보고서 | 과거 오류를 설명하는 근거 문서다. | 현재 타입/슬롯 정책의 보조 근거로만 사용한다. |
| `DOCS/21_PRODUCTION_API_PWA_INTEGRATION.md` | 운영 연결 기록 | 실제 소비 계약과 당시 운영 snapshot을 기록한다. 시간이 지나면 stale할 수 있다. | 아래 호환표와 exact commit을 함께 갱신한다. |
| `WIREFRAME/*` | 현재 구현·QA | 고충실도 UI와 fixture다. | API·DB 정본이나 production seed로 승격하지 않는다. |

## Stage 0 확정 계약과 source gap

### 사진 보존

- 청소 제출 사진은 최종 검사 결정 전 삭제하지 않고 승인·반려 `decidedAt + 168시간`에 만료한다.
- 이슈·컴플레인 및 중단/동기화 충돌 증빙은 해결·종결 후 180일, 진짜 orphan은 업로드 후 30일이다.
- metadata는 원본 만료 뒤에도 영구 보존하고, 이미 삭제된 사진을 복구됐다고 표시하지 않는다.
- 현재 source의 accepted 사진 `uploadedAt + 168시간` 고정과 즉시 orphan queue는 **미해결**이다.

### PIN 접근

- assignment 통보/outbox 확정 시 durable entitlement가 시작되고 `availableFrom` 전에도 본인 담당이면 유효하다.
- field complete, upload pending, submitted, review pending 동안 유지하며 최종 결정·취소 승인·재배정·비활성화 정리 때 종료한다.
- 최대 30초 reveal lease는 entitlement와 별도다. PIN 변경은 구 reveal/revision을 즉시 무효화하고 이미 알림된 현재·다음 담당의 entitlement를 새 revision으로 갱신한다.
- 현재 source의 `availableFrom` 및 `scheduled|in_progress` attempt 중심 접근은 **미해결**이다.

### 객실 표시·예약 준비 3축

- `intervalBookable`: 요청한 미래 `[checkInAt, checkOutAt)` 구간의 예약 가능성. **일반 예약용 preview/range API는 현재 미구현**이다.
- `readinessStatus`/`checkInReady`: 현재 체크인·배정 준비 상태.
- `pinSyncStatus`: PIN 동기화 상태. 미래 예약 bookability와 합치지 않는다.
- 대표 상태는 `BLOCKED > OCCUPIED > ARRIVAL_PENDING > RESERVATION_PRESENT > CLEANING_REQUIRED > READY`다. 현재 시각의 lifecycle/readiness/PIN 분리 projection은 백엔드 `dev`에 이미 구현돼 **해결됨**이나, 이를 미래 `intervalBookable`로 재사용하면 안 된다.

## 후속 구현 계획

| 범위 | OpenAPI | migration/backfill | 고정할 회귀 이름 |
|---|---|---|---|
| 사진 retention | 의미·nullable 확장이므로 다음 승인 계약 버전(현재 후보 `0.4.0`)에 반영 | 현재 62개 이후 새 append-only migration. pending review는 유지하고 이미 purged는 `unavailable`, accepted/linked/orphan은 실제 evidence로 분류 | `pending_review_photo_survives_upload_plus_7d`, `decision_photo_expires_at_168h_boundary`, `orphan_expires_after_30d`, `resolved_evidence_expires_after_180d` |
| PIN entitlement | entitlement/reveal ID와 안정 오류를 다음 승인 계약 버전(현재 후보 `0.4.0`)에 추가 | durable assignment entitlement 원장과 terminal cleanup을 새 migration으로 추가. 구 attempt lease를 장기 자격으로 backfill하지 않는다. backfill 후보는 (1) `cleaning_assignments.is_current=true`, `notified_at IS NOT NULL`, `ended_at IS NULL`인 exact assignment/maid/room/revision, (2) target `status`가 `notified|in_progress|upload_pending|inspection_pending`이고 `cancelled_at IS NULL`, (3) attempt가 없거나 exact assignment revision의 current attempt `status`가 `scheduled|in_progress|field_completed|upload_pending|submitted`, (4) current submission이 있으면 `status=submitted`이고 final inspection decision이 아직 없는지를 서로 다른 테이블 축으로 각각 확인한다. `approved|rejected|cancelled` target/submission, noncurrent·종료·재배정 assignment, inactive/departed 또는 비활성화가 최종화된 maid는 제외한다. PIN rotation은 동일 entitlement identity의 exact revision을 갱신하고 과거 reveal lease를 무효화한다. 구현 PR은 실제 FK/current-pointer와 authoritative join을 다시 검증해야 한다. | `notified_assignment_pin_before_available_from`, `pin_access_survives_field_complete_until_decision`, `pin_revision_rotation_revokes_old_reveal`, `terminal_assignment_revokes_entitlement` |
| 현재 객실 projection | 기존 additive source 계약 유지 | 기존 59~60번째 projection 유지, 중복 migration 없음 | `room_primary_status_priority`, `pin_warning_does_not_change_current_readiness` |
| 미래 interval bookability·범위 조회 | preview/list 계약을 다음 승인 계약 버전(현재 후보 `0.4.0`)에 추가 | 생성·변경과 같은 `[in,out)` 최종 검증을 재사용하는 app-owned RPC/route. 기존 constraint로 충분한지 구현 PR에서 확인하고 필요할 때만 append-only migration 추가 | `pin_warning_does_not_change_interval_bookability`, `preview_does_not_guarantee_commit`, `reservation_range_cursor_has_no_gap_or_duplicate` |

정확한 migration timestamp는 각 구현 PR에서 현재 `dev`를 다시 확인해 확정한다. 현재 source의 OpenAPI `info.version`은 여전히 `0.2.0`이라 개발 snapshot과도 맞지 않는다. 공개 계약은 production `0.3.0` 이후 minor 의미 확장에 해당하므로 `0.4.0`을 후보로 두되, 첫 의미 변경 PR에서 Issue/release decision으로 최종 승인한 버전과 migration note를 함께 제공한다. 기존 62개 migration과 삭제된 provider 원본을 수정·복원하지 않는다.

## 해결·미해결 inventory

| 영역 | 상태 | 근거/후속 |
|---|---|---|
| 현재 객실 lifecycle/readiness/대표 상태 | 해결됨(source/dev) | 59~60번째 projection 유지. production 승격과 별도 |
| 체크인 전·투숙 중 객실 이동 | 해결됨(source/dev) | 61~62번째 migration 및 preview/commit 유지. production 승격과 별도 |
| payroll adjustment `bookVersion` | 해결됨(source/dev) | 기존 payroll projection 유지 |
| 임의 기간 bookability preview·예약 범위 조회 | 미구현 | Stage 2 additive route/RPC/cursor 계약 |
| `standard | long_stay`와 종료 미정 | 미구현·정책 검증 필요 | nullable checkout, obligation 생성 시점, 이동 제약을 별도 Decision/PR로 처리 |
| 객실 타입 catalog | 부분 구현 | 내부 master는 있으나 app-owned `GET /v1/room-types` 없음 |
| 청소 완료·주간 근무 이력 | 미구현 | availability/assignment/field completion을 합치지 않는 bounded role-scoped projection 필요 |
| operation block·issue 목록과 room event timeline | 미구현 | command는 있으나 새 세션에서 entity를 재조회할 목록 없음 |
| payroll cycle/deep-link by-ID resolver | 미구현 | typed notification이 발행한 entityId의 역할·소유권 기반 resolver 필요 |

계정 비활성화 제한 capability와 complaint lifecycle 핵심은 source/dev에 이미 있으므로 중복 구현하지 않는다. complaint 자유문 content/notes는 기존 PII·자유문 금지 결정과 충돌하므로 별도 제품 결정 전 추가하지 않는다.

## API 소비·제공 호환표

| 영역 | 프런트 snapshot 실제 소비 | 최신 정본 요구 | 백엔드 `dev` 제공 | 판정 |
|---|---|---|---|---|
| 인증·세션 | login, me, password, Supabase refresh | 동일 | 제공 | 호환 |
| 계정·개발자 상태 | account CRUD 일부, developer 상태/로그 | 동일 | 제공 | 호환. 역할·상태는 매 요청 최신 서버값 사용 |
| 가능일 | 제출·변경 요청·결정·후보 | 동일 | 제공 | 호환. KST·CAS·멱등 키 유지 |
| 예약·객실 | 예약 CRUD/취소/체크아웃, 현재 객실 projection·운영 명령 | 미래 기간 preview와 from/to/cursor 범위 조회 | 현재 projection 제공, 일반 interval preview/range 조회 미제공 | 부분 호환. `stateVersion`/`version`과 409 재조회 필수 |
| 청소 템플릿·수행·미퇴실 사건 | 운영 API 연결 | 상태 기반 수행과 사건 동결 유지 | 제공 | source/dev. production 상태와 별도 |
| 배정·사진·제출·검수 | 운영 API 연결 | 도메인별 retention과 본인 이력 조회 | lifecycle 제공, retention gap | 사진 안전 계약 후속 필요 |
| 알림·Web Push | 권한/PWA shell만 사용 | 동일 | source 제공 | hosted provider 활성화와 실제 소비는 별도 |
| 주급·컴플레인 | 데모 화면 | 동일 | 제공 | 연동 대기 |
| PIN·Sheets | 신규 PIN API 연결 | 통보 기반 entitlement와 30초 reveal 분리 | reveal/source 제공, entitlement gap | entitlement 후속 필요; hosted 활성화와 별도 |
| 검수 대기열 pagination | 미소비 | 미소비 | PR #176 후보 | 병합 뒤 generated client 갱신 대상 |

프런트 snapshot의 `scripts/check-api-integration.mjs`는 운영 OpenAPI 계약면을 검사한다. 이 수치는 실제 UI 호출 수가 아니며, 백엔드 `dev`의 113 paths / 121 operations도 production 배포 상태를 뜻하지 않는다. literal request와 generated contract는 후속 PR마다 함께 대조한다.

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

1. 연동 작업 시작과 PR 준비 직전에 승인된 exact snapshot SHA와 현재 원격 ref를 각각 기록한다.
2. 원격 ref가 삭제되거나 분기됐으면 exact snapshot을 유지하고 다른 branch를 선형 후속으로 추정하지 않는다.
3. `AGENTS.md`, `DOCS/16~22`, `FINAL_UX_AUDIT.md`, `WIREFRAME/README.md`, API client/check script 변경을 우선 대조한다.
4. 새 프런트 정책이 기존 사용자 확정 계약과 충돌하면 조용히 승격하지 않고 양 저장소 Issue에 충돌과 처리 결정을 기록한다.
5. 백엔드 OpenAPI의 path 수만 비교하지 않고 role, status, error code, idempotency, CAS, nullable 의미를 함께 비교한다.
6. generated client와 breaking diff CI 구현은 #173, 전체 adapter 전환과 browser E2E는 #13에서 진행한다.
