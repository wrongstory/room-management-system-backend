# 프런트엔드 Codex 실행 인계 — production API v0.4.0

> 이 문서는 `wrongstory/room-management-system`에서 작업할 Codex에게 그대로 전달하는 실행 프롬프트다. HTTP 요청·응답의 기계 판독 정본은 production OpenAPI이며, 이 문서는 구현 순서와 화면 의미를 설명한다.

## 전달용 프롬프트

```text
Repo: wrongstory/room-management-system

목표:
현재 프런트의 fixture/demo 상태 계산을 production API v0.4.0 계약으로 교체하고,
관리자·메이드가 실제 백엔드 기능을 화면에서 사용할 수 있게 한다.

백엔드 정본:
- production source: main@80f935016d5581d500136fba29c206f6ee797bc0
- production DB: 73 migrations
- production Edge api: ACTIVE v17
- OpenAPI: 0.4.0 / 120 paths / 130 operations
- 사람이 읽는 Swagger:
  https://wrongstory.github.io/room-management-system-backend/
- codegen용 OpenAPI:
  https://wrongstory.github.io/room-management-system-backend/openapi.json
- portal manifest:
  https://wrongstory.github.io/room-management-system-backend/portal-manifest.json
- 상세 연동 가이드:
  https://github.com/wrongstory/room-management-system-backend/blob/dev/docs/FRONTEND_API_INTEGRATION.md
- 제품·계약 snapshot:
  https://github.com/wrongstory/room-management-system-backend/blob/dev/docs/FRONTEND_CONTRACT_SNAPSHOT.md

작업 원칙:
1. 프런트 저장소의 AGENTS.md와 제품 문서를 먼저 읽는다.
2. 현재 원격 main에서 codex/13-production-api-v040 작업 브랜치를 만든다.
3. OpenAPI JSON으로 TypeScript 타입을 다시 생성한다. 생성 파일을 직접 수정하지 않는다.
4. endpoint, field, enum, 권한, 오류를 fixture나 화면 문자열에서 추측하지 않는다.
5. API base URL은 환경변수 또는 OpenAPI servers[0].url에서 읽는다. project ref를 여러 파일에 하드코딩하지 않는다.
6. Supabase service-role/secret은 브라우저에 절대 넣지 않는다. 공개 클라이언트에는 허용된 publishable key만 사용한다.
7. production에 임의 계정·예약·PIN·청소 데이터를 만들지 않는다. 실제 mutation 확인은 사용자가 화면에서 수행한다.

우선 구현 순서:

A. 공통 API 기반
- openapi-typescript 7.13.0을 고정해 src/api/generated/room-management-api.ts를 생성한다.
- 공통 fetch adapter에 API base URL, Bearer access token, no-content 204 처리,
  `{ error: { code, message }, requestId }` 오류 파싱을 둔다.
- mutation에는 `Idempotency-Key: crypto.randomUUID()`를 보낸다.
- timeout/응답 유실로 같은 body를 재전송할 때만 같은 key를 재사용한다.
- 409에서는 관련 projection을 다시 조회하고 사용자가 재확인하도록 한다.
- 한국어 message 문자열로 분기하지 않고 HTTP status와 error.code로 분기한다.

B. 인증·역할
- POST /v1/auth/login
- GET /v1/auth/me
- POST /v1/auth/password
- 앱 시작과 세션 복구 때 /auth/me를 호출해 최신 role/status/mustChangePassword를 확인한다.
- mustChangePassword=true면 비밀번호 변경·로그아웃 외 업무 화면을 막는다.
- developer는 계정/운영 화면만 사용하고 rooms/reservations 업무 권한을 부여하지 않는다.
- admin과 maid 메뉴를 역할별로 분리하고 401/403을 fixture fallback으로 숨기지 않는다.

C. 객실 현황 — 현재 시각 축
- GET /v1/rooms와 GET /v1/rooms/{roomId}를 사용한다.
- 현재 카드의 대표 상태는 서버 `primaryDisplayStatus`를 그대로 사용한다.
  BLOCKED=배정 불가
  OCCUPIED=투숙 중
  ARRIVAL_PENDING=입실 예정·준비 필요
  RESERVATION_PRESENT=투숙 예정
  CLEANING_REQUIRED=청소 필요
  READY=배정 가능
- `reservationLifecycle`, `occupancyStatus`, `readinessStatus`, `pinSyncStatus`,
  `blockingReasonCodes`, `readinessReasonCodes`를 서로 다른 보조 축으로 표시한다.
- 미래 예약이 있다는 이유만으로 현재 `cleaningRequired`를 true로 만들거나 객실 전체 날짜를 잠그지 않는다.
- PIN mismatch/unconfigured는 경고 축이다. 미래 기간 예약 가능 여부를 false로 바꾸지 않는다.
- evaluatedAt/serverTime을 한 응답 snapshot 기준으로 사용하고 브라우저 현재 시각으로 서버 상태를 재계산하지 않는다.

D. 미래 기간 예약 가능 여부·캘린더
- POST /v1/reservations/bookability/preview를 예약 객실 후보의 정본으로 사용한다.
- candidate의 `intervalBookable`이 요청한 [checkInAt, checkOutAt) 구간의 예약 가능 여부다.
- `checkInReady`는 현재 입실 준비 안내일 뿐 미래 기간 예약 가능 여부가 아니다.
- 같은 객실도 기존 예약과 겹치지 않는 이후 구간은 다시 예약할 수 있어야 한다.
- GET /v1/reservations의 from/to/cursor를 사용해 캘린더를 채운다.
- from/to는 strict RFC 3339 offset이며 [from,to)는 최대 31일이다.
- nextCursor는 해석하거나 수정하지 않고 같은 filter에만 재사용한다.
- roomId filter 결과에는 객실 이동 segment 이력이 포함될 수 있으므로 현재 roomId만으로 다시 제거하지 않는다.

E. 예약 명령
- POST /v1/reservations
- PATCH /v1/reservations/{reservationId}
- POST /v1/reservations/{reservationId}/cancel
- POST /v1/reservations/{reservationId}/manual-checkout
- 모든 명령은 서버의 reservation version/state version과 Idempotency-Key를 사용한다.
- reservationType은 standard 또는 long_stay다.
- standard는 checkOutAt 필수, long_stay는 고정 checkout 또는 null을 허용한다.
- PIN 미등록/불일치 자체로 예약 등록 버튼을 막지 않는다.
- CLEANING_TEMPLATE_NOT_CONFIGURED는 예상시간 누락이 아니라 게시된 checkout template 부재로 안내한다.
- durationMinutes가 null이어도 예약과 planned checkout target 생성 요청을 허용한다.
- 예약 생성 직후 객실 현재 상태를 로컬에서 청소 필요로 바꾸지 말고 GET /v1/rooms를 재조회한다.

F. 객실 변경
- 체크인 전과 투숙 중 모두 먼저
  POST /v1/reservations/{reservationId}/room-change/preview를 호출한다.
- preview의 effectiveAt, reasonCode, evaluatedAt, expiresAt, impactFingerprint와 expected versions를
  변경하지 말고 POST /v1/reservations/{reservationId}/room-change에 전달한다.
- DURING_STAY는 종료 미정 long_stay에서 OPEN_ENDED_STAY_REQUIRES_END를 표시한다.
- stale/overlap/blocked/PIN lease 충돌을 다른 Idempotency-Key로 자동 우회하지 않는다.
- 이동 뒤 reservation.roomId만으로 과거 객실 이력을 덮지 않는다. API가 반환하는 stay/segment를 사용한다.

G. 청소관리
- GET/POST /v1/cleaning-templates로 타입별 게시 템플릿을 표시한다.
- durationMinutes는 선택값이다. null을 0분·1분·데모 시간으로 변환하지 않는다.
- GET /v1/assignments와 history/preview/draft/commit/change/unassign 계약을 generated 타입대로 연결한다.
- maid 작업 화면은 GET /v1/attempts/current 및 attempt start/complete/lifecycle API를 사용한다.
- 청소 시작 가능 여부는 POST /v1/attempts/{attemptId}/start 결과가 정본이다.
- PREVIOUS_ROOM_WORKFLOW_ACTIVE와 CHECKOUT_INCIDENT_OPEN을 명시적으로 표시한다.
- 고객 미퇴실 신고는 POST /v1/attempts/{attemptId}/checkout-not-completed,
  관리자 결정은 checkout-incidents detail/decision API를 사용한다.
- 실제 수행시간은 startedAt부터 fieldCompletedAt까지이며 template duration으로 완료를 추정하지 않는다.
- 완료 이력은 GET /v1/cleaning-history, 주간 기록은 GET /v1/work-history를 사용한다.

H. 사진·제출·검수
- photo slot UUID는 GET /v1/attempts/{attemptId}/photo-slots에서 받는다.
- JPEG/WebP raw bytes만 업로드하며 multipart/base64를 만들지 않는다.
- provider_succeeded/reconciliation_pending을 제출 완료로 표시하지 않는다.
- current submission과 inspection API를 generated 타입대로 연결한다.
- 사진 provider/Cron이 운영 활성화되지 않은 경우 503을 성공으로 숨기지 않고 준비 중 상태로 표시한다.

I. PIN
- PIN 숫자는 문자열로 유지해 선행 0을 보존한다.
- PIN 원문은 URL, 로그, analytics, 오류 수집, localStorage, IndexedDB, Service Worker cache에 넣지 않는다.
- reveal 응답은 메모리에만 표시하고 clearAfterSeconds/expiresAt/background/navigation 중 가장 빠른 조건에 지운다.
- 초기 PIN bootstrap과 generated confirm은 관리자 전용 화면으로 격리한다.
- 운영 bootstrap과 실제 도어락 적용은 사용자가 별도 승인하기 전 자동 실행하지 않는다.
- legacy POST /v1/rooms/{roomId}/pin-sync-events를 신규 PIN 생성/변경 UI에 사용하지 않는다.

J. 알림·정산·컴플레인
- GET /v1/notifications와 read command를 연결한다.
- Web Push provider가 비활성인 경우에도 앱 알림함은 동작해야 한다.
- payroll 목록과 entries cursor를 구분하고 items/lateEarnings preview 배열 길이를 전체 건수로 쓰지 않는다.
- complaint, inspection, payroll은 역할·version·cursor를 generated contract 그대로 사용한다.

필수 화면 검증 체크리스트:
- 미래 예약을 등록해도 오늘 객실이 즉시 청소 필요가 되지 않는다.
- 예약이 하나 있어도 겹치지 않는 이후 기간은 preview에서 예약 가능하다.
- 실제 겹치는 [checkInAt,checkOutAt)만 RESERVATION_OVERLAP으로 차단된다.
- 당일 입실 예정, 투숙 중, 청소 필요, 배정 가능, 배정 불가가 서버 primaryDisplayStatus대로 보인다.
- 예약 create/change/cancel/manual checkout 뒤 목록·상세·캘린더가 서버 재조회 결과로 갱신된다.
- BEFORE_CHECKIN 및 DURING_STAY 객실 이동 preview/commit 화면이 있다.
- 관리자 청소 템플릿·배정·사건 처리 화면과 maid 작업 시작·완료 화면이 실제 API를 호출한다.
- 401/403/409/429/503을 성공이나 fixture fallback으로 바꾸지 않는다.
- 같은 mutation의 더블클릭/응답 유실에서 중복 데이터가 생기지 않는다.
- console/network 오류 보고에는 requestId만 사용하고 token/PIN/고객명/request body를 남기지 않는다.

테스트:
- generated OpenAPI 파일이 최신 0.4.0 계약에서 생성됐는지 검사한다.
- typecheck/build/unit test를 실행한다.
- API mock은 OpenAPI example/shape만 사용하며 과거 fixture field를 섞지 않는다.
- 브라우저 E2E는 admin/maid/developer 역할별 허용·거부를 확인한다.
- production mutation은 자동 E2E에서 실행하지 않는다. 사용자가 승인한 계정/대상으로 수동 확인한다.

완료 보고:
- 변경한 화면과 endpoint 목록
- 제거한 fixture/local-only 경로
- generated client source URL과 OpenAPI version/path/operation 수
- 실행한 테스트 결과
- 사용자가 화면에서 직접 확인해야 할 항목
- 아직 provider/Cron/운영 fixture가 없어 확인하지 못한 항목
- production 데이터 변경 여부

금지:
- service-role/secret을 프런트에 넣기
- API에 없는 endpoint나 enum 만들기
- 한국어 message 문자열 비교
- 미래 예약을 현재 청소 필요/배정 불가로 변환하기
- 현재 allocationReady를 미래 모든 날짜의 예약 가능 여부로 재사용하기
- PIN·고객 PII·token을 영속 저장하거나 로그에 남기기
- 사용자의 승인 없이 production test data 생성하기
```

## 사용자가 직접 확인할 핵심 화면

프런트 구현 후 사용자는 다음 순서로 확인한다.

1. 관리자로 로그인하고 객실 현황에서 `투숙 예정`, `투숙 중`, `청소 필요`, `배정 가능`, `배정 불가`가 현재 시각 기준으로 구분되는지 확인한다.
2. 미래 예약을 하나 등록한 뒤 오늘 상태가 즉시 `청소 필요`로 바뀌지 않는지 확인한다.
3. 같은 객실의 기존 예약과 겹치지 않는 이후 날짜가 예약 가능하고, 겹치는 날짜만 차단되는지 확인한다.
4. 예약 변경·취소·수동 체크아웃 후 화면 새로고침 없이 서버 재조회 결과가 반영되는지 확인한다.
5. 체크인 전 객실 변경과 투숙 중 객실 이동을 preview 후 확정할 수 있는지 확인한다.
6. 관리자 청소관리에서 템플릿·배정·고객 미퇴실 사건을 확인하고, 메이드 계정에서 본인 작업 시작·완료 화면이 분리되는지 확인한다.
7. 네트워크 오류나 409 충돌 때 중복 등록 없이 재조회·재확인 흐름으로 돌아가는지 확인한다.

## 운영 기능 경계

- production API와 Swagger 배포는 완료됐다.
- 안전한 운영 fixture 기반 예약·객실 이동·PIN positive mutation smoke는 아직 별도다.
- Google Drive 사진 provider, Google Sheets PIN projection, Web Push와 관련 Cron/secret의 실제 hosted 활성화는 API source 제공과 별도다.
- 따라서 endpoint가 OpenAPI에 있다는 사실만으로 외부 provider 작업까지 성공한다고 표시하지 않는다.
