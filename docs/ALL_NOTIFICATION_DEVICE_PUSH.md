# 모든 알림의 PC·휴대폰 푸시

2026-11-06 사용자는 앱 알림함과 휴대폰 푸시를 모두 요청했고, 이어 “알림은 다 기기 푸시 알림 가야 해 PC든 폰이든”으로 범위를 확정했다. 근무 가능일 요청/승인/반려를 포함한 모든 63개 알림 family를 push eligible로 유지한다.

## 변경과 보존

- source152는 기존 검수·컴플레인·주급의 16개 `push_eligible=false`만 true로 바꾸며, 새 family도 푸시 대상이어야 하는 CHECK를 추가한다. 기존 immutable catalog trigger는 같은 migration에서 복원한다.
- 수신자·권한·자기 행동 알림 제외·비활성/임시 비밀번호/만료 세션 제외는 기존 계약을 따른다. 정보성 알림을 `requires_action=true`로 바꾸지 않는다.
- 과거 inbox/outbox를 복제하거나 재전송하지 않는다. migration은 Cron이나 Vault/Function Secrets를 변경하지 않는다.
- 아직 운영 미적용인 source151의 `availability_request_status = text` 비교를 명시적 `::text` 비교로 고친다. 운영 적용된150개 migration은 그대로다.
- upgrade 검증은 정확한16개 false→true만 허용하고 나머지 전체 catalog 필드를 그대로 비교한다. 기존 snapshot digest는 이16개 flag만 원래false로 정규화하며 unfiltered catalog를 별도로 대조한다.

## 실제 실행 상태

2026-11-06 수정 후보fbd7583의 run42143097303 attempt1은 검증용54322 포트 충돌로 DB 시작 전에 실패했다. 사용자 승인 후 실패 job만1회 재실행한 attempt2/job127650248891은 fresh152·최종 catalog·template·TLS/atomic fixture·승인된 lint baseline·합성 backup dry-run을 통과했다. 이어 누적56→152 업그레이드의 기존 catalog 행 보존 검사가 요청된16개 push flag 변경을 거부해 실패했고 cleanup은 성공했다. 전체SQL·나머지upgrade·경합은 완료되지 않았고 운영 적용은0회다.

후속 수정은56/73 누적 업그레이드 두 곳에서 catalog 원문 메타데이터를 별도로 대조한다. 기존16개가 모두false였다는 전제 아래152에서만true를 기대하며, 수신자·정보성 상태·링크·나머지 모든 기존 필드와 다른 테이블의 행 해시 보존은 그대로 검사한다. 소스SQL·API·worker·운영 실행 범위는 바꾸지 않는다. 새 입력의 전체DB 재실행은 별도1회 승인이 필요하다.

PR #595 최초 전체 DB run42141304313은 source151 함수 타입 오류로 strict lint에서 실패했다. fresh 적용·catalog·template·TLS 검사 후 중단했고 cleanup은 성공했다. 이후 재실행 결과는 위 기록을 따르며 운영 적용은 아직 하지 않았다.

읽기 확인: 운영은150 migrations, Web Push 구독/revision0, notification Cron0, Vault 호출키0, pending10(모두24시간 경과)·target0. VAPID 및 binding/invoke Function Secrets도 없다. 단순 Edge ACTIVE를 전달 성공으로 보지 않는다.

## 준비된 운영 적용 범위

정확한 최종 후보에 격리 전체 DB 검증1회가 성공한 뒤 main을 보호 병합하고 동일 지문 증거를 재사용한다. API/worker가 새 링크를 이해한 뒤 pending151·152를 한 번 적용한다. 별도 SQL/운영 실행 승인은 아래의 각 실행을 포함해야 한다.

1. 신규 VAPID pair/version·binding HMAC·notification invoke key를 안전하게 생성해 필요한 Function Secrets만 설정한다. 기존 subscription envelope key/keyring은 보존하고 미설정 version을 지정한다. 호출 mode는 signed-v1, 기존 scheduler와 다른 worker의 설정은 유지한다. secret 원문은 명령행·로그·Git에 남기지 않는다.
2. 동일 새 invoke key를 Vault `notification_delivery_invoke`에1회 등록한다. 기존 동일 이름/활성 구독/예상 밖 queue 상태가 있으면 재검토한다.
3. 승인된 main API와 notification-delivery를 배포한다. missing/bad signature·query·body negative smoke,1회 signed empty-worker positive smoke를 수행한다. 만료된10건은 기존24시간 규칙에 따라 suppressed 처리하며 재발송하지 않는다. 실제 수신자 시험 사건은 임의 생성하지 않는다.
4. 기존 `ops/notification-delivery/install.sql`을1회 실행해 매분 signed 호출 job을 **비활성** 설치한다. 수동 SQL helper 호출1회로 실제 pg_net 빈 body·서명 parity를 확인한다. 성공 시 `ops/notification-delivery/activate.sql`을1회 실행한다.
5.5회 연속 성공 heartbeat, overdue/dead-letter/operator-blocked0, 활성 job·5분 이내 heartbeat를 확인한다. 오류 시 해당 notification job만 비활성화한다. 기존 reservation Cron·업무 원장·과거 기록을 삭제하지 않는다.
6. 각 PC/휴대폰에서 로그인→더보기→알림 연결→브라우저 허용을 거쳐야 수신 가능하다. 프런트는7종 typed link, notificationId tag,24시간·1000개 ID-only 중복 억제, 로그인 후 본인 알림 재조회를 담당한다. 실제 기기 표시 확인 전 기기 수신 PASS를 기록하지 않는다.

검증: 새 SQL의 PostgreSQL15/17 문법,6,340 application 검사, typecheck/build/manifest 및 기존 지급·검수 SQL의 실제 outbox 기대를 보강한다. 새 SQL 테스트의 실제 실행은 승인된 최종 CI에 포함한다.
