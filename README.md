# CASTLE THE ART 객실관리 백엔드

`room-management-system` 정적 와이어프레임을 실제 운영 서버로 전환하기 위한 TypeScript 백엔드입니다. 현재 1차 기반으로 인증 경계, 객실 조회 API, Supabase 스키마·RLS, 121개 객실 초기 마스터와 자동 테스트가 들어 있습니다.

## 현재 구현

- Fastify 5 + TypeScript API
- Supabase Auth 기반 로그인 토큰 검증
- 이름형 로그인 아이디를 Supabase Auth 내부 계정에 매핑하는 서버 로그인
- `GET /health`, `POST /v1/auth/login`, `GET /v1/auth/me`, `GET /v1/rooms`
- 예약 기간 중복 배타 제약, 활성 청소 대상/담당/수행 회차 유일 제약
- 제출·검수·수익·주차별 지급 중복 방지 키
- 공개 스키마 전 테이블 RLS와 비공개 사진 버킷 정책
- 원본 정본의 4개 객실 타입, 고정 단가, 숙박 인원, 121개 객실 seed

전체 분석과 설계는 [프로젝트 분석](docs/PROJECT_ANALYSIS.md), [백엔드 설계](docs/ARCHITECTURE.md)를 참고하세요. 구현 전에 검토할 최신 관계도는 [ERD 초안](docs/ERD.md)이며, [DBML 원본](docs/room-management-system.dbml)을 dbdiagram.io에 붙여 넣어 전체 다이어그램을 확인할 수 있습니다.

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
- 사진은 private Storage 버킷에 불변 경로로 저장하고, RLS 또는 짧은 signed URL로만 읽습니다.
- 현재 연결된 원격 Supabase 프로젝트에는 아직 마이그레이션을 적용하지 않았습니다.
