# v0.7.0 청소 사진·이력·주급 개편

운영 Git 릴리스는 기존 v0.6.5 다음의 v0.7.0이다. HTTP OpenAPI 계약 버전은 기존 0.5.1 다음의 0.6.0이며 두 버전은 별도로 관리한다. 기존 v0.6.0 태그와 발행된 릴리스 기록은 수정하지 않는다.

## 변경 범위

- 일반 사진 1~20장, 폭탄방/특이사항 별도 컬렉션. CAS·중복 요청·검증된 사진·제출 봉인 유지.
- 관리자/본인 메이드의 `GET /v1/cleaning-history/{submissionId}`와 담당 메이드의 `POST /v1/attempts/{attemptId}/room-issues`.
- 주급 `accrualAmount`, `expectedAmount`, `pendingAmount`, `pendingCount` 읽기 projection. 지급 명령/잠금 원장 변경 없음.
- 현재 주 조회와 종료 주 지급 gate를 분리. 목록·산출·cycle 조회만 현재 주 허용, 미래 주 조회 및 현재 주 지급은 차단.
- CORS DELETE 허용. OpenAPI 0.6.0, 131 paths / 141 operations.

## Migration

운영 사전 확인: 84개, head `20260926010110`. 후속 85번째 `20260928095656_flat_cleaning_evidence_history_payroll.sql` 한 건만 적용한다.

기존 승인 제출 1건과 사진 version 11개를 삭제하지 않는다. 기존 template은 retired로 보존하고 운영값을 복제한 새 version을 게시한다. 시작/업로드/제출이 없는 target만 전환하며 private append-only receipt에 이전 snapshot을 기록한다. PIN/고객명/수익/지급 원장은 변경하지 않는다.

84 -> 85 합성 upgrade에서 미시작 target 2건 전환 및 기존 제출/사진 byte parity를 확인했다. 과거 6개 upgrade의 원장 불변 검사는 명시적 새 사진 계약 전환 직전인 84까지만 적용하고 원래 assertion은 유지했다. 85의 전환·보존은 별도 upgrade 검사로 검증한다. 실제 운영 반영 전 source PR -> dev -> release/v0.7.0 -> main과 필수 CI를 거친다.

기존 운영 migration timestamp와 Git filename은 일부 다르다. stable name/head/건수와 실제 schema를 확인하고 이번 한 건만 원자적으로 적용·기록한다. 기존 history repair, 전체 db push, 기존 migration 재적용은 하지 않는다.

## 검증 기록

- 로컬 fresh migration 적용, 84 -> 85 데이터 upgrade: 통과.
- Fastify typecheck/lint/build, 580개 application 및 287개 Edge 회귀: 통과.
- Python console lint/format/mypy, 95개 테스트, ephemeral OpenAPI codegen/package source: 통과. 기존 AttemptLifecycleRequest 중복 모델 codegen warning은 유지.
- 운영 Security Advisor 사전 확인: DB/RLS WARN/ERROR 없음. 기존 Free Plan의 `auth_leaked_password_protection` WARN 1건은 이번 변경과 무관한 알려진 제한. private RLS/no-policy INFO는 의도적인 직접 접근 차단이다.
- 12개 버전 upgrade 경로, fresh 85 migration, 전체 SQL 64파일/3,366개 assertion, KST 자정 경계 5개 시각, 합성 backup/recovery, 전체 동시성 회귀: 통과.
- 최종 로컬 Security Advisor: WARN/ERROR 0건.
- 실제 운영 계정으로 청소 생성·업로드·승인·송금하지 않음. 합성 로컬 테스트와 운영 read-only smoke를 구분한다.
- 모바일 실기기 카메라·설치형 앱 하드웨어 Back은 브라우저 에뮬레이션만으로 통과를 선언하지 않는다.

## 운영 순서

main 병합 후 pending migration 한 건, api exact source 배포, health/OpenAPI/CORS/권한 없는 요청 검사, 기존 제출·사진 건수 보존 확인, Swagger Pages 갱신, 프런트 배포본 source hash 확인 순으로 진행한다. 운영 데이터 mutation smoke는 별도 테스트 계정/대상 없이 실행하지 않는다.
