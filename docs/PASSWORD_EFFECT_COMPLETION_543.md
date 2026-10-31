# #543 비밀번호 효과 반영 후 완료 기록 누락

## 2026-10-31 dev·v1.0.0 통합

사용자는 #543을 dev와 로컬 v1.0.0 후보에 통합하도록 승인했다. 이는 DB 실행 승인이 아니다.
main PR545의 `d3ecff164d99eba8837d14d302ca213e4be17353`을 dev `ebd732c`에 백포트하며,
기존 source1~141을 보존하고 같은 SQL을 142번째에 추가한다. hotfix의 124번째라는 표기는
별도 main 이력의 순번이며 dev의 기존 124번째 배정 카드 migration을 대체하지 않는다.

- SQL: `20261030183754_password_effect_completion.sql`, LF SHA-256
  `d376583cce221bfefa07c8839acf2b4b572dacee4428790373d106eefe1974c8` — main 원문 보존.
- manifest는 생성기로 갱신하고 upgrade 검사의 정확한 파일/hash·허용 tip을142로 연결한다.
  기존123~141의 검증과 음성 검사는 유지한다. developer 상태와 Node/Deno/SQL fixture의
  기대 head는 `password_effect_completion`으로 맞춘다.
- 공개 API/Swagger·권한 grant·prepare/inspect 인증 계약은 변경하지 않는다.
  메모·READY 정정·운영 보호·offline 관측을 포함한 기존 dev 기능은 보존한다.
- PR545의 CI41114087909 attempt1은 별도 hotfix124 입력의 실제 Full DB PASS다.
  그 성공을 이번 dev142 통합본의 DB 성공으로 재사용하지 않는다.
- 이번 통합본의 실제 SQL/RLS·경합·Full DB·운영 migration·기존 요청 복구는 NOT RUN이다.
  소스/application·Edge·독립 QA 결과와 dev PR 병합 근거는 #543에 기록한다.

백포트 로컬 검증은 `ci:quality`(214파일/5,676 tests, 타입/빌드/명세/비밀/lint),
manifest142, template-client, Edge 전체가 PASS다. 실제 보고 기능 후보 번들은19,992,740 bytes로
20,000,000 제한까지7,260 bytes 여유다. 독립 QA는 관련10파일/375건과 PG15/17 소스 파싱,
기존141개 해시·main SQL 원문 동일성에 PASS했다. 이 결과는 실제 DB 실행 증거가 아니다.

dev 보호 병합 후 기존 로컬 `release/v1.0.0`에 통합하되, 전체 DB를 유발하는 release
push/PR 생성·재실행은 최종 입력과 격리 환경·재구축/fixture/정리 범위의 별도 승인 전에는
진행하지 않는다. main 병합 hotfix 포함 여부와 검증 지문을 다시 확인한다. #396의 기존
릴리스 범위·초기화 미완성 gate와 운영 history/baseline 차단 조건도 유지한다.
운영 migration은 최신 이력·정확한 pending 대조 후 별도 승인받는다. 이 통합은 운영 적용이나
이미 만료된 요청 복구 완료를 뜻하지 않는다. 아래는 긴급 hotfix 개발 당시의 이력이다.

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
3. 복구 시점의 새 비밀번호 변경/관리자 초기화와 충돌하지 않도록 해당 기능 일시중지·기존 실행 종료 확인이 필요하다. 이전 #535 유지보수 승인을 이번 작업에 재사용하지 않는다. 차단 전 ACL을 저장하고 성공·실패 모두 원복을 확인한다.
4. 별도 검토된 관리자 실행 transaction에서 actor advisory lock → profile → exact receipt → Auth 사용자 → password version 순으로 잠근 뒤 모든 조건을 다시 검사한다. 만료 lease를 연장하거나 원세션을 위조해서 일반 RPC를 호출하지 않는다.
5. 실제 비밀번호/회전 시각은 변경하지 않는다. 현재 효과가 입증된 경우에만 profile gate·실패 횟수, 기존 요청의 completed/claim/lease, 원 요청에 연결된 감사 기록을 원자적으로 마무리한다. 기존 receipt/감사 이력 삭제는 금지한다. 감사의 기록 시각과 실제 Auth 반영 시각을 혼동하지 않는다.
6. 일반 completion 정책과 맞추려면 원세션이 없는 대상 계정의 현재 세션들도 종료되어 다시 로그인해야 한다. 이 영향은 운영 복구 승인 질문에 명시한다. 다른 계정의 세션은 건드리지 않는다.
7. 실행 후 요청 completed·미완료 0·감사 정확히 1·Auth 효과/회전 시각 불변·권한 원복을 확인한다. 재실행은 중복 감사/재수정 없이 이미 완료됨을 보고해야 한다. 사용자 재로그인 및 다음 변경 성공은 별도 UAT다.

이 절차는 복구 설계 준비이며 실행 SQL/합성 회귀/독립 QA는 아직 미완료다. 위 구현이 최종 DB 검증 입력을 바꾸면 성공 증거를 재사용하지 않고 새 실행 전 재승인을 받는다. 이번 재발 방지 함수의 DB 검증과 기존 요청 복구 완료를 구분한다.
