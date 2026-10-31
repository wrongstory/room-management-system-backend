# #543 비밀번호 효과 반영 후 완료 기록 누락

2026-10-31: 변경된 비밀번호로 로그인은 사용자 확인 완료. 재변경은 미완료 receipt 때문에409.
운영 최근 관리자 요청의 Auth version은 effect marker와 일치하고 원 세션은 존재하지 않는다.
이는 #535 반환값 누락/미실행 복구와 다른 단계다. 새 문의번호9347eeac-ecd2-4a4b-8634-9520540052d1의 개별로그연결은 미확인이다.

## 수정 후보

공통 assert/inspect/prepare의 최신세션 검사는 그대로다. complete만 활성계정·Auth연결·원sessiondigest·request hash·claim을 묶고 Auth사용자/shadowversion 잠금 아래 실제effect를 검증한다.
원세션이 없을 때는 auth_pending과 아직유효한lease가 필수이며 잠금대기후 재확인한다. reset준비/다른version/NULL fingerprint/다른session/비활성계정은 거부한다.
기존 gate·감사·receipt 완료와 다른세션종료를 동일transaction으로 처리한다. 새세션이나토큰은 생성하지 않는다.
세션이없어진뒤204라면 후속auth/me401은 새비밀번호재로그인 안내로 처리한다. 프런트기존 passwordChanged 분기는 이 흐름과 호환되며 일반409안내는 frontend271에인계한다.

## 운영 복구 경계

기존 관리자 pending은 이미lease만료이므로 새완료RPC에 그대로재전송하지않는다. #535 unstarted helper도 적용금지다.
별도효과증명 운영복구는 exactreceipt/생성·변경시각/Authversion/감사없음/reset없음과 요청종료를 확인하고 gate·감사·receipt를 원자적으로 완료해야 한다. 세션정리 영향과 실행범위 승인 전에는 운영자료를 변경하지 않는다. 현재 복구 실행파일은 아직 미작성이다.

## 검증 상태

새 migration124 (운영 main123 기반) 작성만 완료. manifest/source 검사 가능, 실제SQL/경합/운영migration/계정복구 NOT RUN.
전체DB는 최종릴리스에서 새입력에 대한 사전승인 후1회만 실행한다. #537의 다른입력 성공을 이 후보에 재사용하지 않는다.
최초 dev142 후보는 소스5666/독립QA233 PASS이나 Edge크기초과로FAIL. dev후보를stash로보존하고 운영main123+수정1로분리했다. 긴급후보 ci:quality 전체3169 PASS, 추가exact-source 관련161 PASS, Edge전체PASS(bundle19,431,880 bytes), 독립QA204 PASS. 실제DB는NOT RUN.
독립QA의 NULL hash 및효과변경/reset/inconsistent/cross-auth 음성검사 보완 반영. 소스전체/Edge 검증결과는 issue543에기록한다.

Refs: #543, #535. 공개API/Swagger계약 변경없음. 운영반영전완료로표기하지않는다.

## 2026-10-31 승인 및 기존 요청 복구 준비

- 사용자 승인: 이번 후보의 격리 CI 전체 DB 검증 1회. 운영 migration과 기존 요청 복구 실행은 포함하지 않는다.
- 최종 소스 후보: `fb9f1cc`, main `f1fbec9`의 기존 123개 + completion 함수 1개. 문서만 추가하며 검증 입력은 유지한다.
- 실행 전 확인: 해당 브랜치 PR/CI 이력 없음. 실제 전체 DB 실행 0회. PR 생성 시 quality workflow에서 시작하며 실패·취소 후 자동 재실행하지 않는다.
- 상위 작업 환경 PR 지침은 hotfix → main 자동 생성을 금지한다. 브랜치 push와 검토 본문 준비 후 사용자 PR 생성이 필요하다. 우회 workflow나 다른 브랜치로 전체 dev 기능을 섞지 않는다.

### 기존 관리자 요청 복구 절차 초안 — 아직 실행 불가

1. 대상은 2026-10-30 18:30:49.453414 UTC 생성된 관리자 요청 한 건이다. 실제 실행에서는 정확한 receipt ID·actor/Auth ID·생성/변경 시각·attempt·effect version을 보안 실행 입력으로 고정하고, 일치하지 않으면 중단한다. 공개 문서에 계정 식별자·비밀번호·claim을 기록하지 않는다.
2. 현재 Auth effect 일치, 상태 auth_pending, lease 만료, 원세션 없음, 해당 요청의 완료 감사 없음, reset 연결/준비 marker 없음을 재조회한다. 비밀번호가 이미 바뀐 요청이므로 #535 미실행 요청 복구 도구는 사용하지 않는다.
3. 복구 시점의 새 비밀번호 변경/관리자 초기화와 충돌하지 않도록 해당 기능 일시중지·기존 실행 종료 확인이 필요하다. 이전 #535 유지보수 승인을 이번 작업에 재사용하지 않는다. 차단 전 ACL을 저장한다. COMMIT 응답 유실 등 결과가 불확실하면 무조건 권한을 복원하지 않고 읽기 전용 정합 확인 후 해제한다.
4. 별도 검토된 관리자 실행 transaction에서 actor advisory lock → profile → exact receipt → Auth 사용자 → password version 순으로 잠근 뒤 모든 조건을 다시 검사한다. 만료 lease를 연장하거나 원세션을 위조해서 일반 RPC를 호출하지 않는다.
5. 실제 비밀번호/회전 시각은 변경하지 않는다. 현재 효과가 입증된 경우에만 profile gate·실패 횟수, 기존 요청의 completed/claim/lease, 원 요청에 연결된 감사 기록을 원자적으로 마무리한다. 기존 receipt/감사 이력 삭제는 금지한다. 감사의 기록 시각과 실제 Auth 반영 시각을 혼동하지 않는다.
6. 일반 completion 정책과 맞추려면 원세션이 없는 대상 계정의 현재 세션들도 종료되어 다시 로그인해야 한다. 이 영향은 운영 복구 승인 질문에 명시한다. 다른 계정의 세션은 건드리지 않는다.
7. 실행 후 요청 completed·미완료 0·감사 정확히 1·Auth 효과/회전 시각 불변·권한 원복을 확인한다. 재실행은 중복 감사/재수정 없이 이미 완료됨을 보고해야 한다. 사용자 재로그인 및 다음 변경 성공은 별도 UAT다.

이 절차는 복구 설계 준비이며 실행 SQL/합성 회귀/독립 QA는 아직 미완료다. 위 구현이 최종 DB 검증 입력을 바꾸면 성공 증거를 재사용하지 않고 새 실행 전 재승인을 받는다. 이번 재발 방지 함수의 DB 검증과 기존 요청 복구 완료를 구분한다.

## PR #545 최종 검증 및 복구 설계 QA

2026-10-31 KST: CI `41114087909` attempt1, head `4d414ea`의 application/migration PASS.
승인된 전체 검증은 한 실행으로 완료했고 재실행하지 않았다. fresh/SQL/upgrade/static warning/KST/concurrency/cleanup 및 신규 password_effect_completion.sql PASS를 확인했다.
Full DB proof: `d4259eb00a177f67f26ef964a21480c12b646fa943c55f3c94b20b51a7620e69`.
위 NOT RUN/PR 생성 대기 기록은 검증 전 시점이다. 운영 migration/기존 요청 복구/UAT는 여전히 NOT RUN이다.

복구 설계 독립 QA는 별도 pg_temp SECURITY INVOKER helper를 권장했다. 실제 구현과 DB 검증은 미완료다.
현재 profile gate·실패횟수·잠금시각까지 승인 snapshot에 포함하고 사건 이후 새 실패/잠금은 지우지 않는다. 변동이나 새 잠금이 있으면 중단한다.
원세션 부재는 현재 세션의 digest를 비교한다. 완료 요청 재호출은 검증 후 no-op으로 처리하여 새 로그인 세션을 재삭제하지 않는다.
해당 복구 helper는 PR #545 성공 입력에 포함되지 않으므로 이 DB proof로 검증됐다고 표시할 수 없다.

## 병합 및 별도 복구 후보 — 2026-10-31

PR #545 main squash `d3ecff1` 완료. main CI `41161653288` application/migration PASS.
migration은 원 PR proof를 재사용했고 DB 시작/재구축/SQL/경합 단계 전부 SKIPPED다. 전체 검증 재실행 없음.

`scripts/sql/recover-password-effect-543.sql`에 운영자 전용 pg_temp helper를 구현했다.
실제 효과·exact snapshot·15분 유지보수 cutoff·기존 transaction 종료·원세션 부재·reset 없음·감사 1건을 검사한다.
이번 장애 계정은 gate가 이미 false이므로 profile을 수정하지 않는다. 새로운 실패/잠금은 덮지 않고 중단한다.
`scripts/sql/test-recover-password-effect-543.sql`은 격리 DB 전용 transaction/rollback 회귀 후보다.
성공/중복 복구 후 새 세션 보존/효과 불변/새 실패 및 Auth 효과 차단/동일 감사 키 충돌을 검사한다.
두 파일 SQL/PLpgSQL 구문 분석 PASS, helper 독립 소스 QA PASS. Node3170/typecheck/build PASS.
실제 복구 SQL 회귀·경합 NOT RUN. 별도 승인 후 기존 격리 DB에서 좁은 SQL 검사만 실행하며 migration/reset/전체 검증은 반복하지 않는다.
운영 함수 적용·일시중지·대상 요청 복구·대상 세션 종료는 각각 실행 범위를 명시해 승인받는다. 현재 운영 변경 없음.

## 승인된 기존 격리 DB 복구 SQL 검사 — 2026-10-31

사용자가 기존 격리 DB의 복구 SQL 검사 및 rollback만 승인했다. Docker가 꺼져 있어 지정 Safe Start를 한 번 실행한 뒤 Desktop running/server29.7.2를 확인했다.
기존 로컬 volume의 `supabase_db_room-management-system-backend`에 Unix socket/postgres로 연결했다. schema112/head `room_event_effective_lookup_indexes`이며 운영124 후보와 같지 않다. 필요한 기존 비밀번호 원장·trigger·함수 계약을 확인하고 그대로 사용했다. migration/reset/extension 설치/전체 DB 검증은 하지 않았다.

독립 QA가 발견한 fixture의 immutable created_at UPDATE를 제거하고 과거 시각의 합성 receipt를 최초 INSERT하도록 보완했다. 실제 Auth version trigger는 그대로 실행했다. pgTAP이 없어 session-local assertion 함수로 검사하고 확장을 설치하지 않았다.

`test-recover-password-effect-543.sql`의 include를 동일 helper 본문으로 결합해 `docker exec -i ... psql -U postgres -d postgres -X -v ON_ERROR_STOP=1`로 실행했다. 13건 PASS, 명시적 ROLLBACK 완료:
- 차단 시간 부족·writer ACL 미차단 거부
- 정확한 효과 완료, 대상 현재 세션 종료·타 계정 세션 보존
- 완료 재호출 no-op·새 로그인 세션 보존·감사 정확히 1건
- 비밀번호 효과 및 회전 시각 불변
- 이후 로그인 실패·후속 Auth 변경·동일 감사 키 충돌 거부
- 음성 사례의 미완료 원장 보존

검사 전후: Auth users/sessions, profiles, password commands/versions, audit events 모두 0건으로 동일. 3개 prepare RPC ACL은 postgres/service_role EXECUTE로 동일. 임시 검사/복구 함수 잔존0.
history112 fingerprint `a3471c4698cc9c5622412323d467fc2a` 동일. 이 검증은 기존 격리112에서의 좁은 복구 회귀이며 운영124 전체 동등성이나 실제 동시 경합 검증을 주장하지 않는다.
운영 함수 migration·계정 복구·세션 종료·유지보수는 모두 NOT RUN, 별도 실행 승인 필요.
