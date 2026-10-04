# #352 공용 Auth session 강제 만료 검사

> 2026-10-04 후속 릴리스 기준: #352 원본100 SQL은 변경하지 않는다. #363/#373의101 append는 dev에 통합됐으며 아래 strict17은 당시 이력이다. 최신 source 원본 strict FAIL9와 exact9 gate를 구분하고 실제 운영85에는 아직 미적용이다. 사용자가 승인한 #364 순차 릴리스와 새 exact 검증/백업·보안 경로 gate는 [런북](./RELEASE_V0.8.0.md)을 따른다.

> 최종 source/dev: PR365 source576b0e5 → dev2f9736b, treeb41786cc 동일. exact-head CI37116122570 application/migration·전체26 upgrade/SQL78파일4640·KST145·full6 경합·fresh100 합성복구 PASS. 구현 미참여 독립 QA/countercheck의 신규 scope P0/P1/P2=0 후 보호 squash로 통합했다. 아래 실행 중 표현은 이전 checkpoint이며 strict17 FAIL/#363·운영 NOT RUN은 유지한다.

## 계약과 범위

공용 `public.is_active_auth_session(uuid,uuid)`는 정확한 session/user 존재와 함께
`not_after IS NULL OR not_after > statement_timestamp()`를 검사한다.
NULL은 기존 무기한 session, 미래 시각은 유효하다. 과거와 정확한 statement 경계는 거부한다.
missing/wrong-user/null ID도 false이며 signature·boolean·STABLE·SECURITY DEFINER·기존 search_path와 ACL은 유지한다.

Auth cleanup과 JWT 만료를 기다려 강제 만료된 세션을 허용하지 않는다.
Node 일반/사진, Edge 일반/limited/사진의 helper false는 기존 401 흐름으로 종료하며,
후속 업무 RPC와 외부 provider 호출을 하지 않는다. 기존 역할·ownership·capability·CAS·멱등성은 유지한다.
새 Auth timebox, 제한 계정 새 로그인·bearer 복구, 2h/24h 연장, PIN 조회·취소 제한을 만들지 않는다.

## Migration과 검증

100번째 append `20261003095426_auth_session_hard_expiry.sql`만 추가한다.
기존 99 source migration, 원장, receipt, RLS, table/index, Auth 설정과 실제 session row를 변경하지 않는다.
합성 로컬 fixture로 NULL/future/past/equal/owner/missing/권한, 대표 read·limited read·command와
유효 replay 및 만료 replay의 무변경 거부를 검증한다. 99→100 전체 기존 행/catalog 보존을 별도로 검사한다.

행 보존 검증의 정확 범위는 public/private regular tables + auth.users/auth.sessions다.
cleaning/limited capability/command receipt/audit를 seed했으며 재무 table은 이 fixture에서 비어 있다.
다른 Auth table 행·전체 migration history 행 byte-exact 검증이나 nonempty 재무 이력 실측 보존으로 확대하지 않는다.
catalog·ACL·identity 및 기존99 source SHA/history count·max 검사는 별도로 수행했다.

## 실제 검증 checkpoint

- `npm run ci:quality`: PASS. Secret·OpenAPI137 paths/148 operations·lint(기존 info5)·typecheck·Node1225/65파일·build.
- `npm run edge:check`: PASS. pinned fmt/check·Edge469·bundle17,477,907bytes. 초기 test1파일 fmt FAIL은 linewrap 보완 뒤 전면 재검증했다.
- `npm run db:manifest:verify`: 5종 PASS, 기존99 entry/SHA 불변. dev의 pending22는 historical baseline78 기준이며 현재 운영85 대비 릴리스 후보100의 pending15와 구분한다.
- `npm run db:verify`: fresh100 실제 적용 PASS. `node scripts/test-auth-session-hard-expiry-upgrade.mjs`: 정확99→100 전체 기존 행/receipt/catalog·helper ACL/identity 보존 및 최종 fresh100 cleanup PASS.
- 전용 pgTAP36 + developer32: PASS(2파일/68). 초도 FAIL1은 anon의 기존 schema 차단 문구 기대 오류였고, 정확 `42501/permission denied for schema public`로 보완했다. anon grant 추가나 검사 삭제·완화는 없다.
- WARN/ERROR Advisor: 0건/PASS. Strict DB lint는 FAIL/exit1, 기존10함수17경고·신규helper 경고0으로 #363 별도 추적을 유지한다.
- 전체26 upgrade/전체 SQL·KST/전체 concurrency·최종 합성 backup·exact-head 독립 QA/CI는 진행 전 또는 실행 중이며 PASS로 선행 기록하지 않는다.

최종 결과는 [#352](https://github.com/wrongstory/room-management-system-backend/issues/352)의 exact-head PR에서 확인한다.
기존 #331의 PASS를 새 #352 결과로 재사용하지 않는다. strict lint FAIL의 진단용 커밋 권한도 별도로 확인한다.

## 남은 경계와 배포

이 helper의 STABLE statement-clock 검사만으로 잠금 대기 중 만료 문제까지 해결했다고 주장하지 않는다.
직접 session 존재만 보는 password-change·Web Push·delivery permit과 legacy Data API RLS는 별도 감사 범위다.
#329의 최초 제한 전환 당시 기존 session membership, 제출 RPC의 session binding도 별도 구현한다.
strict DB lint baseline17 경고는 #363, 기존 단발 CAS 추적은 #362로 유지한다.

feature→dev에서 운영 migration을 적용하지 않는다. 사용자 승인 중간 릴리스
[#364](https://github.com/wrongstory/room-management-system-backend/issues/364)의 release→main gate 후
pending DB→exact Supabase API/필요 scheduler 배포와 read-only smoke를 수행한다.
보안 predicate를 제거하는 rollback 대신 검증된 후속 보완을 사용하고 실제 원장·키·PIN은 되돌리거나 삭제하지 않는다.
