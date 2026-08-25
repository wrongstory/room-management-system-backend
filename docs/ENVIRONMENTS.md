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
- 운영값은 배포 플랫폼의 encrypted secret으로만 주입한다.
- `APP_ENV=production`에서는 HTTPS 원격 URL, 프로젝트 Ref, HTTPS CORS origin이 모두 필요하다.
- URL의 호스트와 `SUPABASE_PROJECT_REF`가 다르면 서버가 시작하지 않는다.
- publishable key는 브라우저 사용이 가능하지만 secret/service-role key는 서버에만 둔다.
- 운영·복구 DB 접속 문자열, Google OAuth 값, dump 파일은 Git과 일반 로그에 넣지 않는다.

## 마이그레이션 흐름

1. `npm run db:new -- <snake_case_name>`으로 파일을 만든다.
2. 로컬에서 `npm run db:verify`로 전체 마이그레이션을 처음부터 적용한다.
3. `npm run ci:quality`와 RLS 계약 테스트를 통과시킨다.
4. 운영 적용 전 원격 마이그레이션 목록과 대상 project Ref를 확인한다.
5. Git의 동일 SQL을 운영 프로젝트에 한 번 적용한다.
6. 적용 후 121개 객실, RLS, 명시적 GRANT, Security/Performance Advisor를 검증한다.
7. recovery 프로젝트에는 운영 dump 복구 절차를 통해 반영한다.

운영 스키마를 Dashboard에서 직접 수정하지 않는다. 긴급 변경도 먼저 마이그레이션 파일을 만들고 검증한 뒤 적용한다.

## Auth 기본 원칙

- 공개 회원가입과 익명 로그인을 끈다.
- 관리자만 서버 API를 통해 관리자·메이드 Auth 사용자를 만든다.
- 사용자 입력 `loginId`는 서버가 내부 이메일로 매핑하며 내부 이메일은 응답하지 않는다.
- 역할과 계정 상태는 사용자 수정 가능한 `user_metadata`가 아닌 DB `profiles`에서 확인한다.
- refresh token rotation을 사용하고 민감 작업은 최신 DB 프로필 상태를 다시 확인한다.
- 로컬 이메일 확인은 끄고 Mailpit에서만 테스트한다. 운영 이메일/비밀번호 정책 변경은 별도 검토한다.

## CI와 병합 제한

GitHub Actions의 `application`과 `migration` 작업이 PR과 main push에서 실행된다. 현재 저장소는 개인 계정의 비공개 Free 저장소라 GitHub API가 branch protection을 허용하지 않는다. 따라서 실패 시 병합을 기술적으로 차단하려면 저장소를 public으로 전환하거나 GitHub 유료 플랜이 필요하다. 그 전에는 두 작업의 성공을 병합 전 운영 규칙으로 강제한다.
