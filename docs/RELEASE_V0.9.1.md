# v0.9.1 프런트 인계 계약 정합화

## 승인과 범위

2026-10-09 사용자가 #406/PR407 병합 및 운영 재배포를 승인했다.
v0.9.0은 보존하고 후속 patch release로 API와 Swagger만 갱신한다.
release/v0.9.1은 최신 dev1a91ad8에서 시작해 main d9e053b의 기존 문서183줄을
정상 merge로 보존했다. 최초 통합 tree는 main과 정확히 동일하다.
PR407의 최신 필수 CI 통과 및 dev squash 후 그 dev를 통합해야 한다.

- Edge CORS PUT 허용. exact Origin allowlist, credentials, CAS/멱등성 헤더 유지.
- AttemptPhotoSlots.photoCount 0..20 정합화. 실제 일반20/선택10/legacy1 제한 불변.
- 이미 배포된 #336 11 operations의 deployed/v0.9.0 근거 표기.
- Python codegen의 이전 미배포 literal 검사도 같은 계약으로 정합화.
- 새로운 업무 API·권한·Auth/PIN·provider/Cron·프런트 소스 변경 없음.

## DB 및 보안 경계

운영 aodikrxcczbogjpsjwjt(Seoul), API41, scheduler18을 읽기 전용 확인했다.
운영 migration111/head20261005023103이며 main/dev/수정 source의 SQL·manifest 차이0이다.
운영 db push/reset/history repair 또는 재적용은 하지 않는다.
Security Advisor의 기존 leaked-password protection WARN은 이 코드 변경과 무관하며
Auth 설정을 임의 변경하지 않는다. private deny-by-default RLS/no-policy INFO를
해소하기 위해 정책을 넓히지 않는다.
백업/복원·실제 초기화 개발은 사용자의 후속 트랙 결정대로 제외한다.

## 검증과 승격 절차

1. PR407: Node2666, Python102, Edge, 독립 QA PASS. 최초 application CI 실패는
   Python codegen 미배포 표기 누락으로 보완했고 새 exact-head CI를 확인한다.
2. dev 통합 후 release→main PR의 application/migration·독립 QA·보호 규칙·
   미해결 리뷰0과 기존 main 문서 보존을 확인한다. CI 우회 없음.
3. 병합된 exact main에서 기존 runtime lock/static assets/verify_jwt=false를 유지해
   api만 재배포한다. scheduler 및 다른 worker는 변경하지 않는다.
4. ACTIVE version, health200, PUT preflight204, 비허용 Origin403, 20장 schema,
   150paths/162operations/11배포표기, 인증 없는 보호 조회401/no-store를 확인한다.
5. 실제 운영 OpenAPI를 입력으로 main Swagger Pages workflow를 실행하고
   게시된 명세의 같은 계약을 확인한다. 프런트 업무 UAT와 구분한다.

## Rollback과 현재 상태

실패 시 직전 main d9e053b/API41 source로 api를 복구하고 직전 Pages artifact를 사용한다.
DB 변경이 없어 DB rollback은 필요 없다. 실제 데이터 mutation smoke는 하지 않는다.
현재는 릴리스 준비 기록이며 병합·운영 재배포 완료가 아니다.
실제 main SHA/API version/Pages run 및 최종 결과는 연결 PR에 기록한다.
