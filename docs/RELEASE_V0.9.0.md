# v0.9.0 빠른 기능 확인용 운영 릴리스

## 2026-10-07 사용자 결정

프런트 요구와 백엔드 기능의 실제 동작·의도를 먼저 확인한다. 완료 기능의 운영 배포와
Swagger 인계를 우선하고, 전체 후속 내부 검증·백업/복원·DB 초기화 기능 개발은 뒤로 분리한다.
이 결정은 이전 #387의 실제 백업/복원 선행 및 배포 직전 정지 순서를 대체한다.
필수 application/migration CI, 독립 QA, 보호된 release → main 병합, 권한·데이터 보존은
우회하지 않는다. 파괴적 변경·Auth/PIN 변경·새 provider/Cron 활성화는 이번 범위가 아니다.
백업 없이 진행하므로 이번 작업의 검증된 복구 사본은 없으며, DB 변경 뒤 단순 API rollback이
전체 복구를 보장하지 않는다. 데이터 삭제/변환 위험이 드러난 작업은 따로 중단·보고한다.

추가 사용자 결정: 개발 단계마다 로컬 전체 migration/reset/upgrade를 반복하지 않는다.
중간에는 변경 기능·타입·빌드·독립 QA를 검증하고, 최종 통합 후보의 필수 migration CI를
배포 검증 근거로 사용한다. 운영 pending migration은 최종 한 번의 배포 절차에서 적용한다.
이는 기존 migration 파일·적용 이력을 합치거나 필수 CI를 삭제/우회한다는 뜻이 아니다.

## 후보와 실제 운영의 구분

- 출발 dev: `8bdaec35cb845426173ec23941824785445f5e1a`.
- 작업 브랜치: `release/v0.9.0` → `main`. 기존 `release/v0.8.0`은 보존한다.
- 2026-10-07 읽기 전용 운영 확인: `aodikrxcczbogjpsjwjt`, ACTIVE_HEALTHY,
  migration 85개, head `20260928095656_flat_cleaning_evidence_history_payroll`.
- 운영 API ACTIVE v38, reservation-scheduler ACTIVE v16. 이번 작업에서 배포하지 않았다.
- 후보 migration 111개. 운영 이후 추가 26개이며 기존85 파일의 source 차이는 없다.
  원격 history timestamp는 source와 다를 수 있어 stable name/hash/schema로 검증한다.
- 후보 Swagger: OpenAPI 0.6.0, 150 paths / 162 operations. 앱 릴리스 v0.9.0과 별개다.
- #396 foundation은 이미 dev에 있지만 공개 초기화 API·실행 기능은 없다.
  미병합 #402 및 초기화 후속은 이번 릴리스 선행조건이 아니다.

## 프런트 요구 대조 및 사용자 점검표

읽기 전용 대조: `makee-ham/room-management-system`의
`dev@09ed28446a4fd43919cddb29ebe442b848548ab8`, `DOCS/30_DEPLOYED_WIREFRAME_API_PARITY.md`.
아래는 source 대응표이며 운영 사용·실제 화면 UAT 완료 표시가 아니다.

| 프런트 항목 | 포함 source | 배포 후 확인 |
|---|---|---|
| B01 제출 후 촛불·신고 | #330 공동 촛불 조정, #336 별도 신고·증빙 | 승인 전후 조정/신고, 원 제출·주급 불변, 관리자 공유 |
| B02 송금 표시 | #331 독립 on/off 및 금액 변경 재확인 | 다른 관리자/새로고침 동일 표시, 실제 PAID 원장 불변 |
| B03 PIN | 기존 #315 hotfix 유지 | 권한 있는 조회·마스킹, 원문 로그 없음; 실제 도어락 변경 제외 |
| B04 배정·취소·시각 | #326/#328/#348 snapshot·취소 가능·예약 일정 | PIN 조회 뒤 미착수 취소, 통보/배정/실제 시각 구분 |
| B05 날짜별 객실 | #318 serviceDate projection | 오늘 LIVE/과거 종료/미래 시작 평가 시각과 표시 |
| B06 퇴실점검 대상 | #318 조회 reason | 대상 필터; 수동 완료 lifecycle은 미확정으로 제외 |
| B07 운영 목록 페이지 | #322 limit/cursor Edge guard | 관리자 이슈/차단 다중 페이지 조회 |
| 추가 요구 | #329 기존 세션, #332 제출 전 신고, #382 배열 순서, #383 저장명 | 제한 세션 범위, 등록 신고만 조회, 순열 수용, 실제 Drive 이름 |

B01 문서의 타 메이드 촛불 금지보다 사용자의 #330 모든 활성 메이드 공동 조정 결정이 우선한다.
#336은 본인 실제 통보 배정 이력 접근이며 타인 초안·현재 객실/PIN 전체 권한을 주지 않는다.
B05 홈 과거 주급/검수 대기 재구성과 B06 수동 완료는 이 배포의 구현 완료로 주장하지 않는다.
프런트 소스는 별도 담당이며 배포만으로 기존 비활성 버튼이 자동 연결되지는 않는다.

## 배포에 직접 필요한 남은 작업

1. main의 기존 hotfix와 운영 문서를 보존하며 누적 squash 이력의 병합 충돌 해소.
   실제 정상 merge에서 발생한121개 충돌을 파일별 이력 근거로 해소했다. 각 main blob가
   dev 이력에 존재함을 전부 확인했고, 해소 결과121개는 기존 릴리스 HEAD와 정확히 같다.
   사진 생성 파일2개와 manifest는 기존 생성기로 재생성·동일성을 확인했다.
   main-only `docs/RELEASE_V0.7.1.md`를 원본 blob 그대로 보존한다.
2. #376 배포 차단 보완 통합: 운영의 검수 목록/개발자 catalog 함수는 알려진 CRLF 본문이다.
   보완 전 정적 경고 migration은 raw LF 지문만 받아 이 상태에서 실패했다.
   2026-10-07 원격 read-only raw/LF MD5 재확인 결과는 #376의 알려진 두 쌍과 일치했다.
   검증된 좁은 호환 보완만 반영하며 지문 검사를 제거하거나 운영 함수를 미리 수정하지 않는다.
   최신 dev 통합 source83e7122를 PR377에 정상 push했다. 로컬 Node2664·SQL5572·fresh111·
   CRLF4조합/15거부/실제 원자 rollback·#336 upgrade·Edge·독립QA PASS다.
   CI37603160916 application/migration 모두 PASS, 독립 QA·미해결 리뷰0·보호 규칙 확인 후
   PR377을 dev `bec3dbe1ea964782510a5c43fe1670875a8a033e`로 squash했다.
   source83e7122와 dev tree는 동일하며, 이 release에 충돌 없이 정상 통합했다.
   기존111개 순서·이름은 유지하며 remediation hash 한 개 외 SQL 변경은 없다.
3. 최종 후보의 필수 CI·독립 QA, 운영 85→후보 migration 적용 가능성·기존 이력 보존 확인.
   새 범용 #378 실행기 전체 개발 완료를 임의 선행조건으로 추가하지 않는다. 기존 승인된
   적용 경로의 원자성·timeout·history/readback을 확인하고 불확실 결과에는 재실행하지 않는다.
4. #336 증빙 인계의 전용 영속 키 준비 여부 확인. 미설정 시 인계만503이라는 제한을
   명확히 표시한다. 기존 PIN/Auth/암호키를 교체하거나 재사용하지 않는다.
5. 보호된 release→main 병합 후 pending SQL만 적용·readback, exact main API와 필요한
   scheduler runtime 배포, health/OpenAPI/CORS/no-store/권한 smoke.
6. 실제 운영 OpenAPI로 Swagger Pages 갱신, 프런트 인계 후 사용자 화면 점검.
   업무 데이터 mutation UAT는 승인된 테스트 계정·대상에서만 수행한다.

## 후속 트랙

#273 실제 백업/복원 및 정기 스케줄, #396 초기화 실행/복구, #378 범용 실행기 확장은
기능 확인 뒤 진행한다. 기존 PR·미커밋 변경은 보존하며 임의 병합·종료하지 않는다.
필수 CI 안의 기존 합성 검사를 삭제하거나 기준을 완화하지 않는다.

## 현재 검증

- 후보 출발점 `npm test`: 105파일/2,663 PASS (2026-10-07).
- 릴리스 범위 문서 추가 뒤 `npm run ci:quality`: PASS, 2,663 tests/typecheck/build,
  secret scan/OpenAPI 포함. 기존 lint info18건은 오류가 아니다.
- 독립 read-only 충돌 감사: main727파일 중605개 동일·121개 후속 변경·main-only 문서1개.
  기존85 migration 및 PIN/Samsung 사진 핵심 hotfix 보존 확인. 실제 해소 뒤121개 모두
  기존 release blob와 동일하고 main 문서1개만 추가된다. 필수 최종 QA/CI는 별도다.
- 충돌 해소 후 `npm run ci:quality` 재실행: 105파일/2,663 tests·typecheck·build·
  secret/OpenAPI PASS. 독립 staged/doc QA도 PASS(P0/P1/P2=0), 미해결 충돌0이다.
- 충돌 해소 sourcee2f703e의 CI37604470137 application/migration 모두 PASS.
- #376 통합은 이미 검증된 dev와 동일한7파일이며 새 업무 기능/SQL 변경을 추가하지 않았다.
  통합 후 quality105파일/2,664 tests·typecheck·build·secret/OpenAPI와 manifest5종 PASS다.
  중간 로컬 DB 전체 실행은 반복하지 않았다. 독립 통합 QA109 PASS(P0/P1/P2=0),
  코드/SQL/테스트/package/workflow의 dev 동일성과 기존 운영85 SQL 보존을 확인했다.
  push 후 required CI는 최종 exact head에서 따로 확인한다.
- 기존 #336/PR401·#396/PR399 필수 CI/독립 QA 이력은 각 PR에 보존한다.
- 최종 exact-head CI·운영 migration/API 배포·Swagger 갱신·사용자 UAT: 미완료.
