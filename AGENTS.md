# 백엔드 작업 규칙

- 제품 정책 우선순위는 원본 저장소의 `AGENTS.md`를 따른다.
- 모든 공개 스키마 테이블은 RLS를 활성화하고 실제 소유권 또는 관리자 조건을 정책에 포함한다.
- Supabase secret/service-role 키와 객실 PIN 원문은 클라이언트, 로그, 알림, Git에 넣지 않는다.
- 예약·청소 요청·배정·제출·검수·수익·지급 명령은 DB 제약, 트랜잭션, 멱등성 키로 중복을 막는다.
- 스키마 변경은 `supabase migration new <name>`으로 파일을 만든 뒤 작성한다.
- 변경 뒤 `npm run typecheck`, `npm test`, `npm run build`를 실행한다.

