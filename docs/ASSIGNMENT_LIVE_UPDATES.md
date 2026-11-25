# 배정과 알림의 실시간 동기화 (#620)

개발 브랜치의 SQL 후보 155번부터 관리자와 메이드의 유효한 세션에 업무·알림 변경 신호를 전달한다. 업무 원본은 기존 로그인 API에서 보며 모바일 백그라운드 알림은 기존 Web Push를 사용한다.

## 프런트 구독 계약

- 앱의 Supabase Auth access token을 Realtime에 사용한다. 세션 JWT의 소문자 UUID `session_id`를 UTF-8로 SHA-256 해시해 소문자 64자리 16진수로 만든다. 채널은 `rms-updates-v1:<hex>`이다. SDK 채널 옵션은 `config.private: true`, 수신은 `broadcast`의 `changed` 이벤트다. 세션 UUID·토큰·채널을 로그나 URL에 넣지 않는다.
- 메시지 payload는 `{ "version": 1, "eventId": "<uuid>", "changed": ["assignments"] }` 또는 `{ "version": 1, "eventId": "<uuid>", "changed": ["notifications"], "notificationId": "<uuid>" }`다. 읽음·해결 신호에는 `notificationId`가 없다. 기존 로그인 토큰 갱신을 소켓 인증에 전달한다.
- 배정 신호를 받으면 현재 보고 있는 예정 청소일의 `GET /v1/assignments?serviceDate=D`와 관련 홈·상세를 다시 읽는다. 알림 신호는 `GET /v1/notifications`로 배지·목록을 갱신한다. 알림 ID는 서버 응답에서 본인의 새 알림임을 확인한 뒤 앱 소리 중복 방지에 쓴다. 일괄 통보의 여러 신호는 짧게 묶고, 재조회 중 신호를 받으면 마지막 변경을 한 번 더 반영한다.
- 최초 구독 완료, 재연결, foreground 복귀에서 둘 다 다시 읽는다. Broadcast는 일시적이라 소켓이 살아 있는 상태에서도 드물게 신호가 빠질 수 있다. 열린 화면에서 낮은 빈도의 확인 조회(초기 제안 60초)를 유지한다. 접속 실패 시 기획안의 15→30→60초 간격을 사용한다. 계정·날짜 변경 시 이전 응답을 폐기하고 작성 중인 메모·업로드를 보존한다.
- iOS 홈 화면 설치 앱과 Android에서 기존 `/v1/push-subscriptions/config`와 등록·해제 계약을 사용한다. 실제 기기 시험에서는 등록 확인 뒤 합성 시험 계정에 배정 통보를 보내 잠금 상태에서 받는다. 사용자용 ‘테스트 알림 보내기’는 기존 API 계약에 없으므로 별도 테스트 발송 명령이 필요하다.

## 저장과 권한

통보된 현재 배정이 생기거나 종료될 때 수신 대상이 갱신된다. 메모 변경은 새 배정 버전으로 이어진다. 재배정 시 이전 담당과 새 담당을 각각 처리한다. 알림 생성 및 실제 읽음·해결 변경도 독립적으로 신호를 만든다. 배정·알림과 같은 트랜잭션의 DB Broadcast는 커밋 뒤 전송된다. 초안과 롤백은 수신자에게 보이지 않는다.

DB는 채널 가입 시 로그인한 사용자, 정확한 세션, 비밀번호 변경 여부, 계정 상태를 확인한다. 발송 시 세션의 존재와 만료도 재확인한다. 행 잠금을 사용해 권한 폐기와 발송 순서를 확정하며 잠긴 세션은 보완 조회로 복구한다. 이미 커밋돼 전달 중인 신호는 재조회 시 API에서 현재 권한을 다시 확인한다.

## 검증과 운영 적용

1. 일반 개발 PR은 앱 검사, manifest, 소스 QA로 검증한다. 승인된 최종 격리 DB 검증에서 `assignment_live_updates.sql`의 통보·메모·재배정·회수·읽음·세션 검사를 실행한다. SQL 테스트는 DB 발송 경계를 관찰하며 실제 WebSocket 연결도 후속으로 확인한다.
2. 연결 시험 전 Supabase의 관리형 `realtime.messages`, `realtime.send`, `realtime.topic`, 테이블 RLS와 155번의 세 정책 설치 여부를 확인한다. 운영에서는 현재 사용 중인 다른 기능 영향을 확인한 뒤 비공개 채널 설정으로 열고, 계정 A·B와 익명으로 실제 수신과 송신 차단을 검증한다. Realtime이 없는 격리 DB에서는 권한 도우미와 이벤트 생성은 검증할 수 있으며, 정책·WAL 송신 검증은 Realtime이 준비된 환경에서 수행한다.
3. iPhone·Android에서 새 배정, 잠금 알림, 권한 거부, 회수, 재연결과 중복 소리를 확인한다. 정상 네트워크의 열린 화면 반영은 p95 3초를 목표로 한다. close/rejoin과 관계없이 세션 폐기 뒤 생긴 새 신호가 이전 채널에 도착하는지 함께 검사한다.
4. 운영 마이그레이션은 실행 전 별도 승인. 프런트는 해당 운영 환경의 Realtime 검증 결과를 확인한 뒤 연결을 활성화한다. 신호 오류가 관찰되면 프런트는 재조회 경로로 복귀할 수 있다.

[백엔드 #620](https://github.com/wrongstory/room-management-system-backend/issues/620) · [프런트 #337](https://github.com/makee-ham/room-management-system/issues/337) · [Broadcast 안내](https://supabase.com/docs/guides/realtime/broadcast) · [채널 권한](https://supabase.com/docs/guides/realtime/authorization)
