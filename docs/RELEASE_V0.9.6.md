# v0.9.6 — PIN 가져오기 사진 OAuth 재사용

## 범위와 기준

- 이전 운영 정본: main `329a8a361bef431e31b6395b636d44cf7acc7abc` (v0.9.5).
- 개발 정본: dev `56dc304ae743c1303ea921175f43ab882124f0e0` (PR #462).
- main의 v0.9.5 회귀 검사/호환성 보완을 보존하고 #452 가져오기 인증 연결만 추가한다.
- 사진 provider, 업로드/조회, 기존 단방향 Sheet worker, API 요청/응답과 DB SQL은 변경하지 않는다.
- migration 119개는 이전 운영 정본과 동일하다. 운영 적용이 필요하다는 증거가 발견되면 실행 전 재승인받는다.

## 운영 설정 및 접근 근거

- #463에 기록한 사용자 승인 범위에서 기존 사진 OAuth로 새 비공개 빈 시트를 생성했다.
- 실제 가져오기 reader로 정확한 탭/헤더/행 제한과 읽기 접근을 검증했다. 실제 PIN 데이터는 입력하지 않았다.
- 운영 가져오기 원본/tab 설정을 새 대상으로 전환하고 두 설정 외 secret digest 불변을 확인했다.
- 임시 진단 함수는 삭제했다. 사진 OAuth의 scope·credential 및 사진 기능을 변경하지 않았다.
- 이 기록은 실제 PIN preview/apply 성공이나 API 배포 완료를 의미하지 않는다.

## 검증 checkpoint (2026-10-21)

- typecheck / build: PASS.
- Node: 123 파일, 3,092 테스트 PASS.
- edge:check / ci:quality / db:manifest:verify: PASS.
- npm audit --omit=dev: 취약점 0. 개발용 Vite의 high 경고 1건은 #465에서 추적하며 운영 Edge 포함 여부와 구분한다.
- 독립 QA: PASS, 관련 Node 122건 PASS, 신규 P0/P1/P2 결함 없음. main 기존 13파일 보존과 사진/SQL/lock 불변 확인.
- 사용자 승인된 격리 전체 DB CI 1회: 아직 실행 전. 실패하면 수정 후 재실행 승인을 받는다.
- 운영 migration / 실제 PIN 가져오기 / API 배포: NOT RUN.

## 배포 및 복구

1. release/v0.9.6 → main PR의 application/migration, 독립 리뷰 및 미해결 대화를 확인한다.
2. 격리 전체 DB 검증 통과 후 squash 병합한다. main CI는 동일 입력 proof 재사용 여부를 확인한다.
3. 운영 migration 이력과 대상 설정을 읽기 확인한 후 검증된 main의 api 함수만 배포한다.
4. 함수 inventory, health/OpenAPI, 인증 없는 민감 경로 차단을 확인한다. 실제 관리자 가져오기 적용은 수행하지 않는다.
5. 회귀 시 v0.9.5 정본 api를 재배포한다. 이 경우 사진 동작은 유지되지만 OAuth 가져오기 연결은 다시 미지원 상태다.

Refs: #452, #463, PR #462
