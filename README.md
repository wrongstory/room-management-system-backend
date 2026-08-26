# CASTLE THE ART 객실관리 백엔드

`room-management-system` 정적 와이어프레임을 실제 운영 서버로 전환하기 위한 TypeScript 백엔드입니다. 인증 경계, 관리자·메이드 개별 계정 수명주기, 객실 조회 API, Supabase 스키마·RLS, 121개 객실 초기 마스터와 자동 테스트가 들어 있습니다.

## 현재 구현

- Fastify 5 + TypeScript API
- Supabase Auth 기반 로그인 토큰 검증
- 이름형 로그인 아이디를 Supabase Auth 내부 계정에 매핑하는 서버 로그인
- 관리자·메이드 개별 계정 생성, 역할·상태 변경, 잠금 해제, 비밀번호 초기화
- 임시 비밀번호 변경 강제와 폐기된 세션의 매 요청 차단
- `GET /health`, `/v1/auth`, `/v1/accounts`, `GET /v1/rooms`
- 예약 기간 중복 배타 제약, 활성 청소 대상/담당/수행 회차 유일 제약
- 제출·검수·수익·주차별 지급 중복 방지 키
- 공개 스키마 전 테이블 RLS와 Google Drive 사진 메타데이터 정책
- Biome lint, secret 검사, 타입 검사, 테스트, 빌드 CI 품질 게이트
- 로컬·개발·운영·복구 환경 분리와 운영 프로젝트 Ref 오접속 방지
- 원본 정본의 4개 객실 타입, 고정 단가, 숙박 인원, 121개 객실 seed

전체 분석과 설계는 [프로젝트 분석](docs/PROJECT_ANALYSIS.md), [백엔드 설계](docs/ARCHITECTURE.md)를 참고하세요. 구현 전에 검토할 최신 관계도는 [ERD 초안](docs/ERD.md)이며, [DBML 원본](docs/room-management-system.dbml)을 dbdiagram.io에 붙여 넣어 전체 다이어그램을 확인할 수 있습니다. 계정 규칙은 [계정 수명주기](docs/ACCOUNT_LIFECYCLE.md), 환경 분리는 [환경 운영안](docs/ENVIRONMENTS.md), 권한 경계는 [Auth·RLS 계약](docs/AUTH_RLS_CONTRACT.md), 사진 규칙은 [사진 저장 운영안](docs/PHOTO_STORAGE.md), Free 프로젝트 2개 구조는 [백업·복구 운영안](docs/BACKUP_AND_RECOVERY.md)에 정리했습니다.

## 로컬 실행

Node.js 22 이상이 필요합니다.

```bash
npm install
copy .env.example .env
npm run dev
```

macOS/Linux에서는 `cp .env.example .env`를 사용합니다. `.env`에는 실제 Supabase 프로젝트의 URL, publishable key, 서버 전용 secret key를 입력합니다.

빈 프로젝트의 최초 관리자만 서버 환경에서 다음 명령으로 생성합니다. 실제 이름과 휴대전화 번호는 명령 인자로만 전달하고 CI 로그에서는 실행하지 않습니다.

```bash
npm run bootstrap:admin -- --name "관리자 이름" --phone "010-0000-0000"
```

## 검증

```bash
npm run secrets:check
npm run lint
npm run typecheck
npm test
npm run build
```

로컬 Supabase 전체 검증에는 Docker가 필요합니다.

```bash
npm run db:start
npm run db:reset
```

## 보안 경계

- `SUPABASE_SECRET_KEY`는 API 서버에서만 사용합니다.
- 브라우저는 객실 PIN 원문, 내부 Auth 이메일, 다른 메이드 데이터에 직접 접근하지 않습니다.
- 사용자 인증정보는 `user_metadata`가 아니라 DB 프로필과 서버 검증 결과로 권한을 결정합니다.
- 휴대전화 원문은 저장하지 않고 서버 비밀값으로 만든 HMAC과 마지막 4자리만 저장합니다.
- 사진은 앱에서 300KiB 이하로 압축한 뒤 백엔드가 비공개 Google Drive 폴더에 저장합니다. Google OAuth 토큰과 파일 ID는 브라우저에 직접 노출하지 않습니다.
- 운영 프로젝트는 서울 `aodikrxcczbogjpsjwjt`, 복구검증 프로젝트는 `matalcofimnhuzslfhdd`로 분리했습니다. 원격 운영 마이그레이션은 검증 후 적용합니다.
