# v0.9.3 운영 배포 기록 — 2026-10-10

이 기록은 이전 후보/CI 대기 상태보다 우선한다. 기존 준비 기록은 당시 이력으로 보존한다.

## 배포 결과

- [릴리스 PR430](https://github.com/wrongstory/room-management-system-backend/pull/430)을 보호 squash했다.
- 운영 source main: `72771b5f7d87cc749ed57a845b9ecf8bf18aa290`.
- [v0.9.3 Release](https://github.com/wrongstory/room-management-system-backend/releases/tag/v0.9.3) 게시 완료.
- Supabase production `aodikrxcczbogjpsjwjt`: API ACTIVE44, 기존 내부 인증/verify_jwt=false 유지.
- API artifact SHA256: `4b325961b2553a4c4c6f1807c26f4ee6cb153d5a3cae414c292108d502ab2eaa`.
- scheduler18/photo-purge7/notification-delivery9/room-pin-sheet-sync7 변경 없음.
- 신규 SQL0, 운영 migration 실행0. 운영 history112 그대로이며 DB 재적용/repair 없음.
- 프런트 소스/flag·Secrets·Cron·Auth·PIN·업무 데이터 변경 없음.

## 반영 범위

- #427: 가능일 exact count/반환 수 및 current 주간7일 완전성 검사. 잘림을 성공으로 숨기지 않는다.
- #413: 성공 업무 응답의 고정 숫자 `Server-Timing: api_total;dur=<ms>` 계측.
  인증/오류/HEAD/OPTIONS 제외, 기존 사진 timing·권한·no-store 유지.
- #414: `GET /v1/payroll/remittance-markers?weekStart=YYYY-MM-DD&maidProfileIds=UUID,UUID`.
  최대10명 CSV 문자열, 요청별 동시3, 항목별 최신 권한 RPC, 하나라도 실패하면 전체 오류.
  기존 단건 유지. DB RPC는 N회이며 동일 snapshot이 아니다.
- #415: 배정 attempt→submission 종속 조회를 다른 관계 조회와 병렬 수행.
  최종 live 권한·실제 통보 이력·완전성 검사를 유지하며 DB 호출 수 자체는 동일하다.

## 검증 및 최종1회 DB 정책

- 최종 source5c9671f [CI38020765645](https://github.com/wrongstory/room-management-system-backend/actions/runs/38020765645):
  application/전체 migration SUCCESS.
- full proof: `420bcb3906d2fc84424a08c52f1ca307b3315bcb20f854d216e0195ddddc8999`.
- main [CI38025990739](https://github.com/wrongstory/room-management-system-backend/actions/runs/38025990739):
  application/migration SUCCESS. migration은 위 proof 재사용이며 DB 시작·전체 검사·종료 및
  새 full proof 생성은 SKIPPED. manifest만 검사했다. 독립 QA가 원본과 재사용 로그를 확인했다.
- Node2815, typecheck/build/lint/명세, Edge525+runtime65 및 번들19,277,578bytes PASS.
- 독립 기능·릴리스·검증 정책 QA PASS. 공개 운영 GET/OPTIONS 독립 QA PASS.
- health200, 허용 Origin204/비허용403, 비인증 보호 GET401/no-store/timing 비노출 확인.
- 운영 OpenAPI의 CSV batch 및 기존 사진 opt-in/nullable 계약 유지 확인.
- [Swagger Pages](https://wrongstory.github.io/room-management-system-backend/) 게시
  [CI38026183486](https://github.com/wrongstory/room-management-system-backend/actions/runs/38026183486) SUCCESS.
  공개 API와 게시 paths/components 동일, 151 paths/163 operations.
- 게시 명세 SHA256: `110623b8ad92c532d902bb7d8e5a57c6bb8309f65519a4e9b84e384f2ae57f60`.
- OpenAPI info.version0.6.0은 앱 릴리스 v0.9.3과 별개다.
- 배포 CLI의 기존 `.js` 탐색 경고는 명시적 `.ts` mapping으로 처리되며 exit0 및 운영 로딩 검증 PASS.

## 프런트 인계와 남은 범위

[프런트 #207 인계](https://github.com/makee-ham/room-management-system/issues/207#issuecomment-6094034492)를
최신화했다. 현재 페이지 최대10명만 CSV 문자열로 전달하고 실패를 미송금/빈 목록/근무 불가로
치환하지 않는다. CAS/version/basisFingerprint·재확인 표시·권한별 캐시 폐기를 유지한다.
401/403/500은 미지원404와 다르며 timing 헤더 부재는 정상이다.

실제 계정 batch/가능일/사진 업로드·snapshot/null fallback·화면 UAT·p50/p95는 NOT RUN이다.
사진 snapshot 옵션은 정상 UAT 후 프런트에서 활성화한다. 체감 개선율을 주장하지 않는다.
#414 반복 DB 집계, #416 계측, #427 row cap/1000초과 pagination, #411 썸네일,
백업/복원/DB초기화는 후속이다. 실제 기능 확인을 백업·초기화 개발보다 우선한다.
기존 Advisor leaked-password-protection WARN1/deny-by-default RLS-no-policy INFO127은 유지한다.

## Rollback

직전 main `32c100ea3f1eecbd43ebc900feafdb6af63173c2`/API43 소스를 api만 재배포하고 Swagger도
해당 명세로 게시한다. 프런트 batch는 기존 단건으로 전환한다. 신규 SQL이 없으므로 DB rollback이나
history repair는 하지 않는다. 실제 rollback/복원은 미실행이다.

Refs #429, #431, #427, #413, #414, #415
