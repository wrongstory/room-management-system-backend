# 개발 오케스트레이션·source 승인 기준

> 2026-10-04 최신 승인: 사용자가 #374 → #375의 dev 통합을 승인했다. #363/#373 PR #374는 source `8edc9fb1`의 required CI `37165344729` application/migration PASS·독립 QA98/100·미해결 P0/P1/P2=0을 확인하고 dev에 squash `a103db80d4e849db64b79211cff2de96a00a7193`로 병합했다. source/dev tree `4384747a650026c2359c309897f015441b49fb92`는 같다. 경고8개 보완 및 호환9개 exact baseline gate는 통합됐지만 원본 strict는 FAIL9/exit1을 유지한다. [계약과 과거 실행 기록](./DB_STATIC_WARNING_BASELINE.md)을 따른다. 아래 strict17/Draft/미병합 표현은 과거 checkpoint다.

> [#371 알림 fixture drain](./NOTIFICATION_DELIVERY_FIXTURE_DRAIN.md) PR #375의 기존 source `6177eb93`/100 migrations는 required CI `37168729600` application/migration PASS·독립 QA98이었다. 위 dev/101 통합본의 실제 local Node1,432·Edge470·Python95·fresh101·26 upgrades/SQL4,718·exact9 gate/static upgrade·KST145·6경합/cleanup·독립 QA98도 PASS다. 최종 drain93회/현재 처리 가능 잔여0이며 원본294개 raw SHA를 보존했다. 새 exact-head CI와 dev 병합은 commit 이후 후속 gate이며 최신 판정·source/dev mapping은 PR #375/#371에 기록한다. 기존100 PASS를 새101 통합본이나 동결 release PR #366의 PASS로 대체하지 않는다. #329 Draft PR #372·release/main·운영 DB/API·태그는 이번 dev 통합 승인 범위에서 변경하지 않는다. 아래 과거 checkpoint를 운영 완료로 해석하지 않는다.

> 2026-10-03 최신 승인: 사용자가 순차 개발과 중간 릴리스·운영 배포·문서 정리를 승인했다. #331은 PR361의 source087407b → dev squash eb1ec3e로 통합됐다. exact-head CI37111364892 application/migration(전체 upgrade·SQL·KST·경합·cleanup) PASS, 독립 QA98/100·범위 내 미해결 P0/P1/P2=0이다. 아래 #331 후보/Draft·진단용 승인만이라는 문구는 과거 checkpoint다. 기존 strict lint17/INFO inventory FAIL은 #363, 단발 CAS 원인 추적은 #362로 유지한다.

> 중간 점검 릴리스는 [#364](https://github.com/wrongstory/room-management-system-backend/issues/364)의 v0.8.0 후보다. #329의 기존 로그인 계약과 운영 배포에 선행하는 공용 세션 `not_after` 검사 #352를 별도 PR로 먼저 보완한다. 현재 dev에 완료된 기능과 #352만 첫 릴리스에 포함하며, #329 → #317은 그 이후 순차 구현한다. release/main 필수 검증·독립 QA·CI·protected 병합 후에만 승인된 pending DB → exact API 및 reservation-scheduler를 배포하고 smoke·문서·태그를 확인한다. 프런트 source, Node fallback 활성화, Auth 설정, 키, 실제 PIN/송금, provider/Cron/TASK는 변경하지 않는다. 실제 배포 완료나 사용자 UAT 통과를 선행 기록하지 않는다.

> 2026-10-03 현재: #327은 [PR #357](https://github.com/wrongstory/room-management-system-backend/pull/357)의 source `22cbf0be9ed2c5e228e6c5091059c2052a61adce` → dev squash `b6f799811416fad6f80dba3d721ba279159c0aa8`로 완료했다. source/dev/CI merge tree 동일, required CI `37086130779` application/migration PASS·독립 QA98/100이다. 아래 #327 후보·#328 Draft 문구는 과거 checkpoint다. #325는 이 dev/96 migrations에서 최신 주급 조정 원장 CAS 조회를 추가하는 별도 후보다. [조회 계약과 검증 상태](./PAYROLL_ADJUSTMENT_BOOK.md)를 따르며, 운영·프런트 제공 완료를 뜻하지 않는다.

> 2026-10-03 현재: #328은 [PR #351](https://github.com/wrongstory/room-management-system-backend/pull/351)의 source `76e2780c0304a7336433cdd17e585610360785e3` → dev squash `3968e42967c8ad223661b7a3eb4ce200aabd2499`로 완료했다. 두 tree와 CI merge tree가 같고 required CI `37027527827` application/migration PASS·독립 QA98/100이다. 아래 Draft·후속 gate 표현은 과거 checkpoint다. #327은 이 dev/95 migrations에서 관리자 open 사건 목록을 구현 중인 후보이며 현재 source OpenAPI 목표는 132 paths·142 operations다. 신규 96번째 migration과 검증·운영 제외 범위는 [관리자 미퇴실 목록 계약](./CHECKOUT_INCIDENT_ADMIN_LIST.md)을 따른다. production/main/recovery·프런트 UI/UAT 완료를 뜻하지 않는다.

> #328 최신 gate(2026-10-03): 세션 만료·KST fixture 보완 후 local 개별 검증은 PASS다(Node859·Edge323·Python95·같은 migration SHA의21 upgrades·전체SQL4161·KST145·전체동시성·fresh95·advisors0·합성복구). 초기 전체 `db:test` FAIL과 원래 CI `37017832732`의 migration FAIL은 이력으로 보존한다. 최종 독립 QA·새 exact-head CI·dev 통합은 후속 gate이며 [PR #351](https://github.com/wrongstory/room-management-system-backend/pull/351)은 아직 Draft다. [상세 실행 기록](./ASSIGNMENT_SCHEDULE_SNAPSHOT.md#보완-후-local-개별-최종-검증)을 따른다.

2026-09-23에 정한 개발 진행 원칙과 이후 source 승인 근거를 기록한다. 사용자는 기능 구현·배포와 직접 화면 확인을 우선하고,
보안·대규모 검증 보강은 기능 흐름 확인 뒤 묶어서 진행하기로 했다. 다만 migration 불변성, 비밀값·PII·PIN
비노출, required CI, 승인 없는 production 변경 금지처럼 되돌리기 어렵거나 운영 데이터를 위험하게 만드는
gate는 기능 우선순위와 무관하게 유지한다.

## 2026-10-03 다음 기능 순서

#327/#325/#324는 각각 PR357/358/359로 dev 통합 완료했다. 다음 bounded context 순서는
#331 송금 표시 → #329 제한 계정 재진입 → #317이다.
현재 #331만 구현하며 사용자 최종 선택에 따라 표시·별도 재확인 이력을 분리한다.
기존 주급 명령·원장·집계/실제 지급 정책을 바꾸지 않는다.
current/past KST 주차 조회와 source의 실제 maid 귀속은 유지한다.
정본·호환성·최종 gate는 [#331 표시 계약](./PAYROLL_REMITTANCE_MARKER.md)을 따른다.
선행 dev는8481e21/98 migrations·134 paths/144 operations이며 현재 후보는
99 migrations·137 paths/148 operations다. 이는 운영 배포나
프런트 완료를 뜻하지 않으며 다른 OPEN PR의 충돌·검증·정책을 임의 해결하지 않는다.

## 역할과 진행 단위

- Codex: 정본·Issue·원격 head 확인, 작업 분할, 통합 검증, 점수 평가, 진행 현황 정리.
- 구현 서브에이전트: 하나의 bounded context 안에서 파일 소유권을 나누어 구현·회귀 작성.
- 독립 QA 서브에이전트: 본인이 구현하지 않은 최종 diff의 정책·권한·동시성·노출 경계 검토.
- 외부 GPT 리뷰가 있으면 exact-head 근거를 보존한다. COMMENTED를 APPROVED로 표현하지 않는다.

작업 순서: 정본 확인 → feature 분기 → 구현/테스트 → Codex 통합 검증 → 독립 QA →
exact-head CI → 평가·승인 기록 → 허용된 경우 dev squash 병합 → tree/head/Issue 상태 확인.
GitHub 보호 규칙을 우회하지 않으며, 구현·검증·승인·병합·운영 배포는 각각 별도 상태다.

## 평가와 중단 조건

| 평가 영역 | 배점 | 확인 근거 |
|---|---:|---|
| 승인 요구사항·범위 | 25 | 정본/Issue와 구현 및 제외 범위 대응 |
| 보안·무결성 | 30 | 역할·session·ownership·CAS·멱등성·RLS·비밀값 격리 |
| 실제 검증 | 25 | fresh DB/동시성/Edge/application/Python/CI 결과 |
| 운영·문서 인계 | 20 | API/OpenAPI/생성 client/상태표/제한/배포 경계 |

**90점 이상**일 때만 Codex가 source/dev 승인을 내릴 수 있다. 다음은 점수와 무관한 필수 gate다.

- in-scope P0/P1 0건, 승인된 요구사항 범위, 독립 QA 완료.
- exact-head `application`/`migration` 및 해당 변경의 필수 검증 PASS.
- 미해결 blocking review thread 없음, 충돌 없음, 기존 migration/history 보존.
- head가 바뀌면 변경 범위 재검토, 검증/CI 및 독립 QA 갱신 후 다시 평가.
- 저장소 보호 규칙 충족. 관리자 bypass/force push/auto-merge로 대기 gate 우회 금지.

90점 미만 또는 필수 gate가 막히면 안전한 상태로 작업을 정리하고 리뷰·남은 blocker를 남긴 뒤
사용자에게 승인을 요청한다. FAIL/BLOCKED/NOT RUN을 PASS로 적거나 점수로 상쇄하지 않는다.
범위 밖 기존 결함은 별도 Issue와 영향/배포 제한을 공개하며 현재 PR의 P0/P1와 구분한다.

## 변경 금지 영역

별도 명시적 허가 전에는 production/recovery DB·migration·secret·Edge·Cron/Vault·Pages,
main/release 승격, tag/GitHub Release를 변경하지 않는다. feature/dev source를 직접 배포하지 않는다.
기존 원격 migration 수정·history rewrite, 보호 규칙 완화, secret/PII/PIN 기록은 금지다.

## 2026-10-02 #328 진행 기준

- 현재 선행 dev는 #326 PR #350이 통합된 `f34dca3746a1e553a773470aba13b55fa95bf816`/94 migrations다.
  source `2eb489c`와 dev squash의 동일 tree, required CI `36987938462` application/migration PASS,
  독립 QA98/100으로 #326 source/dev 완료를 확인했다. 아래 후보/PENDING/FAIL 기록은 당시 이력이다.
- 다음 기능 순서는 #328(배정 일정 snapshot·현재 actual 분리) → #327(사건 목록)이다.
  #328의 95번째 migration/카드 DTO는 로컬 검증 완료 후보다. Node 859·Edge 323·Python 95·
  SQL 4,152·21 upgrade·KST 145·전체 동시성·fresh 95·advisors 0건·합성 백업 복구 PASS다.
  최종 독립 QA·exact-head CI·dev 통합은 연결 Issue/PR에서 확인하며 #326 결과를 재사용하지 않는다.
- 독립 QA round 1의 P1 role race는 adapter 초기 role과 RPC 최신 role을 `p_expected_actor_role`로
  묶어 기존 403으로 닫는 보완을 구현했다. 당시 exact-source 재검증·최종 QA는 PENDING이었으며,
  이후 local 전면 PASS와 최종 QA/CI 후속 gate를 구분한다.
  과거 1차 quality 857 PASS, Edge 321 PASS/1 FAIL, fresh 95 sourceDrift CRLF FAIL과 당시 보완/
  미재실행 상태는 [일정 계약의 실제 실행 이력](./ASSIGNMENT_SCHEDULE_SNAPSHOT.md)에 보존한다.
  후속 Node 859·Edge 323/bundle 17,240,776 bytes·Python 95/전체 Ruff/mypy/codegen/build check,
  CRLF 보완 fresh 95·전용 94→95 upgrade·targeted 4 SQL files/339 tests는 실제 PASS지만
  마지막 raw-column grant 보완 전 실행이다. 이후 추가 역할별 거부와 최종 전면 재검증도 위와 같이
  PASS했다. 이 절은 PR 생성 전 검증 시점 기록이다. 최종 QA 점수·exact-head CI·dev squash/Issue 종료는
  [Issue #328](https://github.com/wrongstory/room-management-system-backend/issues/328)의 연결 PR을 따른다.
- scheduleSnapshot은 생성 계획·최초 통보의 실제 사실을 보존한다. 현재 목록에만 exact current
  notified source의 currentDeparture를 별도로 제공하며 history/includeHistory는 항상 null이다.
  legacy backfill·현재 예약 재수화·기본 시각 추측·Preview/command 응답 확대는 하지 않는다.
- 업무 authority/RLS는 유지하되 두 저장 테이블의 authenticated SELECT를 pre95 컬럼별로
  좁혀 신규 JSONB 원문·내부 binding의 Data API 직접 조회를 차단한다. 기존 명시 컬럼/count/join·
  service_role table grant는 유지하고 `SELECT *`/whole-row는 의도적으로 `42501`이다.
- Fastify/Edge/OpenAPI·생성 client·문서는 함께 검증하며 [일정 계약](./ASSIGNMENT_SCHEDULE_SNAPSHOT.md)의
  실제 검증 gate를 따른다. scoped 프런트 main/dev 확인은 전역 제품 snapshot 업그레이드가 아니다.
  production/main/recovery·프런트 개발·PIN·UAT·tag는 변경하지 않는다.

## 과거 2026-10-02 #326 source 진행 기준 — PR #350 병합 전 검증 이력

- 현재 선행 통합 기준은 `dev@f72c43d4ac9d8b5abc4e700dd38392cc01ba804a`다.
  #348 수동 요청 취소 B안·PIN 제한 제거가 source/dev에 통합된 93 migrations 기준이며
  OpenAPI 131 paths·141 operations / catalog 59 family·42 category는 유지한다.
- #305는 PR #347의 exact-head CI `36960375990` application/migration PASS·독립 QA98·dev 통합 뒤 CLOSED다.
  근거와 보존할 제한은 [#305 종료 감사](./WORK_DEADLINE_CLOSURE.md)를 따른다.
- #348 통합 전 재개 검증은 전용 SQL 147·Edge 312·Node 715·Python console 95 tests,
  19 upgrades·전체 SQL 3,931·KST145·전체 경합·복구 PASS였다. 당시 두 full-command FAIL 이력도
  보존한다. 이 결과를 신규 #326 검증으로 재사용하지 않는다. 선행 취소 정책·통합 근거와 제한은
  [수동 요청 취소 계약](./MANUAL_CLEANING_CANCEL.md)을 따른다.
- 다음 기능 순서는 #326(snapshot·등록 근거·취소 capability 조회) → #328(메이드 일정 projection)
  → #327(사건 목록)이다. 사용자의 B안 및 PIN 제한 전부 제거 결정을 #326 조회에도 그대로 따른다.
  #326은 기존 endpoint·ID/CAS를 유지하는 94번째 migration/DTO 구현 후보이며 source write·
  과거 receipt 재수화·snapshot backfill·신규 자동 취소 정책을 넣지 않는다.
  최신 local PASS는 fresh 94 reset 재실행·focused Node 156/Deno 34/typecheck/lint·QA 2차 후
  `ci:quality` 795 tests/55 files(secrets/lint/typecheck/build/OpenAPI 12 포함)·Edge 318 tests /
  bundle 17,204,763 bytes·Python console 95/full Ruff·mypy·codegen·build다.
  5 manifests·candidate backup 94·DB lint exit 0도 PASS다. 기존 10 functions warning은 유지하고
  #326 추가 경고는 없으며 local public base 49개/RLS 누락 0개다. 이전 중간 PASS 수치와 첫
  focused 기대 객체 7건·ReturnType lint 1건·Edge format FAIL/재검증 PASS는 계약 문서에 보존한다.
  독립 QA 1차 P2는 raw snapshot 빈/비문자 key의 SQL null 대 TS 500 불일치이며 raw normalizer와
  fresh strict pack parser 분리 및 SQL Preview classifier 보완으로 정적 resolved다. 최종 QA는
  아직 PENDING이며 조회 계약은 raw optional key unknown null,
  malformed fresh pack safe 500을 구분한다. legacy elevator A/B fallback 제거는 routing 입력
  변경이므로 새 metadata fingerprint 제외와 별개로 재Preview가 필요하다.
  upgrade 1·2차 FAIL은 1일 fixture가 기존 deferred `AVAILABILITY_WEEK_REQUIRES_SEVEN_DAYS` /
  `23514` 제약을 위반한 원인이다. 제약을 유지한 정상 7일 fixture로 upgrade 3차는 실제 PASS했고
  cleanup fresh 94도 PASS다. 전용 SQL 135는 `SET CONSTRAINTS ALL IMMEDIATE` 추가 후 PASS다.
  QA 2차 P2는 기존 카드/DB/OpenAPI에 없는 표시 metadata 100자 상한이었으며 임의 상한 제거·
  1,001자 이름 회귀 후 정적 resolved(P0/P1/미해결 코드 P2=0)다. 기존 optimizer routing `str(100)`와
  fresh pack reject는 유지한다. 위 최신 quality/Edge/focused는 QA 2차 보완 후보의 실제 실행이다.
  전체 `npm run db:test` exit 0, 명시 20 upgrades 및 72 SQL files/4,068 tests PASS이며 실제
  request/신규 receipt 긴 이름·보존 및 전용 SQL 137을 포함한다. 전용 SQL 135는 이전 별도 실행,
  137은 full suite 결과로 구분한다. KST 5 clocks×29=145 PASS도 확인했다.
  전체 실제 concurrency 및 cleanup fresh 94, local advisor 결과 0건/exit 0도 PASS다.
  clean source commit 이후 exact-source backup·exact-head CI·최종 독립 QA·PR/dev 통합 근거는
  연결 Issue/PR에서 확인하는 PENDING gate다. 이 문서와 승인 source가 dev 정본에 포함되고 연결 Issue/PR의
  exact-head CI/QA 승인·실제 dev 통합 근거를 확인해야 source/dev 완료 효력이 발생한다.
  현재 이미 병합/Issue 종료됐다는 주장이나 운영 승격 승인은 아니다.
  [조회 metadata 계약](./ASSIGNMENT_TARGET_READ_METADATA.md)에 실제 결과를 단계별 기록한다.
  프런트 scoped main/dev 대조는 인계 근거일 뿐 전역 제품 snapshot 갱신이나 프런트 개발/UAT가 아니다.
- `main@1780728a02144c0816565ba091e43a8b3e126c4f`는 이번 작업에서 변경하지 않는다.
  production/recovery DB·Edge·Cron/provider·프런트·tag/UAT는 별도 승인·검증 범위다.
- #13/#300/#320/#341/#342/#344/#345는 부모 #305 종료와 별도로 OPEN 추적한다.
  과거 CI FAIL은 재검증 PASS로 지우지 않는다. #300의 검사 기준 변경에는 별도 결정·보안 검토가 필요하다.

## 2026-09-23 진행 snapshot (과거 기록)

아래 head·runtime·입력값은 당시 기록이다. 현재 운영 재검증이나 새 배포 권한을 뜻하지 않는다.

- 운영 Git 정본은 `main@10a1f814649e92260e9e7353ab242400311b429e`이고 최신 기능 통합 지점은 `dev@2ce8953c76fbf5cb33aff9f8a57b303acbf05cdb`다. 개발 정본은 #171까지 81 migrations / OpenAPI 0.5.1 129 paths / 139 operations이고 #172는 82번째 feature 후보다. production runtime은 78 migrations / OpenAPI 0.5.1 128 paths / 138 operations이다. Pages parity와 기존 관리자 `guestCount` UAT는 완료됐지만 #256 사진 정규화와 #250/#264 배정 후속의 운영 승격은 남아 있다.
- Web Push는 사용자 실제 기기 수신을 확인했다. 내부 health와 secret 상태는 별도 안전 projection으로 확인한다.
- Google human owner는 `yeosucastletheart@gmail.com`으로 정했고, 서버는 별도 최소 권한 service account를 사용한다. 실제 target/credential/Cron 활성화는 별도 운영 gate다.
- 원 maid가 퇴사·부상 등으로 수행 불가한 일반 청소는 현재 배정을 취소하고 같은 target을 미배정으로 돌린다. 검수 반려 재청소는 기존 0원 target을 이력으로 종료하고 원 유상 snapshot의 별도 ordinary replacement target을 만든다. 관리자 알림과 backend API는 #264로 source/dev 완료됐고 프런트 연결·운영 승격은 후속이다. 별도 보상 원장은 만들지 않는다.
- DB 논리 백업은 매일 01:00~06:00 KST, 15일 보관으로 확정했다. 정확한 시각과 추후 지정할 PC 로컬 경로는 아직 입력값이다.
- `v0.3.0`은 소급 tag/Release를 만들지 않으며, `v0.5.1` tag/GitHub Release도 별도 승인 전까지 발행하지 않는다.

새 작업은 사용자가 확인할 실제 기능과 API 연결을 먼저 작은 PR로 닫고, 검증·보안 후속을 숨기지 않고 Issue로 남긴다. 정책 미확정이나 외부 자격증명·저장 경로는 추측하지 않는다.
