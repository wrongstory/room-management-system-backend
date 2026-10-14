# #442 공통 인증 조회 통합 후보

상태: 구현 후보, 운영 미반영. DB 적용·실제 SQL·경합 검증 NOT RUN.
기준선 PR #443은 dev에 병합됐지만 성능 변경을 포함하지 않았다.

## 구현

`getUser → profiles HTTP → is_active_auth_session HTTP`를
`getUser → get_active_auth_context HTTP`로 통합한다. 일반 인증의 DB 왕복은 2→1,
Auth 포함 외부 호출은 3→2다. 호출 수 감소이며 운영 지연 개선율은 아니다.

- Auth 확인 사용자 ID와 검증된 토큰의 session claim만 서버에서 전달한다.
- 프로필/status 이후 별도 SQL 명령으로 live session을 확인한다. VOLATILE / READ COMMITTED
  fresh snapshot과 세션 검사 단계의 clock_timestamp로 profile 대기 중 폐기·만료를 검사한다.
  반복읽기·직렬화는 오래된 snapshot을 사용할 수 있어 안전하게 거부한다.
- 거부 우선순위: 프로필 없음 → 비활성 → session claim 없음 → 잘못된 UUID/폐기/만료.
- PUBLIC/anon/authenticated EXECUTE 금지, service_role만 허용. 테이블/RLS/기존 helper 불변.
- 성공 actor 필드와 Auth 사용자 일치를 Node/Edge에서 검증한다. 실패에는 actor 정보가 없다.
- 로그인·비밀번호 변경·limited/사진 전용 인증·업무 RPC의 최종 권한 검사는 그대로다.
  사진 업로드 전용 인증 왕복까지 줄였다고 주장하지 않는다.
  사진 원본 `GET /v1/photos/{photoId}/content`는 일반 인증으로 통합되지만,
  photo-slots/업로드/삭제/status, offline-events 및 POST submissions는 기존 제한 인증이다.
- 캐시, 권한 생략, 병렬 인증, 조용한 fallback은 없다.

설계 근거: [PostgreSQL 함수 snapshot](https://www.postgresql.org/docs/17/xfunc-volatility.html),
[실제 시각과 statement 시각](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).

## 프런트 / Swagger 인계

클라이언트 호출·성공 DTO 변경 없음. 내부 RPC를 브라우저에서 직접 호출하지 않는다.
Swagger 보호 API의 503 및 공통 ErrorCode에 AUTH_CONTEXT_UNAVAILABLE을 추가했다.

- 503 AUTH_CONTEXT_UNAVAILABLE: RPC 통신 실패/비정상 응답/지원하지 않는 격리 수준.
  로그인 상태 유지, 재시도 안내. 빈 목록·샘플·자동 로그아웃 금지.
- 401 SESSION_REVOKED: 기존 재로그인 처리 유지.
- 변경 요청 재시도에는 기존 본문·Idempotency-Key를 유지한다.
- 단일 RPC 장애의 내부 단계를 알 수 없으므로 이전 네트워크 장애의 401까지 보존한다고
  주장하지 않는다. 업무 거부 순서와 인프라 실패를 구분한다. 원문 오류를 로그/응답에 넘기지 않는다.

## 배포 / 복구

1. source/application/Edge/독립 QA 후에도 실제 DB 검증은 미완료다.
2. 성능 개선 최종 입력을 확정한 뒤 사용자에게 migration/DB 검증 실행 승인을 받는다.
3. 승인된 최종 fresh DB에서 전체 SQL과 test-auth-context-concurrency.mjs를 실행한다.
   실제 profile relation lock 대기를 확인한 뒤 다른 세션에서 폐기/만료하여 거부를 검사한다.
   실행기는 고정 local Docker/빈 fixture를 요구하고 migration/reset을 하지 않는다.
   자신이 만든 합성 ID만 정리하며 외부 URL/자격증명을 받지 않는다.
4. 릴리스 승인·main 병합 뒤 운영 적용 직전 별도 승인, pending migration113 적용 → API 배포.
   DB 함수 없이 API부터 배포하면 503으로 차단된다.
5. 실제 auth/me·accounts·rooms 및 정상/폐기 세션 smoke, 동일 조건 p50/p95 비교.
6. 장애 시 이전 API로 복구. 기존 profiles/helper를 보존했으므로 DB 함수 삭제는 불필요하다.

## 검증 구분

합성 Node/Edge double은 SQL MVCC 경합을 증명하지 않는다. pgTAP 3파일과 실제 경합
실행기는 작성만 했고 NOT RUN이다. 실행기 preflight는 migration count/head를 확인하며
전체 version/hash 동등성 증명은 최종 릴리스 manifest/history gate가 맡는다.
운영/로컬 DB·Auth·PIN은 변경하지 않았다. 최종 코드 검증은 PR exact-head 결과에 기록한다.

### 2026-10-10 작업 checkpoint — 커밋·push 전

- `npm run ci:quality`: PASS, 115파일/2,920 tests, typecheck/build/OpenAPI 151경로·163동작.
- 독립 QA: Node targeted 5파일/93 tests PASS, 당시 정적 검토 P0/P1/P2 없음.
  이 판정은 아래 전체 Edge 실패나 실제 DB 검증을 대체하지 않는다.
- `npm run db:manifest:verify`: PASS, dev113 소스 목록/해시만 확인. DB 실행 아님.
- `npm run edge:check`: FAIL. 보고/증빙 65 PASS; 나머지 523 PASS / 4 FAIL.
  1. `attempt-lifecycle-api.deno.ts`: 일반/limited 경로의 서로 다른 인증 RPC 기대값 구분 필요.
  2. `photo-api.deno.ts`: 사진 경로별 일반/전용 인증 RPC 기대값 구분 필요.
  3. `openapi.deno.ts` preview diagnostics: 신규 503 응답에 기존 no-store 헤더 계약 누락.
  4. `openapi.deno.ts` complaint: 동일 신규 503 no-store 계약 누락.
- 앞선 검사에서 발견한 developer 진단 버전 기대값은 dev113 이름으로 수정했다.
- 최종 API 번들 제한 검사는 위 실패로 완료하지 못했다. 보고 번들만 620,911 bytes 확인.
- 실제 SQL/ACL/MVCC·폐기/만료 경합, DB reset/migration, 운영 성능 비교: NOT RUN.
- 자동 QA 수정 반복 한도에 따라 이번 회차는 여기서 중단한다. 실패 후보를 정상 완료 커밋,
  push 또는 PR로 올리지 않았다. 다음 회차는 위 4건을 먼저 보완하고 전체 Edge/독립 QA를
  다시 확인한다. 캐시 금지·세션 거부 검사를 삭제하거나 약화하지 않는다.

공통 인증을 거치는 일부 사진 조회 경로도 영향받을 수 있으므로, 후속 검토에서 사진 경로별
실제 router를 대조하여 Swagger의 Photos 제외 범위를 점검한다. 전용 업로드 인증 자체를
최적화한 것은 아니며 사진 전체 호출 수 감소를 주장하지 않는다.

### 2026-10-11 보완 내용

위 실패 기록은 이전 회차의 이력이다. 일반/제한 인증 경로별 RPC 기대값을 분리하고,
신규 503 응답에도 `Cache-Control: no-store`를 명시했다. 테스트를 삭제/skip하지 않았다.
실제 Edge router에 맞춰 Photos 전체 제외를 해제하고 사진 원본 조회를 포함한다.
제한 인증의 photo-slots/업로드/삭제/status, offline-events, POST submissions는 제외한다.
기존 업무별 503 설명·스키마·다른 헤더는 보존하고, 캐시 금지 헤더가 없을 때만 보충한다.
독립 회귀가 발견한 비밀번호 변경/사진 content의 기존 503 누락도 같은 방식으로 보완했다.

최종 보완 검증: `ci:quality` PASS(115파일/2,921 tests·typecheck/build),
독립 targeted 5파일/94 PASS 및 잔여 P0/P1/P2 없음. `edge:check` PASS:
원본 보고/증빙65 + 일반527 + 생성 번들65, 최종 API 번들 19,255,681 bytes
(한도 20,000,000). manifest113·프런트 생성 client·diff check PASS.
실제 DB/ACL/MVCC/경합 및 운영 성능 비교는 계속 NOT RUN이다.

### PR #444 CI 보완

첫 CI의 application은 Python 관리 도구의 과거 오류 코드 수(335) 고정 검사에서 실패했다.
실제 현재 계약은 신규 `AUTH_CONTEXT_UNAVAILABLE`을 포함한 336개다. 정확한 전체 수/고유 수
검사를 유지하고 신규 코드 필수 포함, 누락/중복/동수 치환 거부 회귀 3건을 추가했다.
Python 전체105·독립 targeted10, ruff/format/mypy·임시 client codegen·package check PASS.
코드 생성기의 기존 바이너리 등 미지원 경고는 그대로이며 전체 지원으로 주장하지 않는다.
소스만 수정했으며 migration/reset/운영 호출 없이 기존 PR의 application CI를 재확인한다.

후속: #416 객실 계산 → #414 주급 조회 → #415 배정 조회 → 승인된 최종 DB 검증·배포.
사진/Drive 후속은 #411에서 별도로 진행한다.
