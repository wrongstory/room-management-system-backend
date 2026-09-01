# 프론트엔드·Codex API 연동 가이드

이 문서는 `makee-ham/room-management-system` 프론트와 해당 저장소에서 작업하는 Codex가 백엔드 동작을 추측하지 않고 연동하도록 만든 handoff 문서다. 제품 정책은 [AI 백엔드 제품 가이드](./AI_BACKEND_PRODUCT_GUIDE.md), HTTP 계약은 **실행 중인 Edge Function의 OpenAPI JSON**이 정본이다.

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

production Edge는 현재 auth/accounts/객실 목록 중심의 부분 HTTP surface다. source에는 #43 developer operation과 #51~#53 가능일·예약·객실 상세/mutation path가 추가됐지만, 각 source가 release를 거쳐 production에 배포된 OpenAPI에 실제로 나타난 뒤에만 프론트 기능을 활성화한다.

## 2. 로컬 백엔드 준비

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
- 현재 `POST /v1/auth/password`는 #46에서 receipt 재시도 계약을 별도로 보강할 예정이다. 응답 유실·timeout 때 기존 요청을 자동 반복하지 말고 결과 미확정 상태로 처리한다. 나머지 계정 변경 API는 같은 payload 재시도에 기존 logical 결과를 반환한다.

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
| 가능일 제출 시간 아님 | `OUTSIDE_AVAILABILITY_WINDOW` | KST 일요일 12:00–23:59 안내, 클라이언트 시각으로 우회 금지 |
| 가능일 동시 변경 | `STALE_VERSION` | 현재 가능일·요청 목록을 다시 조회하고 expectedVersion 갱신 |
| 처리 중 변경 요청 존재 | `PENDING_CHANGE_REQUEST_EXISTS` | 기존 pending 요청을 표시하고 중복 요청 금지 |
| 예약·객실 동시 변경 | `STALE_VERSION`, `ROOM_STATE_CHANGED` | 예약·객실을 다시 조회하고 서버 version으로 사용자 재확인 |
| 예약 일정 충돌 | `RESERVATION_OVERLAP` | 겹치는 예약을 표시하고 임의 자동 재시도 금지 |
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
| 객실 운영 목록 | `GET /v1/rooms` | active admin만 가능, 독립 상태 축 사용 |
| 객실 운영 상세 | `GET /v1/rooms/{roomId}` | 목록과 동일한 camelCase projection, PIN 원문 없음 |
| 객실 기준정보 변경 | `PATCH /v1/rooms/{roomId}/master-data` | room state `expectedVersion` CAS와 Idempotency-Key |
| 객실 운영 차단 | `POST /v1/rooms/{roomId}/operation-blocks` | 시작/종료 시각은 RFC 3339 offset, 생성 결과 ID는 서버 결정 |
| 객실 운영 차단 해제 | `POST /v1/rooms/{roomId}/operation-blocks/{blockId}/release` | 삭제가 아닌 release 이력 append |
| 촛불 수량 기록 | `POST /v1/rooms/{roomId}/candles` | count 0 이상, physicallyVerified 기본 false |
| 객실 이슈 등록 | `POST /v1/rooms/{roomId}/issues` | description 연락처 입력 금지, raw 문구를 오류 로그에 남기지 않음 |
| 객실 이슈 해결 | `POST /v1/rooms/{roomId}/issues/{issueId}/resolve` | hard delete 없이 해결 이력 기록 |
| PIN 동기화 상태 | `POST /v1/rooms/{roomId}/pin-sync-events` | 상태·version만 전송, PIN/door code/credential 전송 금지 |
| 현재 가능일 | `GET /v1/availability?weekStart=...` | maid는 본인만, admin은 maidProfileId 선택 가능 |
| 가능일 제출 | `POST /v1/availability/submissions` | maid만, KST 일요일 제출창·CAS·Idempotency-Key |
| 마감 후 변경 요청 | `POST /v1/availability/change-requests` | maid만, pending 1건·이력 보존 |
| 변경 요청 목록 | `GET /v1/availability/change-requests` | maid 본인만, admin은 status/weekStart/maid 필터 |
| 변경 요청 결정 | `POST /v1/availability/change-requests/{requestId}/decision` | active admin만, 승인 시 새 version 생성 |
| 배정 가능 후보 | `GET /v1/availability/candidates?workDate=...` | active admin만, 현재 가능일의 active maid |
| 예약 목록 | `GET /v1/reservations` | active admin만, 고객명과 암호문은 응답하지 않음 |
| 예약 상세 | `GET /v1/reservations/{reservationId}` | active admin만 고객명 복호화, 실제 민감조회 activity 기록 |
| 예약 생성 | `POST /v1/reservations` | 객실 version CAS, Idempotency-Key, 고객명 서버 암호화 |
| 예약 변경 | `PATCH /v1/reservations/{reservationId}` | 예약 expectedVersion과 최신 예약 전체 입력 필요 |
| 예약 취소 | `POST /v1/reservations/{reservationId}/cancel` | reasonCode와 expectedVersion 필요, hard delete 없음 |
| 수동 체크아웃 | `POST /v1/reservations/{reservationId}/manual-checkout` | 실제 입실 중인 예약만, 청소 obligation과 함께 원자 처리 |
| 청소 요청 | `POST /v1/reservations/cleaning-requests` | 연박/추가 요청, 객실 version CAS |
| 청소 요청 취소 | `POST /v1/reservations/cleaning-requests/{targetId}/cancel` | target version CAS soft cancel |
| 예약 전이 수동 실행 | `POST /v1/reservations/transitions/process` | admin 운영 명령. scheduler secret endpoint와 별도 |

객실은 `occupied`, `cleaningRequired`, `allocationBlocked`, `allocationReady`를 하나의 status로 합치지 않는다. `allocationReady=false`이면 `reasonCodes` 전체를 보존하고, UI 대표 색상·문구는 별도 mapper에서 결정한다.

객실 mutation은 최신 상세/목록의 `stateVersion`을 `expectedVersion` 또는 `expectedRoomVersion`으로 그대로 보낸다. `STALE_VERSION`이면 현재 객실을 다시 읽어 사용자 확인을 받고, 키를 바꿔 자동 덮어쓰지 않는다. 동일 payload의 통신 재시도에만 같은 Idempotency-Key를 사용한다. PIN 관련 화면은 `pinSyncStatus`와 `pinVersion`만 취급하며 `pin`, `rawPin`, `pinCode`, `doorCode`, `credential`, `providerSecret` 필드를 만들거나 analytics·오류 수집에 보내지 않는다.

가능일의 `weekStart`와 날짜는 `YYYY-MM-DD`로 보내며 client timezone으로 날짜를 다시 변환하지 않는다. `version`은 화면 로컬 카운터가 아니라 서버 응답값을 그대로 다음 `expectedVersion`에 사용한다. 제출 가능 시간과 마감 전/후 구분은 서버의 KST 판정을 따르고, 409를 받은 요청을 다른 Idempotency-Key로 자동 반복하지 않는다.

예약 목록에는 `guestName`이 없으며 UI가 이름을 표시해야 할 때만 단건 상세를 호출한다. 예약 응답의 `version`은 예약 변경 command의 `expectedVersion`으로 사용하고, command 응답에 `roomStateVersion`이 있으면 후속 객실 기준 command의 CAS 입력으로 사용한다. 고객명은 브라우저 저장소·analytics·오류 수집에 보존하지 않고, 상세 화면을 벗어나면 메모리 상태에서도 제거한다. 암호화 설정 장애에서 평문 저장이나 빈 이름으로 성공 처리하지 않는다.

예약 전이 수동 실행의 `Idempotency-Key`에는 `reservation-scheduler-` 접두사를 사용하지 않는다. 이 namespace는 scheduler invocation 전용이며 수동 API는 `RESERVED_IDEMPOTENCY_KEY`로 fail-closed한다. 고객명은 원문과 NFKC·trim·공백 축약 결과가 모두 1~80자여야 하므로, 화면에서도 원문 80자 제한을 먼저 적용하되 서버 오류 코드를 최종 판정으로 사용한다.

developer 운영 화면은 `environment`와 `projectRef`를 항상 텍스트로 함께 표시한다. `migrationDrift=behind`, `rlsValid=false`, `scheduler.status=actor_invalid|degraded`는 정상 성공 payload 안의 운영 경고 상태이므로 HTTP 200과 별개로 사용자에게 차단 수준을 표시한다. `not_configured`는 business admin·Cron 활성화 전의 정상 상태이며 자동으로 scheduler 실행을 시도하지 않는다.

## 7. 민감정보 처리

- access/refresh token, 비밀번호, 전체 휴대전화, 임시 비밀번호를 console·analytics·Sentry breadcrumb·Issue에 남기지 않는다.
- `temporaryPassword`는 생성 직후 권한 있는 사용자에게 전달하는 UI에서만 잠시 표시하고 영속 브라우저 저장소에 보관하지 않는다.
- service-role/secret key와 내부 Auth 이메일은 프론트 환경변수에 두지 않는다.
- 브라우저에는 Supabase publishable key만 허용한다.
- API error object 전체를 무조건 외부 오류 수집기로 전송하지 않는다. allowlist field와 `requestId`만 보낸다.

## 8. 프론트 Codex에 전달할 작업 문구

아래 내용을 프론트 작업 요청에 함께 제공하면 된다.

```text
백엔드 HTTP 계약은 제공된 OpenAPI 3.1 JSON을 정본으로 사용한다.
먼저 openapi-typescript로 타입을 생성하고 생성 파일은 직접 수정하지 않는다.
endpoint, request/response field, enum, 권한을 와이어프레임 fixture로 추측하지 않는다.
보호 API에는 Bearer access token을 사용하고 mustChangePassword=true이면 비밀번호 변경 외 화면을 차단한다.
mutation마다 Idempotency-Key를 만들고 같은 payload 재시도에만 같은 키를 재사용한다.
오류 분기는 한국어 message가 아니라 HTTP status와 error.code를 사용한다.
token, 비밀번호, 전체 휴대전화, temporaryPassword를 로그·fixture·테스트 캡처에 넣지 않는다.
구현 후 생성 타입 기준 typecheck와 역할별 401/403/409/429 UI 처리를 검증한다.
```

## 9. 현재 범위 제한

현재 source Swagger 범위는 인증·계정·developer 운영 projection·객실 목록/상세/운영 mutation·주간 가능일·예약/청소요청이다. #51~#53 source operation은 존재하지만 production Edge와 GitHub Pages snapshot에서 release → main 승격, Edge 재배포, hosted 역할·CAS·PII/PIN redaction smoke가 끝날 때까지 프론트 기능을 활성화하지 않는다. Python 운영도구의 generated client는 운영 관리 surface만 유지하며 업무 예약·객실 operation을 자동 포함하지 않는다.
