# Auth·RLS·상태 변경 계약

## 신뢰 경계

- 브라우저는 publishable key와 사용자 access token만 가진다.
- 인증된 사용자는 Data API에서 자신의 범위에 해당하는 조회만 수행한다.
- 알림 원본 테이블의 브라우저 SELECT/UPDATE는 금지한다. 본인 알림 조회와 `read_at` 최초 기록은 active·비밀번호 변경 완료·live session을 재검증하는 service-role 전용 RPC만 사용하고, `resolved_at`은 검증된 도메인 command만 변경한다.
- 계정, 예약, 배정, 수행, 제출, 검수, 수익, 지급의 변경은 Fastify 서버의 검증된 명령과 트랜잭션/RPC를 통해서만 수행한다.
- 서버 secret/service-role은 서버와 배포 secret에만 둔다.
- API 로그는 Authorization·Cookie·비밀번호·토큰·PIN·휴대전화·서버 secret 필드를 `[REDACTED]`로 치환한다.
- Web Push 구독은 exact active/password-complete `admin | maid` 본인과 실제
  `auth.sessions(id,user_id)` 일치만 허용한다. developer, limited/inactive, 폐기·불일치 session, anon은 거부한다.
- Web Push private logical/revision/secret/event/limiter 테이블은 RLS를 켜고 policy를 두지 않으며
  PUBLIC/anon/authenticated/service_role raw SELECT/DML을 모두 회수한다. private helper EXECUTE도 허용하지 않는다.
- 고정 search_path SECURITY DEFINER register/retire/bounded-purge RPC만 service_role이 실행하며,
  register/retire는 actor·ownership·CAS·상한을 함수 안에서 다시 검증한다. 모든 membership mutation은
  같은 bounded global advisory lock 뒤에서만 subscription row를 잠가 endpoint swap/retire 교착을 막는다.
- endpoint/key/envelope/digest/session/token은 Data API, audit, notification, receipt, log, error projection에 노출하지 않는다.
- raw Auth session UUID는 Web Push metadata column에 저장하지 않고 current AES-GCM envelope에만 포함하며,
  후속 #111 delivery claim에서 복호화한 exact session의 생존 여부를 fail-closed 재검증한다.

## 역할별 조회 범위

| 데이터 | 관리자 | 메이드 |
|---|---|---|
| 프로필 | 전체 | 본인 |
| 객실 타입·객실 | 전체 활성 기준정보 | 활성 계정일 때 조회 |
| 예약·감사 이벤트 | 전체 | 직접 조회 불가 |
| 주간 가능일·변경 요청 | 전체 | 본인 version·요청만 조회 |
| 날짜별 가능 메이드 후보 | 활성 메이드만 조회 | 직접 조회 API 미제공 |
| 청소 대상·배정·수행 | 전체 | 본인 담당/수행 |
| 제출·검수·수익·주급 | 전체 | 본인 제출/수익/주급 |
| 사진 메타데이터 | API 경유 | API 경유, 본인 제출만 |
| 알림 | 본인 조회·읽음 처리 | 본인 조회·읽음 처리 |

RLS는 행 범위를 방어하고 GRANT는 가능한 작업 자체를 제한한다. `TO authenticated`만으로 권한을 허용하지 않으며 항상 관리자 또는 실제 소유권 조건을 둔다.

알림함은 관리자도 다른 수신자의 알림을 읽지 않는다. `GET /v1/notifications`는 최대 100건의
`(occurred_at DESC,id DESC)` keyset page만 반환하며 recipient/dedupe/group 및 내부 actor/session을
노출하지 않는다. cursor는 전용 32-byte 이상 HMAC secret으로 actor·role·stream·sort에 묶는다.
`POST /v1/notifications/{notificationId}/read`는 임의 시각을 받지 않고 DB server가 첫 `read_at`만 기록한다.
typed 알림은 private catalog의 exact source/recipient capability를 통과해야 생성되고,
public projection은 허용된 UUID `deepLink`/`groupId`만 추가한다. self-action과
inactive/임시 비밀번호 수신자도 inbox는 보존하지만 typed delivery enqueue는 거부한다.
legacy/typed outbox 둘 다 raw `service_role` 권한을 주지 않고, #109의 typed outbox는
#111 전용 입력이며 현재 claim/worker/provider 권한은 없다.

## 상태 변경 규칙

업무 상태는 테이블 UPDATE 권한으로 직접 바꾸지 않는다. 서버 명령은 다음을 한 트랜잭션으로 처리한다.

1. access token과 최신 DB 프로필 상태 확인
2. 현재 상태·역할·대상 소유권 검증
3. version/revision 또는 멱등성 키 확인
4. 허용된 다음 상태로만 전이
5. 관련 원장과 audit/outbox 동시 기록
6. 커밋 결과를 동일 요청 재전송에도 재사용

P1부터 각 이슈는 상태 전이표와 금지 전이 테스트를 API 구현보다 먼저 추가한다.

주간 가능일은 브라우저의 직접 INSERT/UPDATE/DELETE를 허용하지 않는다. 활성 메이드의 제출과
변경 요청, 활성 관리자의 승인·반려는 최신 profile 상태, KST 제출 창, current version,
idempotency key를 다시 확인하는 service-role 전용 RPC만 사용한다. RLS는 관리자의 전체 조회와
메이드 본인 조회만 허용하며 `deactivation_pending`, `upload_only`, `inactive`, `departed`는 일반
가능일 권한을 얻지 못한다.

## Auth 기본값

- 공개 회원가입: 끔
- 익명 로그인: 끔
- 서버 관리자 API를 통한 Auth 사용자 생성만 허용
- refresh token rotation: 켬
- access token 기본 만료: 1시간
- 로그인 실패 5회: 15분 잠금
- 임시 비밀번호: 휴대전화 마지막 4자리, 첫 로그인 뒤 변경 강제
- 개인 비밀번호: 숫자 6자리 이상을 API에서 검증
- Auth 최소 길이: 6. 휴대전화 끝 4자리 임시값은 서버 내부 namespace로 8자 이상 변환해 전달
- 비밀번호 초기화·비활성화 때 모든 세션을 폐기하고 매 요청 `session_id` 존재를 검사
- 권한 데이터: `profiles` 정본, `user_metadata` 사용 금지

운영 Dashboard의 Auth 설정은 로컬 `supabase/config.toml`과 일치하는지 적용 직후 다시 확인한다.
