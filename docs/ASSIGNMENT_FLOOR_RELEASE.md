# 층수 근거리 배정 운영 수정 후보

- 운영 기준 `main@3e80524`에서 분리한 `hotfix/assignment-floor-proximity`다.
- 백엔드 개발 PR #530의 층수 계산/가산 점수/회귀 테스트만 반영한다. 프런트 개발 PR #260은 병합 완료, 운영 후보는 별도 main PR이다.
- 엘리베이터 구역 뒤에 연속 객실 층수 차이 합을 비교한다. 배정 가능 수·요금 균형·고정 담당/순서·재청소 원담당·기존 저장/통보를 보존한다.
- DB migration 추가/수정 0개. 운영 기준 122개/head `post_approval_memo_only` 그대로다. dev의 후속 15개 DB 변경은 포함하지 않는다.
- Node 22 전체 126파일/3,157테스트, Deno 2.1.4 Preview core 7테스트, typecheck/build/manifest/OpenAPI 154 paths/166 operations 통과.
- 개발 후보의 5,391테스트 기록과 운영 후보의 3,157테스트 기록은 각각 다른 기준 소스의 검증이다.
- Full DB NOT RUN. AGENTS.md와 FINAL_DB_VALIDATION.md에 따른 사용자 승인 전에는 hotfix push/PR 생성 및 전체 DB 재구축을 실행하지 않는다.
- 승인 대상: 이 후보의 GitHub Actions 격리 DB 전체 검증 1회(기존 122 migration fresh/upgrade/SQL/권한/경합/cleanup). 실패/취소/입력 변경 뒤 재실행은 다시 승인받는다.
- 운영 DB reset/migration/업무 데이터 쓰기는 제외한다. 필수 CI/리뷰 통과 뒤 main 병합, 정확한 main의 API 및 프런트 배포, health/OpenAPI/비인증 거부/CORS/정적 파일·서비스워커 확인을 수행한다.
- API 응답은 no-store이며 관리자 기존 미리보기/저장 흐름을 유지한다. 실제 배정 저장·통보 smoke는 실행하지 않는다.
- 되돌림은 이전 main API/프런트 아티팩트를 재배포하는 방식이며 DB 복구나 이력 변경이 필요하지 않다.
