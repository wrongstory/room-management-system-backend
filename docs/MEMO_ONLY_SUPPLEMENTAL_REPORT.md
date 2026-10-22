# #474 메모 전용 추가 특이사항 신고

## 확정 정책과 범위

2026-10-22 사용자 결정: 청소 상세의 제출·승인 후 추가 특이사항은 사진 없이 메모만으로 등록할 수 있다.
메모는 기존 1~500 UTF-16 code unit 및 공백 전용 거부 규칙을 유지한다. 사진은 0~10장이다.
일반 청소 제출 필수 사진, 폭탄방 증빙, 제출 전 신고, 기존 사진 업로드 기능은 변경하지 않는다.
관리자 공유 및 실제 통보 배정 이력이 있는 메이드 접근 권한도 변경하지 않는다.

## 프런트 계약

1. 기존 drafts API로 메모를 저장하고 반환된 draftRevision을 사용한다.
2. 사진 없는 새 초안은 업로드를 호출하지 않는다.
3. supplemental-room-issues 확정 요청에 evidence: []와 expectedEvidenceRevision: 0을 보낸다.
4. 사진이 있으면 기존처럼 현재 양수 증빙 revision과 전체 증빙 목록을 보낸다.
5. 사진이 이미 등록된 초안을 빈 배열로 확정하여 사진을 누락시킬 수 없다. 서버의 collection CAS 검증은 유지된다.
6. 확정·목록·상세·종결 후 조회에서 사진 없는 신고는 evidence: []로 반환한다(null이 아님).
7. 동일 Idempotency-Key 재시도와 불변 receipt, 실제 작성자 감사 기록은 유지한다.

## 배포 상태

미배포 후보. 운영에서 사진 필수 제한을 해제했다고 간주하지 않는다.
백엔드 후속 migration 적용 및 API 배포 확인 후 프런트 #227의 사진 필수 guard를 제거한다.
DB migration 파일은 작성했지만 실행하지 않았다. 격리 DB 검증과 운영 적용은 각각 사용자 사전 승인이 필요하다.
기존 migration 및 과거 보고서·receipt는 수정하지 않는다.

## 검증 범위

Node 계약 회귀는 메모 전용 확정, 빈 배열 응답, 공백 메모 거부, revision 불일치 거부를 검사한다.
SQL 회귀는 메모 전용 확정·동일 요청 재시도·0개 seal·관리자 종결·종결 조회를 추가했다.
SQL 회귀는 아직 실행하지 않았으므로 DB 검증 완료를 의미하지 않는다.

### 로컬 checkpoint

- npm test: 124파일, 3,117건 PASS.
- typecheck/build: PASS. lint: 종료 코드 0, 기존 경고 24건/info 60건.
- db:manifest:verify: PASS(파일 목록·해시 검사만 수행, DB 실행 아님).
- edge:check: PASS. 기존 Edge 537건, 번들 runtime 68건 PASS. 후보 번들 19,421,933 bytes.
- 프런트 #227에 계약과 미배포 상태 댓글 인계 완료.
- 독립 QA: 코드·계약·비DB 회귀 PASS. 관련 9파일 320건 및 보완 후 2파일 118건 재검증.
- 도구 최종 독립 QA: helper/upgrade-source 2파일 144건 PASS. source/manifest 해시와
  121·122 exact pin, 개발자 DB 진단의 head/직전 이력 검사 확인. 차단 사항 없음.
- DB 도구: 113~122 SQL 감사 결과 알림 catalog DML 추가 없음. 118의 runtime dispatcher와
  122의 보고 감사는 기존 catalog를 사용한다. 95~122만 허용하고 123 이상은 거부한다.
  111의 정확한 1행·11필드 예외 외 기존 모든 행 비교를 유지한다.
  112~122 각 head에서 미승인 추가·변조·삭제·중복·누락 catalog 거부를 검증했다(26건 PASS).
- 전체 DB/실제 SQL/upgrade/경합: NOT RUN. 사용자 승인 후 최종 릴리스에서 실행한다.
- 개발 PR은 dev 대상이며 CI는 application/manifest만 실행한다. 운영 배포 전이다.

## 배포·복구

승인된 최종 통합 DB 검증 → 릴리스/main 병합 → 별도 승인된 운영 후속 migration →
API 배포 → 프런트 guard 해제 순서다. DB 수정은 CHECK와 기존 함수 재정의이며 신규 키/환경변수가 없다.
메모 전용 자료가 생긴 뒤 최소 1장 CHECK로 되돌리거나 기존 API로 무조건 rollback하면
빈 증빙 응답을 처리하지 못한다. 기존 API로 회귀하지 말고 메모 전용 등록을 일시 중단한
호환 API로 대응하고 기록은 보존한다. 기존 사진 기능은 그대로 유지한다.
