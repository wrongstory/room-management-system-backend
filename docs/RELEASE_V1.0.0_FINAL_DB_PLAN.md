# v1.0.0 최종 DB 검증 계획 — #396 범위 분리

## 상태와 확정 범위 (2026-11-01)

사용자 결정: “#396은 진단·안전장치만 v1.0.0에 포함하고 실제 초기화는 운영사 인계 전
후속 작업으로 미뤄.” 기존 R1/T1/S1/A는 유지하며 실제 초기화 기능을 완료로 표시하지 않는다.
이 문서는 실행 계획이며 **격리 DB 실행 승인·Full DB PASS·운영 적용 승인이 아니다.**
단일 실행 승인 기록은 담당 채팅의 `USER_DECISIONS.md`로 유지한다.

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

- dev: `206c298d3889384e7835c02a5a85d93b5e60f175`.
- 로컬 release 후보: `6f562f89ad498a27827f2f47cfcb5b699132219b` (`release/v1.0.0`).
- 위 두 source의 tree: `245d290674e01d5f53d763c7c8de3633662a341a`.
- 포함된 main: `d3ecff164d99eba8837d14d302ca213e4be17353` (#543/PR545).
- 기존 gate로 계산한 DB 입력 지문:
  `b88c2a712c27214118b7d73422ab20d00f44e8aba2fd106db219eeb547709c07`.
- 비서술 검증 입력1259개, migration source142, SQL 회귀 파일114. source head는 `password_effect_completion`.
  마지막 파일은 `20261030183754_password_effect_completion.sql`이며 기존141개를 보존한다.
- #532 READY 정정, #534 메모와10개 경합 준비, #535/#543 인증 보완을 포함한다.
  미통합 #548은 이 입력에 포함되지 않는다. 별도 기능 추가 시 개발·QA·dev 통합 뒤 입력을 다시 동결한다.

이 문서 변경은 Markdown 서술만으로 기존 gate의 입력에서 제외되지만 source/tree SHA는 달라진다.
문서 통합 뒤 최종 candidate SHA·tree·원격 dev/main 조상·manifest/SQL/입력 지문을 재대조해
실행 승인안에 기록한다. 실제 PR의 GitHub merge SHA 지문도 같아야 한다. 변경·차이·오류를
예상값으로 덮지 않는다. 과거 FINAL-141-R3, 사전검증 시도, hotfix124 성공은 이 입력의 proof가 아니다.

## 격리 CI 최종1회 계획 (승인 전 NOT RUN)

대상은 `release/v1.0.0 → main`의 GitHub Actions `quality`가 만드는 임시 격리 DB다.
운영/복구 Supabase와 연결하지 않는다. release 첫 push/PR이 전체 DB를 유발하므로 실행 전에
최종 SHA·입력·대상·아래 재구축/fixture/정리 범위를 명시해 **1회 승인**을 받는다.

1. 실제 PR 입력 지문과 workflow/gate를 고정하고 기존 required application/migration을 유지한다.
2. manifest 검사 후 기존 Supabase 시작·source122 fresh reset·hash-only checkpoint·정확한
   최신 tip까지 적용한다. prefix122는 검증 기준이지 현재 운영 설치 상태라는 가정이 아니다.
3. 같은 run/attempt/source의 실제 catalog로 read-plan과 메모리 합성 사진 HOLD 부모 보호를 검사한다.
   합성 행을 실제 업무 데이터·전체 초기화·복구 증거로 표시하지 않는다.
4. 템플릿 계약, 고정 PostgreSQL TLS/원자 fixture, 정확한 lint baseline, 합성 백업 dry-run을 수행한다.
5. 기존 전체 upgrade·pgTAP/SQL/RLS, static warning upgrade, KST clock, 동시 요청 검사를 수행한다.
   #534 메모의 저장/생략/명시 초기화/승계/권한/이력과10경합, #532 실제 상태 정정,
   #543 Auth 효과/세션/원장 회귀 및 #396 공개 실행 차단·기존 업무 호환을 포함한다.
6. 성공/실패와 무관한 기존 cleanup을 수행한다. 전체 단계·정리·hash-only oracle 업로드까지
   성공한 migration job의 `Full DB proof <fingerprint>`만 성공 근거로 인정한다.

“1회”는 최종 workflow run/attempt1회를 뜻한다. 내부의 기존 fresh/upgrade/격리 fixture와
여러 reset·자원 정리를 포함하며 SQL 한 번이나 reset 한 번이라는 의미가 아니다.
현재 정상 성공 경로는 reset79회(122 checkpoint1 + upgrade61 + static2 + concurrency15),
28개 upgrade 프로그램·12개 경합 진입점을 포함한다. 최초 설치와 합성 복구 DB1개,
TLS fixture1개도 범위에 들어간다. #543 통합으로 reset 호출을 추가하지 않았다.
실패 시 정리는 별도 결과로 확인하며 강제 취소 후 정리가 끝났다고 추정하지 않는다.
workflow의 application20분/migration40분 상한과 검사 항목을 바꾸지 않는다. 자동 재실행하지 않는다.
실패·취소·UNKNOWN·입력 변경이면 증거를 보존하고 원인/수정을 정리한 뒤 재실행 전에 다시 승인받는다.

개발 PR의 migration PASS는 source/manifest 검사다. `Full DB NOT RUN`과 구분한다.
main 병합 뒤에는 동일 PR·동일 입력 성공 proof를 확인하며 전체 DB를 다시 구축하지 않는다.

## 운영 적용은 별도 승인

1. 실제 운영 history의 version/name/내용과 H1 기준·허용된 차이를 읽기 전용 대조한다.
   과거 source122/metadata 결과를 최신 사실로 쓰지 않고 #543 별도 운영 복구와 중복하지 않는다.
2. 정확한 pending 파일·순서·해시·영향·중단/재개 조건을 확정해 적용 직전에 별도 승인받는다.
   source142나 manifest baseline 차이를 운영 pending 개수로 사용하지 않는다.
3. required CI·독립 QA·리뷰/대화·보호 규칙을 충족한 main에 대해 승인된 pending만 적용한다.
   이력이 예상과 다르거나 적용 결과가 UNKNOWN이면 중단한다. history repair·자동 전체 db push 금지.
4. 호환 API/필요 worker·Swagger 배포와 안전 smoke, 프런트 인계/UAT를 별도 기록한다.
   이후 배포 범위가 실제 확인될 때만 해당 이슈/릴리스 완료를 판단한다.

실제 초기화, Auth/계정 삭제, 저장 PIN 초기화, 템플릿 인계 실행, Drive 삭제, 전체 복구 시험,
운영 시작 잠금/유지보수 전환은 이 계획의 실행 범위가 아니다. #396을 닫지 않는다.
최종 DB 검증 계획 승인과 운영 migration 승인은 실제 초기화 실행 승인으로 전용할 수 없다.

Refs #396, #431, #532, #534, #543.
