# 객실 PIN Phase A/B 운영 인계

## 범위와 배포 상태

이 문서는 Issue #131 Phase A와 Issue #136 Phase B source 계약을 설명한다. 통합 기준은 `dev@d9b6ce90fa8f924a4a62cea6566fc8e7754f054b`, 49 migrations / 102 paths / 109 operations이고 Phase B candidate는 50번째 append-only migration을 추가하되 공개 OpenAPI 수는 유지한다. feature → `dev` 검증만 수행하며 production/main/recovery migration, Edge, Cron, Vault, Google hosted 설정은 변경하지 않는다.

Phase A에는 encrypted PIN revision/current pointer, 물리 변경 조정, 안전한 reveal, public sync event와 sheet outbox 기반이 포함된다. Phase B는 dedicated service account의 Sheets API projection worker, global singleton claim/lease/fence, current-version coalescing, bounded retry와 operator-blocked 관측을 추가한다. full resync·운영 승인 target mapping·Google hosted ACL/Cron은 #137 및 release gate로 남긴다.

## Phase B Google Sheets projection

- Sheet는 DB 정본을 보여주는 단방향 projection이다. `room_number`가 business identity이며 worker는 bounded `A2:H122` board 전체에서 정확히 한 행을 찾아 실제 행 위치를 갱신한다. 중복 room number 또는 deterministic 빈 slot에 다른 객실이 있으면 덮어쓰지 않고 operator-blocked다.
- 컬럼은 `room_number,current_pin,pin_version,sync_status,effective_at,last_synced_at,reason_code,environment`로 고정한다. 현재 event의 `sync_status`를 그대로 쓰며 PIN 이외의 자유형 값은 쓰지 않는다. `effective_at`은 PIN revision 생성 시각이 아니라 현재 projection outbox 사건 시각이므로, 같은 version을 물리 원복한 경우에도 더 늦은 rollback 사건과 reason을 보존한다.
- Sheet version이 DB current보다 크면 사람/외부 변경으로 보고 block한다. version이 같고 PIN·marker가 모두 같을 때만 no-op이며, 같은 version의 PIN/marker 변조는 DB 정본으로 repair한다. 낮은 version은 최신 DB revision으로 갱신한다.
- 한 실행은 최대 10개 room identity, provider 시작 33초, DB settle 39초, heartbeat 포함 전체 45초 absolute deadline을 공유한다. 명시적 HTTP 429/5xx는 bounded backoff retry이고, write 시작 뒤 network timeout/abort는 결과 불확실이므로 global operator-blocked다.
- claim/authorize/settle은 global singleton lease와 증가 fence를 사용한다. 새 PIN version은 과거 pending outbox를 supersede하며 mid-write 변경은 stale settle 후 다음 current outbox로 수렴한다. 불확실 write와 retry 소진은 자동 성공 처리하지 않고 reconciliation 전까지 멈춘다.
- Google OAuth는 별도 service account, fixed token endpoint, `https://www.googleapis.com/auth/spreadsheets` 단일 scope와 RS256 assertion만 쓴다. Sheet endpoint·private key·OAuth assertion/access token·PIN/envelope·provider raw error는 로그, heartbeat, developer projection, audit에 남기지 않는다.
- source-controlled approved target에는 현재 local/test synthetic mapping만 있다. 승인되지 않은 hosted environment/projectRef/spreadsheet/tab은 PIN 복호화와 OAuth token exchange 전에 fail-closed한다. production mapping은 #137/release 승인 PR에서만 추가한다.
- local worker adapter 테스트는 `RUNTIME_ENVIRONMENT=local`, `SUPABASE_PROJECT_REF=local`, synthetic spreadsheet ID, exact `객실_PIN_현황` tab을 함께 써야 한다. 공용 `.env.example`의 빈 project ref를 그대로 두고 worker를 실행할 수 없으며, 다른 local API의 target 계약을 바꾸려고 전역 예시를 임의 수정하지 않는다.
- developer database status는 secret configured boolean, target approved boolean, safe status/count/time/stable error만 제공한다. raw outbox ID, room ID, PIN, Sheet cell/payload, provider credential은 제공하지 않는다.

## Secret과 암호화

- `ROOM_PIN_KEY_BASE64`는 canonical Base64 32-byte AES-256 key이고 `ROOM_PIN_KEY_VERSION`은 1~32자의 source-controlled version이다.
- `ROOM_PIN_KEYRING_JSON`은 최대 5개의 prior version→canonical Base64 32-byte key를 가진다. current version을 중복 선언하거나 같은 key를 재사용할 수 없다.
- reservation PII, Web Push current/prior key와 PIN current/prior key를 재사용하지 않는다. Node 환경 계약은 cursor/pepper 등 다른 목적 secret과의 재사용도 거부한다.
- 새 encryption마다 12-byte random nonce를 사용한다. private change-lease 원장의 `(key_version, nonce)` unique가 서로 다른 생성 envelope의 재사용을 추가로 차단한다. confirm이 같은 lease envelope를 immutable revision으로 승격하는 것은 새 encryption이 아니다.
- AAD는 source-controlled format/environment/projectRef/roomId/pinVersion으로 만든다. immutable lease/revision에는 bounded nonsecret environment/projectRef만 저장하며 full AAD bytes나 key는 저장하지 않는다. 복구 환경은 현재 runtime 값이 아니라 저장된 exact context로 복호화한다.

키 회전은 새 current key/version을 배치하고 기존 current를 prior keyring에 둔 상태에서 시작한다. 모든 live revision을 새 PIN revision으로 재발급하기 전 prior key를 제거하면 해당 revision은 fail-closed한다. key나 실제 envelope/PIN 값을 로그, Issue, PR, audit, notification에 붙이지 않는다.

## 물리 변경 절차

1. 권한 있는 사용자가 `POST /v1/rooms/{roomId}/pin-changes/prepare`를 호출한다. 클라이언트는 선행 0을 보존한 `pinDigits`만 보낸다. 서버가 global lifecycle lock과 room lock 아래 current room number snapshot을 확인하고 `<room_number>-<pin_digits>`를 암호화한다.
2. prepare 성공 즉시 객실은 mismatch다. current pointer는 그대로지만 allocation readiness와 모든 reveal이 차단된다.
3. 운영자가 실제 도어락 PIN을 변경한다.
4. 실제 변경이 확실할 때만 confirm한다. confirm이 immutable revision/current pointer, exact verified sync event, safe sheet outbox, audit/receipt를 한 transaction에서 기록한다.
5. 물리 결과가 불확실하거나 lease가 만료되면 mismatch를 유지한다. 실제 PIN을 다시 입력해 새 revision을 confirm하거나, 기존 current PIN으로 실제 도어락을 원복한 뒤 source-controlled rollback을 확인해야 한다. 자유형 사유나 추측으로 해소하지 않는다.

최초 version 0 prepare가 만료돼도 영구 정지하지 않는다. unresolved expired lease가 실제 존재할 때만 `ACTUAL_PIN_REENTRY`를 준비·confirm해 version 1을 수립할 수 있다. 평상시에는 이 reason을 사용할 수 없다. Phase A에는 room number 변경 HTTP command가 없다. current PIN 또는 unresolved lease가 있는 객실의 내부 room number 변경도 `ROOM_PIN_REISSUE_REQUIRED`로 거부되며, 재발급 후 rename 같은 존재하지 않는 workflow를 운영 절차로 가정하지 않는다.

## Maid 권한과 reveal

Maid reveal/change는 본인의 exact current notified assignment, 동일 current nonterminal attempt, access 시각 도달, current pin version의 기존 unrevoked/unexpired `room_pin_access_leases`를 모두 요구한다. change prepare/confirm은 attempt가 exact `in_progress`여야 한다. 알려진 다른 maid/과거/revoked/stale lease ID를 조합해도 권한이 생기지 않는다.

Maid confirm이 PIN version을 올리면 서버는 변경을 승인한 기존 authoritative lease를 `PIN_VERSION_SUPERSEDED`로 폐기하고, 동일 room/target/assignment/attempt/maid/만료 시각을 새 version으로 원자 재발급한다. confirm 응답의 `accessLeaseId`를 새 reveal 권한으로 사용한다. revision의 provenance는 변경 승인에 쓴 기존 lease ID를 보존한다.

Reveal은 기존 public access lease를 대체하지 않는 30초 이하 private 보조 lease다. 서버는 복호화 후 DB에서 session/profile/current revision/mismatch/assignment/attempt/access lease를 다시 확인하고 authoritative public lease의 `revealed_at`과 safe `sensitive.read` event를 원자 기록한다. 그 append가 실패하거나 TTL이 0이면 plaintext를 반환하지 않는다.

응답은 항상 `Cache-Control: no-store`다. 클라이언트는 `clearAfterSeconds`와 `expiresAt` 중 더 이른 시점 또는 navigation, background, pagehide, device lock, assignment removal, relock 즉시 credential을 메모리에서 지운다. clipboard, cache, service worker, offline queue, analytics, persistent storage에 저장하지 않는다.

## 장애 확인

- `ROOM_PIN_MISMATCH_UNRESOLVED`: allocation과 reveal을 계속 차단하고 실제 물리 상태를 확인한다.
- `PIN_CHANGE_IN_PROGRESS` / `PIN_CHANGE_LEASE_EXPIRED`: 새 변경으로 덮지 말고 기존 lease의 물리 결과를 resolve한다.
- `STALE_PIN_VERSION` / `ROOM_NUMBER_CHANGED`: 최신 객실/version을 다시 조회하고 새로운 idempotency key로 재시도한다.
- `PIN_ACCESS_REQUIRED` / `PIN_ACCESS_LEASE_REQUIRED` / `PIN_REVEAL_AUTHORIZATION_CHANGED`: assignment, attempt, session, access lease가 바뀐 것이므로 plaintext를 폐기하고 다시 권한을 얻는다.
- `ROOM_PIN_KEY_UNAVAILABLE` / `ROOM_PIN_CRYPTO_CONFIG_INVALID`: keyring을 복구하기 전 reveal/change를 중단한다. 오류 응답이나 로그에 key/envelope/PIN을 남기지 않는다.

DB의 `room_pin_sync_events`와 private sheet outbox에는 room/version/status/source-controlled reason만 있어야 한다. audit developer projection은 `roomId`, `leaseId`, `pinVersion`, `status` 같은 승인 필드만 표시하며 raw state/request hash/envelope을 노출하지 않는다.

## Rollback

Source rollback은 애플리케이션과 해당 append-only migration을 함께 다루는 release 절차에서만 검토한다. 이미 encrypted revision/physical change가 존재하면 schema를 먼저 제거하지 않는다. 배포 중단 시에는 새 PIN endpoint 트래픽을 차단하고 mismatch 객실을 실제 re-entry/rollback 절차로 해소한 뒤 keyring과 DB backup을 보존한다. Phase B에서 write 결과가 불확실하면 Sheet와 DB current version/PIN을 사람이 대조한 후에만 service-owned reconciliation으로 재개하며, 자동 full resync나 추정 성공 처리는 하지 않는다.
