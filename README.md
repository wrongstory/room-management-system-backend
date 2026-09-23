# CASTLE THE ART 객실관리 백엔드

`room-management-system` 정적 와이어프레임을 실제 운영 서버로 전환하기 위한 TypeScript 백엔드입니다. 인증 경계, 단일 개발자와 관리자·메이드 개별 계정 수명주기, 객실·예약 원자 명령, Supabase 스키마·RLS, 121개 객실 초기 마스터와 자동 테스트가 들어 있습니다.

운영 Git 정본은 `main@10a1f814649e92260e9e7353ab242400311b429e`이고, 최신 기능 통합 지점은 `dev@1a28263567b44661a1d6fdc3e4f99be8f55ff8de`입니다. 개발 정본은 79 migrations / OpenAPI `0.5.1` 129 paths / 139 operations이며 #256 사진 정규화, #250 진행 중 메이드의 후속 계획 허용, #264 수행 불가 취소·재배정을 포함합니다. 마지막으로 검증된 운영 API는 78 migrations, Supabase `api` ACTIVE v24, OpenAPI `0.5.1` 128 paths / 138 operations이며 Pages도 그 배포본과 artifact parity를 완료했습니다. 기존 관리자 UAT에서 예약 가능 미리보기의 `guestCount` 생략·`null`·양수와 예약 현황 인원 표시, 객실 유형별 최소·최대 인원 적용을 확인했습니다. 개발 정본의 후속 기능은 release 승격 전까지 운영 API에서 사용할 수 없고, `v0.5.1` tag와 GitHub Release도 아직 발행하지 않았습니다.

## 현재 구현

- Fastify 5 + TypeScript API
- Supabase Edge Functions + Cron 무료 production runtime PoC (#36)
- Supabase Auth 기반 로그인 토큰 검증
- 이름형 로그인 아이디를 Supabase Auth 내부 계정에 매핑하는 서버 로그인
- 단일 developer bootstrap과 관리자·메이드 개별 계정 생성, 역할·상태 변경, 잠금 해제, 비밀번호 초기화
- 임시 비밀번호 변경 강제와 폐기된 세션의 매 요청 차단
- `GET /health`, `/openapi.json`, 로컬 `/docs` Swagger UI, `/v1/auth`, `/v1/accounts`, `/v1/rooms`, `/v1/reservations`, `/v1/availability`, `/v1/payroll`
- 운영 OpenAPI snapshot을 제공하는 무료 GitHub Pages 읽기 전용 Swagger 포털
- 객실 기준정보 CAS 변경, 운영 차단·촛불·이슈·PIN 동기화 event 기록
- 예약 생성·일정 변경·취소·수동 체크아웃, 연박/추가 청소 요청과 예정 입·퇴실 전이
- 일요일 주 알림을 유지한 메이드의 현재·다음 주 요일 무관 가능일 version 제출·직접 변경, 관리자 승인형 변경 요청, 날짜별 배정 후보 조회
- production 시작 시 활성 관리자 `RESERVATION_SCHEDULER_ACTOR_PROFILE_ID`를 필수 검증하고, 중단 기간의 예약은 퇴실 우선 catch-up으로 복구
- 예약 고객명 AES-256-GCM 암호화, 목록 비노출, 관리자 상세 복호화와 180일 보존 만료
- 예약 기간 중복 배타 제약, 활성 청소 대상/담당/수행 회차 유일 제약
- 제출·검수·수익·주차별 지급 중복 방지 키
- 공개 스키마 전 테이블 RLS와 Google Drive 사진 메타데이터 정책
- Biome lint, secret 검사, 타입 검사, 테스트, 빌드 CI 품질 게이트
- 로컬·개발·운영·복구 환경 분리와 운영 프로젝트 Ref 오접속 방지
- 원본 정본의 4개 객실 타입, 고정 단가, 121개 객실 seed. 타입별 최소·최대 숙박 인원은 DB의 현재 설정값이 정본이며 운영 UAT에서 예약·현황 반영을 확인했습니다. 문서의 예시 숫자를 운영값으로 간주하지 않습니다.

백엔드 GPT/Codex는 구현 전에 [제품·도메인 가이드](docs/AI_BACKEND_PRODUCT_GUIDE.md)를 먼저 읽어야 합니다. 전체 분석과 설계는 [프로젝트 분석](docs/PROJECT_ANALYSIS.md), [백엔드 설계 초안](docs/ARCHITECTURE.md)을 참고하세요. 검토용 관계도는 [ERD 초안](docs/ERD.md)이며, [DBML 원본](docs/room-management-system.dbml)을 dbdiagram.io에 붙여 넣어 전체 다이어그램을 확인할 수 있습니다. ERD/DBML은 제품 가이드와 reconcile되기 전에는 목표 계약이 아닙니다. 계정 규칙은 [계정 수명주기](docs/ACCOUNT_LIFECYCLE.md), 환경 분리는 [환경 운영안](docs/ENVIRONMENTS.md), 권한 경계는 [Auth·RLS 계약](docs/AUTH_RLS_CONTRACT.md), 사진 압축·폴더·자동삭제 규칙은 [사진 저장 운영안](docs/PHOTO_STORAGE.md), Free 프로젝트 2개를 이용한 운영·복구 구조는 [백업·복구 운영안](docs/BACKUP_AND_RECOVERY.md)에 정리했습니다. 정책 문서끼리 충돌하면 제품·도메인 가이드의 우선순위와 `[미확정]` 표시를 따릅니다.

## 로컬 실행

Node.js 22 이상이 필요합니다.

```bash
npm install
copy .env.example .env
npm run dev
```

macOS/Linux에서는 `cp .env.example .env`를 사용합니다. `.env`에는 실제 Supabase 프로젝트의 URL, publishable key, 서버 전용 secret key와 32바이트 예약 개인정보 암호화 키를 입력합니다. 주급 cursor에는 다른 key/pepper와 재사용하지 않는 `PAYROLL_CURSOR_HMAC_SECRET`을 UTF-8 32바이트 이상으로 생성해 Fastify와 Edge에 각각 설정합니다. production에서는 예정 전이·개인정보 보존 worker가 조용히 중지되지 않도록 활성 관리자 profile ID인 `RESERVATION_SCHEDULER_ACTOR_PROFILE_ID`도 반드시 설정합니다.

빈 프로젝트의 단일 최상위 developer만 서버 환경에서 다음 명령으로 생성합니다. `--name`은 표시 이름일 뿐이며 로그인 ID는 입력과 무관하게 `admin`으로 고정합니다. 휴대전화 번호 외 비밀번호는 명령 인자로 전달하지 않습니다.

```bash
npm run bootstrap:developer -- --name "개발자 표시 이름" --phone "010-0000-0000"
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
npm run edge:check
```

Supabase-only 운영 PoC의 endpoint, secret, Cron과 rollback 기준은 [Edge runtime PoC](docs/EDGE_RUNTIME_POC.md)에 정리했습니다. 운영 smoke가 끝나기 전까지 기존 Fastify 구현은 개발 기준선으로 유지합니다.

로컬 Edge Function을 실행한 뒤 `http://127.0.0.1:54321/functions/v1/api/docs`에서 한글 Swagger UI로 Edge API를 확인할 수 있습니다. 운영 문서는 [GitHub Pages Swagger 포털](https://wrongstory.github.io/room-management-system-backend/)에서 읽고, [정적 OpenAPI JSON](https://wrongstory.github.io/room-management-system-backend/openapi.json)을 타입 생성에 사용할 수 있습니다. Pages artifact는 실제 운영 Edge OpenAPI를 배포 시점에 내려받아 만들며 공개 포털에서는 `Try it out`과 Authorization 입력을 비활성화합니다. 인증·멱등성·오류 처리는 [프론트 API 연동 가이드](docs/FRONTEND_API_INTEGRATION.md), 이번 hotfix의 배포·계약 경계는 [v0.5.1 적용 기록](docs/RELEASE_V0.5.1.md)을 따릅니다.

## 보안 경계

- `SUPABASE_SECRET_KEY`는 API 서버에서만 사용합니다.
- 브라우저는 객실 PIN 원문, 내부 Auth 이메일, 다른 메이드 데이터에 직접 접근하지 않습니다.
- 사용자 인증정보는 `user_metadata`가 아니라 DB 프로필과 서버 검증 결과로 권한을 결정합니다.
- 휴대전화 원문은 저장하지 않고 서버 비밀값으로 만든 HMAC과 마지막 4자리만 저장합니다.
- 사진은 앱에서 300KiB 이하로 압축해 Google Drive 비공개 폴더에만 저장합니다. 청소 제출 사진은 최종 검사 결정 뒤 168시간, 해결된 이슈·컴플레인·충돌 증빙은 종결 뒤 180일, 실제 orphan은 업로드 뒤 30일의 분리된 retention 계약을 사용합니다. metadata는 원본 만료 뒤에도 보존하고 token과 provider locator를 브라우저에 노출하지 않습니다. 실제 Google Drive OAuth·purge Cron hosted 활성화는 별도 운영 gate입니다.
- 예약 고객명은 서버에서만 암복호화하고 DB·로그·감사 payload에 평문을 저장하지 않습니다. 목록에서는 제외하고 관리자 단건 상세에서만 표시하며 체크아웃/취소 180일 뒤 worker가 암호문을 제거합니다. 암호화 키를 바꿀 때는 이전 키를 `RESERVATION_PII_KEYRING_JSON`에 유지한 채 새 key version으로 쓰기를 전환하고 기존 암호문을 계획적으로 재암호화해야 합니다.
- 고객명 idempotency fingerprint는 암호화 키와 분리된 `RESERVATION_GUEST_NAME_PEPPER`를 사용해 암호화 키 회전 전후에도 같은 요청 hash를 유지합니다.
- 운영·복구검증 Supabase에는 P0·계정 수명주기·도메인 무결성 migration이 적용됐습니다. 정확한 구현·배포 구분은 제품·도메인 가이드의 구현 현황 절을 따릅니다.
