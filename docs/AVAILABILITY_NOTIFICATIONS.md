# 이번 주 근무 가능일 변경 알림

2026-11-06 사용자 요청: 메이드가 변경 요청을 제출하면 관리자에게, 관리자가 승인·반려하면 요청한 메이드에게 알린다. 승인 전과 반려 후에는 기존 가능일을 유지한다. 다음 주 직접 제출은 이번 알림 대상이 아니다.

| 사건 | 수신자 | 앱 내 알림 | 푸시 대기열 | 처리 필요 |
| --- | --- | --- | --- | --- |
| `availability.change_requested` | 업무 관리자 | 생성 | 활성·비밀번호 변경 완료 수신자 | 승인 또는 반려 전까지 |
| `availability.change_approved` | 요청한 메이드 본인 | 생성 | 활성·비밀번호 변경 완료 수신자 | 아니오 |
| `availability.change_rejected` | 요청한 메이드 본인 | 생성 | 활성·비밀번호 변경 완료 수신자 | 아니오 |

성공한 도메인 명령이 추가한 `availability.change_requested` / `availability.change_decided` 감사 행의 AFTER INSERT 트리거에서 기존 typed writer를 호출한다. 원본 요청 UUID·요청/결정 시각·actor·상태·감사 payload를 검증하며, 같은 트랜잭션에서 inbox와 `private.notification_delivery_outbox`를 기록한다. 결정 시 관리자 요청 알림을 `resolvedAt`으로 해소한다. 기존 명령 영수증과 수신자별 논리 사건 unique key가 재시도 중복을 막는다. 실패한 명령은 알림도 롤백한다.

`deepLink: { kind: "availabilityRequest", entityId: 요청 UUID }`이며 방/청소대상은 null이다. 요청별 독립 grouping을 사용한다. 프런트는 기존 요청 조회 API의 역할·소유권 범위에서 요청을 다시 확인하고, 이번 주 관리자는 기존 승인·반려 화면으로 이동한다. 과거 주차나 결정 완료 요청은 해당 요청 이력을 읽기 전용으로 보여 준다. 승인 알림의 요청 날짜가 이후 요청까지 포함한 현재 승인 상태라고 단정하지 않는다.

알림 제목·본문에는 자유 입력 사유·개인정보를 복제하지 않는다. Web Push는 기존 일반 문구와 UUID만 포함한 암호화 payload, 구독 검증, worker 재시도·만료 정책을 사용한다. 푸시 대기열 생성과 실제 기기 수신은 다르며, 기기 알림 권한과 활성 구독이 필요하다. 과거 요청에 대한 소급 발송, 기존 큐 강제 재전송, 임의 수신자 발송 API는 추가하지 않는다.

## 검증 및 적용 상태

- DB 없는 TypeScript·빌드·OpenAPI(161 paths / 174 operations)·manifest(151)·PostgreSQL 15/17 SQL 문법 검사 통과. Vitest 234 files / 6,339 tests 전체 통과, 변경 후 재실행에서 기존 Google Sheets 테스트 1건이 5초 시간 초과했고 해당 파일 16개 검사는 단독 재실행 통과했다. 해당 CI 결과를 별도로 확인한다.
- Deno 2.1.4의 notification API/provider 합성 검사 11개 통과. 실제 네트워크 발송과 운영 DB 쓰기는 하지 않았다.
- `supabase/tests/availability_notifications.sql`: 수신자 범위, 초기 승인 대기, 요청/결정 멱등성, 승인/반려 푸시, 관리자 처리 완료, stale 명령 무알림을 롤백 fixture로 검증한다.
- 기존 최종 fresh/upgrade/경합 검사에 새 migration을 포함한다. upgrade 보존 검사는 기존 catalog 행 전체를 유지하고 정확한 신규 3행만 허용한다.
- **Full DB NOT RUN**. 이 문서의 구현은 dev 준비 상태이며 운영 DB 적용·Edge API/notification-delivery 재배포·실기기 수신을 완료했다는 증거가 아니다. 저장소 규칙에 따라 최종 통합본 DB 검증과 운영 적용은 실행별 명시 승인 후 수행한다.
