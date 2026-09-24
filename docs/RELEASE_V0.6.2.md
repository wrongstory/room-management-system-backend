# v0.6.2 사진 실패 진단 릴리스

상태: release candidate. 개발 PR #295의 진단 변경과 기존 main의 릴리스 manifest·검증 설정을 보존한다. 운영 반영은 required CI·독립 QA·main 병합 후 수행한다.

## 범위와 안전 경계

- #294: 파일 수신·입력 검사·decode·변환·encode·출력 검사·시간 예산 실패 단계를 닫힌 코드로 구분한다.
- Edge console에는 HTTP 상태, 닫힌 진단 코드, UUID 문의 번호만 남긴다. 원본 사진, metadata, 파일명/경로, 크기/해시, 계정/객실 정보, native message/stack/relatedErrors, 인증정보는 기록하지 않는다.
- 공개 오류 응답과 JPEG/WebP/HEIC/HEIF 5MiB 입력, JPEG/WebP 307200bytes 이하 저장, 기존 자원 상한·권한·CAS·멱등성·Drive 계약은 변경하지 않는다.
- DB migration, Secrets, Cron, 다른 Function, 프런트, 운영 fixture/사진 슬롯 변경 없음.
- 이번 변경은 원인 조사용이다. 원인 확인 뒤 임시 진단의 제거/축소를 별도 검증된 변경으로 판단한다.

## 검증과 잔여 항목

- 개발 exact head bf43b690eaeb34959a38d9d454477de484232dec 독립 QA 승인, 차단 결함 없음.
- 개발 ci:quality 558 tests, Edge 284 tests 및 bundle17127976bytes PASS.
- 개발 application/migration CI run36004528183 PASS. fresh local DB 재적용, SQL 및 동시성 검증은 CI runner에서 수행했다.
- 동일 실사용 JPEG가 Node에서는 통과했고 Deno에서는 변환 단계 RESOURCE 오류 한 번 후 반복 네 번 통과했다. 시간/메모리 변경 단발 실험만으로 원인을 확정하거나 운영 제한을 완화하지 않는다.
- release exact-head 의존성/quality/Edge/manifest, required CI와 독립 QA는 병합 전에 별도 확인한다.
- 사전 운영 상태: api v32 ACTIVE, health200, OpenAPI0.5.1 129paths/139operations, migration83/head20260923172455. Drive 설정 네 개는 존재하지만 존재 확인은 OAuth 성공 증거가 아니다.
- Security Advisor는 기존 INFO89 및 leaked-password protection WARN1이다. 인증·권한 설정은 변경하지 않는다.
- 승인된 QA 계정/attempt/slot이 없어 hosted 업로드, Drive/DB MIME·크기·SHA 일치, verified 재조회와 멱등성 검증은 NOT RUN이다. 임의 fixture를 만들지 않는다.

## 배포 및 복구

1. 릴리스 required CI, 독립 QA, 충돌/미해결 review를 확인하고 main으로 squash 병합한다.
2. exact merged main에서 npm ci, npm run ci:quality, npm run edge:check를 통과시킨다.
3. Node22에서 node scripts/generate-photo-edge.mjs --assets-only를 실행한다.
4. api만 로컬 Edge 번들 방식으로 배포한다. 서버 bundling API 및 DB migration은 실행하지 않는다.
5. Function 버전/ACTIVE, health200, OpenAPI 입력·저장 계약, 다른 Function과 migration 미변경을 확인한다.
6. 사용자가 기존 승인된 작업에서 재시도한 문의 번호로 안전한 진단 코드만 조회한다. 사진 원본이나 고객정보는 로그에 추가하지 않는다.
7. 배포 문제 시 이전 main bf8adb6954b87120201b0a2c4001d541e6e2fd47의 api를 재배포한다. DB rollback은 필요 없다.

보안 안내: [RLS policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [유출 비밀번호 보호](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
