# 개발 오케스트레이션·source 승인 기준

## 2026-10-07 사용자 우선순위 변경 — 빠른 운영 배포 트랙

추가 결정: 중간 로컬 전체 migration/reset/upgrade 반복을 중단하고 변경 기능 검증과
최종 통합 후보의 필수 CI로 검증한다. 운영 적용은 최종 한 번의 배포 절차로 수행한다.
PR377/source83e7122는 required CI37603160916·독립 QA 후 devbec3dbe로 보호 squash됐다.
release의 main 충돌121개는 e2f703e에서 해소했고 CI37604470137 두 check도 PASS다.
#404 감사 검사 오탐 보완 PR405/sourcec3803be는 CI37626935185 두 check와 독립 QA PASS 후
dev1a91ad8로 보호 squash됐다. release에 테스트 한 파일을 정상 통합했다.
승인된 #336 전용 키 준비·기존 키 보존은 확인했지만 실제 인계 hosted 검증은 미완료다.
최종 release exact-head CI 및 운영 적용 도구 원자성/timeout·짧은 업무 중지 통제가 남았다.
운영 DB/API·Swagger 승격은 아직 하지 않았다.

최신 지시는 완료된 프런트 요구 기능의 운영 배포·Swagger 인계·실사용 확인을 먼저 수행하는 것이다.
아래 과거의 #396 전체 개발 → #378 전체 실행기 → #273 실제 백업/복원 → 배포 직전 정지 순서는
대체됐다. 백업/복원·DB 초기화 기능 개발은 후속이며 이번 릴리스의 선행조건으로 사용하지 않는다.
필수 CI·독립 QA·보호 병합·권한/기존 데이터 보존은 유지한다. 운영 데이터 초기화·Auth/PIN 변경은
하지 않는다. 최신 범위·실제 미완료 gate는 [v0.9.0 빠른 배포](./RELEASE_V0.9.0.md)를 따른다.
release/v0.9.0은 dev8bdaec3에서 시작했으며 미병합 초기화 PR402와 v0.8.0은 보존·분리한다.
운영85/source111 및 main 누적 충돌·#376 실제 CRLF 호환이 현재 직접 배포 점검 대상이다.

## 2026-10-07 최신 실행 checkpoint

#336/PR401은 dev f1d1f6d에 보호 squash 완료, #336/#400 source/dev 종료다.
source0cc368c·CI merge·dev tree6e7873a3b4298df7978097f28c9953302dad9f33 동일,
CI37579027245 application/migration PASS와 독립 QA·미해결 리뷰0을 확인했다.
운영 미반영이며 다음은 #396 PR399 진단 foundation의 최신 dev 통합·전체 보존/삭제 설계다.
로컬111 재대조는183관계/FK474/trigger333·누락0이지만 review125/mixed10은 여전히
후속 검토이고 실제 초기화는 비활성이다. 아래31차의 미병합 문구는 당시 기록이다.

최신은 [#336 31차 checkpoint](./POST_APPROVAL_ROOM_ISSUE_REPORT.md#31차-checkpoint--2026-10-07-종결-조회-보완과-전체-재검증)다.
종결 GET/list 필드 보완 후 Node2,524·SQL5,568·fresh111·110→111 upgrade·18경합·전체 Edge가
PASS다. 독립 기능 재QA189 PASS이며 마지막 mock 보완 뒤 API46 PASS다. 후보 번들19,185,148 bytes.
exact9 baseline PASS와 raw strict FAIL9를 구분한다. 최종 증거 독립 QA PASS(미해결 P0/P1/P2 없음),
마지막 보완 후 전체 Node2,524 재실행 PASS다. 변경 범위 확정·PR/CI·dev/운영은 후속이다.
아래30차는 보완 전 기록이다.

최신 진행은 [#336 30차 checkpoint](./POST_APPROVAL_ROOM_ISSUE_REPORT.md#30차-checkpoint--2026-10-07-독립-qa-보완-판정)다.
독립 QA는 P2 두 건으로 보완 판정했다. 종결 상태 GET/list 누락은 미해결이고,
#400 frozen lock 검사는 수정·독립 재QA PASS다. 아래 PASS는29차 실행 증거이지 최종 승인 아니다.
신규11개 기본 API/source Swagger 등록150/162/335, Node2,517 및 실제110→111 upgrade PASS다.
#400 실행/검증 lock 분리 후 실제 기본 Edge18,550,494 bytes·별도 후보19,171,562 bytes와
전체 Edge(raw65/기존491/생성본65)가 통과했다. 기존18–27 upgrade 분할 재실행 및 전체 SQL88파일/
5,560·static·KST145·전체11경합·최종fresh111 및 exact9 baseline도 PASS다. 최초 실패 이력은 보존한다. 신규 전체
QA·CI·dev/운영은 미완료이며 아래27차 수치는 이전 실행 이력이다.

개발 정본은 `dev@ac8c775` /110 migrations다. #332/PR338 및 #397/PR398은 required CI·
독립 QA를 거쳐 dev에 보호 squash됐다. 아래109d6b7/108개 및 CI 대기 문구는 과거 기록이다.

아래는27차 당시의 통합 이력이다. #336은 별도 `codex/336-latest-dev-integration`에 이전 미커밋 후보를 보존해 통합했다.
manifest111·기존110 SHA/순서 불변, Node2,363·Edge 실제 후보18,262,301 bytes·Python95·
template client·audit 취약점0 및 독립 caller/통합 QA144 PASS다. fresh111·template DB·exact9
baseline·합성복구도 PASS이고, 전체27 upgrade/SQL은 진행 중이다. 전용110→111 upgrade,
전체 경합, 정식 API/Swagger 등록·새 exact-head CI·dev 병합·운영은 완료가 아니다.
[정확한 범위와 최초 실패/후속 PASS](./POST_APPROVAL_ROOM_ISSUE_REPORT.md#27차-checkpoint--2026-10-07-최신-dev-격리-통합-전체-db-진행-중)를 따른다.

진행 순서는 #336 완성 → 최종 스키마의 #396 개발자 초기화 실행/복구·보존 삭제 manifest →
#376/#378 실행기/실제 fault → 개발 완료 후 #273 Supabase-only B 실제 백업/복원 →
별도 v0.9.0 릴리스 준비다. #396 PR399는 실행 비활성 진단 foundation Draft이며,
진단 도구 PASS를 실제 DB 초기화 완성으로 해석하지 않는다. v0.8.0·프런트·운영은 보존하고
현재 지시대로 실제 운영 반영·tag/Release 직전에 정지한다.

## 2026-10-06 자동 진행 순서

현재 개발 정본은 `dev@109d6b7`/108 migrations다. #318/PR321과 #330/PR337은
required CI·독립 QA·보호 병합을 완료했다. #391도 PR337과 동일 tree/CI 근거로 source/dev 종료했다.

1. #332/PR338: 최신 dev 통합110개·OpenAPI140/151 후보. Node1,831/Edge491/Python95,
   fresh110·전체27 upgrade/SQL87/5,327·static/KST145·전체10경합/최종cleanup·exact9/catalog3
   baseline과 독립 source/staged QA PASS. source7f3e5f4를 push했고 새 required CI는 대기 중이다.
   최종 문서 검토·exact-head CI 완료 뒤 보호 병합한다.
2. #336: 제출·승인 후 새 특이사항 신고를 독립 사건/새 증빙으로 구현한다.
   2026-10-06 사용자 결정에 따라 관리자 간 기능·정보를 공유하고 메이드는 본인 실제 통보
   배정 이력 범위만 접근한다. 담당 종료·제출/승인·경과 일수만으로 #336 접근을 막지 않으며,
   배정자·수행자·처리자는 기록한다. 기존 원 수행자/작성자 전용 guard를 감사·보완한다.
3. #376/PR377와 #378/PR392: 최신 dev에서 CRLF 엄격 지문 호환 및 유한·원자 migration 실행,
   응답 손실/중단 상태 판정과 실제 DB fault 검증을 완료한다. 기존 실패를 우회하지 않는다.
4. 개발 종료 뒤 #273/PR379의 Supabase-only B 실제 백업·복원·동일성·FK 검증을 완료한다.
   로컬 운영 백업 파일은 제외하며 성공 검증 뒤 복구 프로젝트만 최소15일 Pause한다.
5. 최신 dev에서 별도 `release/v0.9.0 → main`을 검증·리뷰·보호 병합한다.
   기존 v0.8.0 후보는 보존하고 운영 pending SQL만 적용한 뒤 exact main API/scheduler를 반영한다.
6. hosted smoke·API/Pages/릴리스 문서·프런트 인계를 확인하고 실제 완료 뒤 tag/Release를 발행한다.

운영 쓰기·Auth 변경·worker의 배포 직전 일시 중지는 2026-10-06 사용자가 승인했다.
시행 직전 안내하고 실제 백업·검증·배포 뒤 정상화하며 승인 자체를 시행 완료로 표시하지 않는다.
운영 프로젝트 Pause, 비밀번호/암호키/실제 PIN 변경, 실제 송금, 프런트 소스 개발은 이 범위에 포함하지 않는다.
이 목록은 완료 선언이 아니며 raw strict FAIL9와 승인된 exact9 gate의 구분을 유지한다.
현재 #332 증거는 [등록 신고 조회](./ADMIN_REPORT_READ.md), 전체 릴리스 gate는
[Issue387](https://github.com/wrongstory/room-management-system-backend/issues/387)을 따른다.

> 2026-10-05 현재: #329 PR372는 dev `79d6fb2`, #393 PR394는 dev `58a5821`에 통합됐다. #318의 checkpoint `0781d14`를 최신 dev58a와 정상 통합한106개 후보는 Node1,794·Edge487·Python95/client순열·fresh106·전체27 upgrade/SQL5,193·static/KST145·전체9경합/최종cleanup·exact9 baseline·독립 소스 QA PASS다. 원본484 hash drift0와 실제 caller7/18/core2도 확인했다. raw strict FAIL9/exit1은 유지한다. 최종 staged QA·새 exact-head CI/PR321 보호 병합이 다음이며 이후 #330 → #332 → #336 및 #376/#378 → 실제 Supabase-only 백업/복원 → v0.9.0 release/main·운영 승격 순서를 유지한다. v0.8.0과 운영·프런트는 불변이다. [현재 #318 증거](./ROOM_BOARD_DATE_FILTERS.md)와 아래 과거 checkpoint를 구분한다.

### 과거 #318의 bb4fa40 통합 준비
> 2026-10-05 #318 병행 최신 통합 후보: 별도 `codex/318-latest-dev-integration`에서 dev `bb4fa40`/102 SQL과 원 #318 본문 SHA를 보존한다. 원격 미적용 baseline 재정렬로 #329 strict migration-time inventory를 먼저 검증한 뒤 board RPC를 추가하고, LIVE의 PIN/current-cleaning helper·실제active 점유 선택만 후속 append로 호환 보완한 총104개 후보다. 예정 퇴실 이후 inspection 조건은 materialization과 독립 축으로 유지한다. [적용 순서·실제 source 검증·남은 gate](./ROOM_BOARD_DATE_FILTERS.md)를 따른다. 최신383/382/329 재통합·전체 fresh DB·경합·exact-head CI·최종 독립 QA·운영 백업/복원·릴리스 배포는 완료로 표시하지 않는다.

### 과거 #329 통합 검증 checkpoint
> 2026-10-05 최신 gate: #329의 4da53b0 +devfdd8d7d 정상 통합 후보는 Node1,767/74·Edge486/0·Python95/client6순열·실제 fresh104/template6순열/receipt/CAS/16malformed→전체9경합→finalfresh104 exit0 PASS다. 원본480/사본480 drift0/SQL200LF/raw280·fixture0·RLS0·객실121 확인. 이전 전체27 upgrades/SQL82·5,119/static/KST145 PASS와 새 로컬 재실행NOT RUN, 최초 cleanupFAIL/후속3PASS/새전체9PASS를 구분한다. [현재 증거](./LIMITED_SESSION_REENTRY.md#2026-10-05-최신-devfdd-통합전체9-경합-완료-checkpoint) 뒤 최종 독립 문서/staged QA·commit/push·exact CI·보호 dev 병합을 마친다. #318 → #330 → #332 및 #336·#378·#376 후속과 실제 Supabase-only 백업/복원·v0.9.0 운영 gate를 생략하지 않는다.

> 2026-10-05 최신 순서: #382/#323을 PR335/source `c15ebd6`·exact CI37254484170 두 required PASS·독립 QA 후 dev `fdd8d7d`에 보호 squash했다. #329의 정상 checkpoint `4da53b0`에 이 dev를 재통합하며 양쪽 계약·테스트·Python codegen 검사를 유지한다. 새 전체9 경합과 실제 템플릿 검사는 이전 세 경합의 PASS와 별개로 실행한다. #329 검증·QA·CI·보호 dev 병합 뒤 #318 → #330 → #332와 정적 검사 보완을 통합한다. #336 후속 신고와 #378 실제 실행기 개발은 별도 병행하고, 모든 개발 뒤 실제 Supabase-only 백업/복원·v0.9.0 릴리스·운영 검증을 진행한다. v0.8.0·운영·프런트 변경은 현재 없다.

> 2026-10-05 #329 최신104 통합 후보: 실제 fresh104/27 upgrades/SQL82·5,119/static/KST145 PASS, 첫9경합은 limited standalone cleanup 누락 때문에8번째 fresh 조건 FAIL(named/마지막verify NOT RUN). 기존 harness/TTL/SQL를 보존한 cleanup 보완 후 fresh104→limited7/cleanup→photo-context7/cleanup→named7/cleanup→최종fresh104 exit0, Node1,727/73·Edge483/0·Python95·비작성자 source QA0·원본307/사본307 drift0까지 확인했다. 첫 실패·raw strict FAIL9/exact9 catalog3 PASS를 구분하고 후속3개를 새 전체9 aggregate PASS로 표시하지 않는다. [정확한 실행 checkpoint](./LIMITED_SESSION_REENTRY.md)를 따른다. 최종 staged/doc QA·최신 devfdd8d7d(#382) 정상 재통합·새 exact-head CI·dev 병합이 이어지며 현재 main/v0.8.0/운영/프런트는 불변이다. 실제 Supabase-only 백업/복원은 개발 이후·운영 배포 전 필수다.

> 2026-10-05 #329/#389의 bb4fa40 통합 후보는 Node1,525/70·실제 LF fresh103/전체SQL81·4,942/100→101 upgrade/제한 세션 경합7/최종103 cleanup PASS, 원본304·사본304 drift0까지 완료했다. 원본 strict FAIL9와 exact9/catalog3 gate PASS를 구분한다. #389는 승인된 두 후속 signature만 정확히 검사하는 fixture이며 원본 installer·권한을 변경하지 않는다. 실제 후속7/18→7/19와 최신 dev의 #383/#388/#382 재통합·최종27 upgrades·QA·새 CI·dev 승격은 후속이다. 기존 v0.8.0은 보존하고 최신 기능은 #387 v0.9.0으로 준비한다. 운영/백업/복원/프런트 UAT 완료는 아니다. [현재 실행 checkpoint](./LIMITED_SESSION_REENTRY.md)를 따른다.

> 2026-10-05 #329 병렬 통합 후보: 별도 managed worktree에서 기존 PR #372/source `8941039`와 `dev@bb4fa40`(#384 source/dev 통합)을 정상 merge한다. A안의 기존 세션만 허용하는 정책과 원본 migration/LF SHA·snapshot6/fresh18/core2·TTL/CAS/receipt를 보존한다. #329 upgrade·#373 exact9/static upgrade·#384 concurrency를 모두 품질 명령에 유지하며 raw strict FAIL9를 PASS로 숨기지 않는다. #383/#382 최신 dev 통합 뒤 정상 재통합·fresh/전체 DB·독립 QA·새 exact-head CI가 필수다. 현재 source/dev·운영 완료를 선언하지 않으며 기존 PR372의 CI와 아래 과거 strict17/101 checkpoint는 새 통합 PASS가 아니다. 이후 #318 → #330 → #332 순서와 실제 백업/복원의 모든 개발 후속·운영 배포 전 필수 경계를 유지한다. #336 reporter 정책·운영 Auth 설정·PIN·송금·프런트 변경은 포함하지 않는다.

## 과거 2026-10-03 진행 결정: 릴리스 준비와 #329 개발 분리

사용자는 운영 백업·보안 DB 연결 준비 동안 #329의 별도 개발 병행을 승인했다.
`release/v0.8.0@5408c54e032273cdf300d90b91ebda38c9587a7c`는 고정하며 #329를 섞지 않는다.
#329는 `dev@e9fcc564dfb4acd2cc4e175df7d1421dbb6b07e5` 기준 별도 작업 브랜치에서 구현·검증한다.
#367/PR369·#368/PR370은 dev 통합 완료이나 실제 운영 진단·Pages readback은 후속 gate다.
#364의 운영 배포 gate를 유지하며 #329 뒤 후속 bounded context는 #317이다.
#364 CI37127623239는 application PASS / migration FAIL이며 PR366 Draft를 유지한다.
알림 delivery fixture drain의 정적 보완점은 별도 #371로 분리했다. 실제 CI 잔여 수치는 없어 발생 원인을 단정하지 않는다.
이번 병행 승인은 #329의 main/release/운영 승격이나 프런트 수정 승인이 아니다.
아래 릴리스 완료 후 #329 순차 진행 문구는 이 병행 결정 전 checkpoint다.
[제한 세션 재진입 계약과 실제 검증 상태](./LIMITED_SESSION_REENTRY.md)를 따른다.

2026-10-04 #329 재개 checkpoint: 새 repair cycle에서 Edge allowlist와 strict 신규6경고를 보완했다.
새 SHA의 Node1275·Edge477·Python95·LF fresh101/핵심SQL307·후보 합성복구는 PASS다.
원본100 SQL은 보존했고 strict 신규0/기존 #363의17개 FAIL은 구분한다. 기존 예약 이동 fixture의
첫 전체SQL FAIL·단독109PASS 이력을 보존한다. 새 SHA의 전체upgrade27·SQL79/4774·KST145·
경합7·추가 역할별 실행 거부4건은 실제 PASS이고 독립 소스 QA의 새 확정 P0/P1/P2=0이다.
사용자 승인에 따라 기존 strict17 FAIL을 명시한 진단용 commit·push·Draft PR으로 exact-head CI를 확인한다.
CI·dev 통합·운영·프런트 UAT는 미완료이며 이전 SHA 결과나 로컬 PASS를 운영 완료로 승격하지 않는다.
다음 순서는 #329 Draft CI·후속 gate 확인이며 #317이나 운영 승격으로 건너뛰지 않는다.


## 과거 2026-10-05 #382 source 검증 checkpoint
> 2026-10-05 릴리스 결정: 기존 `release/v0.8.0`/PR #366 범위는 동결 보존하고, 최신 기능은 [#387 v0.9.0](https://github.com/wrongstory/room-management-system-backend/issues/387)의 별도 release→main에서 운영 승격한다. #384/PR386 → #383/PR385 → #388/PR390은 각각 독립 software QA와 exact required CI 두 항목 PASS 뒤 보호 squash로 dev에 통합됐다. 현재 dev는 `12097563f30d694780c279440c79f12742672d04`이고 운영 반영은 없다. #382/#323의 #388 재통합103 후보는 Node1664/71·Edge479/0·Python95/client6순열·fresh·실제6순열/receipt/CAS/16 malformed·SQL81/4979·static/KST145·全8경합/최종cleanup PASS/exit0다. 原305 SHA·LF197/원문108 drift0, strictFAIL9와 승인 exact9/catalog3PASS를 구분한다. 전체26 upgrades는 같은 SQL·manifest의 이전 c2b5618 후보에서 실제 PASS였으며 새 후보의 로컬 재실행은 NOT RUN이다. 최종 tree QA·새 exact-head CI와 보호 dev 병합은 후속이다. [현재 실제 검증 checkpoint](./ARCHITECTURE.md#323-v9-게시-명세-정합화)와 아래 과거 이력을 구분한다. 실제 백업/복원과 #378 유한·원자 실행기 완료 전에는 운영 migration/API를 적용하지 않는다.

> 2026-10-05 #382 병렬 source 후보: 사용자가 템플릿 배열 순서 불필요를 명시해 #323/PR #335의 선행 정책 결정을 해소했다. canonical 역할/order 객체 값은 유지하고 입력의6개 배열 순열만 허용한다. #383/c2b5618 정상 통합103 후보의 Node1631/Edge479/Python95/client6순열·fresh DB·실제6순열/receipt/CAS/16 malformed·전체26 upgrades/SQL81파일·4,979 및fresh cleanup은 실제PASS/exit0다. 原305 SHA/197LF+108원문 drift0, strictFAIL9/exit1와 exact9/catalog3 gatePASS를 구분한다. fullDB 로그 SHA `ec783912a90824904348a3dd0d16fb8beaa5d10e8629fe0c7983a548ace7fce6`를 보존한다. source QA가 승인한 기존 tree에서 문서의 실제 checkpoint만 갱신했다. 이후 #388은 PR390/exactCI37249916811 두requiredSUCCESS/독립QA0 뒤 dev1209756에 보호squash했다. 이를 정상 재통합한 새 tree·전체경합·최종 독립 QA·새 exact-head required CI는 후속 gate다. 기존 PR335나 parent의PASS를 새exacthead검증으로 대체하지 않는다. 이번기능의migration·manifest·권한·기존snapshot·운영은변경하지 않는다.

## 과거 2026-10-05 자동 운영 승격·정책 checkpoint

사용자가 운영 배포까지 자동 진행을 승인했다. 기존 v0.8.0 후보는 유지하고 최신 기능은 별도
v0.9.0 [릴리스 #387](https://github.com/wrongstory/room-management-system-backend/issues/387)로 준비한다.
#382는 입력 템플릿 배열 순서 제한 제거로 확정됐으며 종류·수량·중복·snapshot 검증은 유지한다.
#336은 제출·승인 후 신고 허용이 확정됐고 신고 주체 등 최종 matrix는 별도 확인한다.

#384는 exact source ae99532/tree643eacb의 CI37237806986 두 required checks 및 최종 독립 QA
신규 P0/P1/P2=0을 확인하고 PR386으로 dev bb4fa40에 보호 squash했다. source/dev tree는 같다.
이것은 운영 배포가 아니다. #383은 이 dev를 정상 merge하고 named 동시 예약·purge/보상·worker
회귀를 보강하는 후보이다. combined103 fresh·저장 이름 SQL177·실제 예약 경합7 및 cleanup,
Node1,591·Edge476·Python95·독립 범위 QA(신규 P0/P1/P2=0)는 PASS다. 전체26 upgrades/SQL81파일·
4,979 및 static/KST145도 PASS다. 전체8경합 첫 실행은 기존 offline fixture의 요청 전 만료로
FAIL이며 후속7 aggregate 명령은 그 실행에서 NOT RUN이다. 같은 source의 fresh103 cleanup 후
1회 제한 재실행은 전체8명령/cleanup PASS·exit0다. 원본302 raw SHA/실제 임시본 대응 불일치0,
최종103/head·RLS누락0·객실121·합성 Auth/session/profile/target/photo operation/name0을 확인했다.
최초 FAIL을 보존하며 준비시간/clock 개선은 별도 #388이다. 새 exact-head CI·최종 독립 QA·Ready·dev 병합은 후속 gate다.
다음은 테스트-only #388 기한 fixture 보완 → #382/#323 → #329 → #318 → #330 → #332 → #336 → 최종 release 검증이다.
백업 개발·보안 입력 재시도·실제 Supabase 복사/복원은 전체 backend 개발 이후 후속이며 운영
배포 전 필수다. 로컬 운영 backup 파일을 요구하지 않으며 승인된 recovery 격리·복원/FK 검증·
성공 후 recovery-only 최소15일 Pause 조건을 유지한다.

## 과거 2026-10-05 진행과 사용자 결정 checkpoint

#322는 PR333의 source/dev 통합이 완료됐고, #323은 [Draft PR335](https://github.com/wrongstory/room-management-system-backend/pull/335)의
source `9d17e5d68b0551148547e124c89788db61c7a9fb`에서 required application/migration CI37225838146가 모두 PASS다.
다만 #382 입력 배열 순열의 Fastify/Edge/schema 차이는 별도 P2 OPEN이며 #323 전체 종료·Ready·병합을 선언하지 않는다.

#383은 사용자 요청에 따라 새 canonical v9 사진의 실제 저장 이름을 날짜·유형·호실·고유 순번으로 예약하는
[Draft PR385](https://github.com/wrongstory/room-management-system-backend/pull/385)다. 구현 source `0c87076283990751a1afaec0642966752f0acb75`는
정상 push됐고 로컬 기능/DB/기존 경합 회귀와 독립 범위 QA98/100·신규 P0/P1/P2=0이다.
최초 통합 `db:test` FAIL과 보완 후 별도 whole SQL PASS, raw strict FAIL9와 승인 exact baseline PASS,
named 단독 purge/race 및 실제 Drive/운영 미실행은 [저장 이름 계약](./PHOTO_STORAGE_NAMES.md)을 따른다.
문서 추가 등 head가 바뀌면 새 exact-head CI를 별도로 추적하며 이전 head PASS로 대체하지 않는다.
이 기능은 기존 사진/이미 예약된 UUID 이름을 바꾸거나 입력 순열 명세를 대체하지 않는다.

다음 순서는 #383 CI·미실행 범위 확인 → **#384 다중 사진 provider-context P1 별도 수정·검증** →
#382/#323 종료 기준 정리 → 기존 후속 **#329 → #318 → #330 → #332**다.
#384의 합성 재현9/9는 결함 확인 성공이지 기능 정상 통과가 아니며, 해결 전 사진 기능 운영 승격을 차단한다.
프런트는 프런트 담당 범위이고, 기능·dev 통합·운영 배포·사용자 UAT 완료를 구별한다.

사용자 최신 결정대로 실제 Supabase 백업·복원·비밀번호 입력은 모든 백엔드 개발 이후 후속이다.
단 **운영 배포 전 백업·복원 검증은 필수**이며 생략하지 않는다. 이번 변경에서는 운영/복구 DB·Auth·PIN·API/Edge·
Cron/provider·실제 Drive·frontend·Release/tag·실제 백업/복원을 변경하지 않았다.
아래 개발 순서·중간 백업·Draft/통합 상태는 작성 당시의 snapshot이며 현재 순서와 경계는 이 절이 우선한다.

### 과거 #384 구현 후보 checkpoint
> 2026-10-05 현재 순서: #383 실제 저장 이름은 Draft PR #385/head `6884ec7`의 application·migration CI `37230502851` PASS이며 미병합이다. #384의 두 번째 사진 provider context 충돌은 dev `859f7cd`에서 별도102 append로 보완했다. 첫 syntax/기대 오류 분류 실패를 보완한 뒤 Node1,437·Edge474·Python95·fresh102·26 upgrades/SQL4,802·static/KST145·기존6+신규1 전체경합/cleanup·local 합성복원·warn 이상 advisors0·원본299 SHA 보존 PASS다. 독립 소프트웨어 QA PASS·신규 P0/P1/P2=0이며 새 exact-head CI, 최종 source/dev 승인·보호된 통합은 후속 gate다. 이후 #329 기존 PR #372의 최신 dev 통합·재검증 → #318 → #330 → #332 순서를 유지한다. [실제 검증과 남은 gate](./PHOTO_COLLECTION_PROVIDER_CONTEXT.md)를 따른다. 프런트 소스·운영 DB/API·복구 DB·실제 Drive·실제 백업·릴리스/태그는 변경하지 않는다. 실제 백업/복원은 모든 개발 이후 후속, 운영 배포 전 필수다. 아래 예전 순서/백업 선행/Draft 표현은 해당 시점의 기록이며 현재 완료로 승격하지 않는다.

> 2026-10-04 최신 승인: 사용자가 #374 → #375의 dev 통합을 승인했다. #363/#373 PR #374는 source `8edc9fb1`의 required CI `37165344729` application/migration PASS·독립 QA98/100·미해결 P0/P1/P2=0을 확인하고 dev에 squash `a103db80d4e849db64b79211cff2de96a00a7193`로 병합했다. source/dev tree `4384747a650026c2359c309897f015441b49fb92`는 같다. 경고8개 보완 및 호환9개 exact baseline gate는 통합됐지만 원본 strict는 FAIL9/exit1을 유지한다. [계약과 과거 실행 기록](./DB_STATIC_WARNING_BASELINE.md)을 따른다. 아래 strict17/Draft/미병합 표현은 과거 checkpoint다.

> [#371 알림 fixture drain](./NOTIFICATION_DELIVERY_FIXTURE_DRAIN.md) PR #375의 기존 source `6177eb93`/100 migrations는 required CI `37168729600` application/migration PASS·독립 QA98이었다. 위 dev/101 통합본의 실제 local Node1,432·Edge470·Python95·fresh101·26 upgrades/SQL4,718·exact9 gate/static upgrade·KST145·6경합/cleanup·독립 QA98도 PASS다. 최종 drain93회/현재 처리 가능 잔여0이며 원본294개 raw SHA를 보존했다. 새 exact-head CI와 dev 병합은 commit 이후 후속 gate이며 최신 판정·source/dev mapping은 PR #375/#371에 기록한다. 기존100 PASS를 새101 통합본이나 동결 release PR #366의 PASS로 대체하지 않는다. #329 Draft PR #372·release/main·운영 DB/API·태그는 이번 dev 통합 승인 범위에서 변경하지 않는다. 아래 과거 checkpoint를 운영 완료로 해석하지 않는다.

> 2026-10-03 최신 승인: 사용자가 순차 개발과 중간 릴리스·운영 배포·문서 정리를 승인했다. #331은 PR361의 source087407b → dev squash eb1ec3e로 통합됐다. exact-head CI37111364892 application/migration(전체 upgrade·SQL·KST·경합·cleanup) PASS, 독립 QA98/100·범위 내 미해결 P0/P1/P2=0이다. 아래 #331 후보/Draft·진단용 승인만이라는 문구는 과거 checkpoint다. 기존 strict lint17/INFO inventory FAIL은 #363, 단발 CAS 원인 추적은 #362로 유지한다.

> 중간 점검 릴리스는 [#364](https://github.com/wrongstory/room-management-system-backend/issues/364)의 v0.8.0 후보다. #329의 기존 로그인 계약과 운영 배포에 선행하는 공용 세션 `not_after` 검사 #352를 별도 PR로 먼저 보완한다. 현재 dev에 완료된 기능과 #352만 첫 릴리스에 포함하며, #329 → #317은 그 이후 순차 구현한다. release/main 필수 검증·독립 QA·CI·protected 병합 후에만 승인된 pending DB → exact API 및 reservation-scheduler를 배포하고 smoke·문서·태그를 확인한다. 프런트 source, Node fallback 활성화, Auth 설정, 키, 실제 PIN/송금, provider/Cron/TASK는 변경하지 않는다. 실제 배포 완료나 사용자 UAT 통과를 선행 기록하지 않는다.

> 2026-10-03 현재: #327은 [PR #357](https://github.com/wrongstory/room-management-system-backend/pull/357)의 source `22cbf0be9ed2c5e228e6c5091059c2052a61adce` → dev squash `b6f799811416fad6f80dba3d721ba279159c0aa8`로 완료했다. source/dev/CI merge tree 동일, required CI `37086130779` application/migration PASS·독립 QA98/100이다. 아래 #327 후보·#328 Draft 문구는 과거 checkpoint다. #325는 이 dev/96 migrations에서 최신 주급 조정 원장 CAS 조회를 추가하는 별도 후보다. [조회 계약과 검증 상태](./PAYROLL_ADJUSTMENT_BOOK.md)를 따르며, 운영·프런트 제공 완료를 뜻하지 않는다.

> 2026-10-03 현재: #328은 [PR #351](https://github.com/wrongstory/room-management-system-backend/pull/351)의 source `76e2780c0304a7336433cdd17e585610360785e3` → dev squash `3968e42967c8ad223661b7a3eb4ce200aabd2499`로 완료했다. 두 tree와 CI merge tree가 같고 required CI `37027527827` application/migration PASS·독립 QA98/100이다. 아래 Draft·후속 gate 표현은 과거 checkpoint다. #327은 이 dev/95 migrations에서 관리자 open 사건 목록을 구현 중인 후보이며 현재 source OpenAPI 목표는 132 paths·142 operations다. 신규 96번째 migration과 검증·운영 제외 범위는 [관리자 미퇴실 목록 계약](./CHECKOUT_INCIDENT_ADMIN_LIST.md)을 따른다. production/main/recovery·프런트 UI/UAT 완료를 뜻하지 않는다.

> #328 최신 gate(2026-10-03): 세션 만료·KST fixture 보완 후 local 개별 검증은 PASS다(Node859·Edge323·Python95·같은 migration SHA의21 upgrades·전체SQL4161·KST145·전체동시성·fresh95·advisors0·합성복구). 초기 전체 `db:test` FAIL과 원래 CI `37017832732`의 migration FAIL은 이력으로 보존한다. 최종 독립 QA·새 exact-head CI·dev 통합은 후속 gate이며 [PR #351](https://github.com/wrongstory/room-management-system-backend/pull/351)은 아직 Draft다. [상세 실행 기록](./ASSIGNMENT_SCHEDULE_SNAPSHOT.md#보완-후-local-개별-최종-검증)을 따른다.

2026-09-23에 정한 개발 진행 원칙과 이후 source 승인 근거를 기록한다. 사용자는 기능 구현·배포와 직접 화면 확인을 우선하고,
보안·대규모 검증 보강은 기능 흐름 확인 뒤 묶어서 진행하기로 했다. 다만 migration 불변성, 비밀값·PII·PIN
비노출, required CI, 승인 없는 production 변경 금지처럼 되돌리기 어렵거나 운영 데이터를 위험하게 만드는
gate는 기능 우선순위와 무관하게 유지한다.

## 2026-10-03 다음 기능 순서

#327/#325/#324는 각각 PR357/358/359로 dev 통합 완료했다. 다음 bounded context 순서는
#331 송금 표시 → #329 제한 계정 재진입 → #317이다.
현재 #331만 구현하며 사용자 최종 선택에 따라 표시·별도 재확인 이력을 분리한다.
기존 주급 명령·원장·집계/실제 지급 정책을 바꾸지 않는다.
current/past KST 주차 조회와 source의 실제 maid 귀속은 유지한다.
정본·호환성·최종 gate는 [#331 표시 계약](./PAYROLL_REMITTANCE_MARKER.md)을 따른다.
선행 dev는8481e21/98 migrations·134 paths/144 operations이며 현재 후보는
99 migrations·137 paths/148 operations다. 이는 운영 배포나
프런트 완료를 뜻하지 않으며 다른 OPEN PR의 충돌·검증·정책을 임의 해결하지 않는다.

## 역할과 진행 단위

- Codex: 정본·Issue·원격 head 확인, 작업 분할, 통합 검증, 점수 평가, 진행 현황 정리.
- 구현 서브에이전트: 하나의 bounded context 안에서 파일 소유권을 나누어 구현·회귀 작성.
- 독립 QA 서브에이전트: 본인이 구현하지 않은 최종 diff의 정책·권한·동시성·노출 경계 검토.
- 외부 GPT 리뷰가 있으면 exact-head 근거를 보존한다. COMMENTED를 APPROVED로 표현하지 않는다.

작업 순서: 정본 확인 → feature 분기 → 구현/테스트 → Codex 통합 검증 → 독립 QA →
exact-head CI → 평가·승인 기록 → 허용된 경우 dev squash 병합 → tree/head/Issue 상태 확인.
GitHub 보호 규칙을 우회하지 않으며, 구현·검증·승인·병합·운영 배포는 각각 별도 상태다.

## 평가와 중단 조건

| 평가 영역 | 배점 | 확인 근거 |
|---|---:|---|
| 승인 요구사항·범위 | 25 | 정본/Issue와 구현 및 제외 범위 대응 |
| 보안·무결성 | 30 | 역할·session·ownership·CAS·멱등성·RLS·비밀값 격리 |
| 실제 검증 | 25 | fresh DB/동시성/Edge/application/Python/CI 결과 |
| 운영·문서 인계 | 20 | API/OpenAPI/생성 client/상태표/제한/배포 경계 |

**90점 이상**일 때만 Codex가 source/dev 승인을 내릴 수 있다. 다음은 점수와 무관한 필수 gate다.

- in-scope P0/P1 0건, 승인된 요구사항 범위, 독립 QA 완료.
- exact-head `application`/`migration` 및 해당 변경의 필수 검증 PASS.
- 미해결 blocking review thread 없음, 충돌 없음, 기존 migration/history 보존.
- head가 바뀌면 변경 범위 재검토, 검증/CI 및 독립 QA 갱신 후 다시 평가.
- 저장소 보호 규칙 충족. 관리자 bypass/force push/auto-merge로 대기 gate 우회 금지.

90점 미만 또는 필수 gate가 막히면 안전한 상태로 작업을 정리하고 리뷰·남은 blocker를 남긴 뒤
사용자에게 승인을 요청한다. FAIL/BLOCKED/NOT RUN을 PASS로 적거나 점수로 상쇄하지 않는다.
범위 밖 기존 결함은 별도 Issue와 영향/배포 제한을 공개하며 현재 PR의 P0/P1와 구분한다.

## 변경 금지 영역

별도 명시적 허가 전에는 production/recovery DB·migration·secret·Edge·Cron/Vault·Pages,
main/release 승격, tag/GitHub Release를 변경하지 않는다. feature/dev source를 직접 배포하지 않는다.
기존 원격 migration 수정·history rewrite, 보호 규칙 완화, secret/PII/PIN 기록은 금지다.

## 2026-10-02 #328 진행 기준

- 현재 선행 dev는 #326 PR #350이 통합된 `f34dca3746a1e553a773470aba13b55fa95bf816`/94 migrations다.
  source `2eb489c`와 dev squash의 동일 tree, required CI `36987938462` application/migration PASS,
  독립 QA98/100으로 #326 source/dev 완료를 확인했다. 아래 후보/PENDING/FAIL 기록은 당시 이력이다.
- 다음 기능 순서는 #328(배정 일정 snapshot·현재 actual 분리) → #327(사건 목록)이다.
  #328의 95번째 migration/카드 DTO는 로컬 검증 완료 후보다. Node 859·Edge 323·Python 95·
  SQL 4,152·21 upgrade·KST 145·전체 동시성·fresh 95·advisors 0건·합성 백업 복구 PASS다.
  최종 독립 QA·exact-head CI·dev 통합은 연결 Issue/PR에서 확인하며 #326 결과를 재사용하지 않는다.
- 독립 QA round 1의 P1 role race는 adapter 초기 role과 RPC 최신 role을 `p_expected_actor_role`로
  묶어 기존 403으로 닫는 보완을 구현했다. 당시 exact-source 재검증·최종 QA는 PENDING이었으며,
  이후 local 전면 PASS와 최종 QA/CI 후속 gate를 구분한다.
  과거 1차 quality 857 PASS, Edge 321 PASS/1 FAIL, fresh 95 sourceDrift CRLF FAIL과 당시 보완/
  미재실행 상태는 [일정 계약의 실제 실행 이력](./ASSIGNMENT_SCHEDULE_SNAPSHOT.md)에 보존한다.
  후속 Node 859·Edge 323/bundle 17,240,776 bytes·Python 95/전체 Ruff/mypy/codegen/build check,
  CRLF 보완 fresh 95·전용 94→95 upgrade·targeted 4 SQL files/339 tests는 실제 PASS지만
  마지막 raw-column grant 보완 전 실행이다. 이후 추가 역할별 거부와 최종 전면 재검증도 위와 같이
  PASS했다. 이 절은 PR 생성 전 검증 시점 기록이다. 최종 QA 점수·exact-head CI·dev squash/Issue 종료는
  [Issue #328](https://github.com/wrongstory/room-management-system-backend/issues/328)의 연결 PR을 따른다.
- scheduleSnapshot은 생성 계획·최초 통보의 실제 사실을 보존한다. 현재 목록에만 exact current
  notified source의 currentDeparture를 별도로 제공하며 history/includeHistory는 항상 null이다.
  legacy backfill·현재 예약 재수화·기본 시각 추측·Preview/command 응답 확대는 하지 않는다.
- 업무 authority/RLS는 유지하되 두 저장 테이블의 authenticated SELECT를 pre95 컬럼별로
  좁혀 신규 JSONB 원문·내부 binding의 Data API 직접 조회를 차단한다. 기존 명시 컬럼/count/join·
  service_role table grant는 유지하고 `SELECT *`/whole-row는 의도적으로 `42501`이다.
- Fastify/Edge/OpenAPI·생성 client·문서는 함께 검증하며 [일정 계약](./ASSIGNMENT_SCHEDULE_SNAPSHOT.md)의
  실제 검증 gate를 따른다. scoped 프런트 main/dev 확인은 전역 제품 snapshot 업그레이드가 아니다.
  production/main/recovery·프런트 개발·PIN·UAT·tag는 변경하지 않는다.

## 과거 2026-10-02 #326 source 진행 기준 — PR #350 병합 전 검증 이력

- 현재 선행 통합 기준은 `dev@f72c43d4ac9d8b5abc4e700dd38392cc01ba804a`다.
  #348 수동 요청 취소 B안·PIN 제한 제거가 source/dev에 통합된 93 migrations 기준이며
  OpenAPI 131 paths·141 operations / catalog 59 family·42 category는 유지한다.
- #305는 PR #347의 exact-head CI `36960375990` application/migration PASS·독립 QA98·dev 통합 뒤 CLOSED다.
  근거와 보존할 제한은 [#305 종료 감사](./WORK_DEADLINE_CLOSURE.md)를 따른다.
- #348 통합 전 재개 검증은 전용 SQL 147·Edge 312·Node 715·Python console 95 tests,
  19 upgrades·전체 SQL 3,931·KST145·전체 경합·복구 PASS였다. 당시 두 full-command FAIL 이력도
  보존한다. 이 결과를 신규 #326 검증으로 재사용하지 않는다. 선행 취소 정책·통합 근거와 제한은
  [수동 요청 취소 계약](./MANUAL_CLEANING_CANCEL.md)을 따른다.
- 다음 기능 순서는 #326(snapshot·등록 근거·취소 capability 조회) → #328(메이드 일정 projection)
  → #327(사건 목록)이다. 사용자의 B안 및 PIN 제한 전부 제거 결정을 #326 조회에도 그대로 따른다.
  #326은 기존 endpoint·ID/CAS를 유지하는 94번째 migration/DTO 구현 후보이며 source write·
  과거 receipt 재수화·snapshot backfill·신규 자동 취소 정책을 넣지 않는다.
  최신 local PASS는 fresh 94 reset 재실행·focused Node 156/Deno 34/typecheck/lint·QA 2차 후
  `ci:quality` 795 tests/55 files(secrets/lint/typecheck/build/OpenAPI 12 포함)·Edge 318 tests /
  bundle 17,204,763 bytes·Python console 95/full Ruff·mypy·codegen·build다.
  5 manifests·candidate backup 94·DB lint exit 0도 PASS다. 기존 10 functions warning은 유지하고
  #326 추가 경고는 없으며 local public base 49개/RLS 누락 0개다. 이전 중간 PASS 수치와 첫
  focused 기대 객체 7건·ReturnType lint 1건·Edge format FAIL/재검증 PASS는 계약 문서에 보존한다.
  독립 QA 1차 P2는 raw snapshot 빈/비문자 key의 SQL null 대 TS 500 불일치이며 raw normalizer와
  fresh strict pack parser 분리 및 SQL Preview classifier 보완으로 정적 resolved다. 최종 QA는
  아직 PENDING이며 조회 계약은 raw optional key unknown null,
  malformed fresh pack safe 500을 구분한다. legacy elevator A/B fallback 제거는 routing 입력
  변경이므로 새 metadata fingerprint 제외와 별개로 재Preview가 필요하다.
  upgrade 1·2차 FAIL은 1일 fixture가 기존 deferred `AVAILABILITY_WEEK_REQUIRES_SEVEN_DAYS` /
  `23514` 제약을 위반한 원인이다. 제약을 유지한 정상 7일 fixture로 upgrade 3차는 실제 PASS했고
  cleanup fresh 94도 PASS다. 전용 SQL 135는 `SET CONSTRAINTS ALL IMMEDIATE` 추가 후 PASS다.
  QA 2차 P2는 기존 카드/DB/OpenAPI에 없는 표시 metadata 100자 상한이었으며 임의 상한 제거·
  1,001자 이름 회귀 후 정적 resolved(P0/P1/미해결 코드 P2=0)다. 기존 optimizer routing `str(100)`와
  fresh pack reject는 유지한다. 위 최신 quality/Edge/focused는 QA 2차 보완 후보의 실제 실행이다.
  전체 `npm run db:test` exit 0, 명시 20 upgrades 및 72 SQL files/4,068 tests PASS이며 실제
  request/신규 receipt 긴 이름·보존 및 전용 SQL 137을 포함한다. 전용 SQL 135는 이전 별도 실행,
  137은 full suite 결과로 구분한다. KST 5 clocks×29=145 PASS도 확인했다.
  전체 실제 concurrency 및 cleanup fresh 94, local advisor 결과 0건/exit 0도 PASS다.
  clean source commit 이후 exact-source backup·exact-head CI·최종 독립 QA·PR/dev 통합 근거는
  연결 Issue/PR에서 확인하는 PENDING gate다. 이 문서와 승인 source가 dev 정본에 포함되고 연결 Issue/PR의
  exact-head CI/QA 승인·실제 dev 통합 근거를 확인해야 source/dev 완료 효력이 발생한다.
  현재 이미 병합/Issue 종료됐다는 주장이나 운영 승격 승인은 아니다.
  [조회 metadata 계약](./ASSIGNMENT_TARGET_READ_METADATA.md)에 실제 결과를 단계별 기록한다.
  프런트 scoped main/dev 대조는 인계 근거일 뿐 전역 제품 snapshot 갱신이나 프런트 개발/UAT가 아니다.
- `main@1780728a02144c0816565ba091e43a8b3e126c4f`는 이번 작업에서 변경하지 않는다.
  production/recovery DB·Edge·Cron/provider·프런트·tag/UAT는 별도 승인·검증 범위다.
- #13/#300/#320/#341/#342/#344/#345는 부모 #305 종료와 별도로 OPEN 추적한다.
  과거 CI FAIL은 재검증 PASS로 지우지 않는다. #300의 검사 기준 변경에는 별도 결정·보안 검토가 필요하다.

## 2026-09-23 진행 snapshot (과거 기록)

아래 head·runtime·입력값은 당시 기록이다. 현재 운영 재검증이나 새 배포 권한을 뜻하지 않는다.

- 운영 Git 정본은 `main@10a1f814649e92260e9e7353ab242400311b429e`이고 최신 기능 통합 지점은 `dev@2ce8953c76fbf5cb33aff9f8a57b303acbf05cdb`다. 개발 정본은 #171까지 81 migrations / OpenAPI 0.5.1 129 paths / 139 operations이고 #172는 82번째 feature 후보다. production runtime은 78 migrations / OpenAPI 0.5.1 128 paths / 138 operations이다. Pages parity와 기존 관리자 `guestCount` UAT는 완료됐지만 #256 사진 정규화와 #250/#264 배정 후속의 운영 승격은 남아 있다.
- Web Push는 사용자 실제 기기 수신을 확인했다. 내부 health와 secret 상태는 별도 안전 projection으로 확인한다.
- Google human owner는 `yeosucastletheart@gmail.com`으로 정했고, 서버는 별도 최소 권한 service account를 사용한다. 실제 target/credential/Cron 활성화는 별도 운영 gate다.
- 원 maid가 퇴사·부상 등으로 수행 불가한 일반 청소는 현재 배정을 취소하고 같은 target을 미배정으로 돌린다. 검수 반려 재청소는 기존 0원 target을 이력으로 종료하고 원 유상 snapshot의 별도 ordinary replacement target을 만든다. 관리자 알림과 backend API는 #264로 source/dev 완료됐고 프런트 연결·운영 승격은 후속이다. 별도 보상 원장은 만들지 않는다.
- DB 논리 백업은 매일 01:00~06:00 KST, 15일 보관으로 확정했다. 정확한 시각과 추후 지정할 PC 로컬 경로는 아직 입력값이다.
- `v0.3.0`은 소급 tag/Release를 만들지 않으며, `v0.5.1` tag/GitHub Release도 별도 승인 전까지 발행하지 않는다.

새 작업은 사용자가 확인할 실제 기능과 API 연결을 먼저 작은 PR로 닫고, 검증·보안 후속을 숨기지 않고 Issue로 남긴다. 정책 미확정이나 외부 자격증명·저장 경로는 추측하지 않는다.
