# v1.0.1 근무 가능일 변경 알림

개발 통합: PR #592 (`16dfb8d7f657fcc32185b3f49ff2832802a4c927`). application / migration(source·manifest) PASS. 사용자 요청의 이번 주 변경 요청→관리자, 승인·반려→요청 메이드 알림을 연결한다. [상세 계약](./AVAILABILITY_NOTIFICATIONS.md).

## 준비된 운영 변경

- pending migration 1개: `20261106002729_availability_change_notifications.sql` (source151). 기존150 migration 내용과 운영 기록은 보존하며 신규 사건부터 알림을 생성한다.
- API와 notification-delivery Edge 함수가 `availabilityRequest` 링크를 읽도록 배포한다. API 명세 버전은 0.6.0이며 런타임 릴리스 표시는 1.0.1이다.
- 프런트 availabilityRequest 처리 버전을 먼저 배포하고, API/worker를 갱신한 뒤 migration을 적용한다. 오래된 API가 새 링크를 거절하는 구간을 만들지 않는다.
- 기존 outbox 소급 재전송·임의 업무 요청/승인·반려·테스트 push 전송은 포함하지 않는다.

## 승인과 검증 상태

**Full DB NOT RUN / 운영 적용 NOT RUN.** 이 로컬 릴리스 후보의 push/PR 생성은 아직 하지 않았다.

승인 요청 범위는 최종 통합 입력에 대한 격리 CI 전체 DB 검증 1회(fresh·SQL·upgrade·경합·정리), 통과 시 main 병합, 해당 pending migration 1회 운영 적용, API/notification-delivery와 프런트 배포, read-only smoke/advisor 확인과 v1.0.1 태그다. 입력 변경이나 실패 시 동일 승인으로 전체 DB를 반복 실행하지 않는다.

main 병합 뒤 동일 검증 지문 성공 증거를 재사용한다. 운영 확인은 migration history151, family3 및 trigger·함수·권한, Edge ACTIVE와 OpenAPI link 계약, 프런트 build-info/실제 HTML/SW 일치를 대상으로 한다. 실제 기기 수신은 새 요청이 발생하고 해당 기기의 알림 권한·활성 구독이 있을 때 확인할 수 있다.

## 2026-11-06 추가 읽기 점검

프런트 PR #314는 main `7dde9761f4d583a5786bf2470af9d7bbc06823f8`에 병합·운영 배포되었다(SW `2026-11-06-6`). 운영 HTML/SW/hash와 기존 runtime 설정 일치를 확인했다.

운영 DB의 Web Push 활성 구독은 0개이며 `notification-delivery` Cron은 없다. 이번 후보는 앱 알림과 typed outbox를 생성하지만 휴대폰/브라우저 배경 푸시 완료를 주장하지 않는다. 기존 [Web Push runbook](./WEB_PUSH_DELIVERY_RUNBOOK.md)의 활성화·승인된 기기 UAT는 별도 선행 조건이다. 다른 알림까지 전송할 수 있는 Cron이나 기존 큐 재전송은 이 릴리스 승인 범위에 포함하지 않는다.
