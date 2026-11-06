# v1.0.4 전체 알림 기기 푸시 운영 기록

2026-11-06 사용자가 승인한 근무 가능일 알림과 전체 기기 푸시를 운영에 반영했다. 메이드의 이번 주 변경 요청은 관리자에게, 승인·반려는 요청한 메이드에게 알린다. 승인 전과 반려 후에는 기존 가능일을 유지한다. 모든 63개 알림 family / 45개 category가 Web Push 대상이며 기존 수신자·권한·자기 행동 제외·세션 정책을 보존한다.

## 코드와 최종 DB 성공 증거

- [릴리스 PR #605](https://github.com/wrongstory/room-management-system-backend/pull/605), main `d761e8e1a032899ef2a89032e8d93c38895c7504`.
- 승인 후보 `9fbb115659cf3ee13ba0690be3d25497fad94181`의 [최종 DB CI42157951253](https://github.com/wrongstory/room-management-system-backend/actions/runs/42157951253)은 application, fresh DB, upgrade, SQL, static-warning, 날짜 경계, 전체 동시성, cleanup 및 Full DB proof 모두 성공했다. 로컬 application 234파일/6,363개·typecheck/build 및 개발 CI #604도 통과했다.
- 검증 입력 지문은 `3eff479b20dd9b74c6a1a498ec6961b5465b2b73169fad3e09dda9b021c22f87`이다. 운영 배정 요금 균형 hotfix v1.0.3을 보존한 release head `b59981115320c1410e2647fb8ce5640dcac00124`와 최종 main의 입력 지문이 동일하다.
- 후속 [PR CI42161989472](https://github.com/wrongstory/room-management-system-backend/actions/runs/42161989472), [main CI42162331779](https://github.com/wrongstory/room-management-system-backend/actions/runs/42162331779)의 application/migration 모두 성공했다. main gate가 같은 PR의 성공 증거를 검증했으며 DB 재구축 단계는 전부 생략됐다.
- Code Review 로그 제공자가 HTTP502를 반환해 GitHub 연결 API의 실제 job/step 결과로 성공 증거를 확인했다. 이전 실패를 성공 증거로 사용하지 않았다.

## 실제 운영 적용

대상은 운영 Supabase `aodikrxcczbogjpsjwjt`다. 사용자 승인 범위의 각 DB 쓰기와 수동 positive 호출을 1회씩 실행했다.

- 기존 150개 migration의 전체 행 digest `3900097e474ebf3c8564943c307033dc`를 보존했다. 공식 CLI의 remote history와 일치하는 격리 migration 디렉터리에서 `migration up --linked` 1회로 `20261106002729_availability_change_notifications`와 `20261106010813_all_notification_device_push`만 적용했다. 최종 history는 152개다. 운영 reset, db push, history repair는 하지 않았다.
- 새 VAPID pair/version, binding key, signed invoke key 등 미설정 10개 Function Secrets를 설정하고 기존 구독 암호화 key/keyring을 보존했다. Vault `notification_delivery_invoke` 등록은 1회다. 비밀 원문은 문서·Git·명령행에 기록하지 않는다.
- 정확한 main API61과 notification-delivery16을 배포했다. 최초 server-side 배포는 생성 파일/import map 누락, 다음 API 업로드는 크기 제한으로 실패했다. Node22.23.2로 검증된 생성 파일을 준비하고 API는 local Docker bundle 전송으로 성공했다. pinned Edge bundle은 19,308,989 bytes이며 source 변경은 없다. worker는 명시적 import map을 사용한 server-side 배포가 성공했다.
- 전역 Function Secrets 설정에 따른 기존 worker metadata version 증가는 있었으나 다른 worker 소스를 배포하거나 설정을 바꾸지 않았다. 예약 정기 작업은 계속 활성 상태다.
- 사후 확인: catalog63/push63/category45, 가능일 요청·승인·반려 3종, trigger·immutable catalog·all-push CHECK·증거 index 정상, private 함수의 anon/authenticated/service_role 예상 밖 EXECUTE 권한 0.
- API `/health` 200. worker missing/bad signature 401, query 404, body 400으로 차단됐다. signed empty HTTP positive 1회는 200이며 오래된 10건을 `STALE_NOTIFICATION`으로 suppressed 처리했다. 전송·재시도·dead-letter·blocked는 모두 0이며 과거 알림을 재발송하지 않았다.
- `ops/notification-delivery/install.sql` 1회로 매분 job을 비활성 설치했다. SQL helper positive 1회는 pg_net HTTP200, timeout false, error null과 succeeded heartbeat를 남겼다. `activate.sql` 1회로 04:34 UTC에 활성화했다.
- 자동 실행 heartbeat가 04:35·04:36·04:37·04:38·04:39 UTC에 5회 연속 succeeded였고 Cron 실행 기록 5개도 모두 succeeded였다. 각 관측의 overdue/dead-letter/operator-blocked는 0이며 기존 reservation Cron은 계속 활성 상태다. 운영 OpenAPI161경로/174operation과 availabilityRequest 링크도 확인했다.

보안 Advisor는 신규 항목·ERROR 0이며 기존 `auth_leaked_password_protection` WARN만 동일하게 남아 있다. 생성한 임시 secret 파일은 삭제했고 hosted Function Secrets와 Vault만 유지한다.

## 실제 기기 확인 범위

배포 시 등록 구독은 0개다. 실제 PC·휴대폰 표시 및 새 업무 사건의 끝까지 수신 확인은 아직 하지 않았다. 각 기기에서 로그인 → 더보기 → 알림 연결 → 브라우저 허용을 완료해야 한다. iPhone은 기존 화면 안내대로 홈 화면에 설치한 앱에서 연결한다. 임의 업무 사건·가짜 수신자·과거 알림 재전송으로 실기기 성공을 만들지 않는다.

최신 프런트는 이미 배포된 typed link·notificationId 중복 억제·기기별 연결을 유지한다. 백엔드 활성화나 provider 응답을 실제 기기 표시 성공으로 기록하지 않는다.
