# #406 프런트 인계 HTTP 계약 정합화

## 2026-10-09 병합·운영 재배포 승인

사용자가 PR407 병합과 운영 재배포를 승인했다. 아래 10월8일 배포 보류는
당시 경계다. 필수 CI·독립 QA 후 dev 및 release/main 절차를 진행하며 DB는 변경하지 않는다.
최초 PR407 CI37780825139는 migration PASS/application FAIL이었다.
Python codegen 검사에 남아 있던 미배포 literal을 deployed/v0.9.0의 엄격 검사로
정합화했다. 권한·인증 검사 유지 및 상태/버전/권한 drift 거절 회귀7건 추가,
Python102·ruff·format·mypy·codegen·package source 검증 PASS다.
실제 병합·배포 결과는 릴리스 기록과 PR에서 별도로 확인한다.

2026-10-08 사용자 승인 범위: CORS, 사진 개수 스키마, Swagger 배포 표기.
프런트 targeted snapshot은 makee-ham/room-management-system
dev@3bb0bb3930511b9ef0ad105e95f87c8e6e353991의
DOCS/31_BACKEND_V090_FRONTEND_INTEGRATION.md다. 전역 제품 정책을 교체하지 않는다.

## 변경과 불변 경계

- Edge CORS 허용 메서드에 PUT 추가. exact Origin allowlist, 인증, CAS/멱등성
  헤더는 유지한다. Preview 도메인을 wildcard로 허용하지 않는다.
- AttemptPhotoSlots의 photoCount 범위를 0..20으로 정합화한다.
  일반 사진20, 선택 증빙10, legacy 단일 사진1의 실제 slot별 제한은 유지한다.
- #336의 이미 배포된11 operations는 deployed / x-deployed-release v0.9.0으로
  표시한다. PR403/main d9e053b 및 v0.9.0 Release의 API41/history111 배포 기록이
  근거다. 이는 실제 업무 UAT 완료나 이번 수정본 운영 반영을 의미하지 않는다.
- 데이터/RLS/마이그레이션/업무 권한/사진 보존/원장 변경 없음.

## 검증 및 배포 경계

기준선 Node2664 PASS. 최초 전체 실행은 이전 배포의 ignored node:test 임시
파일이 Vitest에 수집돼 FAIL했다. 해당 파일은 삭제하지 않고 .check.mjs로
보존했으며 재실행 PASS다. 제품 테스트 제외나 기준 완화는 없다.

수정본 Node 106파일/2666건, typecheck, build, lint(exit 0, 기존 info 19건),
OpenAPI 150 paths/162 operations, secrets 검사, 전체 edge:check PASS.
Edge 검사의 최초 manifest drift는 생성기로 runtime.ts 해시만 갱신해 해소했다.
최종 후보 포함 Edge 번들은 19,217,399 bytes로 20,000,000 제한 이하다.
독립 QA는 관련 Vitest 191건과 exact-origin CORS 경계 7건 PASS, 차단 결함 없음.
DB 검증은 스키마 변경이 없어 NOT RUN이며 원격 CI 상태는 연결 PR에서 확인한다.
운영 API·Swagger Pages 재배포는 보류한다. 현재 사용자는
https://room-management-system-prod.vercel.app 에서 직접 점검 중이다.
승격 전 연결 검증과 운영 반영 뒤 최종 확인을 별도 기록한다.
실제 송금 표시 on/off·다른 관리자 조회와 사진 업무 UAT는 아직 미실행이다.
제한 계정 cold start와 증빙 인계 화면은 이번 수정 범위가 아니다.
