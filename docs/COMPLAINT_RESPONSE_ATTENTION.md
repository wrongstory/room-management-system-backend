# #343 컴플레인 미응답 주의 알림

## 제품 계약과 범위

#305/#306에서 확정한 최초 판정 후 기존 7일 응답 기준을 알림용으로만 사용한다.
관찰 대상은 `decided` 상태, 최초 판정의 유한한 `responseDeadline`이 있고,
그 기준을 엄격히 지났으며 실제 메이드 응답 원장이 없는 사건이다.
정정은 최초 판정 시각·응답 기준을 초기화하지 않는다. 확인/이의·종결 사건과
기준이 없는 과거 사건은 제외하며 모든 판정 유형을 같은 기준으로 검사한다.

메이드는 기준 경과 후에도 최초 판정에 한 번 응답할 수 있다.
새 SLA, 응답 차단, 자동 종결, 재응답, 벌점·수익·보상 변경, 반복 경고는 없다.
migration 자체의 과거 사건 backfill이나 기존 receipt replay에 붙이는 새 알림은 없다.
실행 시점의 현재 상태를 관찰하며 과거 원장·감사·결정·응답은 바꾸지 않는다.

## 알림 및 무결성

| 항목 | 계약 |
|---|---|
| family / 공개 category | complaint.response_attention_admin / complaint_response_attention |
| 수신자 | 현재 active/password-complete business admin |
| action / push | false / true; actor 본인 inbox는 보존하고 자기 push는 제외 |
| source / resolver | complaint_response_attention_event / none |
| deep link / grouping | complaintCase / complaint_response_attention, room |
| 중복 경계 | 사건별 불변 evidence 1건, evidence/수신자 enrollment 1건 |

현재 case의 최초/current 결정·version·room·target·응답 부재를 case row lock 안에서
재검증한다. 증거와 enrollment는 append-only private 원장이다. notification/outbox와
enrollment의 deferred commit invariant로 일부만 저장되는 실패를 막는다.
10분 grouping 경계, 반복 호출, 다른 actor나 correction은 기존 알림을 재생성하지 않는다.
응답·정정·종결 후에도 이미 생성된 알림의 불변 provenance를 유효한 이력으로 보존한다.
새 수신자 등록도 현재 미응답 상태를 다시 확인하며 기존 사건의 발생 시각을 유지한다.
새 수신자 delivery는 enrollment 시각을 enqueue 기준으로 구분한다. 이미 발생한 사건의
inbox/group 시각은 바꾸지 않되, 새 outbox의 기존 24시간 TTL을 등록 시각부터 적용하여
과거 발생 시각 때문에 신규 전달이 즉시 만료되지 않도록 한다.
기존 수신자 outbox의 clock/TTL을 연장하거나 재발행하지 않는다.

메모·사진·고객/직원 PII·PIN·raw request·private source/decision ID는 알림 공개 projection,
push payload, 감사에 복제하지 않는다. 기존 recipient-only 조회/읽음 및 no-store를 유지한다.

## 실행·배포 경계

기존 assignment lifecycle RPC 안에서 별도 keyset cursor로 한 호출에 최대 100건을
공정 순환 검사한다. 내부 결과에 `complaintAttentionCount`를 추가하고 scheduler heartbeat가
이를 합산한다. 이전 완료 receipt에는 이 필드가 없어도 유효하며 원문을 고쳐 쓰지 않는다.
공개 API 경로/DTO/OpenAPI, caller 권한, 신규 Cron/secret/provider는 추가하지 않는다.

프런트는 read-only로 `makee-ham/room-management-system@09ed28446a4fd43919cddb29ebe442b848548ab8`
`WIREFRAME/index.html`의 `renderLiveNotificationListMarkup`과
`openLiveNotificationTarget`을 대조했다. category string/title/body를 일반 목록에 표시하고
기존 `complaintCase` deep link를 처리한다. 이 좁은 호환성 대조는 제품 전체 기준 갱신이나
실제 화면/UAT·새 category의 한국어 라벨 완성을 뜻하지 않는다. 프런트 수정은 별도 담당 범위다.

92번째 CLI 생성 append-only `20261001210323_complaint_response_attention.sql`을 사용한다.
이전 91개 migration을 수정하지 않는다. feature → dev source 구현 범위이며
운영/main/recovery DB·Edge·Cron/Vault, 프런트 코드·운영 실제 기기 UAT는 제외한다.
운영 승격은 승인된 release에서 migration 적용 후 exact source scheduler 배포 순서로 진행한다.
rollback은 과거 원장 삭제가 아니라 별도 검토된 후속 migration/이전 호환 scheduler로 한다.

## 검증과 상태

2026-10-02 로컬 source 검증 기록이다. 구현·전체 SQL/upgrade·동시성 검증 완료,
최종 독립 QA 및 exact-head CI/dev 승격은 별도 gate다. 후속 승인·병합 근거는
[Issue #343](https://github.com/wrongstory/room-management-system-backend/issues/343)에 기록한다.
운영 전달 PASS로 판정하지 않는다.

| 실제 실행 | 결과 |
|---|---|
| `npm run ci:quality` | PASS; secrets/OpenAPI/lint/typecheck/build, 51 files/641 tests |
| `npm run edge:check` | PASS; fmt/type, 304 tests, pinned bundle 17,193,996 bytes |
| Python ruff/format/mypy/pytest/codegen/package source | PASS; 95 tests, 226 format files / 25 mypy files; 기존 binary-photo/handover generator warning 유지 |
| `npm run db:reset` | PASS; fresh append92. 첫 focused 검증의 기존 actor 오류명 기대 1건을 ACTIVE_ACCOUNT_REQUIRED로 보정 |
| 신규 SQL `complaint_response_attention.sql` | PASS; 73 assertions, 역할/RLS·NULL 이력·strict deadline·현재 실제 기한 경과 응답/종결·rollback·fairness·late-admin actual worker |
| `test-complaint-response-attention-upgrade.mjs` | PASS; 91→92 exact 원장/receipt 보존, 무 backfill·기존 receipt 무 side effect, 새 감지·정정·응답 이력 |
| `npm run db:test` | PASS; 누적 upgrade 18개, 70 SQL files / 3,784 assertions |
| `npm run db:manifest:verify` | PASS; append92, 기존 91개 order/name/SHA 보존 |
| `npm run db:test:long-stay-clock` | PASS; KST 5시각 × 29 assertions = 145 |
| `npm run db:verify` / `npm run backup:dry-run` | PASS; fresh92 / 121실 local-synthetic 복구. 최종 commit HEAD/tree 기록은 별도 재검증 |
| DB lint / Security Advisor | PASS; 최종 delivery-clock 포함 오류·security warn/error 0 |
| `npm run db:test:concurrency` | 최종 PASS(exit0); 기존 전체 runner와 별도 fresh DB 신규 실제 RPC 경합, 최종 fresh cleanup 모두 통과 |
| 독립 QA / 새 exact-head required CI | local source QA 98/100, P0/P1/P2=0·커밋 가능; exact-head CI/postcommit backup·최종 병합 QA는 별도 gate |

필수 CI의 migration job만 유한한 25분 예산을 사용한다. 직전 승인 PR #340의
run `36864792279`는 19분 33초(DB upgrade/SQL 14분 9초, 동시성 3분 23초)로 기존
20분 예산의 여유가 27초였다. 이번 18번째 upgrade와 독립 동시성 stage의 추가 fresh reset·
실제 경합을 수용하기 위한 조정이다. application 20분, 검증 명령·assertion·처리 상한·
required checks·항상 cleanup·실패 처리는 유지한다. 무제한 timeout이나 검증 우회가 아니다.
예산 조정 전 첫 원격 실행은 당시 진행 중이었으며 timeout/FAIL로 확정하지 않는다.

독립 QA에서 발견한 신규 family의 late-admin 즉시 TTL 만료는 enrollment clock을 분리해
보완했다. 기존 `cleaning.overdue_admin`의 같은 경계는 범위 밖 [#345](https://github.com/wrongstory/room-management-system-backend/issues/345)로 분리했다.
과거 source의 운영 실제 피해를 확정하지 않았으며, 이 PR에서 기존 family나 TTL을 바꾸지 않는다.

동시성 실패 이력: 첫 실행은 미래 lifecycle이 앞선 미퇴실 checkout fixture와 충돌했다.
순서 격리 후 신규 검증은 PASS했으나 두 번째 전체 실행은 추가 admin fanout으로 기존 전달
drain 1,000건 한도를 넘겨 FAIL했다(1,000 suppressed / 253 pending).
최종 실행은 기존 runner를 원본 그대로 유지하고 신규 stage만 별도 fresh local DB에서 실행했다.
제품 guard·worker·기존 검증 한도·assertion은 완화하지 않았다. 신규 stage는 시작 전 local host를
검사하고 현재 checkout 전체 migration을 적용하며, 종료 후에도 fresh local DB로 정리한다.

## 원격 실패와 로컬 API 검증 경계

2026-10-02 KST exact-head `5267f3564c0ab5e0e4b0fe17ecc3fb737bb8f6d1`의
[CI36935605522](https://github.com/wrongstory/room-management-system-backend/actions/runs/36935605522)는
application SUCCESS / migration FAILURE다. 전체 18개 upgrade·70 SQL/3,784 assertions·
KST145와 기존 전체 동시성 runner 및 cleanup은 통과했으나, 신규 standalone의
rollback 후 같은 key를 보낸 8개 RPC의 전체 성공 assertion에서 실패했다. timeout 실패가 아니다.
개별 RPC 오류가 기록되지 않아 원인은 미확정이며, 로컬 동일 경합 재진단 PASS도 이를 상쇄하지 않는다.

검증 도구만 보완해 fresh reset 뒤 read-only PostgREST OpenAPI의 실제 대상 RPC signature를
유한한 준비 검사로 확인한다. 연결 초기화의 제한된 transient만 준비 검사에서 재시도하고,
인증·권한·도메인·형식 오류와 잘못된 signature는 즉시 실패한다. 실제 mutation RPC에는
재시도를 추가하지 않으며 기존 8-way all-success·receipt·원장·CAS assertions를 그대로 실행한다.
이는 초기화 직후 API 준비 상태를 검증하는 사전조건이지 이전 CI 원인의 확정이나 제품 버그 수정 선언이 아니다.

실패 RPC는 정해진 함수명/호출 순번과 허용된 HTTP status·SQLSTATE/PostgREST code만 남긴다.
generic failure도 원 Error/AssertionError 객체, 원문 message/details/hint/stack, 요청·응답·
key/hash·인물 식별자·PIN을 출력하지 않는다. cleanup 전에 evidence/enrollment/notice/receipt의
정수 건수만 보존하고, 원 실패와 cleanup 실패는 각각 exit failure를 유지한다.
운영 오류 기록 API가 아니며 제품 DB/migration·권한·API·worker·실제 경합 검증 기준은 바꾸지 않는다.

보완본의 실제 검증·독립 QA·새 exact-head CI 상태는 [Issue #343](https://github.com/wrongstory/room-management-system-backend/issues/343)과
[PR #346](https://github.com/wrongstory/room-management-system-backend/pull/346)에 별도로 기록한다.
이전 로컬98점으로 원격 FAIL을 상쇄하거나 source/dev·운영 완료로 표시하지 않는다.

2026-10-02 KST 보완본의 `npm run ci:quality`는 52 files/694 tests·typecheck·build·lint·
secrets·OpenAPI PASS다. helper 단위 53건과 독립 QA98/100(P0/P1 0건)을 확인했다.
실제 standalone 및 `npm run db:test:concurrency`의 기존 전체 runner·신규 fresh 단계·
최종 fresh cleanup도 exit0/PASS다. synthetic 404/PGRST202 주입은 업무 RPC를 재시도하지 않고
8개 실패를 모두 관찰해 기존 assertion이 exit1로 실패하며, 민감 sentinel 미노출·정수 건수 기록·
finally cleanup을 확인했다. 이는 의도된 실패 처리 검증 PASS이지 RPC 기능 성공이 아니다.
이 로컬 기록 이후 새 commit의 required CI와 exact-source 독립 QA는 별도 필수 gate다.
