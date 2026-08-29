# CASTLE THE ART 객실관리 백엔드

`room-management-system` 정적 와이어프레임을 실제 운영 서버로 전환하기 위한 TypeScript 백엔드입니다. 인증 경계, 관리자·메이드 개별 계정 수명주기, 객실·예약 원자 명령, Supabase 스키마·RLS, 121개 객실 초기 마스터와 자동 테스트가 들어 있습니다.

## 현재 구현

- Fastify 5 + TypeScript API
- Supabase Auth 기반 로그인 토큰 검증
- 이름형 로그인 아이디를 Supabase Auth 내부 계정에 매핑하는 서버 로그인
- 관리자·메이드 개별 계정 생성, 역할·상태 변경, 잠금 해제, 비밀번호 초기화
- 임시 비밀번호 변경 강제와 폐기된 세션의 매 요청 차단
- `GET /health`, `/v1/auth`, `/v1/accounts`, `/v1/rooms`, `/v1/reservations`
- 객실 기준정보 CAS 변경, 운영 차단·촛불·이슈·PIN 동기화 event 기록
- 예약 생성·일정 변경·취소·수동 체크아웃, 연박/추가 청소 요청과 예정 입·퇴실 전이
- production 시작 시 활성 관리자 `RESERVATION_SCHEDULER_ACTOR_PROFILE_ID`를 필수 검증하고, 중단 기간의 예약은 퇴실 우선 catch-up으로 복구
- 예약 고객명 AES-256-GCM 암호화, 목록 비노출, 관리자 상세 복호화와 180일 보존 만료
- 예약 기간 중복 배타 제약, 활성 청소 대상/담당/수행 회차 유일 제약
- 제출·검수·수익·주차별 지급 중복 방지 키
- 공개 스키마 전 테이블 RLS와 Google Drive 사진 메타데이터 정책
- Biome lint, secret 검사, 타입 검사, 테스트, 빌드 CI 품질 게이트
- 로컬·개발·운영·복구 환경 분리와 운영 프로젝트 Ref 오접속 방지
- 원본 정본의 4개 객실 타입, 고정 단가, 121개 객실 seed. 타입별 숙박 인원 상한은 아직 데모값이라 production 제약으로 확정되지 않았습니다.

백엔드 GPT/Codex는 구현 전에 [제품·도메인 가이드](docs/AI_BACKEND_PRODUCT_GUIDE.md)를 먼저 읽어야 합니다. 전체 분석과 설계는 [프로젝트 분석](docs/PROJECT_ANALYSIS.md), [백엔드 설계 초안](docs/ARCHITECTURE.md)을 참고하세요. 검토용 관계도는 [ERD 초안](docs/ERD.md)이며, [DBML 원본](docs/room-management-system.dbml)을 dbdiagram.io에 붙여 넣어 전체 다이어그램을 확인할 수 있습니다. ERD/DBML은 제품 가이드와 reconcile되기 전에는 목표 계약이 아닙니다. 계정 규칙은 [계정 수명주기](docs/ACCOUNT_LIFECYCLE.md), 환경 분리는 [환경 운영안](docs/ENVIRONMENTS.md), 권한 경계는 [Auth·RLS 계약](docs/AUTH_RLS_CONTRACT.md), 사진 압축·폴더·자동삭제 규칙은 [사진 저장 운영안](docs/PHOTO_STORAGE.md), Free 프로젝트 2개를 이용한 운영·복구 구조는 [백업·복구 운영안](docs/BACKUP_AND_RECOVERY.md)에 정리했습니다. 정책 문서끼리 충돌하면 제품·도메인 가이드의 우선순위와 `[미확정]` 표시를 따릅니다.

## 로컬 실행

Node.js 22 이상이 필요합니다.

```bash
npm install
copy .env.example .env
npm run dev
```

macOS/Linux에서는 `cp .env.example .env`를 사용합니다. `.env`에는 실제 Supabase 프로젝트의 URL, publishable key, 서버 전용 secret key와 32바이트 예약 개인정보 암호화 키를 입력합니다. production에서는 예정 전이·개인정보 보존 worker가 조용히 중지되지 않도록 활성 관리자 profile ID인 `RESERVATION_SCHEDULER_ACTOR_PROFILE_ID`도 반드시 설정합니다.

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
- 사진은 앱에서 300KiB 이하로 압축해 Google Drive 비공개 폴더에만 저장하고, 업로드 시각부터 정확히 7일 뒤 영구삭제하는 것이 확정 계약입니다. 180일 보존이나 retention hold 예외는 두지 않습니다. 업로드·삭제 worker와 운영 OAuth 자격증명은 아직 구현·배포 전이며, token과 locator를 브라우저에 노출하지 않습니다.
- 예약 고객명은 서버에서만 암복호화하고 DB·로그·감사 payload에 평문을 저장하지 않습니다. 목록에서는 제외하고 관리자 단건 상세에서만 표시하며 체크아웃/취소 180일 뒤 worker가 암호문을 제거합니다. 암호화 키를 바꿀 때는 이전 키를 `RESERVATION_PII_KEYRING_JSON`에 유지한 채 새 key version으로 쓰기를 전환하고 기존 암호문을 계획적으로 재암호화해야 합니다.
- 고객명 idempotency fingerprint는 암호화 키와 분리된 `RESERVATION_GUEST_NAME_PEPPER`를 사용해 암호화 키 회전 전후에도 같은 요청 hash를 유지합니다.
- 운영·복구검증 Supabase에는 P0·계정 수명주기·도메인 무결성 migration이 적용됐습니다. 정확한 구현·배포 구분은 제품·도메인 가이드의 구현 현황 절을 따릅니다.
