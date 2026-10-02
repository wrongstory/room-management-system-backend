# #308 6차: 신고·폭탄방 선판정의 상대 역할 알림

2026-10-02 source/dev 상태: #308 완료. PR #340의 승인 source `bdf3cda`와
dev squash `4d85458c5d0a900cf87f7318fcd9b2474c03a889`의 tree가 같고,
required CI `36864792279` application/migration PASS, 독립 QA98/100·차단0으로
Issue #308을 닫았다. 동일 tree는 `6013c056dd32208ce375138d17918de4bbfa3743`다.
아래 후보/gate 기록은 2026-10-01 승인 전 검증 이력이다. #343도 PR #346으로 source/dev
완료했다. #305 종료는 문서 정합화 PR의 exact-head CI·독립 QA·dev 통합 확인 뒤에만 수행하며
최종 근거는 [Issue #305](https://github.com/wrongstory/room-management-system-backend/issues/305)에서 추적한다. [종료 감사](./WORK_DEADLINE_CLOSURE.md)를 따른다.
이 정합화는 운영 배포·프런트 연결·tag·UAT 변경이나 최신 운영 상태 재검증을 포함하지 않는다.

## 범위와 정책

#305의 확정 상대 역할 통지를 따른다. 5차 head14676c1의 application/migration CI
36833580274는 2026-10-01 17:17:47 KST에 모두 PASS했다. 독립 전체 종료 감사는
단순 업로드가 아닌 성공한 업무 내용 신고/판정에서 3건의 알림 누락을 발견했다.
5차의 좁은 통합 QA98점은 전체 #308 종료 승인이 아니다.

| 성공한 변경 | 수신자 | Family / 공개 category | 공개 deep link |
|---|---|---|---|
| 메이드 폭탄방 신고 | business admin | bomb.reported_admin / bomb_room_reported | cleaningTarget |
| 메이드 특이사항 신고 | business admin | room_issue.reported_admin / room_issue_reported | cleaningTarget |
| 관리자 폭탄방 선판정 | 불변 원 수행 회차 메이드 | bomb.decided_maid / bomb_room_decided | submission |

세 알림은 informational(requiresAction=false, resolver=none)이다.
전체 제출 전에는 관리자 폭탄방 판정 권한이 없으며 알림이 권한을 만들지 않는다.
기존 제출 요청·최종 검수 알림/push 정책과 별개의 정확한 업무 변경이다.
원 신고/판정, immutable 감사, scoped receipt, typed inbox/outbox는 한 transaction이다.

## 유지할 경계

- 기존 public RPC·live session·actor 역할/상태·담당·current 제출·CAS·멱등성은 유지한다.
- 기존 immutable 신고/판정/attempt/assignment/seal과 해당 감사의 정확한 actor/entity를 대조한다.
- 최초 유효 evidence만 허용하며 과거 원장 backfill·receipt replay에 새 알림을 만들지 않는다.
- inbox는 business 수신자 상태와 무관하게 보존한다. push는 active/password-complete/nonself만 생성한다.
- 원문 메모·사진 ID·provider locator·PII·PIN·raw request/감사/private source ID를 공개 알림에 넣지 않는다.
- deep link는 기존 target/submission이다. 조회는 기존 recipient-only RLS/RPC,
  Fastify/Edge 안전 projection·no-store를 사용한다.
- 91번째 CLI 생성 append-only migration을 사용한다. 이전 90개 migration은 변경하지 않는다.
- 새로운 검수 SLA, 한 장 업로드마다 통지, 고객 배정 차단, 수익 생성/수정은 제외한다.

## source 완료조건과 과거 검증 이력

### 전체 #308 source 완료조건 대응

독립 종료 감사는 아래 대응을 다시 확인했다. 정적 coverage 확인과 실제 전체 검증,
새 exact-head CI·dev 승인·운영 사용 가능 판정은 서로 구분한다. source/dev gate는
위 PR #340 근거로 완료됐으며 아래 로컬 기록을 운영 PASS로 확대하지 않는다.

| 완료조건 | source / 회귀 근거 |
|---|---|
| elapsed-only preview/draft/commit 차단 제거 | 86/89/90 migration, 공유 preview core, assignment preview/commit/overdue SQL |
| 과거 serviceDate/dueAt만으로 activation/start 차단 금지 | 86 migration, assignment_attempt_activation / attempt_execution_core SQL |
| 실제 점유·퇴실 materialization·선행 workflow·current owner/CAS 유지 | activation/assignment guard와 기존 역할·상태 회귀 |
| scheduler 자동 rollover/supersede/expire 금지 | 86 migration, lifecycle cursor, assignment_rollover_source_window SQL |
| 최초 지연 원 identity·bounded exactly-once·비밀 비노출 | 87 migration, cleaning_overdue_notifications SQL/upgrade/concurrency |
| 배정·인계·시작·완료·제출·검수 상대 역할 통지 | 기존109/128/264 및 88 migration, cleaning_started_notifications/기존 domain 회귀 |
| 신고·폭탄방 선판정 상대 역할 통지 | 91 migration, cleaning_report_notifications SQL/upgrade/concurrency |
| Fastify/Edge/OpenAPI parity·이력 불변·기술 TTL 보존 | quality/Edge/manifest/전체 업그레이드 및 역할·RLS·concurrency 검사 |

신규 재청소 생성 시 새 availableFrom과 다음 입실 전 window의 순서 제약은
기존 업무의 dueAt 만료 차단과 다르다. 예약·source 생성 안전 guard를 이 작업에서 제거하지 않는다.

### 과거 로컬 검증 — 2026-10-01, PR #340 승인 전

당시 로컬 구현·필수 검증 완료 후 새 exact-head CI/최종 source/dev gate가 남아 있었다.
아래 NOT RUN은 그 단계의 이력이며 최종 승인 CI와 구분한다. 실행하지 않은 운영 검증은
현재도 PASS로 표시하지 않는다.

| 실제 실행 | 결과 |
|---|---|
| `npm run ci:quality` | PASS; typecheck/build/secrets/OpenAPI/lint, 50 files/628 tests, 131 paths/141 operations. 기존 lint info2 유지 |
| `npm run edge:check` | PASS; fmt/type, 301 tests, bundle17,194,016bytes |
| `npm run db:reset` / 전체 SQL | PASS; fresh91, 69 files/3,711 assertions |
| `npm run db:manifest:verify` | PASS; 5종/91개, 이전90개 order/name/SHA 보존 |
| Python ruff/format/mypy/pytest/codegen/package source | PASS; 95tests,226files format/25source mypy. 기존 binary-photo/handover generator warning 유지 |
| `npm run db:test` | PASS;17개 upgrade와 69 files/3,711 assertions. 기존 신고/판정/receipt/notice/outbox exact digest, 과거 source 무 backfill, 새3family9inbox/5outbox 검증 |
| `npm run db:test:long-stay-clock` | PASS;5시각/145 assertions |
| `npm run db:reset` / `npm run db:test:concurrency` | PASS;fresh 전체 RPC 경합. 신규8same-key bomb/4new-key 거부/6same-key issue/6different-key decision CAS 단일승자/알림 실패 전체 rollback·재시도 포함 |
| `npm run backup:dry-run:fresh` | PASS;fresh91/121rooms dump·restore |
| local DB lint / Security Advisor | PASS;lint exit0/error0, 기존 STABLE/VOLATILE·unused warning 유지. Security Advisor No issues found |
| 독립 QA | 98/100(범위25·보안29·검증24·문서20), source P0/P1/blockingP2=0. 전체 #308 coverage/3누락 보완·최초FAIL/최종PASS 경계 재감사. 로컬 commit/push 준비만 승인; commit/tree 재확인 필요 |
| 새 exact-head required CI | NOT RUN;push 후 application/migration gate 별도 |
| production/hosted/frontend/실기기 UAT | NOT RUN |

첫 Edge 실행의 배열 포맷 FAIL은 포맷만 보완했다. 첫 집중 SQL은 합성 추가 청소
템플릿의 duration metadata 누락으로 FAIL했으며 기존 제약을 유지하고 fixture만 보완했다.
첫 전체 SQL의 개발자 migration status 3건 FAIL은 새 head91/이전head90 기대값을
정합화한 뒤 전체 3,711건 PASS했다. 첫 90→91 upgrade harness는 JSON 집계 SELECT의
닫는 괄호 누락으로 FAIL했다. 같은 집계 패턴 3곳을 보완한 뒤 90→91 실제 재실행 PASS했다.
첫 전체 concurrency는 신규 합성 standard/additional 게시 템플릿과 뒤의 기존 photo-retention
fixture가 one-published 제약에서 충돌하여 FAIL했다. 신규 검사 종료 시 exact 자기 template만
허용된 published→retired 상태 전이로 정리하고 원 target/attempt v9 snapshot 참조를 검증한다.
기존 retention fixture·제품 제약·91 migration은 변경하지 않았으며 fresh 전체 재실행 PASS했다.
제품 제약·역할·검사 개수·통과 기준은 완화하지 않았다.

로컬 dump·restore는 현재91 SQL/manifest hash를 검증했다. 커밋 전 artifact의 source metadata는
당시 부모14676c1을 기록하므로 새 commit/tree 검증 근거로 사용하지 않는다.

당시 새 head required CI·독립 QA·최신 dev/리뷰 gate 전에는 Ready/병합/종료하지 않았다.
이 gate는 위 PR #340 근거로 완료했다. 해당 구현의 production/main/recovery·프런트·
실계정/PIN/provider·release/tag 변경은 없었다.

부모 #305의 컴플레인 응답 지연 주의 알림은 [#343](https://github.com/wrongstory/room-management-system-backend/issues/343)으로 분리했다.
당시에는 미완료였지만 이후 PR #346으로 source/dev 완료했다. 이 청소 보완과 검증 근거를
구분하며 [컴플레인 주의 알림 기록](./COMPLAINT_RESPONSE_ATTENTION.md)을 따른다.
#320 실제 신고 사례·#342 잠금 비용 보완·프런트/실기기 UAT도 별도다.

## 프런트 읽기 전용 호환성 대조

대조한 frontend dev09ed284/main d509b44는 category:string 및 기존 cleaningTarget/submission
deep link 계약을 유지한다. dev는 새 세 category를 전체/안 읽음에 표시하고,
requiresAction=false를 처리 필요 필터에서 제외하며 관리자 target·메이드 submission 상세를 지원한다.
제품 전체 frontend 기준을 자동 승격하거나 frontend 파일을 수정하지 않았다.

main d509b44의 메이드 submission은 주급 fallback으로 이동하는 source 경로가 남아 있다.
실제 운영 artifact/브라우저 재현은 NOT RUN이므로 현재 운영 장애로 단정하지 않는다.
frontend 담당 측의 routing 승격·3category/role/deep-link 합성 회귀·운영 UAT를
[#344](https://github.com/wrongstory/room-management-system-backend/issues/344)에서 추적한다.
이 frontend 배포 gate를 backend source 완료와 구분하며, 새 API/권한 완화로 우회하지 않는다.
영문 category 한국어 label은 UX 후속 권고다.
