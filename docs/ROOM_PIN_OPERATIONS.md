# 객실 PIN Phase A 운영 인계

## 범위와 배포 상태

이 문서는 Issue #131의 source candidate를 설명한다. 기준은 `dev@58cf63e36fde8fd209e8ab18508b59d2bd275d0e`, 48 migrations / 98 paths / 105 operations이고 candidate는 49 migrations / 102 paths / 109 operations다. feature → `dev` 검증만 수행하며 production/main/recovery migration, Edge, Cron, Vault, Google 설정은 변경하지 않는다.

Phase A에는 encrypted PIN revision/current pointer, 물리 변경 조정, 안전한 reveal, public sync event, Phase-B sheet outbox 기반만 포함한다. Google Sheets provider 호출, worker, full resync, production secret/ACL은 포함하지 않는다.

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

Source rollback은 애플리케이션과 49번째 migration을 함께 되돌릴 수 있는 release 절차에서만 검토한다. 이미 encrypted revision/physical change가 존재하면 schema를 먼저 제거하지 않는다. 배포 중단 시에는 새 PIN endpoint 트래픽을 차단하고 mismatch 객실을 실제 re-entry/rollback 절차로 해소한 뒤 keyring과 DB backup을 보존한다. Phase A는 외부 Google side effect가 없으므로 provider 보상 작업은 없다.
