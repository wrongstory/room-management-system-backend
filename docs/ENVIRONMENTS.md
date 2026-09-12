# 환경 분리와 비밀값 운영

## 환경 역할

| APP_ENV | Supabase | 목적 | 사용자 트래픽 |
|---|---|---|---|
| `local` | Supabase CLI localhost | 개인 개발 | 없음 |
| `development` | 로컬 또는 CI 임시 Supabase | 통합 테스트 | 없음 |
| `production` | 서울 `aodikrxcczbogjpsjwjt` | 실제 서비스 | 허용 |
| recovery | 뭄바이 `matalcofimnhuzslfhdd` | 논리 백업 복원검증 | 금지 |

Free 프로젝트가 2개뿐이므로 recovery 프로젝트를 개발 DB로 겸용하지 않는다. 개발과 CI는 로컬 Supabase를 사용한다.

## 환경변수 규칙

- 로컬은 `.env.example`을 `.env`로 복사하고 `supabase status -o env` 결과를 입력한다.
- Fastify 운영값은 배포 플랫폼의 encrypted secret으로만 주입한다. Supabase-only PoC에서는 Function Secrets를 사용하고 Cron 호출 secret은 같은 값의 Vault copy만 허용한다.
- `APP_ENV=production`에서는 HTTPS 원격 URL, 프로젝트 Ref, HTTPS CORS origin이 모두 필요하다.
- URL의 호스트와 `SUPABASE_PROJECT_REF`가 다르면 서버가 시작하지 않는다.
- publishable key는 브라우저 사용이 가능하지만 secret/service-role key는 서버에만 둔다.
- 운영·복구 DB 접속 문자열, Google OAuth 값, dump 파일은 Git과 일반 로그에 넣지 않는다.
- Edge runtime이 자동 제공하는 `SUPABASE_SERVICE_ROLE_KEY`를 custom secret이나 Vault에 복제하지 않는다. custom Function Secret 이름은 `SUPABASE_` prefix를 사용하지 않는다.
- 객실 PIN은 `ROOM_PIN_KEY_BASE64`(canonical Base64 32-byte AES key), `ROOM_PIN_KEY_VERSION`, 최대 5개 prior key의 `ROOM_PIN_KEYRING_JSON`을 전용 secret으로 주입한다. reservation PII/Web Push 키를 포함한 다른 목적 secret과 key material을 재사용하지 않는다.
- `ROOM_PIN_AAD_ENVIRONMENT`, `ROOM_PIN_AAD_PROJECT_REF`는 비밀이 아닌 bounded AAD context다. 새 쓰기는 현재 승인 environment/project mapping을 사용하고, 복구 환경의 이전 revision 복호화는 DB에 보존된 exact context를 사용한다. key, AAD 전체 bytes, PIN/envelope를 로그·Issue·PR에 기록하지 않는다.
- Phase B Sheet worker는 `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEETS_ROOM_PIN_TAB`, `GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY`, `ROOM_PIN_SHEET_SYNC_INVOKE_SECRET`을 별도 secret/config로 받는다. 승인된 source mapping과 exact match하기 전 PIN key와 Google private key를 읽지 않는다. 현재 source에는 local/test synthetic target만 있으며 production/recovery mapping과 실제 Sheet ID/credential은 #137/release 승인 전 추가하지 않는다.
- local Sheet adapter를 실행할 때만 `RUNTIME_ENVIRONMENT=local`, `SUPABASE_PROJECT_REF=local`을 exact synthetic target과 함께 설정한다. repository-wide 빈 `SUPABASE_PROJECT_REF` 예시는 다른 runtime의 별도 승인 mapping을 대신하지 않으며, 빈 값이나 `127.0.0.1` alias는 Sheet target 승인이 아니다.
- #131 feature PR은 source 예시와 검증만 갱신하며 production/recovery Function Secrets나 Vault를 설정하지 않는다. 실제 key 주입·회전은 별도 release 승인 범위다.

## 마이그레이션 흐름

1. `npm run db:new -- <snake_case_name>`으로 파일을 만든다.
2. 로컬에서 `npm run db:verify`로 전체 마이그레이션을 처음부터 적용한다.
3. `npm run ci:quality`와 RLS 계약 테스트를 통과시킨다.
4. 운영 적용 전 원격 마이그레이션 목록과 대상 project Ref를 확인한다.
5. Git과 원격 version history가 일치할 때만 표준 migration push를 사용한다. 일치하지 않으면 릴리즈별 검증 문서의 명시적 mapping과 승인된 적용 수단을 사용한다.
6. 적용 후 121개 객실, RLS, 명시적 GRANT, Security/Performance Advisor를 검증한다.
7. recovery 프로젝트에는 운영 dump 복구 절차를 통해 반영한다.

운영 스키마를 Dashboard에서 직접 수정하지 않는다. 긴급 변경도 먼저 마이그레이션 파일을 만들고 검증한 뒤 적용한다.
원격 history가 Git과 다르면 자동 `supabase db push`를 실행하지 않는다. history repair는 DDL 적용과 별도 작업으로 검토하고, 이미 적용된 스키마를 다시 실행하지 않도록 SQL 내용·원격 객체·version mapping을 먼저 증명한다.

## Auth 기본 원칙

- 공개 회원가입과 익명 로그인을 끈다.
- 관리자만 서버 API를 통해 관리자·메이드 Auth 사용자를 만든다.
- 사용자 입력 `loginId`는 서버가 내부 이메일로 매핑하며 내부 이메일은 응답하지 않는다.
- 역할과 계정 상태는 사용자 수정 가능한 `user_metadata`가 아닌 DB `profiles`에서 확인한다.
- refresh token rotation을 사용하고 민감 작업은 최신 DB 프로필 상태를 다시 확인한다.
- 로컬 이메일 확인은 끄고 Mailpit에서만 테스트한다. 운영 이메일/비밀번호 정책 변경은 별도 검토한다.

## CI와 병합 제한

GitHub Actions의 `application`과 `migration` 작업이 PR과 `main` push에서 실행된다. 저장소는 public이며 `main` branch protection은 두 작업을 필수 상태 검사로 요구하고, 작업 브랜치가 최신 `main`을 포함하도록 strict 검사를 적용한다. 두 작업 중 하나라도 실패하거나 최신 base 반영 뒤 다시 실행되지 않으면 병합하지 않는다.
