# developer 운영 API 연동 가이드

Issue #43의 Edge API를 Python 운영 콘솔과 Swagger에서 일관되게 사용하는 기준이다. HTTP 요청·응답의 기계 판독 정본은 배포 환경의 `/functions/v1/api/openapi.json`이며, 이 문서는 운영 판단과 보안 경계를 설명한다.

## 접근 순서

1. `POST /v1/auth/login`에 고정 developer 로그인 ID와 사용자가 직접 입력한 비밀번호를 보낸다.
2. `GET /v1/auth/me`에서 최신 `role=developer`, active profile, active session을 확인한다.
3. 이후 developer endpoint에 bearer access token을 사용한다.
4. 응답은 메모리에서만 처리하고 token·비밀번호·전체 응답 dump를 파일·traceback·clipboard history에 남기지 않는다.

business admin과 maid는 developer endpoint에서 항상 `403 DEVELOPER_REQUIRED`다. developer도 객실 업무 API에서는 business admin으로 취급되지 않는다.

## endpoint와 화면 카드

| Endpoint | 운영 콘솔 표시 | 중요 규칙 |
|---|---|---|
| `GET /v1/developer/overview` | 첫 dashboard | 계정·객실 집계와 runtime/DB/scheduler 상태를 한 번에 표시 |
| `GET /v1/developer/runtime-status` | 연결 환경 | `environment` + `projectRef`를 색상과 무관하게 항상 텍스트 표시 |
| `GET /v1/developer/database-status` | DB 상태 | migration drift, RLS 누락, 핵심 RPC 누락을 별도 경고로 표시 |
| `GET /v1/developer/scheduler-status` | scheduler 상태 | `not_configured`는 활성화 전 정상 상태, 임의 실행 버튼을 만들지 않음 |
| `GET /v1/developer/audit-events` | 감사 목록 | cursor pagination, 최대 31일·100건, raw state 없음 |
| `GET /v1/developer/activity-events` | 활동/보안 로그 | 인증·권한거부·실제 민감조회, unknown login은 anonymous aggregate |
| `POST /v1/developer/diagnostics` | 수동 진단 | body 없음, 자동 반복 금지, `Retry-After` 준수 |

모든 응답은 `Cache-Control: no-store`다. 운영 콘솔은 dashboard 응답을 로컬 DB나 일반 설정 파일에 캐시하지 않는다.

## 상태 판정

### DB

- `migrationDrift=equal`이고 `rlsValid=true`이며 모든 `criticalRpcs`가 true일 때 정상이다.
- migration identity는 적용 시점마다 달라질 수 있는 14자리 원격 version이 아니라 Git migration의 안정적인 `name`을 사용한다. `currentMigrationVersion`은 진단 정보일 뿐 source 동일성 판단에 사용하지 않는다.
- `criticalRpcs`는 같은 이름의 함수 존재 여부가 아니다. 정본 exact signature가 존재하고 `service_role`만 실행할 수 있으며 `anon`·`authenticated`는 실행할 수 없어야 true다.
- `behind`는 운영 DB에 source migration이 아직 적용되지 않은 상태다. 운영 콘솔에서 migration을 직접 실행하지 않고 정식 release runbook으로 이동한다.
- `ahead`는 DB가 현재 client source보다 앞선 상태다. client 업데이트 전 변경 동작을 차단한다.
- `unknown`은 자동 정상 처리하지 않고 연결 환경과 migration history를 별도로 확인한다.

### scheduler

- `not_configured`: Cron 미생성·비활성. 현재 operational activation 전에는 정상이다.
- `actor_invalid`: actor가 없거나 active business admin이 아니다.
- `awaiting_first_run`: Cron/actor는 준비됐지만 app-owned heartbeat가 없다.
- `degraded`: 최근 heartbeat 실패 또는 5분 이상 지연.
- `healthy`: active Cron, exact-admin actor, 최근 성공 heartbeat를 모두 확인했다.

Cron SQL, Vault 값, Authorization header, `pg_net` 응답 본문은 API에 존재하지 않으므로 client가 별도 내부 schema 조회로 보완하지 않는다.

## 감사 pagination

`eventType`은 OpenAPI enum 값을 반복 query로 전달한다. `nextCursor`는 opaque 값이며 decode·수정하지 않고 다음 요청의 `cursor`로 그대로 보낸다. `from`과 `to`의 간격은 최대 31일이다.

```text
GET /v1/developer/audit-events?eventType=account.created&limit=50
GET /v1/developer/audit-events?cursor={nextCursor}&limit=50
```

응답 `summary`는 event별 허용 필드만 가진다. raw `before_state`/`after_state`, 전화번호, 고객명, PIN, token, secret이 필요하다고 가정하지 않는다.

### Domain audit event inventory

Issue #58에서 현재 성공 mutation의 append 지점을 전수 확인했다. developer projection이 승인하는 정본은 다음과 같다.

| 영역 | Event type |
|---|---|
| account | `account.bootstrap_developer_created`, `account.bootstrap_admin_created`, `account.created`, `account.role_changed`, `account.status_changed`, `account.unlocked`, `account.password_reset_requested`, `account.password_changed` |
| availability | `availability.submitted`, `availability.change_requested`, `availability.change_decided` |
| assignment | `assignment.draft_saved`, `assignment.notified`, `assignment.prestart_changed`, `assignment.prestart_unassigned`, `assignment.cancellation_requested`, `assignment.cancellation_decided` |
| reservation | `reservation.created`, `reservation.changed`, `reservation.cancelled`, `reservation.manual_checkout`, `reservation.scheduled_check_in`, `reservation.scheduled_checkout`, `reservation.guest_name_retention_purged` |
| cleaning request | `cleaning.manual_request.created`, `cleaning.manual_request.cancelled` |
| room | `room.master_data_changed`, `room.create_block`, `room.release_block`, `room.set_candle_count`, `room.report_issue`, `room.resolve_issue`, `room.record_pin_sync` |

scheduler가 성공시킨 예약 전이는 별도 중복 event가 아니라 `reservation.scheduled_check_in`/`reservation.scheduled_checkout`으로 같은 domain 원장에 기록된다. scheduler 실행 상태 자체는 `private.scheduler_invocation_heartbeats`의 bounded 운영 projection이다. 현재 구현된 성공 mutation 중 audit append 누락은 발견되지 않았다. 후속 #52/#53은 이 event 이름과 공통 activity helper를 재사용하며 자유문 event/source를 추가하지 않는다.

#27 source의 audit allowlist는 총 33개입니다. pre-start summary는 `cleaningTargetId/assignmentId/previousAssignmentId/maidProfileId/previousMaidProfileId/serviceDate/sequenceNumber/revision/targetAssignmentVersion/requestId/decision/reasonCode`만 허용합니다. `reasonDetail`, `requestHash`, raw before/after state, notification body는 반환하지 않습니다. Python filtered OpenAPI/generated model도 같은 enum/summary로 재생성합니다. developer 콘솔에 업무 재배정 권한을 추가한 것은 아닙니다. 배포 전까지 production allowlist가 source와 같다고 가정하지 않습니다.

## 활동/보안 pagination

업무 상태 변경 감사와 로그인·권한·민감접근 activity를 한 목록으로 합치지 않는다. activity API는 `actorProfileId`, `role`, 반복 가능한 `category`/`eventType`/`outcome`, `from`/`to`, opaque `cursor`를 지원한다. 기간은 최대 31일, page size는 최대 100이다.

```text
GET /v1/developer/activity-events?category=authorization&outcome=denied&limit=50
GET /v1/developer/activity-events?cursor={nextCursor}&limit=50
```

알 수 없는 로그인 실패는 `actorProfileId`, `requestId`가 없는 분 단위 aggregate로만 보인다. 권한 거부도 `(actorProfileId, source, reasonCode, UTC minute)`별 aggregate이며 두 집계 모두 `summary.aggregateCount`가 600에서 포화된다. actor/source/reason이 다르면 별도 행으로 격리된다. 개별 activity event의 `requestId`는 Edge가 생성한 UUID v4이고 caller의 `X-Request-ID`는 영구 원장에 저장하지 않는다. 로그인 ID, IP, HMAC, request body를 복원할 수 있는 값은 존재하지 않는다. `sensitive.read`는 예약 목록처럼 일반 조회가 아니라 고객명 복호화 결과처럼 민감값이 실제 반환된 뒤에만 기록한다.

## Python #44 연결 기준

- API base URL과 publishable key는 환경별 일반 설정으로 분리한다.
- developer password와 access/refresh token은 기본적으로 프로세스 메모리에만 둔다.
- `httpx` client는 오류 본문 전체를 logging하지 않고 HTTP status, `error.code`, `requestId`만 구조화 기록한다.
- OpenAPI generator와 생성 artifact 버전은 #44 lockfile에 고정한다.
- business admin 생성은 `POST /v1/accounts`를 사용하며 service-role key나 DB credential을 사용하지 않는다.
- Phase A에서는 direct DB 연결 기능을 포함하지 않는다.

## 운영 대응

| Code/상태 | 대응 |
|---|---|
| `DEVELOPER_REQUIRED` | 세션을 폐기하고 developer 계정인지 확인 |
| `DEVELOPER_PROJECTION_FAILED` | 자동 변경 금지, `requestId`로 Edge/DB 로그 확인 |
| `DIAGNOSTICS_RATE_LIMITED` | `Retry-After` 뒤 사용자가 다시 실행 |
| `migrationDrift=behind|ahead|unknown` | 변경 기능 차단, release/migration history 확인 |
| `rlsValid=false` | 업무 API 사용 중단 후 append-only security migration 준비 |
| `scheduler.status=actor_invalid|degraded` | Cron 자동 재구성 금지, actor·secret·heartbeat 순서로 점검 |

운영 API는 상태 확인용이다. migration 적용, Cron 수정, secret 조회·변경, 임의 SQL/RPC 실행 기능은 제공하지 않는다.
