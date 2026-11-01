# v1.0.0 최종 DB 검증 계획 — 객실 고정 메모 포함

## 상태와 확정 범위 (2026-11-02)

사용자 결정: “#396은 진단·안전장치만 v1.0.0에 포함하고 실제 초기화는 운영사 인계 전
후속 작업으로 미뤄.” 기존 R1/T1/S1/A는 유지하며 실제 초기화 기능을 완료로 표시하지 않는다.
이 문서는 실행 계획이며 **격리 DB 실행 승인·Full DB PASS·운영 적용 승인이 아니다.**
단일 실행 승인 기록은 담당 채팅의 `USER_DECISIONS.md`로 유지한다.
2026-11-02 사용자가 #551 객실 고정 메모도 검토·병합 후 이번 배포에 포함하도록 선택했다.
이는 DB 실행 승인이 아니다. #548을 포함했던 이전143개 계획은 대체하고 최신 통합 입력으로 다시 동결한다.

그 뒤 정확한 FINAL-144-R1 승인을 받아 PR553/run41344850134 attempt1을 실행했다. 설치·checkpoint와
application은 통과했지만 catalog harness가 실패해 후속 SQL·경합·proof는 실행되지 않았다.
Supabase stop은 성공했고 Docker volume은 보존됐으며 전체 잔여 자원0을 주장하지 않는다.
이 승인1회는 소모됐다. 진단 보완 후 새 입력을 동결하고, 기존 PR553의 동기화 push가 만드는
새 격리 run/attempt1을 별도로 승인받는다. 실패 run 재실행·부분 재개·운영 적용 권한은 없다.

이후 승인된 FINAL-144-R2/run41348857034 attempt1은 설치·catalog/HOLD·template을 통과했으나
TLS atomic child 단계에서 FAIL했다. 읽기 전용18검사와 정리 성공은 관측됐고, 내부 atomic case
결과는 미확인이다. 후속 SQL·경합·proof는 미실행이다. R2 승인도 소모됐으며 다음 보완 입력은
새 정확 승인 전 실행하지 않는다. 과거 성공 단계만으로 변경된 최종 입력의 proof를 만들지 않는다.

| 이번 v1에 유지 | 운영사 인계 전 후속 #396 |
| --- | --- |
| 개발자 전용 읽기 미리보기·보존 영향 진단 | 실제 행/필드별 보존·삭제 및 FK/논리 참조 계획 확정 |
| 기존 HTTP/worker/인증·원장 연결부의 호환·권한 검사 | Auth/PIN/외부 객체를 포함한 일회 보호·복구 실증 |
| 공개 초기화 비활성·사진 삭제 HOLD | 25개 OPAQUE와 기존 세션/직접 접근을 포함한 전체 작업 종료 |
| 기존 SQL·RLS·원자성·동시 요청 회귀 전체 | 재인증·유지보수·승인→실행·재시도/실패 복구·템플릿 인계·화면 |

OPAQUE는 초기화 전 종료 증거가 부족한 경로이며 일반 기능25개의 고장을 뜻하지 않는다.
예약 전용 자동 백업과 감시는 유지하며 재설치하지 않는다. 전체 초기화의 복구 증거로 사용하지 않는다.
운영 시작 잠금·유지보수·admission 모드를 자동으로 설정하지 않는다. 실제 배포 설정을 확인한다.

## 현재 계획 기준 입력

- 개발 통합 출발점은 #548/PR550의 dev `bdfb2d612d6310583750c9ab55c927bbd508e067`이다.
- #551/PR552의 객실 고정 메모와 실제 동시 요청 검사 준비를 더한 source144가 이번 범위다.
  마지막 migration은 `20261101131722_room_fixed_memo.sql`이며 기존143개 원문을 보존한다.
- 전체 SQL 회귀 파일116개와 기존 upgrade/경합 검사에 신규 고정 메모 검사를 결합한다.
  #532 READY 정정, #534 배정별 메모와10경합, #535/#543 인증 보완, #548 입실 projection을 유지한다.
- main `d3ecff164d99eba8837d14d302ca213e4be17353`의 인증 수정 내용·이력을 최종 후보에 보존한다.
- 보호된 dev 병합·로컬 release 통합 후 정확한 source/tree/dev/main과 비서술 입력 개수·공식 지문을
  단일 USER_DECISIONS.md와 불변 입력 목록에 기록한다. 이 문서의 개발 출발점을 최종 실행 SHA로 쓰지 않는다.

Markdown 서술은 기존 gate 입력에서 제외되지만 이번 catalog harness/회귀 검사 보완은
검증 입력을 변경한다. 통합 뒤 최종 candidate SHA·tree·원격 dev/main 조상·manifest/SQL/입력 지문을 재대조해
실행 승인안에 기록한다. 실제 PR의 GitHub merge SHA 지문도 같아야 한다. 변경·차이·오류를
예상값으로 덮지 않는다. 과거141/142/143개 계획, 사전검증 시도, hotfix124 성공은 이 입력의 proof가 아니다.

## 격리 CI 최종1회 계획 (승인 전 NOT RUN)

대상은 `release/v1.0.0 → main`의 GitHub Actions `quality`가 만드는 임시 격리 DB다.
운영/복구 Supabase와 연결하지 않는다. release PR 생성·push·재실행은 사전 승인 경계다.
현재는 기존 PR553의 정확한 동기화 push가 새 전체 DB 검증을 유발한다. 그 전에 최종 SHA·입력·대상·
아래 재구축/fixture/정리 범위를 명시해 **새1회 승인**을 받는다. 입력이 달라지면 다시 승인받는다.

1. 실제 PR 입력 지문과 workflow/gate를 고정하고 기존 required application/migration을 유지한다.
2. manifest 검사 후 기존 Supabase 시작·source122 fresh reset·hash-only checkpoint·정확한
   최신 tip까지 적용한다. prefix122는 검증 기준이지 현재 운영 설치 상태라는 가정이 아니다.
3. 같은 run/attempt/source의 전체 catalog에서 #551 미분류 원장의 정확한 구조와 전체 read-plan/보호 계획의
   명시적 차단을 확인한다. 별도 지문으로 묶은 기존 분류 범위에서 read-plan과 합성 사진 HOLD 부모 보호
   6개 검사를 유지한다. 예상 밖 관계·누락·경계를 넘는 FK는 실패하며 메모 원장의 삭제·보존 정책은 정하지 않는다.
   전체와 파생 검사 범위를 구분하고 합성 행을 실제 업무 데이터·전체 초기화·복구 증거로 표시하지 않는다.
4. 템플릿 계약, 고정 PostgreSQL TLS/원자 fixture, 정확한 lint baseline, 합성 백업 dry-run을 수행한다.
   atomic8개는 각각 다른 합성 project와 정확한 SAN을 사용해 운영의 중복 실행/실패 후 보류 가드를
   그대로 검증한다. 실제 연결은 같은 owned tmpfs fixture의 loopback 포트로 한정한다. child 실패 시
   제한된 JSON의 고정 case ID·상태·개수만 진단하고 원문 오류·SQL·비밀값을 노출하지 않는다.
   실패·누락·잘못된 보고서는 계속 실패이며 기존8개 검사·자원수·명령·상한을 줄이거나 늘리지 않는다.
5. 기존 전체 upgrade·pgTAP/SQL/RLS, static warning upgrade, KST clock, 동시 요청 검사를 수행한다.
   #534 메모의 저장/생략/명시 초기화/승계/권한/이력과10경합, #532 실제 상태 정정,
   #543 Auth 효과/세션/원장, #548 실제 입실 표시·준비 사유 회귀 및 #396 공개 실행 차단·기존 업무 호환을 포함한다.
   #551 객실 고정 메모의 저장·비우기·관리자/통보된 현재 메이드 권한·과거 revision 보존과
   독립 연결의 동시 CAS·같은 키 재전송/내용 충돌·잠금 대기 중 세션 무효화도 검사한다.
6. 성공/실패와 무관한 기존 cleanup을 수행한다. 전체 단계·정리·hash-only oracle 업로드까지
   성공한 migration job의 `Full DB proof <fingerprint>`만 성공 근거로 인정한다.

“1회”는 최종 workflow run/attempt1회를 뜻한다. 내부의 기존 fresh/upgrade/격리 fixture와
여러 reset·자원 정리를 포함하며 SQL 한 번이나 reset 한 번이라는 의미가 아니다.
현재 정상 성공 경로는 reset79회(122 checkpoint1 + upgrade61 + static2 + concurrency15),
28개 upgrade 프로그램·12개 경합 진입점을 포함한다. 최초 설치와 합성 복구 DB1개,
TLS fixture1개도 범위에 들어간다. #551 경합은 기존 reservation fixture 구간을 재사용하며 reset을 추가하지 않는다.
실패 시 정리는 별도 결과로 확인하며 강제 취소 후 정리가 끝났다고 추정하지 않는다.
workflow의 application20분/migration40분 상한과 검사 항목을 바꾸지 않는다. 자동 재실행하지 않는다.
실패·취소·UNKNOWN·입력 변경이면 증거를 보존하고 원인/수정을 정리한 뒤 재실행 전에 다시 승인받는다.

개발 PR의 migration PASS는 source/manifest 검사다. `Full DB NOT RUN`과 구분한다.
main 병합 뒤에는 동일 PR·동일 입력 성공 proof를 확인하며 전체 DB를 다시 구축하지 않는다.

## 운영 적용은 별도 승인

1. 실제 운영 history의 version/name/내용과 H1 기준·허용된 차이를 읽기 전용 대조한다.
   과거 source122/metadata 결과를 최신 사실로 쓰지 않고 #543 별도 운영 복구와 중복하지 않는다.
2. 정확한 pending 파일·순서·해시·영향·중단/재개 조건을 확정해 적용 직전에 별도 승인받는다.
   source144나 manifest baseline 차이를 운영 pending 개수로 사용하지 않는다.
3. required CI·독립 QA·리뷰/대화·보호 규칙을 충족한 main에 대해 승인된 pending만 적용한다.
   이력이 예상과 다르거나 적용 결과가 UNKNOWN이면 중단한다. history repair·자동 전체 db push 금지.
4. 호환 API/필요 worker·Swagger 배포와 안전 smoke, 프런트 인계/UAT를 별도 기록한다.
   이후 배포 범위가 실제 확인될 때만 해당 이슈/릴리스 완료를 판단한다.

실제 초기화, Auth/계정 삭제, 저장 PIN 초기화, 템플릿 인계 실행, Drive 삭제, 전체 복구 시험,
운영 시작 잠금/유지보수 전환은 이 계획의 실행 범위가 아니다. #396을 닫지 않는다.
최종 DB 검증 계획 승인과 운영 migration 승인은 실제 초기화 실행 승인으로 전용할 수 없다.

Refs #396, #431, #532, #534, #543, #548, #551.
