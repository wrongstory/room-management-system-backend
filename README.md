# CASTLE THE ART 객실관리 백엔드

`room-management-system` 정적 와이어프레임을 실제 운영 서버로 전환하기 위한 TypeScript 백엔드입니다. 현재 1차 기반으로 인증 경계, 객실 조회 API, Supabase 스키마·RLS, 121개 객실 초기 마스터와 자동 테스트가 들어 있습니다.

## 현재 구현

- Fastify 5 + TypeScript API
- Supabase Auth 기반 로그인 토큰 검증
- 이름형 로그인 아이디를 Supabase Auth 내부 계정에 매핑하는 서버 로그인
- `GET /health`, `POST /v1/auth/login`, `GET /v1/auth/me`, `GET /v1/rooms`
- 예약 기간 중복 배타 제약, 활성 청소 대상/담당/수행 회차 유일 제약
- 제출·검수·수익·주차별 지급 중복 방지 키
- 공개 스키마 전 테이블 RLS와 Google Drive 사진 메타데이터 정책
- 원본 정본의 4개 객실 타입, 고정 단가, 121개 객실 seed. 타입별 숙박 인원 상한은 아직 데모값이라 production 제약으로 확정되지 않았습니다.

백엔드 GPT/Codex는 구현 전에 [제품·도메인 가이드](docs/AI_BACKEND_PRODUCT_GUIDE.md)를 먼저 읽어야 합니다. 전체 분석과 설계는 [프로젝트 분석](docs/PROJECT_ANALYSIS.md), [백엔드 설계 초안](docs/ARCHITECTURE.md)을 참고하세요. 검토용 관계도는 [ERD 초안](docs/ERD.md)이며, [DBML 원본](docs/room-management-system.dbml)을 dbdiagram.io에 붙여 넣어 전체 다이어그램을 확인할 수 있습니다. ERD/DBML은 제품 가이드와 reconcile되기 전에는 목표 계약이 아닙니다. 사진 압축·폴더·자동삭제 규칙은 [사진 저장 운영안](docs/PHOTO_STORAGE.md), Free 프로젝트 2개를 이용한 운영·복구 구조는 [백업·복구 운영안](docs/BACKUP_AND_RECOVERY.md)에 정리했습니다. 정책 문서끼리 충돌하면 제품·도메인 가이드의 우선순위와 `[미확정]` 표시를 따릅니다.

## 로컬 실행

Node.js 22 이상이 필요합니다.

```bash
npm install
copy .env.example .env
npm run dev
```

macOS/Linux에서는 `cp .env.example .env`를 사용합니다. `.env`에는 실제 Supabase 프로젝트의 URL, publishable key, 서버 전용 secret key를 입력합니다.

## 검증

```bash
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
- 사진은 앱에서 300KiB 이하로 압축하고 서버가 비공개 저장소로 중계하는 것이 목표 계약입니다. Google Drive는 현재 채택안이지만 업로드 worker·운영 계정·보존기간은 아직 확정/구현되지 않았고, 어떤 provider든 token과 locator를 브라우저에 노출하지 않습니다.
- 현재 연결된 원격 Supabase 프로젝트에는 아직 마이그레이션을 적용하지 않았습니다.
