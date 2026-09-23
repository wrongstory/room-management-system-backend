# 객실 PIN Phase A/B/C 및 초기화 운영 인계

## 범위와 배포 상태

이 문서는 Issue #131 Phase A, Issue #136 Phase B, Issue #137 Phase C, Issue #140 초기화와 Issue #169 자동 생성·현장 확인 계약을 설명한다. 마지막으로 검증된 production은 전체 78 migrations / OpenAPI 0.5.1 128 paths / 138 operations이며 `api` ACTIVE v24다. 현재 Git main의 후속 #256 사진 hotfix는 PIN 계약을 바꾸지 않는다. PIN API의 실제 사용자 문제는 해결돼 Issue #140을 완료 처리했다. `room-pin-sheet-sync` source/bundle은 존재하지만 production target mapping·Google ACL/Secrets/Cron/hosted full-resync 검증은 별도 pending이다.

Phase A에는 encrypted PIN revision/current pointer, 물리 변경 조정, 안전한 reveal, public sync event와 sheet outbox 기반이 포함된다. Phase B는 dedicated service account의 Sheets API projection worker, global singleton claim/lease/fence, current-version coalescing, bounded retry와 operator-blocked 관측을 추가한다. Phase C는 안전한 developer/admin status와 DB-authoritative 121실 full resync command를 추가한다. production target mapping·Google hosted ACL/Cron/activation은 release gate로 남긴다. Issue #194의 64번째 append-only migration은 통보 기반 durable assignment entitlement와 최대 30초 reveal lease를 분리하며 production DB/API에 반영됐다. 실제 hosted PIN mutation은 아직 별도다.

## 초기 PIN bootstrap과 예약 계약

- 초기 DB에서 `pinSyncStatus=unconfigured`여도 예약 생성·변경·배정은 가능하다. `allocationReady`와 `reasonCodes`는 예약 업무의 점유·청소·촛불·운영 차단·입실 차단 이슈·기준정보 확인만 나타낸다.
- 실제 체크인 전이와 PIN reveal/change는 current PIN이 `verified`가 될 때까지 계속 fail-closed한다. `mismatch`도 예약 경고로는 표시하지만 실제 입실과 PIN 접근을 막는다.
- active admin은 `POST /v1/rooms/pins/bootstrap`에 선택적 `limit`(기본 20, 최대 25)만 보낸다. 런타임 CSPRNG가 batch 안에서 중복되지 않는 정확히 4자리 PIN을 생성하며 선행 0을 보존한다. 고정 초기 PIN secret이나 클라이언트 PIN 입력은 없다.
- command는 current PIN이나 unresolved mismatch가 없는 객실만 version 1 `mismatch`로 초기화한다. 기존 current/mismatch를 자동 덮어쓰지 않으며 동일 `Idempotency-Key`와 payload는 최초 완료 receipt를 재생한다. `remainingCount`가 0이 될 때까지 새 key로 반복할 수 있다.
- 성공 응답의 `generatedPins`는 admin 전용 30초 reveal lease에서만 복호화하며 `Cache-Control: no-store`를 사용한다. credential을 화면 메모리 밖에 저장하지 않고 `clearAfterSeconds`/`expiresAt` 중 빠른 시점에 지운다. 일반 reveal과 maid 접근은 현장 확인 전까지 거부된다.
- 관리자가 실제 도어락에 적용한 뒤 `POST /v1/rooms/{roomId}/pin/generated/confirm`에 `expectedPinVersion`과 새 `Idempotency-Key`를 보내야 verified sync와 Sheet outbox가 생긴다. 확인 전에는 실제 체크인이 fail-closed다.
- 성공 응답의 `initialized`는 이 batch에서 revision/current/mismatch sync/audit가 함께 확정된 객실이고, `skipped`는 기존 current 또는 unresolved 물리 변경을 보존해 의도적으로 건너뛴 객실이다. 검증 오류를 skipped로 바꾸지 않으며 DB validation 오류는 batch 전체를 rollback한다. HTTP timeout·응답 유실은 rollback을 뜻하지 않으므로 같은 key로 receipt를 재생하고 generated-pending credential을 새 30초 lease로 다시 확인한다.

## Phase B Google Sheets projection

- Sheet는 DB 정본을 보여주는 단방향 projection이다. `room_number`가 business identity이며 worker는 bounded `A2:H122` board 전체에서 정확히 한 행을 찾아 실제 행 위치를 갱신한다. 중복 room number 또는 deterministic 빈 slot에 다른 객실이 있으면 덮어쓰지 않고 operator-blocked다.
- 컬럼은 `room_number,current_pin,pin_version,sync_status,effective_at,last_synced_at,reason_code,environment`로 고정한다. 현재 event의 `sync_status`를 그대로 쓰며 PIN 이외의 자유형 값은 쓰지 않는다. `effective_at`은 PIN revision 생성 시각이 아니라 현재 projection outbox 사건 시각이므로, 같은 version을 물리 원복한 경우에도 더 늦은 rollback 사건과 reason을 보존한다.
- Sheet version이 DB current보다 크면 사람/외부 변경으로 보고 block한다. version이 같고 PIN·marker가 모두 같을 때만 no-op이며, 같은 version의 PIN/marker 변조는 DB 정본으로 repair한다. 낮은 version은 최신 DB revision으로 갱신한다.
- 한 실행은 최대 10개 room identity, provider 시작 33초, DB settle 39초, heartbeat 포함 전체 45초 absolute deadline을 공유한다. 명시적 HTTP 429/5xx는 bounded backoff retry이고, write 시작 뒤 network timeout/abort는 결과 불확실이므로 global operator-blocked다.
- claim/authorize/settle은 global singleton lease와 증가 fence를 사용한다. 새 PIN version은 과거 pending outbox를 supersede하며 mid-write 변경은 stale settle 후 다음 current outbox로 수렴한다. 불확실 write와 retry 소진은 자동 성공 처리하지 않고 reconciliation 전까지 멈춘다.
- Google Sheet의 사람 소유자는 `yeosucastletheart@gmail.com`이다. worker는 이 사람 계정의 로그인 자격증명을 사용하지 않고 대상 Sheet에 최소 권한으로 공유된 별도 service account, fixed token endpoint, `https://www.googleapis.com/auth/spreadsheets` 단일 scope와 RS256 assertion만 쓴다. Sheet endpoint·private key·OAuth assertion/access token·PIN/envelope·provider raw error는 로그, heartbeat, developer projection, audit에 남기지 않는다.
- source-controlled approved target에는 현재 local/test synthetic mapping만 있다. 승인되지 않은 hosted environment/projectRef/spreadsheet/tab은 PIN 복호화와 OAuth token exchange 전에 fail-closed한다. production mapping은 release 승인 PR에서만 추가한다.
- local worker adapter 테스트는 `RUNTIME_ENVIRONMENT=local`, `SUPABASE_PROJECT_REF=local`, synthetic spreadsheet ID, exact `객실_PIN_현황` tab을 함께 써야 한다. 공용 `.env.example`의 빈 project ref를 그대로 두고 worker를 실행할 수 없으며, 다른 local API의 target 계약을 바꾸려고 전역 예시를 임의 수정하지 않는다.
- developer database status는 secret configured boolean, target approved boolean, safe status/count/time/stable error만 제공한다. raw outbox ID, room ID, PIN, Sheet cell/payload, provider credential은 제공하지 않는다.

## Phase C status와 full resync

- `GET /v1/room-pin-sheet-sync/status`는 active developer/admin, 변경 완료 비밀번호와 live session을 요구한다. 응답은 `pending`, `failed`, `operatorBlocked`, `oldestPendingAt`, `lastSuccessAt`, `lastErrorCode`, `version`, `checkedAt`만 포함한다. local credential 또는 approved target이 현재 invalid이면 과거 성공 heartbeat가 있어도 healthy로 해석하지 않는다.
- `POST /v1/room-pin-sheet-sync/full-resync`는 strict `{expectedVersion}` body, `Idempotency-Key`, status에서 읽은 `version` CAS를 요구한다. 서버만 room/PIN snapshot, target identity와 request hash를 만든다. 같은 actor/key/hash는 replay하고 retryable failed run을 포함한 logical active run이 있으면 다른 key는 충돌한다.
- snapshot은 요청 transaction에서 정확한 121실을 `room_number,id` 순으로 row 2..122에 고정한다. worker는 PIN current revision reference만 claim 시 복호화하고 `A1:H122`를 한 번에 DB 값으로 재작성한다. Sheet의 삭제·정렬·변조 값은 입력으로 채택하지 않으며 Sheet→DB 경로는 없다.
- environment/project/spreadsheet/tab의 canonical SHA-256 marker를 run에 immutable하게 저장한다. claim 시 source mapping의 marker와 다르면 credential 검증, OAuth와 Sheets 호출 전에 operator-blocked한다. raw spreadsheet/tab, request hash, PIN, envelope, assertion/token, Google response는 공개 상태·감사에 없다.
- incremental worker와 full writer는 같은 singleton lease/fence를 사용한다. authorize 직전에 121실 room identity/number/current pin version을 다시 확인해 stale snapshot에는 provider permit을 주지 않는다. full write 성공 뒤에는 snapshot room에 속하고 `created_at <= provider_write_started_at`인 pending/processing/failed outbox만 supersede한다. 따라서 fence가 이미 지워진 `DB_SETTLE_UNCERTAIN` 과거 작업도 수렴하지만 authorize 이후 생긴 새 PIN outbox는 보존된다.
- full write 성공 뒤 DB settle 실패는 `DB_SETTLE_UNCERTAIN`으로 operator-blocked하고 같은 run을 자동 재-write하지 않는다. lease expiry reconciliation은 provider marker를 근거로 uncertain 상태에 수렴한다. 명시적 operator full resync만 새 snapshot과 새 fence로 복구한다.
- 일반 run은 immutable self-FK recovery root를 만들고, recovery는 exact singleton fence로 잠근 직전 blocked run의 기존 root만 상속한다. root는 claim/permit CAS를 대체하지 않는다. target mismatch, retry 8회 소진, provider block, `DB_SETTLE_UNCERTAIN`, marker lease expiry, recovery `SNAPSHOT_STALE`도 root를 보존한다.
- 성공 settle은 같은 root이면서 recovery 요청보다 과거인 `operator_blocked` run만 한 번에 최대 32건 supersede한다. 32건을 초과하거나 부분 정리가 감지되면 성공 audit/healthy를 만들지 않고 현재 marker를 보존한 `DB_SETTLE_UNCERTAIN` block으로 전환한다. 같은 run은 재claim하지 않으며 다음 명시 recovery가 남은 bounded prefix를 처리한다.
- developer audit은 `room_pin_sheet.full_resync_requested/succeeded`를 허용하되 summary는 `status`, `roomCount`, 요청 시 `reconciliation`만 포함한다.

### Production 활성화 체크리스트

과거 56→73 적용과 PIN API 배포는 완료됐고 현재 production은 78 migrations / OpenAPI 0.5.1 128 paths / 138 operations다. 아래는 아직 남은 Google Sheets hosted 활성화 기준이다.

1. production DB backup, 78개 migration history와 기존 PIN 원장 evidence를 read-only로 확인한다. 이미 적용된 파일은 수정·삭제·재적용하지 않는다.
2. nonce registry/trigger/FORCE RLS와 `bootstrap_room_pins`, generated reveal begin/finalize, `confirm_generated_room_pin`의 최소 EXECUTE·actor/session/admin 재검증을 확인한다.
3. 별도 승인된 안전 대상에서 생성→mismatch/no Sheet→admin no-store reveal→물리 도어락 적용→version CAS confirm→verified/outbox 흐름을 smoke한다. 일반 reveal과 maid 접근, 확인 전 체크인, 다른 version 확인이 모두 거부되는지 확인한다.
4. 사람 소유자 `yeosucastletheart@gmail.com`이 만든 승인 Sheet에 별도 최소 권한 service account만 공유하고 source-controlled target identity와 ACL을 대조한다.
5. secrets 주입 뒤 negative smoke, bounded incremental sync와 full resync를 확인한 후에만 Cron/Vault를 활성화한다.
6. PIN 원문·service-account key·OAuth token은 로그·Issue·PR·브라우저 저장소에 기록하지 않는다.

적용 중 lock wait/timeout, validation conflict 또는 transaction 중간 실패는 hosted 적용 실패로 취급한다. 기존 lease/revision/current pointer/sync event/Sheet outbox/audit/completed receipt를 삭제·보정하지 말고 원 evidence를 보존한 채 조사한다. source/main·production schema 반영과 Google target·bootstrap 활성화 승인은 별개다.

서비스 계정 key 회전은 새 key 배치→local 구조 검증→OAuth/Sheets smoke→이전 key 폐기 순서다. PC/credential 유출 또는 ACL 오배치 시 Cron과 Function 호출을 중단하고 key를 즉시 폐기하며, target ACL을 회수하고 status/operator-blocked evidence와 audit을 보존한 채 승인된 새 credential로만 복구한다.

## Secret과 암호화

- `ROOM_PIN_KEY_BASE64`는 canonical Base64 32-byte AES-256 key이고 `ROOM_PIN_KEY_VERSION`은 1~32자의 source-controlled version이다.
- `ROOM_PIN_KEYRING_JSON`은 최대 5개의 prior version→canonical Base64 32-byte key를 가진다. current version을 중복 선언하거나 같은 key를 재사용할 수 없다.
- reservation PII, Web Push current/prior key와 PIN current/prior key를 재사용하지 않는다. Node 환경 계약은 cursor/pepper 등 다른 목적 secret과의 재사용도 거부한다.
- 새 encryption마다 12-byte random nonce를 사용한다. private nonce reservation의 `(key_version, nonce)` unique를 regular prepare와 bootstrap이 공유해 객실/AAD가 달라도 다른 생성 envelope의 재사용을 차단한다. confirm이 같은 lease envelope를 immutable revision으로 승격하는 것은 새 encryption이 아니므로 같은 reservation을 사용한다. keyring parser는 같은 실제 AES key를 여러 version에 등록하는 것도 거부한다.
- 52→53 upgrade는 prepared/confirmed/expired/rolled-back lease와 revision 이력을 수정하지 않는다. confirmed lease와 byte-for-byte matching revision은 하나의 논리 암호화로 backfill하고, 동일 key version/nonce에 다른 ciphertext·tag·AAD·room/version evidence가 있으면 원 이력을 보존한 채 migration 전체를 `ROOM_PIN_HISTORICAL_NONCE_REUSE`로 중단한다.
- AAD는 source-controlled format/environment/projectRef/roomId/pinVersion으로 만든다. immutable lease/revision에는 bounded nonsecret environment/projectRef만 저장하며 full AAD bytes나 key는 저장하지 않는다. 복구 환경은 현재 runtime 값이 아니라 저장된 exact context로 복호화한다.

키 회전은 새 current key/version을 배치하고 기존 current를 prior keyring에 둔 상태에서 시작한다. 모든 live revision을 새 PIN revision으로 재발급하기 전 prior key를 제거하면 해당 revision은 fail-closed한다. key나 실제 envelope/PIN 값을 로그, Issue, PR, audit, notification에 붙이지 않는다.

## 물리 변경 절차

1. 권한 있는 사용자가 `POST /v1/rooms/{roomId}/pin-changes/prepare`를 호출한다. 클라이언트는 선행 0을 보존한 `pinDigits`만 보낸다. 서버가 global lifecycle lock과 room lock 아래 current room number snapshot을 확인하고 `<room_number>-<pin_digits>`를 암호화한다.
   - current PIN version이 0인 최초 등록에서 admin 화면이 일반 수정 사유 `ADMIN_PHYSICAL_CHANGE`를 보내도 Fastify/Edge가 DB context를 확인한 뒤 `ADMIN_INITIAL_PIN`으로 정규화한다. request hash와 RPC/audit 사유도 정규화된 값만 사용한다. 명시적 `ADMIN_INITIAL_PIN`은 그대로 유지하고 version 1 이상의 일반 물리 변경, maid 변경, `ACTUAL_PIN_REENTRY`는 정규화하지 않는다.
2. prepare 성공 즉시 객실은 mismatch다. current pointer는 그대로이고 실제 체크인과 모든 reveal은 차단되지만 예약 생성·변경·배정은 차단하지 않는다.
3. 운영자가 실제 도어락 PIN을 변경한다.
4. 실제 변경이 확실할 때만 confirm한다. confirm이 immutable revision/current pointer, exact verified sync event, safe sheet outbox, audit/receipt를 한 transaction에서 기록한다.
5. 물리 결과가 불확실하거나 lease가 만료되면 mismatch를 유지한다. 실제 PIN을 다시 입력해 새 revision을 confirm하거나, 기존 current PIN으로 실제 도어락을 원복한 뒤 source-controlled rollback을 확인해야 한다. 자유형 사유나 추측으로 해소하지 않는다.

최초 version 0 prepare가 만료돼도 영구 정지하지 않는다. unresolved expired lease가 실제 존재할 때만 `ACTUAL_PIN_REENTRY`를 준비·confirm해 version 1을 수립할 수 있다. 평상시에는 이 reason을 사용할 수 없다. Phase A에는 room number 변경 HTTP command가 없다. current PIN 또는 unresolved lease가 있는 객실의 내부 room number 변경도 `ROOM_PIN_REISSUE_REQUIRED`로 거부되며, 재발급 후 rename 같은 존재하지 않는 workflow를 운영 절차로 가정하지 않는다.

## Maid 권한과 reveal

최신 제품 계약에서 PIN 접근 자격은 assignment 통보와 outbox가 확정되는 시점부터 시작하며 `availableFrom` 전에도 본인에게 알림된 담당이면 유효하다. 현장 완료·업로드 대기·제출·검수 대기 동안 유지하고 최종 승인·반려, 취소 승인, 재배정, 비활성화 workflow의 권한 정리 때 종료한다. 이 durable entitlement는 exact assignment/room/maid/PIN revision에 귀속하고 30초 reveal lease와 분리한다.

64번째 source 계약의 private entitlement는 exact current/notified assignment, maid, room, assignment revision, current PIN revision과 **그 grant를 발생시킨 exact typed delivery outbox ID**를 함께 고정한다. 물리 불일치 중에도 이 원장은 알림과 함께 생성하되 실제 reveal은 불일치가 해소될 때까지 차단한다. 최초 알림 grant는 active/password-complete maid만 허용한다. `deactivation_pending`/`upload_only`에서는 기존 원장 row를 final cleanup 전까지 보존할 수 있지만 actual reveal은 active-session gate로 막고 신규/rotation successor grant를 만들지 않는다. inactive/departed 최종 정리는 entitlement와 열린 reveal을 함께 종료한다. change prepare/confirm의 exact `in_progress` + authoritative access lease 제한은 별도 물리 변경 정책으로 유지한다.

PIN version이 오르면 열린 30초 reveal과 이전 revision entitlement를 원자 폐기한다. successor entitlement는 현재 수행 workflow와 이미 통보된 **객실별 최소 미래 service date(다음 근무일)** 담당에게만 발급하며, 더 먼 미래 배정·비활성화 진행/종료 계정은 제외한다. 기존 public access lease 재발급은 물리 PIN 변경 command의 provenance로만 보존되며 reveal 권한 자체는 아니다.

Reveal은 durable entitlement에서 파생되는 30초 이하 private 단기 lease다. 서버는 복호화 후 DB에서 live session/profile/password gate, current revision/mismatch, exact assignment ownership/revision과 entitlement 종료 여부를 다시 확인하고 safe `sensitive.read` event를 원자 기록한다. 그 append가 실패하거나 TTL이 0이면 plaintext를 반환하지 않는다. legacy `attemptId/accessLeaseId` 요청 필드는 호환 입력일 뿐 reveal authority가 아니다.

응답은 항상 `Cache-Control: no-store`다. 클라이언트는 `clearAfterSeconds`와 `expiresAt` 중 더 이른 시점 또는 navigation, background, pagehide, device lock, assignment removal, relock 즉시 credential을 메모리에서 지운다. clipboard, cache, service worker, offline queue, analytics, persistent storage에 저장하지 않는다.

## 장애 확인

- `ROOM_PIN_MISMATCH_UNRESOLVED`: 실제 체크인과 reveal을 계속 차단하고 실제 물리 상태를 확인한다. 예약 배정은 별도 경고를 표시한 채 허용한다.
- `INVALID_PIN_CHANGE_REASON`: 현재 PIN version과 변경 사유 조합이 맞지 않는다. 최신 객실 PIN 상태를 다시 읽고 최초 등록, 일반 물리 변경, 실제 PIN 재입력 중 올바른 절차를 선택한다. 서버는 원문 DB 오류 대신 안정적인 409 코드만 반환한다.
- `GENERATED_PIN_REVEAL_NOT_ALLOWED`: 이미 현장 확인됐거나 generated-pending 상태가 아니므로 초기화 응답을 재사용하지 않고 최신 객실 PIN 상태를 조회한다.
- `GENERATED_PIN_CONFIRMATION_NOT_ALLOWED`: generated-pending/current version 조건이 바뀌었으므로 물리 상태를 임의 확정하지 않고 최신 상태를 확인한다.
- `PIN_CHANGE_IN_PROGRESS` / `PIN_CHANGE_LEASE_EXPIRED`: 새 변경으로 덮지 말고 기존 lease의 물리 결과를 resolve한다.
- `STALE_PIN_VERSION` / `ROOM_NUMBER_CHANGED`: 최신 객실/version을 다시 조회하고 새로운 idempotency key로 재시도한다.
- `PIN_ENTITLEMENT_REQUIRED` / `PIN_REVEAL_AUTHORIZATION_CHANGED`: 현재 notified assignment entitlement, session, assignment/PIN revision 또는 종료 상태가 바뀐 것이므로 plaintext를 폐기하고 최신 배정 상태를 다시 조회한다.
- `PIN_ACCESS_REQUIRED` / `PIN_ACCESS_LEASE_REQUIRED`: 물리 PIN 변경용 exact in-progress attempt/access lease가 없으므로 변경을 진행하지 않는다.
- `ROOM_PIN_KEY_UNAVAILABLE` / `ROOM_PIN_CRYPTO_CONFIG_INVALID`: keyring을 복구하기 전 reveal/change를 중단한다. 오류 응답이나 로그에 key/envelope/PIN을 남기지 않는다.

DB의 `room_pin_sync_events`와 private sheet outbox에는 room/version/status/source-controlled reason만 있어야 한다. audit developer projection은 `roomId`, `leaseId`, `pinVersion`, `status` 같은 승인 필드만 표시하며 raw state/request hash/envelope을 노출하지 않는다.

## Rollback

Source rollback은 애플리케이션과 해당 append-only migration을 함께 다루는 release 절차에서만 검토한다. 이미 encrypted revision/physical change가 존재하면 schema를 먼저 제거하지 않는다. 배포 중단 시에는 새 PIN endpoint 트래픽을 차단하고 mismatch 객실을 실제 re-entry/rollback 절차로 해소한 뒤 keyring과 DB backup을 보존한다. write 결과가 불확실하면 자동 재-write하지 않고 Phase C operator full resync로 새 121실 snapshot을 승인해 복구한다. full resync 자체의 provider 성공 뒤 settle이 불확실하면 그 run의 marker/evidence를 보존하고 또 쓰지 않는다.
