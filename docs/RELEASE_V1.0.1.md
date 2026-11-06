# v1.0.1 근무 가능일 알림과 전체 기기 푸시

근무 가능일 변경 요청→관리자, 승인·반려→요청 메이드 알림과 모든 알림 종류의 PC·휴대폰 Web Push를 연결한다. 사용자 최신 결정은 [전체 기기 푸시](./ALL_NOTIFICATION_DEVICE_PUSH.md), 도메인 계약은 [가능일 알림](./AVAILABILITY_NOTIFICATIONS.md)을 따른다.

## 준비된 운영 변경

- pending151: `20261106002729_availability_change_notifications.sql`. 기존150개 운영 migration은 보존하며 신규 사건부터 알림을 생성한다. 최초 CI에서 발견한 enum/text 비교 오류는 운영 미적용 파일에서 수정했다.
- pending152: `20261106010813_all_notification_device_push.sql`. 기존16개 알림 family의 push 제외를 해제해 전체63개가 푸시 대상이 된다. 정보성 상태·수신자·권한·자기 행동 제외·소급 재발송 금지는 유지한다.
- API/notification-delivery의 `availabilityRequest` 링크 처리. API 명세0.6.0, 런타임1.0.1.
- 프런트 typed 수신/클릭 처리를 먼저 배포하고, 필요한 Function Secrets를 구성한 뒤 API/worker를 갱신하고 migration151·152를 적용한다.
- 현재 구독0·발송 Cron0·발송/등록 필수 secret 미설정. signed-v1 호출 키·Vault 등록과 비활성 Cron 설치, hosted smoke 뒤 활성화는 정확한 추가 승인 대상이다. [운영 순서](./ALL_NOTIFICATION_DEVICE_PUSH.md)에 각1회 범위를 기록했다.

## 승인과 검증 이력

기존 후보7b88721의 승인된 전체 DB 실행은 PR #595 run42141304313에서 수행했다. main 이력을 연결한473659f의 전체 Git tree는7b88721과 동일했다. application PASS, migration은 새 함수의 enum=text 비교 오류로 strict lint에서 FAIL이며 cleanup은 성공했다. SQL/upgrade/경합 전체 성공 증거는 없다. 운영 적용0회.

현재 수정본은 **Full DB NOT RUN / 운영 적용 NOT RUN**이다. 실패한 실행의 승인을 재사용해 release branch를 push하거나 CI를 재시작하지 않는다. 개발 PR #596은 source/manifest만 수행한다.

재승인 범위: 최종 통합 입력의 격리 CI 전체 DB1회(fresh·SQL·upgrade·경합·정리), 성공 시 main 보호 병합·동일 검증 지문 재사용, pending2개 운영 적용1회, API/worker 배포, signed 호출 설정/비활성 job 설치/수동 smoke/활성화를 각각 계획된1회, read-only smoke/advisor·연속5회 heartbeat 및 v1.0.1 태그. 실패·입력 변경 시 자동 반복하지 않는다.

기존 프런트 PR #314(main7dde976, SW2026-11-06-6)는 운영 배포됐으며 추가 기기 수신 수정은 프런트 PR #315다. 실제 기기 알림 표시는 각 기기 권한/구독과 실제 신규 알림으로 확인해야 한다. provider 수락이나 UI 합성 검사를 실제 기기 전달로 표현하지 않는다.
