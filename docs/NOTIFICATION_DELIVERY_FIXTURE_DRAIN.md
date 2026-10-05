# #371 알림 전달 fixture 정리 계약

## 목적과 범위

[Issue #371](https://github.com/wrongstory/room-management-system-backend/issues/371)은
동시성 검사 앞에서 기존 합성 fixture의 현재 처리 가능한 알림 작업을 정리하는
테스트 코드만 보완한다. 운영 delivery RPC, worker, provider 호출, 테이블·RLS·migration,
HTTP API 계약은 변경하지 않는다.

최초 구현·검증 기준은 `dev@e9fcc564dfb4acd2cc4e175df7d1421dbb6b07e5`와 100개 migration이다.
PR #374 dev 병합 후 `dev@a103db80d4e849db64b79211cff2de96a00a7193`/101 migrations를
반영해 새 통합본을 재검증한다. #371 자체는 migration을 추가하지 않는다.
`release/v0.8.0@5408c54e032273cdf300d90b91ebda38c9587a7c` / Draft PR #366과
별도 #329 후보에는 이 변경을 자동으로 섞지 않는다. 운영·복구 DB, Auth 설정,
암호키, 실제 PIN·송금, provider·Cron도 변경하지 않는다.

## 기존 실패와 확인된 결함

릴리스 CI `37127623239`의 application은 PASS, migration은 기존 fixture drain의
`bounded delivery fixture drain converges` 검사에서 FAIL했다. 당시 최종 잔여 작업의
상태별 집계가 없어 그 실행의 직접 원인은 아직 확정하지 못했다.

다만 기존 테스트 소스에서 다음 두 결함은 확인했다.

- target 집계가 parent job 상태를 무시해, 실제 claim이 제외하는 blocked parent의
  target까지 정리 대상으로 계산한다.
- 최대 100번째 claim 직후 재계수하지 않고 실패해, 마지막 허용 호출로 작업이
  소진된 경우도 실패할 수 있다.

따라서 이 수정은 확인된 테스트 결함을 해결하며, 기존 CI의 직접 원인을 확정하거나
운영 알림 장애를 해결했다고 표현하지 않는다. #362의 객실 이동 CAS 진단도 별도다.

## 정리 대상과 종료 기준

기준 RPC는 `20260912123000_assignment_notification_coverage.sql`의
`public.claim_notification_deliveries(text, integer)`다. 고정된 한 DB 관측 시각으로
다음 작업만 정리 대상으로 계산한다.

- `pending` job: 최초 fanout 또는 terminal suppression 처리 전이므로 target이
  없어도 남은 작업이다.
- parent가 `materialized`이고 target이 `pending/retry/claimed`이며
  `next_attempt_at <= 관측 시각`인 작업. `claimed`는
  `lease_expires_at <= 관측 시각`인 경우만 포함한다.

각 호출은 새로운 digest를 쓰므로 동일 digest의 live-lease replay는 정리 대상으로
계산하지 않는다. operator-blocked/terminal parent, 미래 retry, live lease는 제외한다.
NULL lease는 expired로 추측하지 않는다. 표준 SQL은 production claim과 달리 잠금을
얻거나 상태를 바꾸지 않는 테스트 전용 관측이다.

기존 상한인 **최대 100회, 호출당 limit 10**을 유지한다. 시작 전에 한 번 읽고,
필요할 때 claim한 뒤 매번 다시 읽는다. 100번째 직후 남은 작업이 0이면 성공하고,
실제 처리 가능한 작업이 남아 있으면 실패한다. `items=[]`만으로 성공이나 정체를
판정하지 않는다. 빈 반환으로도 pending job이 suppress될 수 있기 때문이다.

오류·잘못된 집계·잘못된 claim 응답은 성공으로 무시하지 않는다. 진행·실패 진단에는
고정된 상태별 정수 집계와 호출 횟수만 포함하며 UUID, endpoint, digest, session,
provider 원문 응답, SQL 오류 원문, PIN을 새 로그에 넣지 않는다.

## 검증과 승격

독립 단위 검사는 0/1/100번째 소진, 100회 후 잔여 실패, 빈 items의 job 처리,
잘못된 입력·오류·민감 원문 비노출을 확인한다. 실제 PostgreSQL 검사는 transaction-local
임시 테이블의 합성 상태 조합에 동일한 관측 SQL을 적용해 parent/시간/lease 경계를
검증한다. production 테이블·RPC는 이 probe에서 변경하지 않는다.

이후 기존 fanout/takeover/block/resume 경합 검사를 그대로 실행한다. 기존
`db:test:concurrency` 연결을 유지하며 테스트 삭제·skip·무한 retry·시간 상한 완화로
성공 처리하지 않는다. Windows에서는 승인된 Git 원본을 보존하고 줄바꿈만 LF로 바꾼
임시 검증본을 사용할 수 있다. 원본 raw SHA의 불변성과 임시 migration의 LF-normalized
manifest SHA를 각각 확인하며, 서로 다른 두 SHA 비교를 혼동하지 않는다. 원본
migration·manifest는 수정하지 않는다.

## 2026-10-04 최초 source/100 migrations 검증 checkpoint

- 기준 `npm test`: 65개 파일·1,229건 PASS. 최종 `npm run ci:quality`:
  66개 파일·1,294건, typecheck/build/OpenAPI 137/148/secrets835 PASS.
  기존 Biome INFO5건은 그대로다.
- targeted 회귀65건, scripts syntax2개, targeted Biome3개, diff check PASS.
- Edge470/fmt99/bundle17,520,444 bytes, Python95/ruff/fmt226/mypy25/
  ephemeral codegen/build source check PASS. 기존 codegen 경고는 유지한다.
- 5개 manifest와 기존100 migration의 canonical SHA PASS. 최종 LF snapshot에
  복사한 원본288개 raw SHA의 불변성도 확인했다.
- 최종 fresh100 `npm run db:verify`, 실제 temp-only predicate probe,
  전체 SQL78개 파일·4,641건 PASS. source/RLS/권한을 바꿔서 통과시키지 않았다.
- 최초 helper 구현의 `db:test:concurrency` 6개 체인과 fresh cleanup PASS.
  QA stderr 보완까지 반영한 최종 snapshot의 6개 체인도 exit0/PASS다.
  최종 drain은 94회 후 현재 처리 가능한 잔여 0이며 100회/limit10 상한은 그대로다.
  fresh cleanup의 100/head 일치·rooms121/profiles0/Auth users0/Auth sessions0을 확인했다.
- 최종 독립 source QA98/100·확인된 P0/P1/P2=0. QA가 직접 syntax2·targeted65·
  Biome3·diff check를 실행했다. DB·CI·사람 GitHub 승인을 대신 주장하지 않는다.
- source `6177eb93b6f455a6aebc5dfd648aed84f02f46ff`의 원격 required CI
  `37168729600` application/migration PASS를 확인했다.

실패·보완 이력도 구분한다. QA에서 sync child가 catch 전에 raw stderr를 출력하는
P2를 찾아 `stdio: 'pipe'`로 보완했다. actual Node child로 최종 probe/summary의
비노출과 메모리상 legacy control의 선행 출력까지 확인했다. 이때 새 VM 회귀63건 중
1건은 합성 context에 Buffer를 제공하지 않아 FAIL했고, context만 보완한 뒤63건 PASS,
legacy controls를 추가한 최종65건 PASS다. 추가 ad-hoc SHA 명령은 없는 manifest
version 필드를 읽어 ENOENT/FAIL했지만 source/manifest는 변경하지 않았다. sorted
filename/name 기반으로 명령을 정정해100 SHA 검사를 통과했고 공식 manifest도 재검사했다.

## 2026-10-04 최신 dev/101 migrations 통합 gate

사용자는 #374 → #375 순서의 dev 통합을 승인했다. #363/#373 PR #374는 exact-head
CI `37165344729` application/migration PASS와 독립 QA98을 확인한 뒤 dev squash
`a103db80d4e849db64b79211cff2de96a00a7193`로 병합했다. #375는 해당 dev의
101번째 append와 정확한 호환9개 lint gate를 반영한다. 원본 strict FAIL9/exit1을
보존하며 #371의 테스트-only 변경과 #363의 이미 통합된 변경 범위를 구분한다.

새 통합본에서 다음 검사를 실제 실행했다. 기존100 PASS와 별개인 검증 기록이다.

- PASS: `ci:quality` Node1,432/67 files·typecheck/build·OpenAPI137/148·secrets843,
  5개 manifest/101 canonical migration SHA. 기존 Biome INFO5건은 그대로다.
- PASS: 원본 보존 LF Edge 검증본 fmt99/check/470 tests/bundle17,440,775 bytes.
  bundle 수치는 LF 검증본 산출값이며 Windows 원본 bundle 크기로 표시하지 않는다.
  첫 임시 복제본은 test fixture 누락으로 BLOCKED였고 복제 범위를 보완한 뒤 PASS다.
  원본282개 source와69개 test raw SHA 및 복제 parity를 확인했다.
- PASS: Python frozen/offline sync·ruff/fmt226·mypy25·pytest95·ephemeral OpenAPI
  codegen137/148·build check. 기존 사진 binary/AttemptLifecycle 생성기 경고는 유지한다.
- PASS: 원본 보존 LF DB 검증본 fresh101·local-synthetic backup·26 upgrades·
  전체 SQL79 files/4,718. 원본294개 파일의 raw SHA도 검증 후 다시 확인했다.
- 원본 strict lint는 FAIL9/exit1이다. 별도 exact9/catalog3 gate는 PASS이며
  `db:test:static-warning`의100→101/source-drift 원자 rollback/모든 이전 row·catalog·
  ACL/RLS/receipt replay·latest fresh101 cleanup도 PASS다.
- PASS: KST5×29=145 assertions, `db:test:concurrency` 6개 suite 전체 exit0.
  최종 실제 drain93회/현재 처리 가능 잔여0, 100회/limit10 유지. 마지막 fresh cleanup은
  migrations101/head 일치·rooms121/profiles0/Auth users0/Auth sessions0이다.
- PASS: 새 통합 working-tree/index 독립 source QA98/100·P0/P1/P2=0,
  syntax2·targeted65·Biome3·diff check와 peer baseline138. 첫 peer baseline 실행은
  ignored LF 복제본까지 발견해2files/276이었으며 `.tmp/**` 복제본만 제외한 재실행은
  원본1file/138이다. 중복 수치를 새로운 source 검사 건수로 확대하지 않는다.
- PENDING: commit/push 이후 새 exact-head required application/migration CI와
  protected dev 통합. 이 문서는 commit 직전 checkpoint이며 이후 최종 판정과
  source/dev SHA·tree mapping은 PR #375 및 Issue #371에 기록한다.

release PR #366의 source/CI, 운영 반영·사용자 UAT·태그/Release는 별도 gate이며
이번 dev 통합 승인으로 자동 변경하지 않는다.
