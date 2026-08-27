# 관리자·메이드 계정 수명주기

## 계정 모델

- 관리자와 메이드는 각각 독립된 Supabase Auth 사용자와 `profiles` 행을 가진다.
- 관리자·메이드 계정 수에는 애플리케이션 제한이 없다.
- 역할과 상태의 정본은 `profiles`이며 Auth `app_metadata`는 동기화 힌트일 뿐 권한 판정에 사용하지 않는다.
- 내부 이메일은 `user-{profileId}@auth.castletheart.invalid`로 서버만 계산하고 API에 반환하지 않는다.
- 휴대전화 원문은 저장하지 않는다. 중복 판정용 HMAC-SHA256과 마지막 4자리만 저장하며 HMAC pepper는 서버 secret이다.

## 이름형 로그인 아이디

| 생성 순서 | 표시 이름 | 로그인 아이디 |
|---|---|---|
| 첫 번째 | 김민지 | 김민지 |
| 두 번째 | 김민지 | 김민지2 |
| 세 번째 | 김민지 | 김민지3 |

두 번째 동명이인을 만들 때 첫 계정은 `김민지1`로 고정된다. 이전 `김민지` alias는 첫 계정이 새 `김민지1`로 로그인할 때까지만 유지한다. 새 아이디 로그인 성공 시 이전 alias와 다른 세션을 폐기한다. 비활성·퇴사 계정의 번호는 다시 사용하거나 재정렬하지 않는다.

## 비밀번호와 잠금

- 최초·관리자 초기화 비밀번호는 등록된 휴대전화 마지막 4자리다.
- Supabase Auth에는 4자리 값을 서버 내부 namespace로 8자 이상 변환해 전달한다. 변환값은 API·로그·응답에 노출하지 않으며 사용자는 끝 4자리만 입력한다.
- 임시 비밀번호 사용자는 `/v1/auth/password` 외 업무 API를 사용할 수 없다.
- 개인 비밀번호는 숫자 6자리 이상이다.
- 연속 5회 실패하면 15분 고정 잠금한다. 잠긴 동안의 요청은 잠금 종료 시각을 연장하지 않는다.
- 로그인 성공, 관리자 잠금 해제, 비밀번호 초기화는 실패 횟수와 잠금을 초기화한다.
- 비밀번호 초기화·계정 비활성화·퇴사 처리 시 DB 세션을 폐기한다. 서명상 아직 만료되지 않은 access token도 활성 세션 조회에 실패하면 거부한다.

## 상태와 역할 전이

| 현재 | 다음 | 허용 조건 |
|---|---|---|
| `active` | `inactive` | 마지막 활성 관리자가 아님 |
| `inactive` | `active` | 퇴사 처리 전 |
| `inactive` | `departed` | 마지막 활성 관리자가 아님 |
| `departed` | 다른 상태 | 금지 |
| `admin` | `maid` | 마지막 활성 관리자가 아님 |
| `maid` | `admin` | 활성 관리자가 실행 |

`deactivation_pending`과 `upload_only`는 진행 중 업무를 종결하는 후속 이슈에서 사용하는 제한 capability 상태다. 별도 역할이 아니며 일반 관리자·메이드 권한을 상속하지 않는다. 현재 Data API의 일반 RLS 조회는 `active` 계정에만 열고, 후속 사진/수행 구현에서는 동결된 assignment revision과 만료 시각에 묶인 좁은 서버 command로만 제한 capability를 제공한다. 이 단계의 일반 계정 API는 `active`, `inactive`, `departed`만 직접 받는다.

## 관리자 API

모든 변경 요청에는 재시도 중복을 막는 `Idempotency-Key`가 필요하다.

| 메서드 | 경로 | 기능 |
|---|---|---|
| `GET` | `/v1/accounts` | 계정 목록, 휴대전화 마지막 4자리만 반환 |
| `POST` | `/v1/accounts` | 관리자·메이드 개별 계정 생성 |
| `PATCH` | `/v1/accounts/:profileId/role` | 역할 변경 |
| `PATCH` | `/v1/accounts/:profileId/status` | 비활성·복구·퇴사 처리 |
| `POST` | `/v1/accounts/:profileId/unlock` | 실패 횟수와 잠금 초기화 |
| `POST` | `/v1/accounts/:profileId/password-reset` | 마지막 4자리로 초기화하고 변경 강제 |

Auth 사용자 생성 뒤 프로필 RPC가 실패하면 서버는 새 Auth 사용자를 삭제해 보상한다. 동일한 계정 생성 멱등성 키는 정규화된 이름·역할·휴대전화 HMAC이 모두 같은 재시도에만 기존 결과를 반환하며, 하나라도 다르면 `409 IDEMPOTENCY_KEY_REUSED`로 거절한다. 프로필·alias·감사 이벤트는 한 DB 트랜잭션에서 커밋한다. 역할·상태·잠금·비밀번호 초기화는 실행 관리자, 시각, 전후 상태, 통제 사유, 멱등성 키를 감사 이벤트에 남긴다.

상태 변경은 DB의 마지막 활성 관리자·허용 전이 검증과 세션 폐기를 먼저 커밋한 뒤 Auth ban을 동기화한다. 따라서 거부된 전이가 Auth 계정을 먼저 잠그지 않는다. DB 커밋 뒤 Auth 동기화가 실패하면 `ACCOUNT_AUTH_STATE_INCONSISTENT`를 반환하며, 운영자는 같은 `Idempotency-Key`로 재시도해 Auth 상태를 reconcile한다. 권한 판정은 항상 최신 DB 프로필을 사용하므로 동기화 대기 중 비활성 계정의 업무 접근은 허용되지 않는다.

개인 비밀번호 변경은 Auth 비밀번호를 먼저 바꾼 뒤 DB의 `must_change_password`와 감사 이벤트를 기록한다. DB 기록이 실패하면 서버가 검증에 사용한 기존 비밀번호로 Auth 변경을 보상하며, 보상까지 실패하면 `PASSWORD_STATE_INCONSISTENT`를 반환해 관리자의 비밀번호 초기화가 필요함을 명시한다.

## 최초 관리자 부트스트랩

일반 계정 API는 활성 관리자만 호출할 수 있으므로 빈 프로젝트의 첫 관리자만 서버 CLI로 만든다.

```bash
npm run bootstrap:admin -- --name "관리자 이름" --phone "010-0000-0000"
```

이 명령은 `profiles`가 비어 있을 때 한 번만 성공한다. 두 번째 관리자부터는 로그인한 관리자가 `POST /v1/accounts`를 사용한다. 임시 비밀번호는 터미널에 한 번 표시되므로 공유 화면·CI 로그에서는 실행하지 않는다.
