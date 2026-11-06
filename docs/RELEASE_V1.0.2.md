# v1.0.2 근무 가능일 알림과 전체 기기 푸시

근무 가능일 변경 요청→관리자, 승인·반려→요청 메이드 알림과 모든 알림 종류의 PC·휴대폰 Web Push를 연결한다. 사용자 최신 결정은 [전체 기기 푸시](./ALL_NOTIFICATION_DEVICE_PUSH.md), 도메인 계약은 [가능일 알림](./AVAILABILITY_NOTIFICATIONS.md)을 따른다.

현재main575bf32는 배정 긴급 수정v1.0.1이다. 이 릴리스는 해당 소스와 릴리스 기록을 보존한 최신dev에서v1.0.2로 준비했다. PR #597의 application/migration(source-only) CI run42145317362가 통과했고dev cd87ca5로 병합됐다. main과dev의 squash 이력 연결 뒤 전체 tree가 검증된dev와 같은지 확인했다.

## 준비된 운영 변경

- pending151: `20261106002729_availability_change_notifications.sql`. 기존150개 운영 migration은 보존하며 신규 사건부터 알림을 생성한다. 최초 CI에서 발견한 enum/text 비교 오류는 운영 미적용 파일에서 수정했다.
- pending152: `20261106010813_all_notification_device_push.sql`. 기존16개 알림 family의 push 제외를 해제해 전체63개가 푸시 대상이 된다. 정보성 상태·수신자·권한·자기 행동 제외·소급 재발송 금지는 유지한다.
- API/notification-delivery의 `availabilityRequest` 링크 처리. API 명세0.6.0, 런타임1.0.2.
- 프런트 typed 수신/클릭 처리를 먼저 배포하고, 필요한 Function Secrets를 구성한 뒤 API/worker를 갱신하고 migration151·152를 적용한다.
- 읽기 확인 당시 구독0·발송 Cron0·발송/등록 필수 secret 미설정. 사용자는 [운영 순서](./ALL_NOTIFICATION_DEVICE_PUSH.md)의 키 설정·Vault 등록1회·비활성 Cron 설치1회·수동 검증2회·활성화1회·연속5회 상태 확인을 전체 DB 성공 조건으로 승인했다. 아직 실행하지 않았다.

## 승인과 검증 이력

기존 후보7b88721의 승인된 전체 DB 실행은 PR #595 run42141304313에서 수행했다. main 이력을 연결한473659f의 전체 Git tree는7b88721과 동일했다. application PASS, migration은 새 함수의 enum=text 비교 오류로 strict lint에서 FAIL이며 cleanup은 성공했다. SQL/upgrade/경합 전체 성공 증거는 없다. 운영 적용0회.

fbd7583의 run42143097303 attempt1은54322 포트 충돌로 DB 시작 전에 실패했다. 별도로 승인된 실패job1회 재실행(attempt2/job127650248891)은 fresh152·catalog·template·TLS/atomic·승인 lint baseline·합성 backup을 통과했다. 누적56→152 upgrade의 이전 카탈로그 보존 기준이16종 push 변경을 거부해 실패했고 cleanup은 성공했다. 전체SQL·나머지upgrade·경합의 성공 증거는 없다.

후속 PR #597은 누적56/73 검사에 정확한16개 false→true 예외를 연결하며 다른 기존 필드·행 보존을 유지한다. 알림SQL·API·worker 변경은fbd7583과 동일하며, 이미 운영 배포된v1.0.1의 배정 긴급 수정도 보존한다. 로컬234파일/6,351개 검사와 typecheck/build/manifest가 통과했다. 이 새 입력은 **Full DB NOT RUN / 운영 적용 NOT RUN**이며, 재승인 전 release push/DB 실행을 하지 않는다.

필요한 재승인은 새 최종 후보의 격리 CI 전체 DB1회(fresh·SQL·upgrade·경합·정리)다. 통과 뒤의 main 보호 병합·동일 검증 지문 재사용, pending2개 운영 적용1회와 API/worker·키/Vault/Cron·검증/활성화는 기존 승인 범위를 따른다. 실패·입력 변경 시 자동 반복하지 않는다.

프런트 PR #315(dev)/#316(main d6f6e376, SW2026-11-06-7)는 운영 배포돼 typed link·기기별 권한 안내·ID 중복 억제를 제공한다. 실제 기기 표시는 각 기기 권한/구독과 실제 신규 알림으로 확인해야 한다. provider 수락이나 UI 합성 검사를 실제 기기 전달로 표현하지 않는다.
