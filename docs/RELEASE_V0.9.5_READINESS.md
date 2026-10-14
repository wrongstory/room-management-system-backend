# v0.9.5 배포 준비 — 운영 미반영

추적: https://github.com/wrongstory/room-management-system-backend/issues/458

## 목적 / 기준
2026-10-13 사용자 요청: 전체 최신 개발을 재확인하고 다음 배포를 준비한다. 제안 버전 v0.9.5. 실제 migration/reset/재구축은 실행 전 별도 승인. 이 이슈 생성은 실행 승인이 아니다.

## 확인한 snapshot
- 운영 Git main/tag v0.9.4: a0cef206c7672541494696bec47ae0ca62723322
- 후보 dev: 5359efa0fb52d48cefaa9207d062af7146fcfa74 (PR457까지)
- Supabase 읽기 전용 확인: migration112/head room_event_effective_lookup_indexes. API ACTIVE46, artifact49e472e383dd018e5dc390796a0203c9d3a730d61cf717e3a2d3461bb8cabe40 (v0.9.4 기록과 동일). 문서의 API45는 과거 번호.
- 운영 공개 health200/OpenAPI151 paths163 operations 확인. 후보154/166은 PR457 CI 근거이며 미배포.
- 프런트 dev795da7ec440d37967ecba601eda576e1be9d08ad, DOCS/33와 #219/#220 계약 대조. frontend source 변경 없음.
- squash 이력 때문에 main..dev 커밋 수를 신규 기능 수로 쓰지 않는다. 실제 tree diff 기준 SQL7개 추가, 기존 SQL 수정/삭제 없음.

## 배포 포함 후보
- #442 공통 최신 인증 DB 왕복 통합, AUTH_CONTEXT_UNAVAILABLE 503 계약
- #416 객실 특이사항 단일 집계, 주급 basis CTE, 응답 내 cursor 키 준비 공유
- #414 주급 wrapper 단일 호출 내 집계 재사용
- #415 배정 이력 대상별 색인/이월 표시 단일 순회
- #446 오늘/내일 계획일·미완료 대상 조회와 KST 자정 미착수 이월
- #452 PIN 자유 문자열 호환, 관리자 Excel export 및 지정 Drive preview/apply

## 신규 SQL (실행하지 않음)
113 common_auth_context_read
114 room_board_issue_counts_single_scan
115 assignment_tomorrow_backlog
116 payroll_remittance_basis_materialized
117 payroll_projection_materialization
118 assignment_midnight_rollover
119 room_pin_transfer
운영 history와 source 이름/내용 mapping 재확인 후 pending7개만 적용 대상. manifest.pending41은 오래된 baseline78 기준이므로 운영 pending으로 사용하지 않는다.

## 남은 gate / 순서
- [x] 이슈/PR/dev-main tree/운영 공개 계약·history/runtime 읽기 확인
- [ ] PR456은 benchmark/tests/docs-only Draft, required CI PASS지만 최신 dev보다 뒤처짐. 통합·재검증·QA 후 포함 여부 확정; 기능 배포 차단 사유로 과장하지 않는다.
- [x] main에만 있는 RELEASE_V0.7.1 및 RELEASE_V0.9.0~4 문서 6개를 원문 보존. 새 release note/프런트 운영 상태표는 실제 배포 후 확정.
- [ ] 확정 source의 application/Edge/OpenAPI 및 독립 release QA 확인
- [ ] 사용자 승인 후 release/v0.9.5→main PR에서 격리 CI 전체 DB 최종1회: fresh/SQL/upgrade/RLS/권한/경합/정적 exact baseline. 실패·입력 변경 시 재실행도 사전 승인. 현재 Full DB NOT RUN.
- [ ] 성능 SQL의 기존/후보 금액·JSON 동등성, 계획/비용 확인. 실제 운영 속도 개선률 미측정.
- [ ] #452 비공개 원본/tab/readonly 서비스계정 권한/별도 HMAC 설정 준비. 미설정 import503과 API 배포/기능 활성화 구분.
- [ ] 보호 규칙·리뷰·CI 만족 후 main squash, 동일 DB 검증 입력 proof 재사용 확인
- [ ] 별도 운영 migration 승인 후 pending7개 DB-first, API/필요 worker 호환 확인 및 배포
- [ ] 운영 health/명세/권한/CORS와 승인된 안전 smoke, Swagger154/166 일치 확인. 실제 PIN import는 일반 배포 smoke에 넣지 않는다.
- [ ] 프런트 #207/#219/#220 운영 연결 인계, 태그/Release 실제 결과 기록

## 복구 및 운영 주의
#452 자유 문자열 PIN이 저장된 뒤 숫자전용 이전 runtime으로 단순 rollback하면 기존 값 조회가 실패할 수 있다. 호환 복호화 유지 복구본을 준비하고 원장을 삭제해 되돌리지 않는다. 실제 PIN 변경/Drive import/Sheet outbox·Cron 설정 변경은 실행하지 않는다.
#446 migration은 이미 실행 중인 scheduler가 다음 호출부터 새 이월 정책을 수행할 수 있다. API 배포 시점만 변경 시점이라고 가정하지 말고 DB 적용 시점·업무 영향/일시정지 여부를 운영 적용 승인에 명시한다.

## 제외 / 후속
백업·복원·DB 초기화(#273/#378/#396; Draft379/392/402), 사진 삭제/썸네일(#411), 배정 hydration 신규RPC/실측(#415), 가능일 pagination/rowcap 실측(#427), 기존 provider 활성화와 안전 fixture 없는 UAT는 별도다. 기존 보안 경고나 미실행을 PASS로 표시하지 않는다.

## 검증 근거
PR457 required application/manifest CI38368026344 PASS, 보고된 통합 Node122files3045/Edge/독립 QA. 이는 source CI 증거이며 최종 릴리스 DB 검증 증거가 아니다. PR451/453/454/455 및 신규 SQL 후보의 source QA 기록을 보존한다.
로컬 미커밋 9개 generated CRLF 변경 보존; 이번 점검에서 코드/DB/운영 설정 변경0.

## 로컬 준비 checkpoint

2026-10-13: source5359efa 기준 ci:quality를 재실행했다. Node122파일3045개,
typecheck/build/secrets/OpenAPI154paths166operations PASS. lint exit0이지만 기존
warning20/info57이 있어 경고0은 아니다. 기능 코드 변경 없이 배포 준비 문서를 추가하고
main의 과거 릴리스 문서6개를 원문으로 보존한다. 독립 read-only 배포 준비 검토에서
위 DB/PIN rollback/scheduler/설정/문서 gate를 재확인했다. 아직 배포 준비 완료 판정이 아니다.
