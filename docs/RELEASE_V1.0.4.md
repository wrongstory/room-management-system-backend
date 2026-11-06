# v1.0.4 근무 가능일 알림과 전체 기기 푸시

메이드의 이번 주 근무 가능일 변경 요청은 관리자에게, 승인·반려는 요청 메이드에게 알린다. 모든 63개 알림 family를 PC·휴대폰 Web Push 대상으로 유지한다. 기존 승인 전 가능일 유지, 수신자·권한·정보성 상태·멱등성·감사 근거·과거 알림 재발송 금지 원칙을 보존한다.

## 통합 범위

- 최신 dev의 가능일 알림, 전체 기기 푸시 및 검사 보완 #597·#599·#600·#604를 포함한다.
- 배정 긴급 수정 v1.0.1과 후속 요금 균형 수정 #601을 보존한다. 별도 운영 후보 #603의 v1.0.3과 버전을 구분해 이 통합본은 v1.0.4로 준비한다.
- pending migration은 기존과 동일한 151 `availability_change_notifications`, 152 `all_notification_device_push` 두 개다. 이번 경합 검사 보완은 운영 SQL·API 권한·worker를 바꾸지 않는다.
- 프런트의 typed link·중복 억제·기기별 알림 연결은 이미 배포됐으며, 최신 화면과 운영 설정을 유지한다.

## 실제 검증 결과와 한계

사용자가 승인한 6e2bb86 / PR #598 / run42153743798의 application 6,351개 검사와 전체 SQL 121파일/6,657개 검사는 통과했다. 업그레이드 체인, static-warning upgrade, KST clock 5개와 일부 동시성(알림 전달·객실 이동·PIN 시트 full-resync)도 통과했다.

가능일 경합의 사후 관찰자가 raw notifications의 직접 SELECT가 금지된 service_role Data API를 사용해 실패했다. 이후 경합과 최종 Full DB proof는 완료되지 않았으며 Supabase stop·cleanup은 성공했다. 운영 실행은 0회다.

#604는 기존 배정 경합 검사와 같은 격리 DB owner의 읽기 전용 조회를 사용한다. 실제 Node assertion으로 승인 승자의 알림 1개·패자의 0개·수신자·종류·정확한 요청 링크를 검사하며, 누락·중복·다른 수신자/링크·불완전 결과를 거부하는 합성 검사 7개를 추가했다. 개발 CI42156951257의 application/migration은 통과했고 dev a8db83e로 병합됐다. 로컬 234파일/6,363개 검사·typecheck/build와 조회 SQL의 PostgreSQL 15/17 문법 검사도 통과했다. 개발 CI는 source/manifest 검사이며 새 Full DB 성공 증거가 아니다.

이 통합 후보의 **Full DB NOT RUN / 운영 반영 NOT RUN**. 정확한 최종 후보의 격리 전체 DB 검증 1회는 별도 사용자 승인 후 실행한다. 이전 실패를 성공으로 재사용하지 않고 검사 기준을 낮추거나 자동 반복하지 않는다.

## 기존 조건부 운영 승인

전체 DB 성공 후 보호 병합과 main의 동일 입력 증거 재사용을 확인한다. 이어 pending migration 2개 적용 1회, API/알림 worker 배포, 푸시 키 설정, Vault 키 등록 1회, 비활성 Cron 설치 1회, 수동 검증 호출 2회, 발송 활성화 1회와 연속 5회 상태 확인을 진행한다. 아직 모두 0회이며 기존 운영 migration 이력과 다른 Cron을 보존한다.

각 PC·휴대폰의 실제 수신은 해당 기기의 로그인·알림 권한·구독과 신규 업무 사건으로 확인한다. worker ACTIVE나 합성 검사만으로 실제 기기 수신 성공을 기록하지 않는다. 상세 계약과 이전 실행 이력은 [전체 기기 푸시](ALL_NOTIFICATION_DEVICE_PUSH.md), [가능일 알림](AVAILABILITY_NOTIFICATIONS.md), [v1.0.2 기록](RELEASE_V1.0.2.md)을 따른다.
