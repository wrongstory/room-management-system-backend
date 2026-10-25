# #415 배정 조회의 다음 병목과 합성 비용 기준선

2026-10-25 통합: #453/#455는 운영 반영됐다. 아래 수치는 2026-10-13 dev f57132f의 합성 CPU 기록이며 제품 코드 추가 변경을 뜻하지 않는다.
운영 배포·DB 실행·실제 사용자 계측을 수행한 문서가 아니다.

## 오프라인 재현

`npx tsx scripts/benchmark-assignment-rollover.ts`

DB/네트워크/환경 비밀정보 없이 합성 데이터만 사용한다. 기준은 #453 이전의
전체 이력 filter/sort, 후보는 현재 대상별 index+단일 순회다. 후보의 index 생성도
측정에 포함한다. 각 입력에서 결과 전체 동등성을 먼저 검사하고 warmup5회,
21회 측정으로 p50/p95를 출력한다. 테스트에는 시간 임계값을 넣지 않는다.

로컬 Windows/Node22.20.0에서 1회 실행 결과(ms):

| 카드 / 대상별 이력 | 전체 이력 | 기존 p50/p95 | 후보 p50/p95 |
| --- | --- | --- | --- |
| 1 / 1 | 1 | 0.000 / 0.004 | 0.001 / 0.003 |
| 100 / 10 | 1000 | 0.840 / 1.041 | 0.097 / 0.116 |
| 1000 / 10 | 10000 | 40.329 / 42.994 | 0.143 / 0.257 |
| 동일 대상의 과거 카드1000 / 이력1000 | 1000 | 8.941 / 9.449 | 2.322 / 2.422 |

독립 QA에서 최초 비교용 배열 includes가 실제 이전 Set.has와 다름을 지적했다.
module-level Set.has로 일치시킨 후 위 수치로 전부 재측정했다. 최초 수치는 사용하지 않는다.

작은 입력은 index 비용/타이머 오차로 개선되지 않을 수 있다. 각 방법을 별도로
워밍업한 단일 프로세스 결과이며 실행순서/JIT/GC/장비 영향이 있다. 이 수치를
전체 API·화면 속도 개선률로 일반화하지 않는다. DB·인증·통신·전체 DTO 투영은 제외됐다.
동일 대상 다중 revision의 반복 순회는 남지만 먼저 실제 DB 시간을 확인한다.

## #415 bounded hydration source 후보 — 2026-10-25

`get_assignment_card_hydration`이 target/profile/모든 attempt/latest attempt의 submission/
rollover 이력 다섯 조회를 assignment ID 최대100개당 한 RPC로 묶는다. 신규 migration124
`20261025020616_assignment_card_hydration.sql`은 함수와 좁은 EXECUTE만 추가한다.
기존 테이블·RLS·원장·notification catalog·migration1..123을 수정하지 않는다.

| exact-date 합성 카드 수 | 이전 DB HTTP 요청 | source 후보 요청 |
| --- | --- | --- |
| 1 | 7 | 3 |
| 100 | 7 | 3 |
| 1000 | 52 | 21 |

같은 메이드, target/attempt 각1개, submission1개 fixture에서 실제 Node adapter가
호출한 interface 수를 검사한 값이다. 인증 공통 경로·네트워크·DB 내부 SQL 시간·프런트
렌더링은 제외한다. 오늘/내일 backlog는 목록 요청1개를 더 사용한다. RPC 내부 SQL문 수가
이만큼 줄거나 전체 API가 이 비율로 빨라졌다는 뜻이 아니다. 실제 p50/p95는 미측정이다.

- initial RPC는 기존 `get_assignment_schedule_read_for_plan(..., false, expectedRole)`를
  재사용하여 최신 actor/status/password/session, exact IDs 및 실제 통보된 maid ownership을 확인한다.
  intermediate hydration에는 현재 퇴실 사실이나 raw 예약 schedule snapshot을 포함하지 않는다.
- 모든 hydration이 끝난 다음 기존 final schedule RPC를 마지막에 별도로 실행한다.
  그 시점의 live actor/session/ownership 검사, history의 currentDeparture=null,
  계획일·불변 통보 snapshot·최신 권한 실패의 전체 응답 거부를 그대로 유지한다.
- 읽기 RPC는 STABLE/empty search_path/security definer이며 service_role만 EXECUTE한다.
  새 browser 접근권·command capability는 없다. 미리 조회한 값으로 최종 검사를 대체하지 않는다.
- 각 관계의1000행 cap과 exact count를 유지한다. SQL LIMIT1001은 초과 탐지 sentinel이며
  초과 결과는 예외로 거부한다. 모든 attempt의 started_at을 보존하여 취소 가능 표시를 계산한다.
- 정확한 assignment→target/maid binding, 누락·중복·다른 ID·알 수 없는 count를 거부한다.
  여러 batch에 걸친 shared target/profile/history는 같은 내용만 중복 제거하고 내용이 바뀌면
  전체 실패한다. 원래 distinct target100개당 이력1000행 cap도 합친 결과에서 재확인한다.
- 공개 DTO/endpoint/Swagger,1000카드 목록 완전성,실제 통보 이력과 제한 계정 경계는 유지한다.
  불완전한 새 RPC를 예전 조회로 자동 fallback하거나 일부 카드만 성공시키지 않는다.

### 실행·배포 경계

개발의 application·manifest·SQL source/합성 검증과 실제 SQL 실행은 별개다.
전체 DB·pgTAP·실제 역할/세션 경합·upgrade·운영 적용·실사용 성능은 NOT RUN이다.
신규 RPC가 존재하는 DB를 먼저 승인 범위에서 적용한 뒤 API를 배포해야 한다. 이전 API는
새 DB에서도 그대로 작동하며 rollback은 이전 API로 가능하다. 새 API를 구 DB에 먼저
배포하면 RPC 부재로 실패하므로 금지한다. 기존 RPC는 제거하지 않는다.
최종 release의 실제 DB 실행·migration/reset/rebuild 전에 별도 승인을 받는다.
#415는 최종 DB/운영 계측이 끝나기 전 OPEN으로 유지한다.

## 프런트 인계

#453/#455는 운영 반영됐다. 이 벤치 통합은 endpoint/Swagger/호출 방식을 변경하지 않는다.
현재 화면 지연이 해소됐다고 안내하지 않는다. 운영 반영 이후 동일화면·동일데이터·동일망에서
Server-Timing/API전체/브라우저 렌더링 시간을 분리 비교한다. 새 RPC는 내부 service-only 후보이며 프런트가 직접 호출하지 않는다.

## 2026-10-25 최신 dev 통합 재검증

PR456 원본을 dev f107c2e와 통합한 source에서 Node22.20.0, warmup5/21회 재측정했다.
1000카드/10000이력 CPU p50/p95는 이전41.268/41.791ms, 현재0.150/0.272ms였다.
전체 애플리케이션 테스트133파일3270개 PASS. 제품 RPC/SQL 변경·실제 DB·운영 계측은 NOT RUN이다.
동일 대상 과거카드1000은 이전9.113/9.553ms, 현재2.397/2.486ms이며 운영 지연을 뜻하지 않는다.

## 신규 RPC 후보 검증 — 2026-10-25

- `npm run ci:quality`: PASS, Node134파일3286개·typecheck/build·OpenAPI·비밀검사.
- `npm run edge:check`: PASS, 전체 Deno/실행 번들·API source parity 검증. Report candidate bundle19,875,768bytes, backup monitor91,678bytes.
- `npm run db:manifest:verify`: PASS, dev124이며1..123 hash 불변. 실제 DB를 실행한 결과가 아니다.
- 독립 source QA와 관련 adapter/protocol 회귀 PASS. 오류 count·scope·역할/세션 변경은 전체 응답을 거부한다.
- 초기 Edge HTTP fixture의 신규 RPC 미지원과 타입/lint 오류는 보완 후 전체 재검증했다. 실패한 중간 실행을 PASS로 집계하지 않는다.
- 실제 SQL/pgTAP·업그레이드·역할/DB 경합·운영 적용·실사용 성능: NOT RUN.
