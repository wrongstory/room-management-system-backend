# Web Push delivery release runbook

이 문서는 #112 source를 release/main 이후 실제 운영에 활성화할 때의 순서와 복구 경계를 고정한다.
feature PR은 production, Vault, Cron, `pg_net`, Function Secrets를 변경하지 않는다.

## 키와 secret 계약

- `VAPID_PUBLIC_KEY`는 uncompressed P-256 raw point 65 bytes의 padding 없는 canonical base64url이다.
- `VAPID_PRIVATE_KEY`는 같은 pair의 P-256 private scalar 32 bytes의 padding 없는 canonical base64url이다. PKCS#8 blob은 받지 않는다.
- Function 시작 시 public/private pair를 실제 ES256 sign/verify로 검증한다. shape만 맞거나 pair가 다른 키는 provider 호출 전에 실패한다.
- `VAPID_CURRENT_KEY_VERSION`은 새 registration/rotation revision에 서버가 결합한다. HTTP client는 version을 보내거나 선택하지 않는다.
- `VAPID_KEYRING_JSON`은 prior version별 `{publicKey,privateKey}`만 포함한다. current version을 중복 포함하지 않는다.
- subscription envelope current/keyring, binding HMAC secret, delivery invoke secret, Supabase service-role key는 VAPID private key와 모두 서로 다른 값이어야 한다.
- private key, envelope key, invoke secret, endpoint, digest, session, provider response body/header/status text는 source, 응답, audit, notification, 로그에 기록하지 않는다.

legacy revision의 `vapid_key_version IS NULL`은 현재 key를 추측해 backfill하지 않는다. 해당 push는
`VAPID_KEY_UNBOUND` dead-letter로 끝나며 inbox는 유지된다. 사용자가 config endpoint의 current public key로
구독을 명시적으로 rotate하면 새 revision부터 복구되고 과거 push는 재생하지 않는다.

## release와 활성화 순서

1. 승인된 release branch를 main에 병합한다. feature branch에서 production을 변경하지 않는다.
2. 45번째 migration을 적용하고 migration history, RLS, service-only RPC grants를 확인한다.
3. API/Edge 배포 전에 모든 Function Secrets를 먼저 주입한다. 특히 public config endpoint도
   `VAPID_CURRENT_KEY_VERSION`과 `VAPID_PUBLIC_KEY`가 없으면 fail-closed이므로 secrets-before-API 순서를 지킨다.
4. `api`와 `notification-delivery` Edge Function의 동일 승인 bundle을 배포한다.
5. invoke secret 누락/오류, body/query/redirect/disallowed-host negative smoke를 먼저 수행한다.
6. fake 또는 승인된 test subscription으로 config→register→delivery→settle positive smoke를 수행한다.
7. 그 뒤에만 Vault/`pg_cron`/`pg_net`을 구성하고 expected job name `notification-delivery`를 active로 만든다.
8. 5회 연속 successful heartbeat, overdue/dead-letter/operator-blocked 0, heartbeat age 5분 미만을 확인한다.
9. 마지막으로 실제 기기의 hosted Web Push 수락과 표시, stable notification ID dedupe를 확인한다.

provider의 201/202/204는 push service accepted일 뿐 device delivered가 아니다. 실제 device smoke 전에는
운영 완료로 판정하지 않는다.

## rotation과 credential recovery

새 VAPID pair는 새 version으로 current에 넣고 기존 current를 keyring으로 이동한 뒤 배포한다. 기존 revision은
immutable bound version으로 prior key를 사용하고 새 revision만 current를 사용한다. keyring 제거 전에는
해당 version에 묶인 active/current revision이 0인지 확인한다. compromise 시 affected version을 제거하면
전송은 fail-closed/operator-blocked가 되며, 새 pair 배포와 client rotation 뒤 service-only bounded resume을
명시적으로 수행한다. 401/403은 endpoint를 retire하지 않는다.

## client/service-worker handoff

frontend 정본 `makee-ham/room-management-system`의 후속 변경은 다음을 구현해야 한다.

- provider payload의 `notificationId`를 notification tag로 사용하고 `renotify=false`로 표시한다.
- IndexedDB 한 transaction에서 notification ID를 확인·기록해 동시 event도 한 번만 표시한다.
- dedupe 보존은 24시간, 최대 1000건이며 오래된 항목부터 bounded purge한다.
- deep link는 허용된 typed kind를 앱의 same-origin route로만 매핑하고 외부 URL로 해석하지 않는다.

## incident와 rollback

heartbeat가 5분 이상 오래됐거나 Cron configured/active가 아니거나 overdue/dead-letter/operator-blocked가 하나라도
있으면 health는 degraded다. 먼저 Cron을 중지해 새 invoke를 차단하고, 승인된 이전 Edge bundle로 되돌린다.
원장 row나 migration을 삭제·rollback하지 않는다. credential 문제를 고친 뒤 negative smoke, bounded resume,
5회 연속 success를 다시 확인하고 Cron을 재개한다.
