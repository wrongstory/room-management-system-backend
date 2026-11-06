# v1.0.1 객실 중복·근거리 배정 긴급 수정

- 운영 main 기준으로 배정 수정만 반영한다. 다른 dev 변경과 pending migration은 포함하지 않는다.
- 사용자 결정: 가까운 전체 숫자 호수 → 같은 엘리베이터 → 가까운 층 → 요금 균형. 고정 층수 제한 없음. 기존 담당·이력은 보존한다.
- 동일 배정표의 같은 roomId 신규 중복·고정 객실 중복은 `ASSIGNMENT_ROOM_CONFLICT`로 제안 차단한다. 과거 청소 의무를 삭제·취소하지 않는다.
- 운영 API의 bundled releaseVersion은 1.0.1이다. OpenAPI schema version과 DB migration은 그대로다.
- 소스 검증: Node 22.23.2, 233 files/6337 tests·typecheck·build, Edge 65/590/68 tests, 운영 bundle 19,302,424 bytes, manifest PASS. 정책 변경에 따라 Node·Edge의 과거 우선순위 기대값을 갱신하고 중복 회귀를 추가했다.
- 2026-11-06 사용자가 이 수정의 CI 격리 DB 전체 검증 1회와 성공 후 배포를 승인했다. 승인된 hotfix PR의 최종 입력에만 실행한다. 운영 migration은 0건이다.
- 검사 대기·실패를 PASS로 기록하지 않는다. 필수 application/migration과 동일 입력의 성공 proof를 확인한 뒤 exact main의 api만 배포하고, Function 상태·health·정적 소스 및 프런트 배포를 확인한다.
- 운영 계정의 배정 저장·통보, 새로운 DB 동시 명령 제약, 이력 정리는 이 변경에 포함하지 않는다.
