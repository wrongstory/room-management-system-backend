# 프론트엔드·Codex API 연동 가이드

이 문서는 `wrongstory/room-management-system` 프론트와 해당 저장소에서 작업하는 Codex가 백엔드 동작을 추측하지 않고 연동하도록 만든 handoff 문서다. 제품 정책은 [AI 백엔드 제품 가이드](./AI_BACKEND_PRODUCT_GUIDE.md), HTTP 계약은 **실행 중인 Edge Function의 OpenAPI JSON**이 정본이다. 과거 v0.4.0 인계는 historical workflow 참고용이고, 현재 계약은 production OpenAPI 0.5.1과 이 문서를 우선한다.

2026-09-22 백엔드 production source는 `main@dda676dc6527a75a2271140d83ae6d2dbfb7cadf`다. 프런트 제품 snapshot과 실제 소비/제공 차이, 변경 감시 규칙은 [프런트엔드 계약 snapshot](./FRONTEND_CONTRACT_SNAPSHOT.md)을 함께 따르며 production source 제공과 hosted provider·실제 업무 mutation 검증을 같은 상태로 표현하지 않는다.

## 1. 계약을 받는 위치

운영 배포 계약:

| 목적 | URL |
|---|---|
| 사람이 확인 | `https://wrongstory.github.io/room-management-system-backend/` |
| Codex·코드 생성 | `https://wrongstory.github.io/room-management-system-backend/openapi.json` |
| snapshot 정보·SHA-256 | `https://wrongstory.github.io/room-management-system-backend/portal-manifest.json` |

GitHub Pages는 실제 production Edge의 `/openapi.json`을 배포 workflow가 검증·복사한 **읽기 전용 snapshot**이다. 공개 포털은 `Try it out`과 Authorization 입력을 비활성화하며 secret, 실제 전화번호, token 입력 용도로 사용하지 않는다. Edge Function을 새로 배포한 뒤 Pages workflow를 수동 실행해 snapshot을 갱신한다. 실행 중인 HTTP 계약의 최종 정본은 production Edge OpenAPI이고 Pages는 프론트 전달·codegen용 검증 snapshot이다.

로컬 API base URL:

```text
http://127.0.0.1:54321/functions/v1/api
```

| 목적 | URL |
|---|---|
| 사람이 확인 | `http://127.0.0.1:54321/functions/v1/api/docs` |
| Codex·코드 생성 | `http://127.0.0.1:54321/functions/v1/api/openapi.json` |
| runtime 확인 | `http://127.0.0.1:54321/functions/v1/api/health` |

Swagger UI 상단의 **OpenAPI JSON 내려받기**로 파일을 받을 수 있다. API base URL은 Pages OpenAPI의 `servers[0].url` 또는 배포 환경변수에서 읽고 Supabase project ref나 운영 URL을 프론트 소스에 하드코딩하지 않는다. OpenAPI에 없는 path는 production endpoint로 가정하지 않는다.

production Edge는 `main@dda676dc6527a75a2271140d83ae6d2dbfb7cadf` 기준 78 migrations, `api` ACTIVE v24, OpenAPI `0.5.1` 128 paths / 138 operations를 사용한다. GitHub Pages v0.5.1 parity는 공개 readback 완료 전까지 pending이다. 안전한 fixture가 없어 실행하지 않은 예약·PIN mutation은 PASS나 전체 프런트 E2E 완료로 표현하지 않는다.

Issue #236/#228의 객실 카탈로그·상태 계약은 v0.5.0으로 production에 반영됐고, #245가 preview의 optional/null `guestCount` 계약만 추가해 OpenAPI 0.5.1 / 128 / 138을 유지한다. 실제 예약 create/change의 `guestCount` 필수 계약은 바뀌지 않는다.

### #131/#140/#169 객실 PIN source 계약

production OpenAPI에는 prepare/confirm/rollback/reveal과 admin 자동 생성·현장 확인 operation이 있다. 일반 변경에서 `pinDigits`는 선행 0을 보존한 `^[0-9]{4,8}$` 문자열로만 보내고 room prefix를 넣지 않는다. 미등록 객실의 admin 수정 요청이 `expectedPinVersion=0`, `reasonCode=ADMIN_PHYSICAL_CHANGE`를 보내도 서버가 최초 등록 사유로 정규화하므로 client가 PIN 존재 여부와 버튼 이름을 별도 command로 분기할 필요는 없다. 명시적 `ADMIN_INITIAL_PIN`도 계속 유효하다. maid prepare/reveal은 현재 통보 assignment, current attempt, current pinVersion의 `accessLeaseId`를 함께 보낸다. maid confirm 응답이 새 `accessLeaseId`를 주면 이후 reveal에는 이 재발급 lease를 사용한다.

Reveal 응답은 `Cache-Control: no-store`이며 `credential`은 화면 메모리에만 일시 표시한다. `clearAfterSeconds`와 `expiresAt` 중 더 빠른 시각, navigation/background/pagehide/device lock/assignment removal/relock 중 하나라도 발생하면 즉시 지운다. clipboard, analytics, console/error log, browser cache, service worker, offline queue, persistent storage에 넣지 않는다. durable assignment entitlement는 통보/outbox 확정부터 최종 검사·취소·재배정·비활성화 정리까지 유지하고, 30초 reveal lease와 구분한다. 초기화는 `POST /v1/rooms/pins/bootstrap`에 `limit`만 보내며 서버가 batch-unique 4자리 값을 생성한다. 응답의 `generatedPins`를 객실별로 표시하고 현장 도어락 적용 후 `POST /v1/rooms/{roomId}/pin/generated/confirm`에 해당 `pinVersion`을 보낸다. 확인 성공 전에는 mismatch 경고와 체크인 차단을 유지하고 메이드에게 표시하지 않는다. 두 path는 production OpenAPI에 반영됐지만 실제 운영 bootstrap·물리 확인 실행은 별도 승인 전까지 시작하지 않는다.

## 2. 로컬 백엔드 준비

### #84 사진 연동 — API source/bundle 배포, 실제 Google provider 활성화 대기

사진 operation과 retention v2 schema/API는 운영 OpenAPI와 production DB/API에 반영됐다. 검수 결정+168시간·해결+180일·orphan+30일 계약이 정본이며, 업로드 후 7일 고정 정책을 사용하지 않는다. 다만 Google Drive 운영 계정·OAuth·대상 폴더·purge Cron과 역할별 hosted smoke가 끝나기 전에는 실제 업로드/삭제 기능을 production-ready로 표시하지 않는다.

1. `GET /v1/attempts/{attemptId}/photo-slots`로 immutable slotId와 currentRevision을 받는다. 슬롯 key만으로 UUID를 추측하지 않는다.
2. `POST /v1/attempts/{attemptId}/photo-slots/{slotId}/upload?assignmentId=...&assignmentRevision=...&expectedPhotoRevision=...`에 JPEG/WebP **raw bytes**를 전송한다. `Content-Type`은 정확히 image/jpeg 또는 image/webp, 원문307200 bytes 이하이며 multipart/base64는 지원하지 않는다.
3. 같은 사용자 동작 재시도는 같은 `Idempotency-Key`와 같은 효과 입력을 보낸다. `PHOTO_VERSION_CONFLICT`는 최신 슬롯 revision을 다시 확인하고 사용자 결정을 받는다. `PHOTO_UPLOAD_IN_FLIGHT`/429에서 key를 무한 교체하지 않는다.
4. `GET /v1/photo-uploads/{operationId}`로 확인하고 accepted만 current 사진 저장 완료로 표시한다. provider_succeeded/reconciliation_pending은 제출 가능한 성공으로 표현하지 않는다.
5. `GET /v1/photos/{photoId}/content`는 인증 proxy다. 공개URL이나 Drive ID를 저장하지 않고 no-store 응답을 영구 브라우저 cache에 넣지 않는다. limited 계정은 photoId=null이며 업로드 권한으로 원본을 읽을 수 없다.

서버가 metadata를 제거하고 output을 재검증하므로 프론트 압축 성공만으로 업로드 성공을 가정하지 않는다.
408 PHOTO_BODY_TIMEOUT은 본문 수신 시간 초과, 413은 원문/출력 크기 또는 decoder 기술상한, 415는 MIME, 409는 CAS/작업·quota·KST clock 경계, 503은 provider/환경 준비 상태를 구분한다. 업로드 initial/retry 응답의 `quotaWarning:boolean`이 true면 용량 경고를 표시한다. Google raw 사용량은 제공하지 않는다.
사진 accepted가 field_completed/전체 제출/검수/ready로 자동 전이되지 않는다. Python developer 운영 콘솔은 이 business upload/read API를 생성하거나 호출하지 않는다.

### #137 PIN Sheet 운영 source/bundle 배포, hosted Google 활성화 대기

active developer/admin만 `GET /v1/room-pin-sheet-sync/status`를 호출한다. UI는 `pending`, `failed`, `operatorBlocked`, `oldestPendingAt`, `lastSuccessAt`, `lastErrorCode`와 `version`만 표시하고 healthy를 별도로 추측하지 않는다. 전체 복구는 strict `{expectedVersion}` body와 새 `Idempotency-Key`로 `POST /v1/room-pin-sheet-sync/full-resync`를 호출한다. 409 stale/pending/busy이면 status를 다시 읽고 운영자가 판단하며 자동 반복하지 않는다. 응답과 클라이언트 상태에 PIN, spreadsheet/tab identity, credential/provider 원문을 저장하지 않는다. 두 path는 production OpenAPI에 존재하지만 hosted mapping/ACL/secret/Cron/smoke가 끝날 때까지 실제 Google 동기화 기능을 켜지 않는다.

백엔드 저장소에서:

```bash
npm install
npm run db:start
```

보호 API까지 직접 호출하려면 백엔드의 `supabase/functions/.env.example`을 참고해 Git에서 제외된 `.env.local`을 준비하고 다음 명령으로 Function을 실행한다.

```bash
npm exec -- supabase functions serve api reservation-scheduler --env-file supabase/functions/.env.local
```

문서·health만 확인할 때도 실제 token, 비밀번호, 전체 휴대전화, service-role key를 캡처·Issue·프론트 fixture에 넣지 않는다.

## 3. TypeScript 타입 생성

OpenAPI를 사람이 보고 interface로 다시 작성하지 않는다. 프론트 저장소에서 버전을 고정해 생성한다.

```bash
npx openapi-typescript@7.13.0 http://127.0.0.1:54321/functions/v1/api/openapi.json --output src/api/generated/room-management-api.ts
```

운영 snapshot으로 생성할 때:

```bash
npx openapi-typescript@7.13.0 https://wrongstory.github.io/room-management-system-backend/openapi.json --output src/api/generated/room-management-api.ts
```

권장 규칙:

- `src/api/generated/room-management-api.ts`는 생성 결과이므로 직접 수정하지 않는다.
- endpoint path와 method는 생성된 `paths` 타입에서 가져온다.
- 화면용 view model 변환은 `src/api/mappers/`처럼 생성 코드 밖에 둔다.
- OpenAPI가 바뀌면 타입을 다시 생성하고 프론트 typecheck를 실행한다.
- OpenAPI에 없는 endpoint·field·enum을 와이어프레임 fixture만 보고 추가하지 않는다.

예시:

```ts
import type { paths } from "./generated/room-management-api";

export type LoginBody =
  paths["/v1/auth/login"]["post"]["requestBody"]["content"]["application/json"];

export type AccountListResponse =
  paths["/v1/accounts"]["get"]["responses"][200]["content"]["application/json"];
```

Python 운영도구도 같은 OpenAPI JSON을 저장소에 복사해 수동 모델을 중복 작성하지 않는다. #44에서 선택한 generator 버전을 lockfile에 고정하고 생성 코드는 직접 수정하지 않으며, `httpx` 인증·재시도·redaction adapter는 생성 코드 밖에 둔다. 상태별 UI·운영 대응은 [developer 운영 API 가이드](./DEVELOPER_OPERATIONS_API.md)를 따른다.

## 4. 공통 HTTP 규칙

### 인증

1. `POST /v1/auth/login`으로 `accessToken`, `refreshToken`, `expiresIn`, `user`를 받는다.
2. 보호 API에는 `Authorization: Bearer {accessToken}`을 보낸다.
3. 앱 시작·새로고침·세션 복구 뒤 `GET /v1/auth/me`를 호출해 최신 role/status/session을 다시 확인한다.
4. token 갱신은 Supabase Auth 표준 refresh session 계약을 사용한다. refresh token을 custom API request body에 보내지 않는다.

`user.mustChangePassword=true`이면 비밀번호 변경 화면 외 일반 계정·객실·가능일 화면을 막는다. `POST /v1/auth/password` 성공은 `204 No Content`이므로 JSON 파싱을 시도하지 말고 `/v1/auth/me`를 다시 조회한다.

### 멱등성

모든 변경 API에는 `Idempotency-Key`가 필요하다.

```ts
const idempotencyKey = crypto.randomUUID();
```

- 사용자가 확인 버튼을 한 번 누를 때 새 키를 만든다.
- timeout·연결 끊김으로 **같은 request body**를 재시도할 때만 같은 키를 쓴다.
- request body가 바뀌면 새 키를 만든다.
- 같은 키를 다른 payload에 쓰면 `IDEMPOTENCY_KEY_REUSED`가 반환된다.
- 키를 analytics, 오류 수집 payload, 사용자 화면에 노출하지 않는다.
- `POST /v1/auth/password`의 timeout·응답 유실은 **동일 Idempotency-Key와 원 요청 body**로만 재시도한다. 서버는 비밀번호 파생 fingerprint를 저장하지 않아 `currentPassword` byte equality를 durable receipt로 비교하지 않으며, replay에서는 서버가 Auth 비밀번호 변경에 결합한 private effect version과 재전송한 `newPassword`가 모두 현재 상태와 일치할 때만 같은 의도 효과로 보고 204를 반환한다. 후속 변경·관리자 초기화·별도 Auth password 변경 뒤 과거 key는 현재 비밀번호가 같아도 409다. `PASSWORD_CHANGE_IN_PROGRESS`는 짧게 대기 후 같은 요청을 재시도하고, `PASSWORD_STATE_UPDATE_FAILED`도 같은 key 재시도로 DB 완료를 복구한다. `PASSWORD_VERIFICATION_RATE_LIMITED`는 새 key/session으로 우회하지 말고 `Retry-After` 뒤 재시도한다. `PASSWORD_STATE_INCONSISTENT`는 자동 재시도하지 않고 운영자에게 문의한다.

### 응답과 오류

- 인증·계정·객실·가능일 응답은 `Cache-Control: no-store`다.
- 성공 본문이 없는 `204`를 별도로 처리한다.
- 오류는 `{ error: { code, message }, requestId }` 형식이다.
- 분기는 HTTP status와 `error.code`를 사용한다. 한국어 `message` 문자열 비교는 금지한다.
- 운영 문의에는 token이나 request body 대신 `requestId`를 사용한다.

| 상황 | 대표 code | 프론트 처리 |
|---|---|---|
| 로그인 필요/만료 | `MISSING_ACCESS_TOKEN`, `INVALID_ACCESS_TOKEN`, `SESSION_REVOKED` | 세션 정리 후 로그인 화면 |
| 최초 비밀번호 변경 | `PASSWORD_CHANGE_REQUIRED` | 비밀번호 변경 화면 고정 |
| 권한 부족 | `ACCOUNT_MANAGER_REQUIRED`, `ADMIN_REQUIRED` | 접근 차단·권한 안내 |
| developer 전용 | `DEVELOPER_REQUIRED` | 일반 admin/maid 화면으로 복귀, 권한 우회 재시도 금지 |
| 계정 잠금 | `ACCOUNT_LOCKED` | 잠금 종료 또는 관리자 해제 안내 |
| 로그인 요청 과다 | `LOGIN_RATE_LIMITED` | `Retry-After` 이후 재시도. 로그인 ID를 바꿔 제한을 우회하지 않음 |
| 로그인 client 확인 불가 | `LOGIN_CLIENT_ID_UNAVAILABLE` | 자동 반복하지 않고 네트워크·gateway 상태 확인 |
| 동시 변경/업무 충돌 | `IDEMPOTENCY_KEY_REUSED`, `LAST_ACTIVE_ADMIN_REQUIRED` 등 409 | 최신 목록 재조회 후 사용자 확인 |
| 서버 상태 불일치 | `ACCOUNT_AUTH_STATE_INCONSISTENT`, `PASSWORD_STATE_INCONSISTENT` | 자동 성공 처리 금지, requestId로 운영 확인 |
| 진단 요청 과다 | `DIAGNOSTICS_RATE_LIMITED` | `Retry-After` 뒤 사용자가 다시 실행 |
| 가능일 대상 주차 범위 밖 | `AVAILABILITY_WEEK_OUT_OF_RANGE` | KST 기준 현재 주 또는 다음 주 월요일로 다시 선택 |
| 과거 가능일 소급 변경 | `PAST_AVAILABILITY_DATE_NOT_ALLOWED` | 현재 주의 지난 날짜를 새로 가능으로 바꾸지 말고 최신 version 재조회 |
| 가능일 동시 변경 | `STALE_VERSION` | 현재 가능일·요청 목록을 다시 조회하고 expectedVersion 갱신 |
| 처리 중 변경 요청 존재 | `PENDING_CHANGE_REQUEST_EXISTS` | 기존 pending 요청을 표시하고 중복 요청 금지 |
| 예약·객실 동시 변경 | `STALE_VERSION`, `ROOM_STATE_CHANGED` | 예약·객실을 다시 조회하고 서버 version으로 사용자 재확인 |
| 예약 일정 충돌 | `RESERVATION_OVERLAP` | 겹치는 예약을 표시하고 임의 자동 재시도 금지 |
| 객실 최대 인원 초과 | `GUEST_COUNT_EXCEEDS_ROOM_TYPE_CAPACITY` | 최신 객실 유형 정보를 다시 읽고 인원 또는 객실 유형을 변경 |
| 객실 유형 인원 변경 충돌 | `ROOM_TYPE_VERSION_CONFLICT`, `ROOM_TYPE_CAPACITY_PREVIEW_STALE`, `ROOM_TYPE_CAPACITY_ACTIVE_RESERVATION_CONFLICT` | 새 preview를 받고 영향 대상과 최신 version을 다시 확인; 기존 예약 자동 변경 금지 |
| 객실 비활성화 충돌 | `ROOM_VERSION_CONFLICT`, `ROOM_DEACTIVATION_PREVIEW_STALE`, `ROOM_DEACTIVATION_BLOCKED` | 최신 카탈로그와 preview 재조회; 예약·청소·PIN·운영 업무를 먼저 해소 |
| 퇴실 청소 템플릿 미게시 | `CLEANING_TEMPLATE_NOT_CONFIGURED` | 예상시간 누락으로 해석하지 않고 해당 객실 유형의 게시된 checkout template 설정 안내 |
| 같은 객실의 이전 수행 진행 중 | `PREVIOUS_ROOM_WORKFLOW_ACTIVE` | 기존 수행 상태를 다시 조회하고 종료·중단 처리 전 새 시작 금지 |
| 고객 미퇴실 사건 처리 중 | `CHECKOUT_INCIDENT_OPEN` | 자동 해제하지 않고 사건 상태와 관리자 결정 결과를 다시 조회 |
| 고객명 보호 설정 장애 | `RESERVATION_PII_*` | 평문 fallback 금지, requestId로 운영 확인 |

## 5. 역할별 화면 경계

| 역할 | `/auth/me` | 계정 목록·변경 | developer 운영 상태 | 전체 객실 목록 | 예약 | 가능일 조회 | 가능일 제출·요청 | 가능일 결정·후보 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `developer` | 허용 | 허용 | 허용 | 금지 | 금지 | 금지 | 금지 | 금지 |
| `admin` | 허용 | 허용 | 금지 | 허용 | 허용 | 전체 허용 | 금지 | 허용 |
| `maid` | 허용 | 금지 | 금지 | 금지 | 금지 | 본인만 | 허용 | 금지 |

- `developer`는 최상위 백엔드·계정 운영자이며 business admin이 아니다.
- 계정 생성·역할 변경 입력에는 `admin | maid`만 사용한다.
- developer 계정의 role/status/unlock/password-reset 버튼을 렌더링하지 않는다. 서버도 항상 다시 차단한다.
- 마지막 active business admin 변경은 동시 요청에서도 거부될 수 있으므로 409를 정상 업무 오류로 처리한다.

## 6. 화면별 endpoint

| 화면/동작 | Method/path | 주의점 |
|---|---|---|
| 로그인 | `POST /v1/auth/login` | unknown ID와 wrong password를 구분하지 않음 |
| 앱 세션 복구 | `GET /v1/auth/me` | 최신 role과 mustChangePassword의 정본 |
| 최초/개인 비밀번호 변경 | `POST /v1/auth/password` | 성공 204, Idempotency-Key 필요 |
| 계정 목록 | `GET /v1/accounts` | 전체 휴대전화·내부 Auth 이메일 없음 |
| 계정 생성 | `POST /v1/accounts` | 응답의 temporaryPassword를 로그·영속 저장하지 않음 |
| 역할 변경 | `PATCH /v1/accounts/{profileId}/role` | admin ↔ maid만 가능 |
| 상태 변경 | `PATCH /v1/accounts/{profileId}/status` | 퇴사는 inactive 선행, reasonCode 필요 |
| 잠금 해제 | `POST /v1/accounts/{profileId}/unlock` | developer 대상 금지 |
| 비밀번호 초기화 | `POST /v1/accounts/{profileId}/password-reset` | 휴대전화 마지막 4자리 임시값, developer 대상 금지 |
| 운영 dashboard | `GET /v1/developer/overview` | developer 전용, 계정·runtime·DB·scheduler 통합 projection |
| runtime 상태 | `GET /v1/developer/runtime-status` | secret은 allowlist 이름별 configured boolean만 제공 |
| DB 상태 | `GET /v1/developer/database-status` | migration drift·RLS 누락·핵심 RPC 여부 |
| scheduler 상태 | `GET /v1/developer/scheduler-status` | Cron SQL/Vault/HTTP body 없이 정규화 상태만 제공 |
| 업무 감사 | `GET /v1/developer/audit-events` | 성공한 domain mutation, 최대 31일·100건 cursor pagination, raw state 없음 |
| 활동·보안 로그 | `GET /v1/developer/activity-events` | 로그인·민감접근 및 분 단위 권한거부 집계, 최대 31일·100건 cursor pagination |
| 운영 진단 | `POST /v1/developer/diagnostics` | body 없음, 임의 URL/SQL/RPC 입력 없음, 10회/분 |
| 개발자 객실 카탈로그 | `GET /v1/developer/room-catalog` | developer 전용 safe projection; 예약·고객·PIN·청소 raw 상태 없음 |
| 객실 유형 인원 변경 미리보기 | `POST /v1/developer/room-types/{roomTypeId}/capacity/preview` | `baseOccupancy/maxOccupancy/expectedVersion`; read-only 5분 TTL |
| 객실 유형 인원 변경 확정 | `PATCH /v1/developer/room-types/{roomTypeId}/capacity` | preview fingerprint·CAS·`CAPACITY_POLICY_CHANGE`·Idempotency-Key 필수 |
| 객실 추가 | `POST /v1/developer/rooms` | 숫자 문자열 객실번호, 활성 유형과 최신 유형 version; `verification_required`로 생성 |
| 객실 비활성화 미리보기 | `POST /v1/developer/rooms/{roomId}/deactivation/preview` | 최신 객실 version으로 점유·예약·청소·PIN·운영 영향 확인 |
| 객실 비활성화 확정 | `POST /v1/developer/rooms/{roomId}/deactivate` | hard delete 없음; fingerprint·CAS·`ROOM_CATALOG_REMOVE`·Idempotency-Key 필수 |
| 객실 운영 목록 | `GET /v1/rooms` | active admin만 가능, 동일한 `evaluatedAt`/`serverTime` snapshot의 lifecycle·readiness 독립 축 사용 |
| 객실 운영 상세 | `GET /v1/rooms/{roomId}` | 목록과 동일한 camelCase projection·next reservation 요약, PIN 원문 없음 |
| 객실 기준정보 변경 | `PATCH /v1/rooms/{roomId}/master-data` | room state `expectedVersion` CAS와 Idempotency-Key |
| 객실 운영 차단 조회 | `GET /v1/rooms/{roomId}/operation-blocks?status=actionable` | 미해제 scheduled/active/expired 전체; 반환 ID와 roomStateVersion을 해제에 사용 |
| 객실 운영 차단 | `POST /v1/rooms/{roomId}/operation-blocks` | 시작/종료 시각은 RFC 3339 offset, 생성 결과 ID는 서버 결정 |
| 객실 운영 차단 해제 | `POST /v1/rooms/{roomId}/operation-blocks/{blockId}/release` | 삭제가 아닌 release 이력 append |
| 객실 점유 보정 | `POST /v1/rooms/{roomId}/occupancy-corrections` | admin 전용; reservationId·occupied·effectiveAt·expectedRoomVersion·reasonCode와 Idempotency-Key 필수. 복합 표시 status를 덮지 않고 canonical stay segment 이력을 보정 |
| 객실 표시 분류 강제 조정 | `POST /v1/rooms/{roomId}/display-status-overrides` | admin 전용; targetStatus는 6개 표시 enum 또는 null(clear). 표시만 바꾸며 예약·점유·readiness·bookability는 불변. 실제 BLOCKED는 operation-block command 사용 |
| 촛불 수량 기록 | `POST /v1/rooms/{roomId}/candles` | count 0 이상, physicallyVerified 기본 false |
| 객실 이슈 조회 | `GET /v1/rooms/{roomId}/issues?status=open` | 미해결 이슈만; 반환 ID와 roomStateVersion을 해결에 사용 |
| 객실 이슈 등록 | `POST /v1/rooms/{roomId}/issues` | description 연락처 입력 금지, raw 문구를 오류 로그에 남기지 않음 |
| 객실 이슈 해결 | `POST /v1/rooms/{roomId}/issues/{issueId}/resolve` | hard delete 없이 해결 이력 기록 |
| PIN 초기화 | `POST /v1/rooms/pins/bootstrap` | active admin, 선택적 limit만 전송; PIN은 서버 secret에서만 읽음 |
| PIN 동기화 상태(legacy) | `POST /v1/rooms/{roomId}/pin-sync-events` | 신규 프런트 사용 금지; 상태 기록만으로 current PIN이 생성되지 않음 |
| 현재 가능일 | `GET /v1/availability?weekStart=...` | maid는 본인만, admin은 maidProfileId 선택 가능 |
| 가능일 제출·직접 변경 | `POST /v1/availability/submissions` | maid만, KST 현재·다음 주, 요일 무관, 과거 날짜 신규 true 금지, CAS·Idempotency-Key |
| 승인형 변경 요청 | `POST /v1/availability/change-requests` | maid만, 대상 주 시작 후 pending 1건·이력 보존 |
| 변경 요청 목록 | `GET /v1/availability/change-requests` | maid 본인만, admin은 status/weekStart/maid 필터 |
| 변경 요청 결정 | `POST /v1/availability/change-requests/{requestId}/decision` | active admin만, 승인 시 새 version 생성 |
| 배정 가능 후보 | `GET /v1/availability/candidates?workDate=...` | active admin만, 현재 가능일의 active maid |
| 예약 목록 | `GET /v1/reservations` | active admin만, 고객명과 암호문은 응답하지 않음. query 없음은 기존 `{reservations}` 호환 응답 |
| 예약 calendar 범위 | `GET /v1/reservations?from=...&to=...&roomId=...&cursor=...` | from/to 필수 쌍, 최대 31일·50건, opaque cursor와 serverTime 사용 |
| 예약 가능 객실 미리보기 | `POST /v1/reservations/bookability/preview` | 필수 `reservationType=standard|long_stay`; `guestCount`는 optional/nullable, standard는 checkout 필수, long_stay는 nullable checkout, optional roomTypeIds/excludeReservationId, 예약 성공 보장 아님 |
| 예약 상세 | `GET /v1/reservations/{reservationId}` | active admin만 고객명 복호화, 실제 민감조회 activity 기록 |
| 예약 생성 | `POST /v1/reservations` | 객실 version CAS, Idempotency-Key, 고객명 서버 암호화 |
| 예약 변경 | `PATCH /v1/reservations/{reservationId}` | 일정·고객정보만 변경. roomId는 현재 값과 같아야 하며 객실 변경 우회 금지 |
| 객실 변경 미리보기 | `POST /v1/reservations/{reservationId}/room-change/preview` | admin, source-controlled reasonCode와 reservation/source/target version 필요; effectiveAt은 생략하거나 checkInAt과 정확히 같게 전송; read-only 5분 TTL |
| 체크인 전 객실 변경 확정 | `POST /v1/reservations/{reservationId}/room-change` | preview payload의 reasonCode와 authoritative effectiveAt, evaluatedAt/expiresAt/fingerprint와 version을 그대로 echo, Idempotency-Key 필수 |
| 예약 취소 | `POST /v1/reservations/{reservationId}/cancel` | reasonCode와 expectedVersion 필요, hard delete 없음 |
| 수동 체크아웃 | `POST /v1/reservations/{reservationId}/manual-checkout` | 실제 입실 중인 예약만, 청소 obligation과 함께 원자 처리 |
| 청소 요청 | `POST /v1/reservations/cleaning-requests` | 연박/추가 요청, 객실 version CAS |
| 청소 요청 취소 | `POST /v1/reservations/cleaning-requests/{targetId}/cancel` | target version CAS soft cancel |
| 예약 전이 수동 실행 | `POST /v1/reservations/transitions/process` | admin 운영 명령. scheduler secret endpoint와 별도 |
| 퇴실 청소 템플릿 조회 | `GET /v1/cleaning-templates?cleaningKind=checkout` | `durationMinutes=null`을 미설정 선택값으로 표시하고 0분·1분으로 변환하지 않음 |
| 퇴실 청소 템플릿 게시 | `POST /v1/cleaning-templates` | 사진 슬롯은 필수, `durationMinutes`는 선택. 모르면 생략하며 임의 기본값을 보내지 않음 |
| 온라인 청소 시작 | `POST /v1/attempts/{attemptId}/start` | 최신 assignment/attempt version을 보내고 같은 객실 수행·미해결 사건 충돌은 서버 409를 최종 판정으로 사용 |
| 고객 미퇴실 신고 | `POST /v1/attempts/{attemptId}/checkout-not-completed` | maid의 current/notified checkout attempt만 가능. 신고 뒤 관리자 확인 대기 상태 표시 |
| 고객 미퇴실 사건 조회 | `GET /v1/checkout-incidents/{incidentId}` | admin 또는 사건에 연결된 maid만 조회. version과 impactFingerprint를 결정 요청에 재사용 |
| 고객 미퇴실 사건 결정 | `POST /v1/checkout-incidents/{incidentId}/decision` | admin만 `EXTEND_CHECKOUT`, `CONFIRM_DEPARTED`, `FALSE_REPORT`; stale version/fingerprint면 재조회 |

객실 응답의 `evaluatedAt`과 `serverTime`은 서버가 projection을 한 번 계산한 정확히 같은 RFC 3339 timestamp다. 기존 `reservationPhase=none|upcoming|current`, `occupied`, `cleaningRequired`, `allocation*`는 호환 유지한다. 새 UI는 `occupancyStatus=VACANT|OCCUPIED`, `reservationLifecycle=NONE|FUTURE|RESERVATION_PRESENT|ARRIVAL_PENDING|OCCUPIED`, `readinessStatus=READY|CLEANING_REQUIRED|CHECKIN_BLOCKED`를 서로 독립적으로 읽는다.

현재 예약 구간은 `checkInAt <= serverTime < checkOutAt`이고 실제 active occupancy도 lifecycle `OCCUPIED`가 우선이다. current가 없으면 가장 이른 미래 active 예약의 KST 체크인 날짜가 오늘이면 `ARRIVAL_PENDING`, 내일이면 `RESERVATION_PRESENT`, 모레 이후이면 `FUTURE`, 없으면 `NONE`이다. `nextReservationId`, `nextCheckInAt`, `nextCheckOutAt`은 current가 아닌 가장 이른 미래 active 예약만 담으며, 현재 투숙 중이어도 뒤 예약이 있으면 값이 존재할 수 있다.

카드·필터·집계의 대표 값은 서버의 `primaryDisplayStatus`를 사용한다. 우선순위는 `BLOCKED → OCCUPIED → ARRIVAL_PENDING → RESERVATION_PRESENT → CLEANING_REQUIRED → READY`다. `canonicalPrimaryDisplayStatus`는 원장에서 계산한 값이고 `displayStatusOverride`는 관리자 강제 분류 또는 null이다. override가 있으면 `primaryDisplayStatus`에만 우선 적용되며 나머지 축은 그대로다. 청소만으로 canonical `BLOCKED`를 만들지 않고 `FUTURE`는 현재 readiness 대표 상태를 유지한다. 상세 설명에는 `blockingReasonCodes`와 `readinessReasonCodes`를 사용하되, 기존 `reasonCodes`도 호환 필드로 보존한다.

이 projection은 저장된 단일 status가 아니다. `occupied`는 서버 평가 시각이 canonical stay segment의 `[startsAt,endsAt)` 안에 있을 때만 true이고, 종료 미정 end=null은 명시 종료 전까지 유지된다. `allocationBlocked`는 운영 차단·배정 차단 이슈·촛불·기준정보 오류 같은 객실 문제만 뜻하므로 점유나 청소만으로 true가 되지 않는다. `allocationReady`는 점유·청소·객실 문제와 current-check-in readiness 경고를 모두 통과할 때만 true다. 미래 예약과 planned checkout만으로 현재 `cleaningRequired`나 `allocationBlocked`를 활성화하지 않는다. `pinSyncStatus=unconfigured|mismatch`는 예약 버튼을 비활성화하거나 예약 요청을 생략하는 조건이 아니며, current check-in 시점에만 readiness 경고로 표시한다. 실제 체크인·PIN 접근 화면은 기존 #140 계약대로 `verified` 전까지 차단한다.

객실 mutation은 최신 상세/목록의 `stateVersion`을 `expectedVersion` 또는 `expectedRoomVersion`으로 그대로 보낸다. `STALE_VERSION`이면 현재 객실을 다시 읽어 사용자 확인을 받고, 키를 바꿔 자동 덮어쓰지 않는다. 동일 payload의 통신 재시도에만 같은 Idempotency-Key를 사용한다. 수동 `PIN 동기화 상태 기록` 화면은 제거하고 bootstrap·prepare/confirm/rollback/reveal API만 사용한다. PIN 관련 목록은 `pinSyncStatus`와 `pinVersion`만 취급하며 `pin`, `rawPin`, `pinCode`, `doorCode`, `credential`, `providerSecret` 필드를 만들거나 analytics·오류 수집에 보내지 않는다.

운영 차단·이슈 화면은 상세 projection의 reason code만으로 ID를 추측하지 않고 전용 GET 두 개를 사용한다. `actionable`에는 미래 scheduled, 현재 active, 종료 시각이 지난 expired 차단이 모두 포함되며 `expired`도 관리자가 명시적으로 release할 때까지 처리 대상이다. release/resolve 버튼은 목록 item의 `id`와 envelope의 `roomStateVersion`을 함께 보내고, `STALE_VERSION`이면 두 목록을 다시 조회한다. 응답의 `evaluatedAt`은 상태 badge의 서버 평가 시각이며 브라우저 시각으로 상태를 다시 분류하지 않는다.

가능일의 `weekStart`와 날짜는 `YYYY-MM-DD`로 보내며 client timezone으로 날짜를 다시 변환하지 않는다. `version`은 화면 로컬 카운터가 아니라 서버 응답값을 그대로 다음 `expectedVersion`에 사용한다. 일요일은 주 제출 알림의 기준일일 뿐 서버 허용창이 아니며, KST 어느 요일이든 현재 주와 다음 주를 직접 제출·변경할 수 있다. 409를 받은 요청을 다른 Idempotency-Key로 자동 반복하지 않는다.

예약 목록에는 `guestName`이 없으며 UI가 이름을 표시해야 할 때만 단건 상세를 호출한다. 예약 응답의 `version`은 예약 변경 command의 `expectedVersion`으로 사용하고, command 응답에 `roomStateVersion`이 있으면 후속 객실 기준 command의 CAS 입력으로 사용한다. 고객명은 브라우저 저장소·analytics·오류 수집에 보존하지 않고, 상세 화면을 벗어나면 메모리 상태에서도 제거한다. 암호화 설정 장애에서 평문 저장이나 빈 이름으로 성공 처리하지 않는다.

calendar 화면은 `from`과 `to`를 함께 strict RFC 3339 offset으로 보내고 `[from,to)`가 31일을 넘지 않게 자른다. 다음 페이지는 응답의 opaque `nextCursor`를 수정하거나 해석하지 않고 같은 `from`/`to`/`roomId`에만 재사용한다. cursor는 actor와 filter에 묶이므로 날짜·객실을 바꾸면 버리고 첫 페이지부터 요청한다. 정렬은 `(checkInAt,id)`이며 각 page의 `serverTime`은 그 page projection의 DB snapshot이다. `roomId` filter는 이동·취소된 예약의 겹치는 객실 segment history도 포함하므로 프런트가 현재 객실만으로 다시 필터링해 과거 기록을 숨기지 않는다. query 없는 legacy 목록 소비자는 `nextCursor`나 `serverTime`을 기대하지 않는다.

새 예약 또는 체크인 전 일정 변경 화면은 먼저 `POST /v1/reservations/bookability/preview`를 호출할 수 있다. 요청에는 `reservationType: "standard" | "long_stay"`를 보내며 `guestCount`는 생략/null 또는 1 이상의 정수다. 생략/null은 임의 1명으로 바꾸지 않고 capacity filter 없이 기간 bookability만 계산한다. 양의 정수이면 해당 유형의 최신 `maxOccupancy`까지 검사한다. 실제 예약 create/change의 `guestCount`는 계속 필수다. standard는 strict RFC 3339 `checkOutAt` 필수이고, long_stay는 고정 end 또는 명시적 `null`을 보낸다. 종료 미정 long-stay는 check-in 이후 객실을 무기한 점유하는 것으로 평가되므로 이후 예약 후보가 될 수 없다. `roomTypeIds` 생략과 `[]`는 모두 전체 유형이다. candidate의 `intervalBookable`만 요청 구간 예약 가능 축으로 사용하고, guestCount를 보낸 요청에서 `GUEST_COUNT_EXCEEDS_ROOM_TYPE_CAPACITY`가 있으면 해당 유형의 최신 `maxOccupancy`를 초과한 것이다. `checkInReady`는 현재 청소·PIN 준비 상태의 별도 안내로 표시한다. `PIN_UNCONFIGURED`/`PIN_MISMATCH`는 `evaluatedAt`에 실제 current check-in pending일 때만 이 안내에 나타나며 interval bookability를 바꾸지 않는다. `excludeReservationId`는 신규 예약에서 생략 또는 `null`, 편집에서는 exact active·체크인 전 예약 ID만 보낸다. preview와 commit 사이에는 최대 인원이나 다른 예약이 바뀔 수 있으므로 성공 문구는 “현재 조회 기준 가능”으로 제한하고, 실제 create/change의 capacity/overlap 오류를 최종 판정으로 다시 표시한다.

예약 응답의 `reservationType`과 nullable `checkOutAt`은 함께 해석한다. 종료 미정 long-stay에는 checkout obligation/청소 target이 아직 없으므로 클라이언트가 가짜 checkout·청소 계획을 만들지 않는다. type은 생성 후 바꿀 수 없고, 고정 checkout을 다시 null로 되돌릴 수 없다. open-ended 예약에 end를 확정하는 change는 최신 `version`과 같은 Idempotency-Key replay 규칙을 사용한다. 체크인 전 객실 변경은 open-ended 상태를 보존하지만, 투숙 중 객실 변경은 먼저 end를 확정해야 하며 `OPEN_ENDED_STAY_REQUIRES_END`를 다른 key로 자동 우회하지 않는다. scheduler가 open-ended 예약을 자동 checkout한다고 가정하지 말고 실제 종료는 관리자 수동 checkout 결과를 정본으로 사용한다.

예약 전이 수동 실행의 `Idempotency-Key`에는 `reservation-scheduler-` 접두사를 사용하지 않는다. 이 namespace는 scheduler invocation 전용이며 수동 API는 `RESERVED_IDEMPOTENCY_KEY`로 fail-closed한다. 고객명은 원문과 NFKC·trim·공백 축약 결과가 모두 1~80자여야 하므로, 화면에서도 원문 80자 제한을 먼저 적용하되 서버 오류 코드를 최종 판정으로 사용한다.

객실 변경 화면은 source-controlled `reasonCode`와 optional `effectiveAt`을 포함해 먼저 preview를 호출한다. 체크인 전 effectiveAt을 생략하면 서버가 `checkInAt`을 authoritative 값으로 반환하며, 직접 보내면 strict RFC 3339 checkInAt과 정확히 같아야 한다. `mode=DURING_STAY` 또는 `eligible=false`이면 commit 버튼을 비활성화하고, inactive 예약도 오류가 아니라 ineligible preview로 표시한다. 성공 preview의 `effectiveAt`, `reasonCode`, `evaluatedAt`, `expiresAt`, `impactFingerprint`, 세 expected version을 수정·재계산하지 말고 commit에 그대로 보낸다. `ROOM_CHANGE_PREVIEW_STALE`이나 `RESERVATION_VERSION_CONFLICT`/`SOURCE_ROOM_VERSION_CONFLICT`/`TARGET_ROOM_VERSION_CONFLICT`이면 새 preview를 받아 사용자가 다시 확인해야 한다. `TARGET_ROOM_OVERLAP`, `TARGET_ROOM_BLOCKED`, `CLEANING_ASSIGNMENT_LOCKED`, `PIN_LEASE_ACTIVE`를 다른 key로 자동 우회하지 않는다. 다른 key로 이미 같은 객실에 이동했다면 원 preview version이 stale이어도 `MOVE_ALREADY_APPLIED` 409를 표시한다. 동일 commit 응답을 잃은 네트워크 재시도에만 같은 Idempotency-Key와 같은 payload를 사용하며, replay는 expiresAt 이후에도 성공 응답을 돌려줄 수 있다. 같은 key에 다른 payload를 보내면 `IDEMPOTENCY_KEY_REUSED`와 동일한 안전한 `error.conflict` 복구 정보가 오며 새 preview부터 다시 시작한다.

전용 객실 변경 409에서는 `error.conflict.reloadResources`에 포함된 `reservation | sourceRoom | targetRoom | roomMovePreview`만 다시 읽고, `latestVersions`의 세 version을 다음 preview의 기준으로 사용한다. version이 `null`이면 추측하지 말고 해당 리소스를 다시 조회한다. conflict payload에는 UUID나 고객/PIN 정보가 오지 않는다.

퇴실 청소 템플릿의 `durationMinutes`는 실제 청소 완료시간이나 배정 preview 계산값이 아니다. 실제 수행시간은
메이드의 attempt 시작~현장완료 기록에서 계산하고, 배정 preview는 예상시간 정책이나 template 값을 사용하지 않는다.
프런트는 duration 미확정 시 필드를 생략하거나 `null`로 보내며 55/65/70/80 같은 데모값을 자동 주입하지 않는다.

### #165 예상시간 선택화 프론트 적용 체크리스트

아래는 `wrongstory/room-management-system`에서 구현할 source 체크리스트다. 백엔드 배포 gate는 완료됐지만 프런트 연결과 안전한 예약 E2E는 별도다.

#### 객실 타입 카탈로그 (#202 production source)

- [ ] active/password-complete business admin 세션에서 `GET /v1/room-types`를 호출하고 `{ items }`를 사용한다.
- [ ] 각 항목의 `id`, 안정적인 `code`, `displayName`, 원 단위 정수 `baseCleaningFee`, `active`, `version`, `roomCount`를 수기 fixture 대신 표시한다.
- [ ] `active=false`도 기존 객실 참조 현황을 위해 목록에는 표시하되 신규 객실 기준정보 선택지에서는 비활성화한다.
- [ ] 수정 화면의 이후 CAS 연결은 서버가 반환한 실제 `version`을 사용한다. `updatedAt`이나 목록 index에서 임의 버전을 만들지 않는다.
- [ ] 이 endpoint는 production OpenAPI에 포함됐다. 401/403/5xx 또는 계약 불일치는 fixture fallback으로 숨기지 않고 표시한다.

#### 타입·템플릿 관리자 화면

- [ ] 최신 production Edge 또는 Pages `/openapi.json`에서 타입을 다시 생성한다. candidate JSON이나 수기 interface를 운영 정본으로 고정하지 않는다.
- [ ] `PublishCleaningTemplateRequest.durationMinutes`를 `number | null | undefined`, 게시·조회 응답을 `number | null`로 처리한다.
- [ ] 예상시간 필수 표시와 필수 validation을 제거한다. 빈 값은 생략 또는 `null`로 보내며 두 입력은 같은 의미로 취급한다.
- [ ] 양수 입력은 1~10080 범위를 유지하고, `null`을 0분·1분 또는 55/65/70/80분으로 치환하지 않는다.
- [ ] 게시 상태에서 `null`은 `미설정(선택사항)`으로 표시한다. 사진 slot 수·필수 slot·`expectedVersion` CAS·`Idempotency-Key`는 기존 계약을 유지한다.

#### 예약·청소 계획 화면

- [ ] 게시된 checkout template과 유효한 사진 slot이 있으면 duration이 없어도 예약 생성·변경 요청을 보낸다. `CLEANING_TEMPLATE_NOT_CONFIGURED`는 duration 누락이 아니라 template 미게시로 안내한다.
- [ ] 예약의 checkout 시각은 퇴실 청소의 시작 가능 시각이고, 다음 check-in 30분 전 등의 `dueAt`은 별도 업무 마감이다. 둘의 차이를 예상 청소시간으로 표시하지 않는다.
- [ ] `durationMinutes=null`이고 `dueAt=null`인 checkout 계획에 임의 종료시각을 만들지 않는다.
- [ ] 열린 checkout 계획이 있어도 수동 청소 계획 등록 자체를 프론트에서 막지 않는다. 명시된 두 구간의 충돌과 실제 시작 가능 여부는 서버 응답을 정본으로 사용한다.
- [ ] 배정 preview는 duration policy 없이도 실행한다. 응답의 `durationPolicyStatus=retired`, `durationPolicyRequired=false`, `durationMinutes=null`을 정상 상태로 처리한다.

#### 메이드 수행·고객 미퇴실 화면

- [ ] 청소 시작 가능 여부는 `POST /v1/attempts/{attemptId}/start` 결과로 판정한다. 로컬 타이머나 예상시간으로 자동 시작·자동 해제하지 않는다.
- [ ] `PREVIOUS_ROOM_WORKFLOW_ACTIVE`이면 같은 객실의 현재 수행을, `CHECKOUT_INCIDENT_OPEN`이면 미해결 사건을 다시 조회하고 사용자가 임의로 우회하지 못하게 한다.
- [ ] PIN 조회는 청소 시작이 아니다. 실제 수행시간은 `startedAt → fieldCompletedAt`으로 표시하고, 중단된 여러 attempt를 임의로 이어 붙이지 않는다.
- [ ] 완료 탭은 `GET /v1/cleaning-history?date=YYYY-MM-DD`를 사용한다. 서버가 KST D-6..D를 계산하므로 클라이언트가 UTC 구간을 만들지 않는다.
- [ ] admin은 선택적으로 `maidProfileId`, `query`, `limit`, `cursor`를 사용하고 maid는 본인 이력만 조회한다. 다음 페이지는 `nextCursor`를 그대로 전달한다.
- [ ] `roomNumber/roomTypeCode/roomTypeName`은 완료 attempt snapshot이다. `performerDisplayName`은 현재 프로필 표시명이며 과거 이름 snapshot이 아님을 UI 도움말에서 구분한다.
- [ ] `mediaAvailability`가 `purged/unavailable`이어도 완료 이력 metadata는 유지한다. 사진 원본 URL·provider locator·PIN·고객 PII를 이 응답에서 기대하지 않는다.
- [ ] 주간 업무 기록은 `GET /v1/work-history?weekStart=YYYY-MM-DD`를 사용하고 `weekStart`는 KST 월요일을 보낸다.
- [ ] `availableSubmitted`, `assignmentNotified`, `fieldCompleted`를 서로 독립된 flag로 표시한다. 가능일이나 통보만으로 실제 완료·근무로 합치지 않는다.
- [ ] admin은 `maidProfileId/limit/cursor`를 사용할 수 있고 maid는 본인 기록만 조회한다. `summary`는 현재 page가 아니라 전체 필터 범위이므로 다음 page에서도 같은 값으로 취급한다.
- [ ] `maidDisplayNameSource=current_profile`은 현재 표시명이라는 뜻이다. 과거 통보·완료 시점의 이름 snapshot으로 표시하지 않고, 상세 작업은 `/v1/cleaning-history`로 이동한다.
- [ ] 고객이 남아 있으면 `POST /v1/attempts/{attemptId}/checkout-not-completed`에 최신 executionVersion·assignment ID/revision과 `Idempotency-Key`를 보낸다.
- [ ] 신고 뒤 `관리자 확인 대기`를 표시하고 이후 PIN 접근·시작·완료·제출 관련 동작은 최신 서버 상태에 따라 차단한다. 이미 화면에 표시된 PIN을 회수했다고 표현하지 않는다.

#### 관리자 사건 처리·공통 오류

- [ ] 사건 조회 응답의 `version`과 `impactFingerprint`를 그대로 결정 요청에 사용하고, `EXTEND_CHECKOUT`, `CONFIRM_DEPARTED`, `FALSE_REPORT`만 제공한다.
- [ ] version/fingerprint 409에서는 자동 덮어쓰기하지 않고 사건을 다시 조회해 영향 범위를 관리자에게 다시 확인받는다.
- [ ] 예약·배정·attempt·사건 409 후 관련 projection을 재조회한다. notification 문구나 브라우저의 이전 상태를 권한·성공의 근거로 사용하지 않는다.
- [ ] timeout·응답 유실은 같은 body와 같은 `Idempotency-Key`로 결과를 확인한다. body를 바꾸면 새 key를 사용한다.
- [ ] 오류 수집에는 allowlist code와 `requestId`만 남기고 token·PIN·고객명·전화번호·request body를 보내지 않는다.

#### 프론트 회귀와 운영 활성화 gate

- [ ] duration 생략과 명시적 `null` 게시, 조회의 `null` 보존, 양수 기존 입력을 모두 검증한다.
- [ ] duration 없는 게시 template으로 예약 생성이 성공하고 planned checkout target이 생성되는 흐름을 검증한다.
- [ ] 같은 객실 동시 시작은 정확히 한 요청만 성공하고, 미해결 고객 미퇴실 사건 중에는 시작·완료·제출이 성공으로 표시되지 않는지 검증한다.
- [x] #165 독립 QA P0/P1=0 → `main` 병합 → production 56번째 migration → 승인 `main` exact source의 `api` 배포 → production OpenAPI nullable 의미 확인 → 네 template 게시 완료.
- [x] 당시 v0.3.0 OpenAPI 109 paths / 117 operations에서 요청의 duration 생략·`null` 허용과 게시·조회 응답의 `null` 보존을 실제 운영 HTTP로 확인. 현재 정본은 v0.4.0 120 paths / 130 operations다.
- [ ] 안전한 운영 fixture에서 예약 생성·동일 요청 replay·planned checkout target/snapshot을 확인. 현재는 `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE`다.

developer 운영 화면은 `environment`와 `projectRef`를 항상 텍스트로 함께 표시한다. `migrationDrift=behind`, `rlsValid=false`, `scheduler.status=actor_invalid|degraded`는 정상 성공 payload 안의 운영 경고 상태이므로 HTTP 200과 별개로 사용자에게 차단 수준을 표시한다. `not_configured`는 business admin·Cron 활성화 전의 정상 상태이며 자동으로 scheduler 실행을 시도하지 않는다.

## 7. 민감정보 처리

- access/refresh token, 비밀번호, 전체 휴대전화, 임시 비밀번호를 console·analytics·Sentry breadcrumb·Issue에 남기지 않는다.
- `temporaryPassword`는 생성 직후 권한 있는 사용자에게 전달하는 UI에서만 잠시 표시하고 영속 브라우저 저장소에 보관하지 않는다.
- service-role/secret key와 내부 Auth 이메일은 프론트 환경변수에 두지 않는다.
- 브라우저에는 Supabase publishable key만 허용한다.
- API error object 전체를 무조건 외부 오류 수집기로 전송하지 않는다. allowlist field와 `requestId`만 보낸다.

## 8. 프론트 Codex에 전달할 작업 문구

짧은 작업 요청에는 아래 원칙을 붙이고, 실제 구현 작업에는 [production API v0.4.0 프런트 Codex 인계](./FRONTEND_CODEX_HANDOFF_V0.4.0.md)의 전체 프롬프트를 그대로 전달한다.

```text
백엔드 HTTP 계약은 제공된 OpenAPI 3.1 JSON을 정본으로 사용한다.
먼저 openapi-typescript로 타입을 생성하고 생성 파일은 직접 수정하지 않는다.
endpoint, request/response field, enum, 권한을 와이어프레임 fixture로 추측하지 않는다.
보호 API에는 Bearer access token을 사용하고 mustChangePassword=true이면 비밀번호 변경 외 화면을 차단한다.
mutation마다 Idempotency-Key를 만들고 같은 payload 재시도에만 같은 키를 재사용한다.
오류 분기는 한국어 message가 아니라 HTTP status와 error.code를 사용한다.
token, 비밀번호, 전체 휴대전화, temporaryPassword를 로그·fixture·테스트 캡처에 넣지 않는다.
구현 후 생성 타입 기준 typecheck와 역할별 401/403/409/429 UI 처리를 검증한다.
객실 현재 상태는 primaryDisplayStatus를 사용하고 미래 기간 예약 가능 여부는 bookability preview의 intervalBookable을 사용한다.
미래 예약을 현재 cleaningRequired로 바꾸거나 현재 allocationReady를 미래 모든 날짜의 예약 가능 여부로 재사용하지 않는다.
```

## 9. 현재 범위 제한

### 주급 pagination 운영 계약 (#96)

- `GET /v1/payroll`은 `payroll` 최대 10개와 `nextCursor`를 반환한다. `maidProfileId`를 생략한 admin-all에서만 여러 cycle page를 순회하며 정렬은 `maidProfileId ASC`로 고정한다.
- 각 cycle의 `itemCount`, `totalAmount`, `lateEarningCount`, `lateEarningAmount`는 전체 exact 값이다. `items`와 `lateEarnings`는 최대 10개 preview이므로 배열 길이를 total로 해석하지 않는다.
- `itemsNextCursor` 또는 `lateEarningsNextCursor`가 있으면 `GET /v1/payroll/entries`에 같은 `weekStart`, `maidProfileId`, 맞는 `kind`와 함께 보낸다. 상세 page는 기본 25, 최대 50이고 `earnedOn ASC, earningId ASC` 순서다.
- 목록에서 `cycleId`가 non-null이면 `GET /v1/payroll/{cycleId}`로 동일 bounded envelope를 다시 조회할 수 있다. admin은 모든 materialized cycle, maid는 본인 cycle만 허용되며 conceptual OPEN은 stable ID가 없어 이 경로로 조회하지 않는다.
- cursor는 opaque 서명값이다. decode/수정/합성하거나 사용자·role·주차·maid filter·kind 사이에서 재사용하지 않는다. scope 변경 시 첫 page부터 다시 요청한다.
- list/entries/start/replay 응답은 UTF-8 JSON 128 KiB 상한을 갖는다. `PAYROLL_CURSOR_INVALID`, `PAYROLL_CURSOR_NOT_CONFIGURED`, `PAYROLL_RESPONSE_TOO_LARGE`는 message가 아니라 code로 분기한다.
- 이 계약은 production OpenAPI와 `api` bundle에 반영됐다. 실제 역할별 hosted read/mutation smoke가 없는 경로는 배포 여부와 별도로 표시한다.

현재 production Swagger 범위는 인증·계정·developer 운영 projection뿐 아니라 객실·예약·가능일·배정·수행·사진·제출·검수·컴플레인·주급·알림·PIN 관련 계약을 포함한 OpenAPI 0.5.1, 128 paths / 138 operations다. operation이 존재한다는 사실과 hosted provider/positive mutation 검증은 구분하며, 프런트는 역할·CAS·idempotency·redaction 계약을 충족한 경로만 활성화한다. Python 운영도구의 generated client는 계속 운영 관리 surface만 유지하며 전체 업무 API를 자동 포함하지 않는다.
