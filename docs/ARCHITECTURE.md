# 백엔드 서버 설계

> 문서 지위: 설계 검토 초안이다. 구현 전에 [백엔드 AI 제품·도메인 가이드](./AI_BACKEND_PRODUCT_GUIDE.md)를 먼저 읽는다. 이 문서와 ERD/DBML은 제품 가이드와 reconcile되기 전에는 목표 계약이 아니며, `[미확정]` 정책을 기존 코드나 이 문서만으로 확정하지 않는다.

## 기술 선택

- API: Node.js 22, Fastify 5, TypeScript
- 데이터·인증: Supabase Auth, PostgreSQL 17
- 사진 파일: Google Drive API, 전용 비공개 폴더
- 입력 검증: Zod
- 테스트: Vitest와 Fastify injection
- 배포 단위: 상태 없는 API 서버 + Supabase 운영 프로젝트 + Supabase 복구검증 프로젝트

Fastify는 작은 초기 서버에서 모듈 경계를 명확히 유지하면서도 요청 처리 비용이 낮습니다. 핵심 정합성은 API 메모리가 아니라 PostgreSQL 제약과 트랜잭션에 둡니다.

## 신뢰 경계

```mermaid
flowchart LR
  UI[관리자·메이드 PWA] -->|Bearer access token| API[Fastify API]
  API -->|사용자 JWT| DATA[Supabase Data API · RLS]
  API -->|서버 secret| ADMIN[Auth 관리·원자 명령]
  DATA --> DB[(PostgreSQL)]
  API -->|서버 OAuth · drive.file| DRIVE[Private Google Drive folder]
  DB --> JOBS[예약 전이·알림·보존 작업]
```

- 브라우저에는 publishable key만 허용합니다.
- secret/service-role 키는 서버에서만 사용하고 로그에 남기지 않습니다.
- 조회는 가능한 한 사용자 JWT와 RLS를 통과시킵니다.
- 계정 생성·비밀번호 초기화·여러 원장을 함께 바꾸는 명령만 서버 secret과 DB 함수를 사용합니다.
- Google Drive access/refresh token은 서버 secret으로만 보관하며 브라우저는 Drive에 직접 접근하지 않습니다.

## 인증

1. 서버가 먼저 불변 profile UUID를 만들고, 관리자가 그 ID로 Supabase Auth 사용자를 생성합니다.
2. 내부 이메일은 `user-{profile_id}@auth.castletheart.invalid` 형식으로 서버만 계산합니다.
3. 사용자가 이름형 `loginId`와 숫자 6자리 이상 로그인 비밀번호를 보냅니다.
4. 서버가 활성 alias와 프로필을 찾고 5회 실패/15분 잠금을 검사합니다.
5. 서버가 Supabase Auth password 로그인을 수행해 access/refresh token을 반환합니다.
6. 이후 API는 `auth.getUser(accessToken)`으로 토큰을 검증하고 최신 프로필 역할·상태를 다시 읽습니다.

권한은 사용자 수정 가능한 `user_metadata`에 의존하지 않습니다. 역할 변경과 비활성화가 JWT 갱신 전에도 반영되도록 DB 프로필을 매 요청 확인합니다.

## 데이터 모델

```mermaid
erDiagram
  PROFILES ||--o{ LOGIN_ALIASES : authenticates
  ROOM_TYPES ||--o{ ROOMS : classifies
  ROOMS ||--o{ RESERVATIONS : books
  ROOMS ||--o{ CLEANING_TARGETS : requires
  RESERVATIONS o|--o{ CLEANING_TARGETS : triggers
  CLEANING_TARGETS ||--o{ CLEANING_ASSIGNMENTS : revises
  CLEANING_ASSIGNMENTS ||--o{ CLEANING_ATTEMPTS : executes
  CLEANING_ATTEMPTS ||--o{ CLEANING_SUBMISSIONS : versions
  CLEANING_SUBMISSIONS ||--o| INSPECTION_DECISIONS : decides
  CLEANING_SUBMISSIONS ||--o| EARNINGS : earns
  PROFILES ||--o{ PAYROLL_CYCLES : paid
  PROFILES ||--o{ NOTIFICATIONS : receives
  PROFILES ||--o{ AUDIT_EVENTS : acts
```

색상이나 `투숙 중/청소 필요/배정 가능/배정 불가` 같은 복합 UI 상태는 저장하지 않습니다. 예약·수동 점유 보정·운영 중지·청소 단계·촛불·차단 이슈에서 파생합니다.

## 동시성과 멱등성

| 작업 | 서버 보장 |
|---|---|
| 예약 저장 | `tstzrange` + GiST exclusion으로 겹침 차단 |
| 청소 요청 | 객실별 활성 대상 partial unique + `source_key` |
| 담당 변경 | 대상 `assignment_version` CAS + 현재 담당 partial unique |
| 청소 시작 | 메이드별 `in_progress` partial unique |
| 제출 | `client_submission_id` unique + 회차별 현재 제출 unique |
| 검수 | 제출별 decision unique, 현재 `submitted` 버전만 조건부 전이 |
| 수익 | submission/entitlement unique |
| 지급 | `(maid_profile_id, week_start)` unique + version CAS |
| 알림 | 수신자별 dedupe key unique, 10분 group key |

복수 테이블을 바꾸는 예약 저장, 배정 통보, 검수, 지급은 다음 단계에서 SQL RPC로 구현하고 감사 이벤트까지 같은 트랜잭션으로 커밋합니다.

## RLS 원칙

- `public`의 모든 테이블은 RLS를 활성화합니다.
- `anon`에는 테이블 권한을 주지 않습니다.
- 메이드는 본인 담당·수행·제출·수익·지급·알림만 읽습니다.
- 관리자는 운영 테이블을 관리하지만 객실 PIN 원문은 전용 조회 함수로만 받습니다.
- view는 `security_invoker = true`를 사용합니다.
- 내부 권한 함수는 `private` 스키마, 고정 `search_path`, 최소 반환값, 명시적 EXECUTE 권한을 사용합니다.
- 사진 파일은 Drive에서 공개 공유하지 않습니다. API가 사용자 역할과 제출 소유권을 검사한 뒤 업로드·열람·삭제를 대행합니다.
- Supabase에는 Drive 파일 ID·해시·크기·삭제예정일만 저장하고, 사진 레코드 쓰기는 서버 역할에만 허용합니다.
- 인증 사용자의 직접 DML은 본인 알림의 `read_at`으로 제한합니다. `resolved_at`과 업무 상태 변경은 서버 명령/RPC만 사용합니다.
- 상세 역할 매트릭스와 상태 변경 규칙은 [Auth·RLS 계약](./AUTH_RLS_CONTRACT.md)을 따릅니다.

## API 단계

현재:

- `GET /health`
- `POST /v1/auth/login`
- `GET /v1/auth/me`
- `GET /v1/rooms`

다음 구현:

- 관리자 계정 생성·복구·비밀번호 초기화
- 객실 상세·기준정보 변경
- 예약 CRUD와 자동/수동 체크아웃 명령
- 주간 가능일 제출, 오늘/내일 청소 대상, 배정·순서 통보
- 300KiB 사진 업로드, 인증된 사진 스트리밍, 현장 완료, 전체 제출
- 검수 승인/반려, 폭탄방 판정, 재청소
- 메이드별 주급과 지급 상태
- 역할별 알림함과 푸시 구독

## 원격 환경 현황

- Free 조직: `yeosucastletheart@gmail.com's Org`
- 운영: 서울 `room-management-system-prod` (`aodikrxcczbogjpsjwjt`)
- 복구검증: 뭄바이 기존 프로젝트 (`matalcofimnhuzslfhdd`), 사용자 트래픽 금지
- 두 프로젝트 생성 비용은 월 `$0`로 확인

아직 필요한 설정:

- Data API 노출 스키마 확인
- 마이그레이션 적용, RLS advisor와 performance advisor 확인
- publishable/secret key를 로컬·배포 환경에 각각 저장
- 실제 관리자 계정 1개 seed 후 로그인·RLS 통합 테스트
- Google Cloud Drive API OAuth 앱, 전용 운영 계정, 비공개 루트 폴더와 refresh token 설정

## 백업·복구

- 마이그레이션 SQL은 GitHub의 `supabase/migrations/`를 정본으로 사용한다.
- Free Plan의 두 번째 프로젝트는 최신 논리 dump를 실제로 복원하는 warm recovery copy로 사용한다.
- 매일 roles·schema·data dump를 만들고 recovery 프로젝트에 복원한 뒤 핵심 행 수·RLS·관리자·객실 seed를 검사한다.
- DB dump는 Google Drive 사진 파일을 포함하지 않으므로 사진은 업로드 후 7일 자동삭제 정책으로 별도 운영한다.
- 전체 주기와 복원 명령은 [백업·복구 운영안](./BACKUP_AND_RECOVERY.md)에 정의한다.
