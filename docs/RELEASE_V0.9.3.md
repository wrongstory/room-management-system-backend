# v0.9.3 가능일 완전성·조회 성능 개선

## 상태와 범위

2026-10-10 준비 기록이며 운영 배포 완료가 아니다. 사용자 승인 후속 순서와 #429를 따른다.
PR428 → PR417 → PR418 → PR419를 필수 CI·독립 QA·미해결 리뷰0·보호 규칙 확인 후
dev에 squash했다. 최종 dev는 `85d8d697f5921c027c6a4c85fd8895945312b559`다.

- #427: 가능일/변경 요청/후보 조회에서 exact count와 반환 수, 주간 7일 상세를 검사한다.
  조용한 부분 성공은 기존 500으로 거부한다. 실제 row cap 확정·1000초과 pagination은 후속이다.
- #413: 성공 업무 응답에 숫자 `api_total`을 제공한다. 인증/오류/HEAD/OPTIONS는 제외한다.
  사진 timing·body·CORS·no-store를 보존하며 전체 체감 시간이나 DB 단독 시간이 아니다.
- #414: 송금 표시 최대10명 CSV GET, 요청별 동시3, 항목별 기존 최신 권한/세션 검사,
  전체 실패·진행 중 요청 종료 대기. 기존 단건 유지, DB RPC는 N회·동일 snapshot 아님.
- #415: 배정 attempt→submission 의존 분기를 병렬로 실행한다. DB 왕복 수는 같으며
  최종 live 권한/세션/실제 통보 이력 및 완전성 검사는 그대로다.

프런트 소스/옵션, 사진 UAT 강제 오류 재현, #411 썸네일, 백업/복원/DB초기화,
Auth/PIN/송금/실제 업무 데이터, scheduler 및 다른 worker는 변경하지 않는다.

## 소스·운영 사전 대조

release/v0.9.3은 최종 dev에서 생성했다. main `32c100e` 정상 merge의 충돌37개는
파일별 대조 후 승인된 dev 기능 코드와 main 전용 운영 문서8개를 보존해 해소했다.
보존 문서는 DB_STATIC_WARNING_BASELINE, DEVELOPMENT_ORCHESTRATION,
FRONTEND_API_INTEGRATION, FRONTEND_CONTRACT_SNAPSHOT 및 RELEASE_V0.7.1/V0.9.0/V0.9.1/V0.9.2다.
프런트 인계 문서 상단의 새 준비 상태 외에 기존 운영 기록은 삭제/수정하지 않는다.
runtime·tests·tools·workflow는 최종 dev와 동일하며 migration/manifest/의존성 변경도 없다.

2026-10-10 읽기 전용 운영 확인: 프로젝트 `aodikrxcczbogjpsjwjt`(Seoul), API ACTIVE43,
artifact SHA256 `01b2094056b0bbb6f310e97da69a75ed4d126c2ff8b1d9510c34171c12093555`.
DB 이력112건의 이름·순서는 소스112건과 일치하며 운영 마지막 version은 `20261009120258`다.
기존 원격/로컬 timestamp 차이를 재적용 대상으로 취급하거나 history repair하지 않는다.
배포 직전 이력을 재확인하고 예상 밖 차이는 중단한다. 이번 릴리스 pending SQL은 없다.

Security Advisor는 기존 [leaked-password-protection WARN1](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection),
[RLS/no-policy INFO127](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)이다.
이 결과를 경고0으로 표시하지 않으며 Auth 설정이나 deny-by-default 정책을 변경하지 않는다.

## 검증 및 남은 gate

최종 기능 source `d39c1b8`의 CI38013804084 application/migration PASS는
Python 소비자/codegen, fresh DB·upgrade/SQL·기존 경고 기준·KST·경합 검사를 포함한다.
독립 QA379(Node235+Edge144) PASS. 이 결과를 새 릴리스 HEAD의 CI 대신 사용하지 않는다.
main 통합 후 로컬 `ci:quality` 109파일/2789건·typecheck/build/lint/명세 검사는 PASS다.
최종 `edge:check`는 Edge525+runtime65 PASS, 후보 번들19,277,578 bytes다.
독립 릴리스 QA는 계약25건·생성 원본 검사 PASS, 차단 결함 없음으로 확인했다.
manifest5종도 PASS다. 새 릴리스 HEAD의 원격 application/migration은 아직 미완료이며
결과를 release PR/#429에 기록한다. 앞선 기능 CI를 대신 기재하지 않는다.
새 로컬 전체 DB 재적용은 반복하지 않고 릴리스 필수 CI에서 최종 통합 검증한다.

## 배포 순서와 복구

1. release → main PR의 exact-head application/migration PASS, 독립 QA,
   미해결 리뷰0·충돌 없음·보호 규칙·최종 dev 코드 일치를 확인하고 squash한다.
2. exact main의 기존 runtime lock/static assets/verify_jwt=false 및 내부 인증을 유지해
   api만 배포한다. DB push/reset/history repair, Secrets/Cron/다른 worker 변경은 없다.
3. ACTIVE 버전·health200·정확한 Origin preflight204/비허용403·보호 경로 비인증401·
   no-store를 확인한다. 공개 OpenAPI는 151 paths/163 operations이며 info.version은 0.6.0이다.
   CSV batch, 가능일 오류, 사진 opt-in/nullability, timing 설명을 후보 명세와 대조한다.
4. main Swagger Pages를 운영 명세로 게시하고 동일 inventory/본문을 확인한다.
5. v0.9.3 태그/Release와 frontend #207에 실제 배포 SHA·명세·미검증 항목을 인계한다.

문제 시 직전 main `32c100ea3f1eecbd43ebc900feafdb6af63173c2`/API43 소스로 복구하고
Swagger도 해당 명세로 되돌린다. DB 변경이 없으므로 DB rollback/history 수정은 없다.
프런트 batch 전환은 실제 배포 확인 후다. 미지원404와401/403/500을 구분하며,
실패를 미송금/빈 목록/근무 불가로 바꾸지 않는다. timing 헤더 부재는 정상 처리한다.
사진 snapshot 옵션 활성화는 프런트 담당의 별도 정상 UAT 후 수행한다.

실제 계정이 없는 정상 batch/가능일/사진 업로드·화면 UAT·p50/p95는 NOT RUN이다.
비인증 smoke나 합성 테스트를 실사용 검증 완료로 표시하지 않는다. 실제 백업/복원도 후속이다.
