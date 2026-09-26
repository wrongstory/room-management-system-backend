# v0.6.1 사진 업로드 호환성 릴리스

상태: release candidate. `dev@237776d94a0cdb294a86266be1aa324dc7dd25b8`의 #291 수정과 기존 main의 릴리스 검증 설정을 보존한다. 운영 반영은 필수 CI·독립 QA 및 main 병합 뒤에만 수행한다.

## 범위

- #291: 검증된 Ultra HDR GainMap 뒤의 Samsung SEF 부가정보를 검사하고 주 JPEG만 정규화한다.
- 입력 JPEG/WebP/HEIC/HEIF 5MiB·12MP/5000px, 출력 JPEG/WebP 307200 bytes 이하 계약 유지
- v0.6.0 release 문서·manifest·검증 스크립트 보존. 충돌한 package.json은 main의 v0.6.0 검증을 유지하고 사진 코드·테스트는 검토된 dev 정본을 유지한다.
- 운영 DB migration 추가/재적용 없음. api Function만 exact merged main에서 로컬 bundle 배포
- Secrets, Cron, 다른 Function, 업무 데이터, 사진 슬롯 변경 없음

## 검증과 완료 구분

- 제공 촬영 JPEG 로컬 재현: 기존 INVALID_PHOTO_BINARY → 수정 후 JPEG 120,108 bytes (입력 3,031,466 bytes)
- Node/Deno 원본 검증: 방향 보정·metadata 제거·동일 입력의 결정적 결과 확인. 원본/metadata는 기록하지 않음
- 독립 QA #292 exact head 3c155cbc 승인, 차단 결함 없음
- npm ci, ci:quality(546 tests), edge:check(283 tests, bundle 17,119,198 bytes): PASS
- #292 required application/migration CI: PASS. fresh local DB 83 migrations, SQL 및 동시성 회귀는 CI runner에서 검증
- 별도 constrained Edge worker smoke는 로컬 worker 시작 실패로 BLOCKED. Node/Deno 성공을 hosted CPU/memory·Drive/DB 성공으로 해석하지 않음
- release exact-head 필수 CI와 독립 QA는 병합 전에 별도 확인
- production 사전 확인: api v31 ACTIVE, health 200, OpenAPI 0.5.1, migration 83/head version 20260923172455
- Security Advisor: RLS enabled/no policy INFO 89 및 leaked-password protection WARN 1. 기존 인증/권한 설정은 변경하지 않음

## 배포와 복구

1. release required CI·독립 QA, 미해결 review/충돌 여부를 확인한다.
2. main으로 squash 병합한 exact commit에서 npm ci, ci:quality, edge:check를 통과시킨다.
3. Node 22에서 `node scripts/generate-photo-edge.mjs --assets-only`를 실행한다.
4. 서버 번들링 API를 쓰지 않고 api 하나만 로컬 bundle 방식으로 배포한다. DB migration은 실행하지 않는다.
5. api 버전/ACTIVE, health 200, OpenAPI 129 paths/139 operations 및 사진 계약을 읽기 확인한다.
6. 배포 문제 시 기존 main `2f6769112591891402457b3c3bec7c5ef218f669` api bundle로 복구하며 DB 상태는 변경하지 않는다.

## 잔여 검증

승인된 QA 계정/실제 attempt/사진 slot을 지정하지 않았으므로 운영 upload·Drive/DB MIME/size/SHA 일치·verified 재조회·동일 Idempotency-Key 및 응답 유실 복구·삭제 검증은 NOT RUN이다. 임의 운영 fixture를 만들지 않는다. 배포 완료를 실제 업로드 완료로 표현하지 않는다.

기존 보안 진단 참고: [RLS policy 안내](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [유출 비밀번호 보호 안내](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
