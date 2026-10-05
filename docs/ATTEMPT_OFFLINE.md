# #7C — 오프라인 완료·격리·관리자 정정

시작 기준: `dev@695c10cd8f6cf1be24d272bd18885e8272d83388`.
작업 브랜치: `codex/7c-offline-lease-quarantine`. PR #79는 source/dev 완료이며 production에는
배포하지 않았다. 최종 HTTP 계약은 같은 source의 OpenAPI다.

2026-09-09 KST: exact head `25ceabd2d9d781bb26e68be2230ab6d08ddd3e87`의 독립 QA P0/P1=0,
required CI `34243676126` PASS, Codex96/100 위임 허가 후 dev squash
`e2648de4e40a84e60d19cbb1e4d01974a2f3d369`에 병합했다. 양쪽 tree는
`6768b63f64fdea6dba7d4eda32a70807b7274823`로 동일하다.

## 승인 범위

- 온라인에서 시작과 서버 work lease 발급을 원자적으로 처리한다. offline start/claim/배정 변경은 없다.
- lease는 본인 profile/attempt/current notified assignment revision/action에 고정하며 TTL은 2시간이다.
- client event의 완료 1종만 단건 처리한다. 여러 종류의 오프라인 업무 batch 엔진이 아니다.
- 정상 event는 현재 권한·회차·시각을 재검증한 뒤 물리 완료로 반영한다.
- 발급 이력이 있는 만료·회수·재배정 event는 격리하며, unknown/위조/다른 사람의 lease로 domain quarantine을 만들지 않는다.
- 관리자 결정은 `record_only`, `reject_effect`, `correction_link`다. 사진/제출/ready/검수/수익은 별도다.

## 2026-09-08 추가 승인

offline metadata와 성공 응답 재조회 보장은 최대90일이다. 서버 lease 발급 시각에 90일을 더한
고정 deadline으로 ingest/replay/metadata를 제한한다. 늦게 도착한 최초 event의 보존 기간은
90일보다 짧을 수 있으며, 새 UUID/key·재전송·관리자 결정으로 deadline을 미루지 않는다.
만료 이후에는 업무를 재실행하지 않고 거부한다. 원 UUID/시각/offset/hash/응답을 기존 영구
command receipt나 audit에 복제하거나 비가역 tombstone을 영구 보존하는 예외는 만들지 않는다.

관리자 완료 정정은 현재 유효한 본래 담당자의 `in_progress` 회차에만 가능하다. 새로운
명시적 command가 현재 actor/owner/assignment identity/revision/execution CAS/source를
검증하고 별도 불변 correction 결정과 원 quarantine provenance를 원자적으로 기록한다.
기존 quarantine를 정상 성공 event로 바꾸거나 과거 interrupted/superseded/종료/재배정
회차를 복구하지 않는다. 기존에 기록된 완료 시각은 덮어쓰지 않는다.

## 인증과 저장 경계

기존 Supabase Auth user, 최신 profile, 유효·미폐기 session이 필요하다. lease ID는 로그인
credential이 아니며 session revoke를 우회하지 않는다. 일반 API의 active-only guard는 유지한다.
known expired/revoked lease의 메타데이터 접수와 현재 물리 완료 실행 권한은 별도로 검증한다.
메이드에게 다른 사람의 lease/event/quarantine이나 전체 관리자 목록을 노출하지 않는다.

private 원장의 raw Data API 접근을 막고 service-owned RPC만 사용한다. privileged RPC는
fixed search_path와 명시적 EXECUTE revoke, actor/session/ownership 재검증을 갖는다.
PIN/guest PII/phone/token/Authorization/session 원문/photo/raw body/자유문은 저장하지 않는다.
API의 request correlation ID는 서버가 생성하며 client header를 원장에 복제하지 않는다.

## 시각과 재전송

client occurredAt/offset은 신뢰된 서버 시각이 아니라 검증할 주장이다. 서버 lease anchor,
실제 시작·만료·잠금 획득 후 수신 시각과 대조한다. ±5분 허용이 2시간 실행권한이나
90일 보존선의 연장을 뜻하지 않는다. 미래 시각을 즉시 물리 완료로 확정하지 않는다.
유효 구간은 시작 시각을 포함하고 만료 시각은 제외한다. 정확히 2시간 또는 90일인 경계도
만료이며, 잠금 대기 전에 통과한 검증으로 만료 뒤 응답을 허용하지 않는다.

KST 날짜가 서버 기준과 충돌하면 자동 귀속하지 않고 격리한다. 관리자 correction은 기존
event에서 검증 가능한 정규화 시각을 명시 확인하는 좁은 경로이며 임의 날짜 입력이나
기존 완료 시각 수정 API가 아니다. 서버 수신일로 물리 완료일을 자동 대체하지 않는다.
검증 불가능한 시각의 event는 단순 기록/효력 거절만 가능하다.

한 lease의 완료 action은 하나의 canonical event 슬롯만 가진다. 같은 UUID/hash는 기존
결과를 반환하고, 다른 UUID/hash로 결과를 덮거나 무한 row를 만들지 않는다. quarantine
재시도는 권한이 나중에 회복돼도 자동 성공으로 승격하지 않는다. 실제 완료와 receipt,
감사 및 필요한 outbox는 같은 짧은 transaction으로 처리한다.

## HTTP 경계 — source/dev 완료

기존 `POST /v1/attempts/{attemptId}/start`는 온라인 수행 계약을 그대로 유지한다.
새 lease가 필요한 클라이언트만 아래 경로를 사용한다. 아래 표는 검증된 source 계약이며 운영 사용 가능
표시가 아니다. method/path가 정확히 일치하지 않으면 기존 unknown-route 계약으로 거부한다.

| 경로 | 역할·효력 |
| --- | --- |
| `POST /v1/attempts/{attemptId}/start-with-lease` | active maid의 본인 회차 시작 + lease 원자 발급 |
| `POST /v1/offline-events` | 본인 lease의 완료 메타데이터 단건 접수; 현재 실행 권한은 DB에서 별도 검증 |
| `GET /v1/offline-quarantines` | active business admin의 기간·cursor 제한 목록 |
| `GET /v1/offline-quarantines/{quarantineId}` | active business admin의 유효 보존기간 내 단건 조회 |
| `POST /v1/offline-quarantines/{quarantineId}/resolve` | active business admin의 명시적 불변 결정 |

developer에게 business admin 권한을 상속하지 않는다. `upload_only` 등의 제한된 신원으로
메타데이터를 접수할 수 있다는 사실은 완료 효력이 허용된다는 뜻이 아니다. 일반 API의
active-only 인증 경계는 완화하지 않는다.

관리자 결정 응답의 `effectiveAt`/`recordedAt`은 결정 시각이고, 완료 정정으로 확정된 물리
완료 시각은 `attempt.fieldCompletedAt`이다. 두 값을 같은 의미로 사용하지 않는다.
클라이언트는 임의의 `correctedAt`을 입력하지 않고 격리된 정규화 시각을 확인하여 결정한다.

## 보존·운영 경계

event/lease/replay metadata의 TTL 제거 경로는 대상 테이블·시각·batch 상한이 고정되어야 한다.
아직 유효한 metadata나 immutable domain audit/resolution을 삭제하는 임의 maintenance API를
만들지 않는다. resolution audit에는 서버 소유 결정/provenance 최소 정보만 남긴다.
purge/ingest/resolve 경쟁에서도 만료 metadata 재삽입·재실행·조회 허용이 발생하지 않아야 한다.
실제 production 자동 purge 연결은 별도 release gate로 확인하며 여기서 운영 Cron을 만들지 않는다.
만료 후 API 조회·재실행 차단과 물리 삭제 완료는 서로 다른 증거다. release의 운영 활성화
gate에는 bounded purger의 실제 주기 실행, 삭제 backlog와 실패 감시, 만료 데이터 제거
검증을 포함한다. 이 source PR만으로 production 90일 물리 삭제가 가동 중이라고 표현하지 않는다.

## 검증 gate

### #388 준비 지연과 실제 만료 crossing 분리 — source 후보

`scripts/test-attempt-offline-concurrency.mjs`의 2h/90d 경합 fixture는 Auth·profile·객실·target·assignment·attempt 준비를 먼저 끝낸다. 준비에 필요한 과거 업무 날짜와 통보 시각은 DB 시각에서 계산하지만, 그것을 lease 발행 시각으로 재사용하지 않는다. 준비 후 private start helper를 호출하는 동일 SQL의 단일 `MATERIALIZED clock_timestamp()`에서 과거 발행 anchor를 선택해 정확히 5초의 잔여 창만 만든다. 발행된 lease를 UPDATE하지 않으며 원래 2시간·90일 TTL, CAS·session·업무 권한 검사와 public RPC는 그대로다.

준비가 KST 자정·주차를 넘겨도 원 업무 날짜를 다시 쓰지 않는다. #308의 기한 비차단 계약은 과거 서비스일의 시작을 허용하며, 실제 availableFrom·점유·담당·버전 guard는 계속 적용된다. 새 unit/source 계약은 6,001ms·60,000ms 합성 준비 지연, 자정·주차 경계, 정확한 5초 SQL과 불변 TTL을 구분해서 검사한다. 합성 시계 검사는 실제 DB 경합 PASS의 대체가 아니다.

실제 runner는 완결된 stdout 행에서 얻은 holder의 정확한 backend PID와 `pg_blocking_pids`로 해당 public RPC의 lock 대기를 확인한다. DB 시각으로 처음 live, 대기 도달 시 live, 같은 holder에 계속 막힌 상태에서 expired를 확인한 다음 잠금을 해제한다. 2h crossing의 `LEASE_EXPIRED` quarantine, 90d의 `OFFLINE_EVENT_EXPIRED`, purge/replay, session 회수와 원 발행 시각 검사는 유지한다. 5초 창을 늘리거나 만료 검사를 건너뛰지 않는다.

테스트-only 선택값 `clockFixturePreparationDelayMs`는 기본 0이며 정수 0–10,000ms만 허용한다. 2개 deadline fixture의 업무 준비 후/발행 전 지연에만 적용해, 실제 local DB에서 6초 준비 지연을 주입할 수 있다. DB 경합·전체 aggregate·최신 exact-head CI·독립 QA는 별도 gate이며 이 source 후보 문단은 완료를 선언하지 않는다. 다른 offline expiry runner와 runtime SQL·migration은 변경하지 않는다.

2026-10-05 최신 `dev@c2b5618` 통합103 후보의 실제 로컬 검증은 PASS다. Node1,624건/70파일
(신규 clock/source33건 포함), secret scan858·OpenAPI137/148·typecheck/build, Edge476/0 및
Python95/Ruff226/mypy25/codegen/package를 실행했다. 원본302 raw SHA와 LF 검증본197 SQL·psql/
105 원문 대응 불일치는0이다. migration·전체 SQL·manifest는 위 dev와 같으며 운영 변경은 없다.

- fresh `db:verify` 및 전체 SQL81파일/4,979검사: PASS.
- 기본 `db:test:concurrency`의 전체8명령과 fresh103 cleanup: PASS(exit 0).
- 별도 runner에서 두 deadline fixture 각각 발행 전6초 준비 지연을 주입한 실제 offline suite와
  fresh103 cleanup: PASS(exit 0). 이것은 기본 aggregate·CI의 지연 설정을 바꾼 결과가 아니다.
- 정리 후 검사한 metadata: migrations103/head `photo_collection_provider_context_axis`, 객실121,
  Auth 사용자·profile·target·photo operation0. 모든 테이블의 무자료 상태를 추정하지 않는다.

기본 전체 경합 원 로그 `qa388-integrated-concurrency.log` SHA-256은
`dadcba38dd4c0ae443576f6b9a04a97a5093dff1806d1bb4257225b6a3b5ee9e`,
별도 지연·cleanup 원 로그 `qa388-integrated-delay-6000.log` SHA-256은
`e56560f1b20310165781195b1d7c840ef4bc31a9d1f5476ceaae11376616e074`다.
이 후보에서 전체26 upgrade 명령을 로컬 재실행하지 않았으며, 과거 #383의 PASS를 이 실행으로
기록하지 않는다. 새 exact-head required CI가 전체 upgrade를 실행해야 한다. 최종 독립 QA·새 CI·
보호 dev 병합·실제 백업/운영 및 프런트 UAT는 별도 후속 gate다. 유효 발행 후에도 5초 창보다
요청·잠금 준비가 늦으면 fail-closed로 실패하므로 모든 부하의 timing failure를 제거했다고 표현하지 않는다.

### 2026-09-09 로컬 검증

- `db:verify`: fresh 29 migrations 순차 적용 PASS (기존 28개 변경 없음).
- `db:test`: 23 files / 910 tests PASS, 신규 offline SQL 104 tests 포함.
- DB lint: 오류 0. Security Advisor: WARN/ERROR 0, INFO 9 (정책 없이 직접 접근을 차단한 RLS 원장).
- `ci:quality`: secrets/lint/typecheck/application 123 tests/build PASS.
- `edge:check`: 114 tests PASS. Python ruff/format/mypy 및 pytest 36 tests, build source check PASS.
- `db:test:concurrency`: 전체 기존 suite 및 신규 offline/expiry 경합 PASS.
- 독립 exact-head QA P0/P1=0, GitHub application/migration 및 source/dev 승인·병합 완료.

- [x] 온라인 시작/lease 원자성 및 다른 key·기기에서 TTL 연장 금지
- [x] actor/session/owner/current revision과 limited 상태 persona/RPC/RLS 검증
- [x] 2시간·±5분·KST·90일 및 lock-wait 경계
- [x] same event replay/conflict, UUID 변경 공격 bounded cardinality
- [x] known stale quarantine / unknown reject / 격리 재시도 자동승격 금지
- [x] admin correction current-only 및 과거/ready/검수/수익 효력 금지
- [x] 완료/인계/계정변경/session revoke/resolve/purge 동시성
- [x] 원자 audit/outbox 및 raw UUID/PII/secret 영구복제 차단
- [x] fresh DB/RLS/concurrency/lint/advisor, Edge/application/Python/OpenAPI
- [x] exact-head independent QA P0/P1=0 + required CI + 위임 평가96/100
- [x] PR #79 dev 병합 (production과 별도)

기존28 migrations는 그대로 두고 후속 migration을 추가한다. #30/#9/#31 및 #73은 이 PR에
포함하지 않는다. production/recovery/main/release/Edge/Pages/Cron/Vault/secrets/tag 변경은 없다.
