# v0.8.0 중간 릴리스 후보·운영 런북

## 현재 상태와 승인 범위

2026-10-03 KST 작성 checkpoint다. 사용자는 정해진 개발 순서와 중간 릴리스의 운영 배포·문서·UAT를 승인했다.
이 문서는 **릴리스 후보**이며 main 병합·운영 적용·사용자 UAT 완료 기록이 아니다.
릴리스 [#364](https://github.com/wrongstory/room-management-system-backend/issues/364)의 최종 exact source와 실제 결과는 아래 표에 갱신한다.

| 구분 | 작성 시 확인 기준 |
|---|---|
| 운영 Git | `main@1780728a02144c0816565ba091e43a8b3e126c4f`, 기존 Git 릴리스/태그 v0.7.1 |
| 운영 DB / runtime | 85 migrations, head `flat_cleaning_evidence_history_payroll`; `api` ACTIVE v38, `reservation-scheduler` ACTIVE v16 |
| 운영 HTTP / package | OpenAPI `0.6.0`, 131 paths / 141 operations; npm package `0.1.0` |
| 릴리스 작업 시작점 | `release/v0.8.0`, dev `eb1ec3e99cfa56bca326064a6c0468714374df75`, source 99 migrations |
| 선행 #352 후보 | [PR #365](https://github.com/wrongstory/room-management-system-backend/pull/365), source `576b0e5d2d98596eb082b4fee0875ef7ace235e1`, tree `b41786cc435cdff12ed50b6a182c91084d082633` |
| #352 CI checkpoint | exact-head run `37116122570`의 application / migration 모두 PASS. dev 병합과 release 자체의 검증은 별도다 |
| v0.8.0 목표 | #352 dev 통합 후 포함, 100 migrations / 운영85 대비 pending15. OpenAPI `0.6.0` / 137 paths / 148 operations를 최종 source에서 확인한다 |

Git 릴리스 v0.8.0, OpenAPI 0.6.0, package 0.1.0, 각 Function의 배포 version은 별도 식별자다.
기존 [v0.7.1 기록](./RELEASE_V0.7.1.md)은 운영 main 원문 그대로 보존하고 이번 결과로 덮어쓰지 않는다.

## 사용자에게 달라지는 기능

| 범위 | 변경과 유지하는 경계 |
|---|---|
| #308 지연 업무·상호 알림 | 기한이 지나도 원 대상·담당·회차·계획일을 유지한다. 자동 이월·scheduled 만료 해소를 폐기하고, 오늘의 과거 미배정 업무 및 시작·신고·판정의 상대 역할 알림을 보완한다. 실제 점유·퇴실·담당·CAS·보안 TTL은 유지한다. |
| #343 컴플레인 미응답 주의 | 최초 판정 기준을 지난 미응답 사건을 관리자에게 informational 알림으로 관찰한다. 응답 권한 만료·자동 종결·벌점이나 수익 변경은 없다. |
| #348 수동 청소 취소 | 관리자는 수동 추가/연박을 배정·통보 뒤에도 실제 착수 전이면 취소할 수 있다. PIN 조회·숨김·만료는 취소 제한이 아니다. 자동 퇴실 청소와 착수 후 일반 취소는 대상이 아니다. |
| #326 배정 대상 metadata | 저장된 객실 타입·요금·등록 근거·원/유효 업무일·실제 이월 근거·취소 advisory를 제공한다. 과거 snapshot을 현재 카탈로그로 채우지 않으며 0원과 unknown/null을 구분한다. |
| #328 일정 snapshot | 계획/최초 통보 때의 사실과 현재 실제 퇴실을 구분한다. 이력에는 당시 snapshot만 제공하며 현재 담당/예약 정보를 섞지 않는다. |
| #327 관리자 사건 목록 | open 미퇴실 사건을 bounded 목록에서 발견하고 최신 상세·기존 결정으로 진입한다. 목록 자체는 결정 CAS나 권한을 발급하지 않는다. |
| #325 조정 book | 최신 주급 조정 원장의 CAS version을 조회해 기존 정정/취소 명령에 사용한다. 금액이나 조정 원장은 변경하지 않는다. |
| #324 work-details | 확정 earning과 미확정 workflow를 별도 stream으로 실제 FK·고정 snapshot·기존 집계의 기여 금액에서 조회한다. 기존 entries/receipt/cursor와 지급 원장은 유지한다. |
| #331 송금 표시 | 실제 PAID와 별도의 on/off·이력을 저장한다. 새 on은 종료 KST 주차·양수 지급 대상에만 허용한다. 금액 근거 변경 뒤에도 on을 유지하고 별도 관리자 재확인을 요구한다. 은행 송금은 실행하지 않는다. |
| #352 session hard expiry | 기존 session helper가 user/session과 `not_after`를 엄격히 검사한다. 행 정리 지연을 유효 권한으로 보지 않는다. 새 Auth 설정·TTL 연장·제한 계정 재로그인은 추가하지 않는다. |

후속 순서 #329 기존 로그인 session 한정 capability → #317 PIN 안전 진단 로그는 **이번에 포함하지 않는다**.
프런트 구현, 새 provider/Google/Push/Cron 활성화, 실제 PIN 변경, 송금 테스트도 제외한다.
상세 계약은 [제품 가이드](./AI_BACKEND_PRODUCT_GUIDE.md), [취소](./MANUAL_CLEANING_CANCEL.md),
[대상](./ASSIGNMENT_TARGET_READ_METADATA.md), [일정](./ASSIGNMENT_SCHEDULE_SNAPSHOT.md),
[사건 목록](./CHECKOUT_INCIDENT_ADMIN_LIST.md), [조정](./PAYROLL_ADJUSTMENT_BOOK.md),
[업무 상세](./PAYROLL_WORK_DETAILS.md), [송금 표시](./PAYROLL_REMITTANCE_MARKER.md)를 따른다.

## Pending migration과 데이터 영향

운영85의 exact history/name/내용과 source100 manifest를 확인한 뒤 다음15건만 순서대로 적용한다.
번호는 source 순서이며, 기존 hosted history timestamp를 Git filename에 맞춰 고치라는 뜻이 아니다.

| 순번 | source 파일 |
|---:|---|
| 86 | `20261001001449_cleaning_overdue_preserve_work.sql` |
| 87 | `20261001012526_cleaning_overdue_notifications.sql` |
| 88 | `20261001024524_cleaning_started_admin_notifications.sql` |
| 89 | `20261001041801_cleaning_overdue_preview_snapshot.sql` |
| 90 | `20261001064101_cleaning_overdue_commit_planning.sql` |
| 91 | `20261001113931_cleaning_report_decision_notifications.sql` |
| 92 | `20261001210323_complaint_response_attention.sql` |
| 93 | `20261002042113_manual_cleaning_cancel_pin_independent.sql` |
| 94 | `20261002074234_assignment_target_read_metadata.sql` |
| 95 | `20261002101126_assignment_reservation_schedule_snapshot.sql` |
| 96 | `20261002161001_checkout_incident_admin_list.sql` |
| 97 | `20261003021153_payroll_adjustment_book_read.sql` |
| 98 | `20261003042015_payroll_work_details_read.sql` |
| 99 | `20261003064220_payroll_remittance_marker.sql` |
| 100 | `20261003095426_auth_session_hard_expiry.sql` (#352 dev 통합 후 후보) |

- DDL·함수·제약·index/ACL, 알림 catalog, 기술 cursor singleton 등 **설치 상태**는 바뀐다. “DB/데이터 변경 없음”으로 기록하지 않는다.
- 95는 nullable JSONB 두 컬럼을 추가한다. 과거 schedule/assignment의 누락 snapshot과 완료 receipt를 현재 예약으로 채우지 않는다.
- 95는 두 테이블의 authenticated 전체 SELECT를 기존 pre95 컬럼의 명시 SELECT로 축소한다. 기존 컬럼·count·join/RLS는 유지하지만 `SELECT *`/whole-row/신규 raw 컬럼은 의도적으로 거부한다. service-role 기존 grant는 유지한다.
- 과거 earning·adjustment·지급 item/result·PAID snapshot·성공 receipt·성공 PIN 공개 이력은 삭제·재계산하지 않는다. PAID로 송금 표시 on을 추측 backfill하지 않는다.
- migration 자체의 과거 알림 backfill은 없다. 적용 후 실제 업무 command/scheduler는 현재 조건에 맞는 업무에 새 불변 알림 evidence·inbox·outbox를 만들 수 있다.
- 93은 구 `cancel_manual_cleaning_request`의 service-role 직접 EXECUTE를 회수하고 session-bound wrapper를 사용한다. 새DB+구API, 구DB+새API 혼재는 취소 실패를 일으키므로 DB·adapter를 한 릴리스로 조정한다.
- 100은 기존 helper predicate만 보강한다. Auth 설정·실제 session 행·업무 기한은 바꾸지 않는다. STABLE statement-clock만으로 모든 잠금 대기 중 만료까지 해결한 것으로 주장하지 않는다.

### 잠금·적용 도구의 미확인 gate

pending source에는 일반 `CREATE INDEX`와 `ALTER TABLE ADD COLUMN`이 있다.
일반 index 생성은 쓰기를 기다리게 하고, ALTER TABLE도 강한 잠금을 요구할 수 있다.
제로 중단·운영 소요 시간·15건 일괄 원자 적용을 보장하지 않는다.
([PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html), [ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html))

선택할 hosted apply 도구의 hard timeout, 한 건의 SQL/history 기록 transaction 경계,
timeout 때의 취소/commit 동작은 **NOT VERIFIED**다.
이를 확인하고 업무 영향·유한 lock/statement timeout 방침·호환 recovery artifact를 준비하는 것이 운영 적용 전 중단 gate다.
확인되지 않은 값을 만들거나 timeout을 무제한 늘려 진행하지 않는다.
응답 timeout은 rollback 증거가 아니다. 재적용 전에 해당 history/schema/ACL/index를 읽어
불명확하거나 부분 적용이면 중단·조사한다. 기존 history repair·전체 db push·기적용 SQL 수정은 금지한다.

## Scheduler·알림 운영 영향

기존 `reservation-scheduler`, 호출 secret/관리자·기존 주기를 재사용하고 신규 Cron을 만들지 않는다.
예약 전이 뒤 기존 assignment lifecycle에서 activation·overdue·complaint attention을
**각각 최대100건의 별도 cursor**로 순환 검사한다. 300건 일괄 완료나 즉시 전량 처리를 보장하지 않는다.
원 담당·회차는 유지하며 `rolledOverCount=0`/빈 배열 호환 출력도 유지한다.

inbox/outbox는 본체와 같은 DB transaction이고 외부 push는 기존 worker가 이후 처리한다.
자기 push·비활성/비밀번호 미변경 push는 억제하며, 알림 생성과 단말 전달 성공은 별도 결과다.
적용 뒤 heartbeat·실패/지연·count·cursor 진행·outbox를 안전한 건수로 관찰한다.
신규 complaint family의 늦은 관리자 등록은 enrollment-clock이지만 기존 overdue의24h push 문제 #345는 남는다.

## 실제 검증 checkpoint·완료 gate

| gate | 작성 시 상태 |
|---|---|
| #352 개별 local | PASS: Node1225/65, Edge469, fresh100, 99→100, manifest5, 전용SQL68. 실제 근거는 PR365를 따른다 |
| #352 전체DB / required CI | PASS: 정확99→100 포함26 upgrade, SQL78파일·4,640 assertions, KST145, 전체6 경합, fresh100 합성 backup/recovery, WARN/ERROR Advisor0. exact-head CI 두 required checks PASS; 최종 독립 QA·dev 병합은 별도 확인한다 |
| release exact source 전체 검증 | NOT RUN: quality/typecheck/test/build·Edge·Python·fresh100·26 upgrades·전체SQL·KST·전체concurrency·history/advisors·exact-source 합성 복구 |
| release→main required checks·독립QA·리뷰/충돌/보호 규칙 | NOT RUN |
| 호환 recovery artifact | local 격리 fmt/typecheck/old OpenAPI131/141/bundle PASS. 아래 외부 seal을 따른다. 실제 hosted 복구·retry는 NOT RUN |
| 실제 운영 백업 / hosted apply·잠금/transaction/history | NOT VERIFIED / BLOCKED: 현재 보안 direct/session DB 연결 설정이 없으며 합성 백업으로 대체하지 않는다 |
| 운영15건 적용·API/scheduler 배포·각 readback·Swagger Pages | NOT RUN |
| hosted positive mutation·사람 UAT | NOT RUN. 미실행과 프런트 미연결은 [UAT](./UAT_V0.8.0.md)에서 구분한다 |

과거 feature PASS/CI merge tree를 새 release exact-head PASS로 재사용하지 않는다.
초기 FAIL과 이후 보완/재실행은 원 Issue/PR에 보존하며 검사 삭제·skip·기준 완화는 하지 않는다.
로컬 합성 복구는 실제 운영 백업/복구 완료가 아니다.

## 운영 런북

1. #352 dev 통합 후 최신dev를 후보에 반영하고15건/manifest·diff·scope를 재확인한다. release exact HEAD/tree·전체 검증·독립QA·required checks·미해결 리뷰0을 고정한 뒤 승인 범위에서 `release/v0.8.0 → main`을 squash한다. main/dev 직접 push와 보호 우회는 금지한다.
2. merged main exact source를 확정한다. 운영 project identity·85건 head/parity·121실·API38/scheduler16·OpenAPI·주요 원장 건수를 다시 읽는다. 불일치면 중단한다. 승인 범위의 실제 백업과100 호환 recovery 절차를 확보하며 복구 전용 project를 dev DB로 바꾸지 않는다.
3. 도구·잠금/timeout/transaction/history gate를 확인하고 필요한 짧은 업무 조정을 한다. pending86→100을 한 건씩 적용하고 **각 건 직후** history/name/내용·해당 schema/ACL/제약/index를 읽어 확인한다. 새API를 DB보다 먼저 배포하지 않는다.
4. 100건 head `auth_session_hard_expiry`, RLS·service-only RPC·구 취소RPC 직접EXECUTE 거부·새 wrapper 존재·기존 원장/receipt 보존·Security Advisor를 확인한다. 기존 warning과 신규 finding을 분리한다.
5. exact merged main의 `api`와 `reservation-scheduler`를 배포한다. 기존 verify_jwt/static assets·secret/actor·Cron/provider 설정은 유지한다. **각 Function 직후** ACTIVE version·배포 시각/source 대응·health/실행 상태를 읽어 확인한다. 배포 접수만으로 성공 처리하지 않는다.
6. health200·OpenAPI0.6.0/137/148과 새path/DTO·CORS·무인증/무효session 거부·no-store·scheduler heartbeat를 확인한다. 업무 데이터가 없는 positive는 NOT RUN이다. Swagger Pages를 같은 source로 갱신하고 공개 artifact를 읽어 확인한다.
7. 아래 프런트 artifact를 재확인하고 [UAT](./UAT_V0.8.0.md)를 사용자가 실제 필요한 업무에서 선택적으로 진행한다. UI 미연결·데이터 없음·API 결함을 구분하며 결과/code/시각/request ID 등 안전한 정보만 남긴다.
8. 운영 DB·API/scheduler·artifact·안전한 smoke 확인 뒤 승인 범위에서 v0.8.0 태그를 생성하고 Issue364/PR/이 문서를 실제값으로 갱신한다. GitHub Release 발행과 태그 생성은 별도 행위다.

### 장애 시 중단·복구

93 적용 후 구API bundle만 단독 rollback하지 않는다. 85의 구 취소RPC 권한만 복원하거나100의 만료 검사를 제거하는 rollback도 금지한다.
호환 adapter와 필요 시 append-only 후속 migration을 사전 검증한 복구안으로 처리한다.
금전 원장·receipt·snapshot·history를 삭제/되돌리지 않는다.
장애 때 이후 적용을 중단하고 실제 history/배포version·안전한 error/request ID를 확인한다.

### 호환 API recovery 준비 기록

`node scripts/prepare-v08-recovery.mjs --validate`는 고정 old main
`1780728a02144c0816565ba091e43a8b3e126c4f`의 source88 blobs와 검증된 asset5개를 새 ignored `.tmp/v08-recovery-*`에 보존한다.
실제 PIN/crypto/runtime/router/OpenAPI/config/lockfile과 shared assignment core는 old Git blob 그대로다.
취소 adapter 한 파일만 정확16추가/1삭제하여 검증된 bearer session을93의 wrapper로 전달한다.
구RPC fallback·권한 복원·가짜 Auth·원격/DB 명령은 없다. application checkout의 full history는 이 고정 Git snapshot 검증에 필요하며 required checks와 timeout은 유지한다.

| 준비 artifact checkpoint | 실제 결과 |
|---|---|
| retained local directory | `.tmp/v08-recovery-pCyg6p` — 릴리스 worktree 내부, Git에 포함하지 않음 |
| 외부 manifest SHA-256 seal | `dbb132f05a7e939466af62b52e0394a24fd18677e5f4ef1925b32d0037ab835b` |
| api.eszip | 17,095,296 bytes / SHA-256 `ca75b65e1312b1af378287750bb82da70c5825910e54638e077081867a2c4ec6` |
| local 실제 검증 | pinned Docker fmt50·typecheck·old OpenAPI131/141·20MB미만 bundle PASS; 신규12 / 전체1,233 Node tests PASS; 독립 정적 QA 미해결P0/P1/P2=0 |
| DB / hosted deployment / retry | NOT RUN. API 회복만 준비하며 scheduler 등 보존된 다른 Function을 함께 배포하지 않는다 |

manifest 자기기입 hash만으로 출처/실행 성공을 보장하지 않는다. 위 외부 seal과 실제 파일·bundle/source/asset 검사를 함께 확인한다.
이 기록은 dev99 checkpoint의 준비 결과다. 최종 release source 고정 뒤 새 artifact를 만들고 외부 seal을 다시 기록해야 한다.
초기 source closure 누락으로 Docker typecheck가 FAIL했지만 old Git shared core를 포함해 후속 PASS했다.
manifest 안전 발행·allowlist 회귀 보완 이력은 #364에 보존한다. 실제 운영 복구 가능성을 검증한 기록으로 대체하지 않는다.

## 프런트 대조·알려진 잔여 항목

scoped 기준은 `makee-ham/room-management-system`의 dev
`09ed28446a4fd43919cddb29ebe442b848548ab8` / main
`d509b44b1371f25d73891e04d355b0cb0e923f5f`다.
현재 공개HTML은1,842,858 bytes, git blob `0d4c5e301d559c43eafcfb3c8af32802cfde5140`,
SHA-256 `6f45a263cf9997e7a42db3a54d5e4cf14aa764a25acfe9e3995b4849f47836a3`와
**정적 parity만** 확인했다. 전역 제품 snapshot 갱신·브라우저 UAT·실기기 PASS가 아니다.

| 잔여 항목 | 이번 릴리스에서의 처리 |
|---|---|
| 신규 metadata/schedule·marker·adjustment-book·work-details·incident 목록 | 공개HTML은 신규 계약을 미소비한다. API 배포만으로 화면 완료를 선언하지 않는다. 프런트 담당의 generated client/연결 뒤 UAT한다 |
| 취소 버튼 target ID/CAS | `cleaningTargetId`/`targetId`와 `targetAssignmentVersion`을 사용한다. FE의 별칭 `manualCleaningRequestId`/`targetVersion` 변환 gap이 있어 통보 후 취소 화면 성공은 별도 gate다 |
| [#363](https://github.com/wrongstory/room-management-system-backend/issues/363) | strict DB lint는 기존10함수17warning으로 FAIL이다. 일반 WARN/ERROR Advisor0과 혼동하지 않고 기존 baseline으로 추적한다 |
| [#362](https://github.com/wrongstory/room-management-system-backend/issues/362) | 과거 room-move 단발CAS 실패를 추적한다. 이후 PASS만으로 원인 해결을 선언하지 않는다 |
| [#334](https://github.com/wrongstory/room-management-system-backend/issues/334) | 기존Node 의존성 취약점 조사. 운영은 Supabase Edge만 사용하고 미보완 Fastify fallback은 금지한다 |
| [#345](https://github.com/wrongstory/room-management-system-backend/issues/345) | 늦게 등록된 관리자 overdue push가 원event 기준24h TTL로 만료될 수 있다. inbox 보존/업무 비차단과 별개다 |
| [#342](https://github.com/wrongstory/room-management-system-backend/issues/342) | 대형 실패 배정의 사전 잠금 비용. 부분 저장/원장 파괴를 확인했다는 뜻은 아니다 |
| [#344](https://github.com/wrongstory/room-management-system-backend/issues/344) | 실제 알림/화면 진입·사람 운영 UAT. 독립 코드QA와 HTML hash 일치로 대체하지 않는다 |

이 문서로 위 잔여 항목이나 #329/#317을 종료하지 않는다. 실제 PIN·고객 정보·token·key는 문서/로그/Issue에 기록하지 않는다.
