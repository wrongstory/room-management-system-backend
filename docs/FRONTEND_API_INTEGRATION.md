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

production Edge는 현재 auth/accounts/객실 목록 중심의 부분 HTTP surface다. #43 developer operation path와 #51~#53의 가능일·예약·객실 상세/mutation은 각 source가 release를 거쳐 production에 배포된 OpenAPI에 실제로 나타난 뒤에만 프론트 기능을 활성화한다.

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

`user.mustChangePassword=true`이면 비밀번호 변경 화면 외 일반 계정·객실 화면을 막는다. `POST /v1/auth/password` 성공은 `204 No Content`이므로 JSON 파싱을 시도하지 말고 `/v1/auth/me`를 다시 조회한다.

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

- 인증·계정·객실 응답은 `Cache-Control: no-store`다.
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

## 5. 역할별 화면 경계

| 역할 | `/auth/me` | 계정 목록·변경 | developer 운영 상태 | 전체 객실 목록 |
|---|---:|---:|---:|---:|
| `developer` | 허용 | 허용 | 허용 | 금지 |
| `admin` | 허용 | 허용 | 금지 | 허용 |
| `maid` | 허용 | 금지 | 금지 | 금지 |

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
| 운영 감사 | `GET /v1/developer/audit-events` | 최대 31일·100건 cursor pagination, raw state 없음 |
| 운영 진단 | `POST /v1/developer/diagnostics` | body 없음, 임의 URL/SQL/RPC 입력 없음, 10회/분 |
| 객실 운영 목록 | `GET /v1/rooms` | active admin만 가능, 독립 상태 축 사용 |

객실은 `occupied`, `cleaningRequired`, `allocationBlocked`, `allocationReady`를 하나의 status로 합치지 않는다. `allocationReady=false`이면 `reasonCodes` 전체를 보존하고, UI 대표 색상·문구는 별도 mapper에서 결정한다.

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

현재 source Swagger 범위는 인증·계정·developer 운영 projection·전체 객실 목록이다. 예약·가능일 Fastify API가 저장소에 존재하더라도 Edge OpenAPI에 없는 route는 Supabase-only production endpoint로 가정하지 않는다. 각 환경에서 내려받은 OpenAPI에 없는 #43 path를 production에 이미 배포됐다고 가정하지 않으며, feature → dev → release → main 승격과 Edge 재배포 뒤에만 활성화한다.
