# #416 객실 이력 조회 인덱스 적용 후보

## 범위와 근거

- 기준: `dev`의 `3e91d88f1afb032e7e1991ee1a702ca23ccc63b4`.
- [진단 PR420의 고정된 측정 기록](https://github.com/wrongstory/room-management-system-backend/blob/34aa69c03a8f40603bc8597c0c742defe4d655f6/docs/QUERY_PLAN_EVIDENCE_416.md)을 근거로 두 인덱스만 추가한다. 진단 PR과 별도 적용 후보이며 #416 전체(주급/반복 계산 포함)를 종료하지 않는다.
- `room_candle_events`, `room_pin_sync_events`에 `(room_id, effective_at DESC, recorded_at DESC, id DESC)` 비고유 btree를 추가한다. 기존 recorded-order 인덱스와 촛불 current-state trigger는 유지한다.
- 함수, RLS, 권한, 정책, 기존 행, 공개 요청/응답, Swagger operation은 변경하지 않는다. 개발자 진단의 기대 migration head만 새 파일 이름으로 맞춘다.

로컬 PostgreSQL 17.6의 합성 121객실 × 각 이력 100건 실험에서 전체 객실 현황 RPC median은 과거 71.421→23.039ms, 당일 65.265→29.064ms, 미래 81.761→26.064ms였다. 전체 DTO 해시 3종은 동일했다. 반면 121행 INSERT median은 촛불 5.187→6.324ms, PIN 상태 1.942→2.948ms로 증가했고, 두 인덱스는 합계 1,671,168bytes를 사용했다.

위 수치는 고정 A→B 순서·warm cache·합성 fixture의 DB 측정으로 운영 HTTP p95, 실제 단말 체감 또는 모든 업무 경로의 개선을 보장하지 않는다. 트랜잭션 rollback도 WAL/통계/물리적 흔적을 되돌리지 않는다. 자세한 반복 수·한계는 고정 측정 기록을 따른다.

## 배포/복구 계약

- 새 migration: `20261009081846_room_event_effective_lookup_indexes.sql`; dev manifest 112건(기존 111건 그대로).
- 운영 적용은 최종 승인된 릴리스에서 한 번 진행한다. 이 문서의 로컬 검증은 운영 적용 또는 배포 완료를 의미하지 않는다.
- 일반 트랜잭션 `CREATE INDEX`이며 `CONCURRENTLY`가 아니다. 테이블 쓰기를 차단할 수 있으므로 승인된 짧은 쓰기 중지 구간에서 수행한다. `lock_timeout=5s`는 잠금 대기 상한이지 전체 빌드 시간 상한이 아니다. 잠금 충돌이면 실패를 확인하고 재계획하며 무한 재시도하지 않는다.
- 배포 순서: 승인된 릴리스의 pending migration → 두 인덱스 valid/ready 및 migration history 확인 → 개발자 진단 기대 head가 맞는 API 반영 → 기존 객실 현황/권한 smoke와 조회·쓰기 지연 확인.
- 회귀 시 기존 조회 코드/인덱스가 그대로이므로 API rollback과 별개로 조사할 수 있다. 적용된 migration을 수정/삭제하지 않는다. 새 두 인덱스 제거가 필요하면 별도 승인된 후속 migration으로 정확한 두 이름만 DROP하고 기존 recorded-order 인덱스는 보존한다. 운영 rollback은 아직 실행하지 않았다.
- 프런트 변경/신규 feature flag 없음. 기존 endpoint와 DTO로 확인하며 운영 전후 성능 수치를 섞지 않는다. 사진 snapshot 및 주급 batch 기능은 각 별도 PR의 배포 상태를 따른다.

## 검증 checkpoint (2026-10-09)

- PASS: fresh local reset, migration 112건 적용. Windows 원본 SQL은 보존하고 해시가 같은 LF 임시 검증본 사용.
- PASS: `npm run ci:quality` — typecheck/build 포함, Node 106files/2668tests, OpenAPI 150paths/162operations. lint 기존 정보 수준 안내 19건.
- PASS: 독립 QA 관련 145tests/manifest/diff 점검, P0/P1/P2 발견 없음. 독립 QA는 DB를 동시에 조작하지 않았다.
- 최초 전체 SQL 중 개발자 진단의 이전 head 기대값 3건 FAIL을 수정했다. 이후 전체 재검증 89files/5591tests PASS(새 인덱스 SQL 14건 포함).
- PASS: `npm run edge:check` 전체 검사; 최종 후보 번들 19,226,953bytes로 기존 20,000,000bytes 한도 이내.
- PASS: `node scripts/test-post-approval-room-issue-upgrade.mjs` — 역사110→111의 기존 행/권한/카탈로그 및 실제 명령 검증, 최종112 fresh 복구, 원본 해시 보존.
- PASS: LF 임시 검증본의 `npm run db:test` 전체 28단계 upgrade chain과 마지막 전체 SQL, exit0.
- PASS: 2026-10-09 최종 `npm run ci:quality` 재실행, 106files/2668tests 및 typecheck/build.
- 촛불 경합 본체 PASS 후 원본 CRLF 작업공간의 standalone 정리 reset이 FAIL했다. 정리 도중 시작된 lint도 `cache lookup failed`로 FAIL했다. 두 최초 실행을 PASS로 기록하지 않는다.
- PASS: LF 검증본 fresh reset 복구 후 `npm run db:test:candles`를 순차 재실행하여 경합 본체와 최종 fresh cleanup 모두 exit0.
- PASS: cleanup 완료 후 `npm run db:lint:baseline` — 승인된 기존 경고9건/함수 fingerprint3건 정확히 일치. 원본 strict lint 자체는 기존 경고로 FAIL(exit1)이며 기준 검사는 PASS(exit0); 새 경고 없음.
- PASS: 최종 `npx supabase db advisors --local --type security --level warn --fail-on error` — 해당 수준 문제 없음(exit0). 운영 Advisor 검증을 뜻하지 않는다.
- NOT RUN: 원격 CI, 운영 적용/운영 체감 측정.
- [프런트 #207 인계](https://github.com/makee-ham/room-management-system/issues/207#issuecomment-6077455104): 프런트 수정 불필요, 로컬 후보/운영 미반영 구분. 사진 snapshot·주급 batch의 별도 배포 확인 원칙 유지.

### 인계 checkpoint

작업 브랜치는 `codex/416-room-event-indexes`다. 기존 SQL의 CRLF 원본을 수정하지 않고 LF 검증본에서 검증했다. 원격 CI·독립 QA 근거·미해결 리뷰·브랜치 보호 조건 확인 전 병합하지 않는다. standalone 촛불 검사도 LF 검증본에서 실행하고 cleanup 종료까지 기다린 후 lint를 수행한다. PR은 #416의 일부 구현이므로 `Refs #416`을 사용한다. 주급/issue-count 진단은 잔여 작업이다.

역사 110→111 검사는 111까지만 담은 격리 workspace에서 그대로 수행한다. 최초/마지막 fresh 상태는 최신112를 요구하며,112 tail 파일명과 SHA를 고정해 임의 migration을 허용하지 않는다. notification catalog의 기존111 한 행 예외만112에도 동일 적용하고 다른 추가/변조/삭제는 거부한다.
