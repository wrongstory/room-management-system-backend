# 운영 릴리스 검증·문서의 dev 복원 — #485

## 범위와 기준

2026-10-25 사용자 요청으로 main `3e805249d768cc108bc365e63ae3503c7a9ac7f0`의
누락된 검증·문서를 dev `0934ae55647ddbec9ea6bffa774f3c1124ffca94`에 선별 복원한다.
main을 dev에 직접 병합하지 않고 일반 작업 PR을 사용한다.
제품 가이드의 #446 자정 이월, #431 최종 DB 1회, 실행 전 개별 승인 계약을 따른다.

- 검증 6개: assignment upgrade의 실행 전 exact source 검사, overdue 경합의 정확히 한 번
  이월·감사·revision 및 replay 보존, 당일 배정 보존 SQL, 순수 rollover 회귀,
  진단 head source 검사, upgrade catalog의 113~122 호환성 검사.
- 문서 10개: 기존 checkpoint 5개 및 RELEASE_V0.9.5~V0.9.9 기록.
- 과거 문서의 '최신/운영/후보'는 당시 기록으로 보존하고 인계·조정 문서 상단에 현재 경계를 명시한다.
- dev의 #479/#480 의존성 보안 패치와 #481 PIN 진단 소스·생성 파일·시험은 보존한다.

API·권한·업무 로직·기존 migration·manifest·CI workflow 변경 없음.
supabase/tests SQL은 검증 소스 복원이며 migration 적용이 아니다.
전체 DB·SQL·upgrade·실제 경합은 이번에 실행하지 않는다.

## 검증

- 변경 전 `npm test -- --maxWorkers=2`: 126 files / 3133 tests PASS.
- 변경 후 `npm run ci:quality`: 127 files / 3166 tests PASS, secret/OpenAPI/lint/typecheck/build PASS.
- `npm run db:manifest:verify`: 기존 4개 릴리스 및 dev 122개 manifest PASS.
- `git diff --check`: PASS.
- runtime/src, package/lock, migration/manifest, workflow의 dev 대비 차이 없음 확인.
- 독립 QA: 별도 에이전트의 5 files / 91 tests PASS, 차단 결함 0. 원격 required CI는 PR에서 확인한다.
- Full DB/SQL/upgrade/경합/운영 migration/배포: NOT RUN.

개발 manifest PASS를 전체 DB PASS로 표시하지 않는다. 이전 릴리스 증거를 새 릴리스의
성공으로 선기록하지 않는다. 최종 통합 입력에 대한 DB 실행은 사용자 승인 후 별도다.

## 프런트·Notion 인계

이번 복원으로 프런트가 수정할 공개 API 계약은 없다. 마지막 운영 배포 기록은
[v0.9.9 / API53 / DB122](https://github.com/wrongstory/room-management-system-backend/pull/477#issuecomment-6359461664)다.
#479/#480/#481은 dev 통합과 운영 반영을 구분한다. 사진/메모 신고의 기존 운영 계약은 유지한다.

- [프런트 #206](https://github.com/makee-ham/room-management-system/issues/206)
- [프런트 #227](https://github.com/makee-ham/room-management-system/issues/227)
- [Notion 문서 센터](https://app.notion.com/p/4044b2ea5a9581658ab1c6063da0b058)

앞으로 의미 있는 구현·검증·병합·배포·차단 변화는 Notion 현황/개발 이력에 반영하고,
공개 계약 변화는 프런트 인계에도 반영한다. 비밀정보와 운영 원문은 기록하지 않는다.
