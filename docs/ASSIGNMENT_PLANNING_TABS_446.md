# #446 오늘·내일 배정 기준 정합화

상태: 독립 QA 지적 소스 보완, DB 검증 대기 후보. 병합/배포 금지.
운영 미배포, 실제 DB 검증·migration 적용 NOT RUN.

## 보완 checkpoint — 2026-10-11

초기 4건에 대해 아래 source 보완을 작성했다. Node 117파일/2,983개·typecheck·build·
manifest·OpenAPI source는 PASS이며 실제 SQL/upgrade/경합은 NOT RUN이다.

- exact assignment/target/maid/revision의 불변 `assignment.notified`/새 `assignment.prestart_changed`
  이력에서 계획일을 읽는다. 없는 legacy 근거를 생성시각으로 추정하지 않고 원 업무일을 쓴다.
- activation 공통 검사에 계획일 상한을 넣었다. scheduler와 실제 start가 같은 검사를 사용한다.
  메이드 current 오늘/내일 목록은 `planningDate`로 필터하고 원 `serviceDate`는 보존한다.
- `POST /v1/assignments/{cleaningTargetId}/change`에 선택 `serviceDate`를 추가했다.
  오늘/내일 탭에서는 반드시 전달한다. 신규 RPC는 선택일의 availability lock/검사와 기존
  actor/CAS/receipt/시작 전 경계를 유지하며 audit에 계획일을 남긴다. 기존 호출은 앞선
  통보 계획일 또는 legacy 원 날짜를 이어받는다. 멱등 hash에 선택일이 포함된다.
- availability 변경 보호도 계획일을 검사한다. 사진/검수만 남은 과거 업무는 내일 메이드
  고정 부하에서 제외하되 다른 target의 같은 객실 workflow 차단은 유지한다.
- 두 upgrade runner는 latest head의 backlog identity 집합을 검사하도록 갱신했다.

독립 재QA는 추가 P2였던 일정 successor의 계획일 유실을 소스상 해소한 것으로 확인했다.
직전 revision·동일 담당/순번·통보·종료·정확한 일정 snapshot과 변경 사유가 일치하는
checkout/일정 변경만 앞선 근거를 승계한다. 다른 담당/일반 재배정에는 승계하지 않는다.
구 `get_assignment_schedule_read`의 응답은 보존하고 새 `get_assignment_schedule_read_for_plan`을
Node/Edge에서 호출한다. DB-first 적용 중 구 API의 strict parser를 깨지 않는다.

독립 QA targeted Node 179개 PASS. 당시 발견한 최신 SQL hash/pin 차이도 갱신했고 이후
전체 Node 2,983개와 manifest를 재통과했다. successor 근거 reader의 보존/비상속·원장 원복
SQL 회귀 7건을 추가했으나 실행하지 않았다. public checkout E2E 검증과는 구분한다.
실제 prestart for_plan/legacy 담당 변경·근무 희망 보호·동시성 검증도 승인 후 DB gate에 남는다.
최종 `edge:check` PASS: 주요 Deno 530개, report TS 65개와 generated JS 65개,
후보 포함 번들 19,272,533 bytes(<20,000,000). 중간 포맷·구 RPC fixture 실패를 보완 후 재실행했다.
typecheck/build/OpenAPI source·생성 client/secret scan/manifest PASS. lint exit 0이나
기존 warning 1건·info 37건은 남는다. source 보완은 SQL 검증/운영 완료가 아니다.

## 최초 독립 QA checkpoint — 2026-10-11 (보완 전 이력)

Node 117파일/2,973개·typecheck·build·manifest·OpenAPI source·tracked secret 검사는 PASS.
별도 리뷰 에이전트의 targeted Node 120개도 PASS지만 아래 의미 불일치 4건이 남아 있다.
Edge 전체 검사는 최초 포맷 오류로 FAIL했고 포맷 보완 후 전체 재실행은 아직 NOT RUN이다.

1. 과거 업무를 내일 근무 희망으로 확정해도 scheduler는 원 effective_service_date를 보고
   오늘 활성화할 수 있다. 메이드 내일 목록 역시 그 업무를 놓친다. 원 날짜 이력을 보존하되
   별도 요청 계획일 근거를 실행/메이드 조회/통보 revision까지 연결해야 한다.
2. 기존 담당자 변경 helper는 원 날짜의 근무 희망을 검사한다. 선택 계획일을 명시적으로
   전달하고 같은 날짜의 가능 여부·version·취소/변경 보호까지 일관되게 검사해야 한다.
3. 사진 업로드/검수 대기 상태가 자동배정에서 메이드 전체를 제외할 수 있다. 물리 청소를
   끝낸 업무의 내일 부하와 해당 객실의 기존 workflow 실행 차단을 분리해야 한다.
4. 과거 upgrade runner가 최신 head 적용 후에도 내일 대상/초안의 과거 개수를 기대한다.
   최종 정책/스키마 구현 후 기대값과 보존·경합 검사를 함께 갱신해야 한다.

단순 목록 확장은 해결 완료가 아니다. 위 항목과 회귀 검사를 마친 뒤 독립 QA를 다시 받고,
사용자 승인 후에만 실제 DB 적용 검증을 진행한다. 현재 코드·SQL은 로컬 미커밋 후보다.

## 사용자 확정 정책

- 내일 배정은 주 계획 화면이다. 오늘까지 미완료 업무와 내일 체크아웃 객실을 내일 근무 희망자에게 배정한다.
- 오늘 배정은 전날 계획한 오늘 업무를 조회·수정하는 화면이다. 오늘까지 미완료 업무와 오늘 체크아웃 객실, 기존 담당자를 표시하며 추가 배정도 허용한다.
- 두 화면의 기능/UI는 같고 선택한 계획일만 다르다. 생성일·통보일로 구분하지 않는다.

## 확인한 차이와 변경

| 경로 | 기존 | 후보 |
| --- | --- | --- |
| 관리자 Node/Edge 배정 목록 | 오늘만 과거 미완료 포함 | 오늘·내일 모두 포함 |
| 자동 배정 core/DB snapshot | 내일은 과거 미완료 제외 | 내일에도 후보/고정 업무 포함 |
| commit preflight/확정 helper | 오늘만 과거 초안 허용 | 내일에도 검사 후 확정 허용 |
| 근무 희망 | 요청 계획일 기준 | 유지 |

기존 target/assignment의 원 날짜·담당자·감사 이력을 재작성하지 않는다. 시작된 작업은
고정 업무이며 일반 재배정 대상으로 풀지 않는다. CAS·멱등성·근무 희망·일정 변경 검사는 유지한다.
메이드 current 내일 목록은 통보된 계획일을 사용하고 과거 이력 조회는 기존 원 날짜 범위를 유지한다.
관리자 내일 backlog에서 승인·취소·제출/업로드/반려 단계는 제외한다.

## 프런트 인계

최종 목표 계약: 선택한 KST 날짜 D를 목록·preview·commit impact·확정에 동일하게 전달한다.
담당 변경에도 `serviceDate: D`를 전달한다. 카드의 `planningDate`는 통보/변경 이력의 계획일이고
`serviceDate`는 원 업무일이다. 운영 미배포 후보이므로 배포 확인 전 운영 계약으로 연결하지 않는다.
응답의 과거 serviceDate를 D와 다르다는 이유로 버리지 않는다. 이는 원 업무일이며
createdAt/notifiedAt도 탭 분류 기준이 아니다. 기존 담당자와 cleaningTargetId를 유지한다.
같은 객실의 별도 업무를 객실 번호로 합치지 않는다. 미래 체크아웃 예정은 실제 퇴실 전에도
계획 대상이므로 현재 cleaning_required만으로 제거하지 않는다.
진행/제출/검수 완료 상태는 해당 탭으로 구분하며 현재 수행 중인 업무의 변경 제한은 유지한다.

검수 사례: 어제 생성된 오늘 배정, 오늘 생성된 내일 배정, 미배정 과거 업무, 기존 초안/
통보 담당자, 오늘 불가·내일 가능 메이드와 그 반대, KST 자정 경계, 시작된 고정 업무,
승인/취소/제출된 과거 업무 제외를 각각 확인한다. 목록 오류를 빈 목록으로 바꾸지 않는다.

## DB 적용 경계

후속 파일 `20261010154753_assignment_tomorrow_backlog.sql`은 날짜 조건과 activation/조회/
availability 보호를 정확한 source 지문으로 교체한다. 계획일 helper, 변경용 RPC·내부 command,
변경 감사 조회 index를 추가하며 기존 prestart 검사를 복제·위임해 보존한다. 새 테이블·데이터
backfill은 없다. 로컬/CI/운영 적용과 DB reset은 실행 전에 별도 사용자 승인이 필요하다.
다른 브랜치의 #416 후속 SQL은 이 후보에 포함하지 않았다. 통합 시 manifest 및 exact-tail
검증을 함께 재정렬해야 한다. 소스 검사 통과를 실제 DB 검증으로 표시하지 않는다.
