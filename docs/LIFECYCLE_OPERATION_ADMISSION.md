# #396 청소 lifecycle 완료 원장 연결 (source137)

기존 `manageAttemptLifecycle` 경로는 일반 OPAQUE admission을 남기므로 실제 DB 명령이
끝나도 자동 terminal 관측이 없었다. source137은 기존 공개 action 세 가지에만 정확한
완료 원장을 연결한다. 상태 변경 기능이나 허용 action, 계정 권한은 변경하지 않는다.

| 기존 action | 기존 immutable command |
|---|---|
| `allow_finish` | `cleaning.lifecycle.allow_finish` |
| `allow_upload` | `cleaning.lifecycle.allow_upload` |
| `interrupt_handover` | `cleaning.lifecycle.interrupt_handover` |

원래 public RPC는 `manage_cleaning_attempt_lifecycle`이고 최외곽 완료는
`private.complete_command(actor, command, key, hash, entity, result)`다. source의
20261001001449 후속은 `expire_scheduled`를 제거했으며 이번에도 지원하지 않는다.
20261003140716의 최신 세션 검사와 원래 업무 capability/CAS/감사/알림은 그대로 사용한다.

## 유한 시작·완료 경계

99-route 정본 중 이 한 행에만 `completionAdapter=LIFECYCLE_V137`를 붙인다. 역사 source130의
`hashMode=NONE` 행과 SQL 생성 결과는 바이트 그대로 유지하며 tag는 source137 경로를 뜻한다.
현재 분류는 기존 receipt65 + lifecycle1 + 순수read6 + atomic1 + 나머지OPAQUE26이다.
tag가 없는 미배포 구 런타임은 계속 OPAQUE로 차단되며 전체 coverage를 주장하지 않는다.

HTTP helper는 실제 service RPC 바로 전에 actor/session/action/key/hash를 확인해 고정
`acquire_operation_lifecycle_admission`을 호출한다. body를 다시 hash하거나 caller가
command 이름을 고르도록 하지 않는다. 비동기 acquire 사이 결합값이 바뀌면 업무 호출을
시작하지 않으며 새로 얻은 lease도 임의 완료하지 않는다. lazy SDK 호출은 한 번만 실행한다.

새 SQL adapter는 기존130의 고정 `manageAttemptLifecycle` acquire를 호출하고 **같은 transaction**에서
선택한 command와 key digest/hash를 새 admission에 결합한다. control lock의 maintenance/version
직렬화와 actor/Auth/session/password/nonce/deadline 결합을 재사용하고, 원래 admin의 최신
세션 권한을 전후 확인한다. raw key·업무 payload는 저장하지 않는다. 새 table·column·정책 seed는 없다.

완료는 기존130 `complete_operation_http_admission`의 현재 actor/session/password/nonce와
정확한 immutable actor/command/key digest/hash/완료시각 조회로만 판단한다. 다른 action,
다른 hash 또는 미완료/없는 원장은 성공 근거가 아니다. 기존의 정상 NULL entity 및 멱등 replay
원장은 그대로 허용한다. HTTP 오류 뒤에도 정확 readback을 시도할 수 있지만 원래 오류를
성공으로 바꾸지 않는다. 응답 유실 뒤 정확한 terminal을 확인하지 못하거나 관측 기한이 지나면
UNKNOWN이며 effect 재시도나 만료 자동 release는 없다. 이미 시작한 명령의 정확 완료는
유지보수 요청 후에도 확인할 수 있다.

## 배포·검증 경계

새 함수는 PUBLIC/anon/authenticated EXECUTE를 회수하고 기존 신뢰 경계의 service_role에만 준다.
원래 업무 RPC의 권한을 대신하지 않고 악성 owner/service 방어를 주장하지 않는다. 기존 opt-in을
자동 활성화하지 않는다. 활성 런타임보다 source137이 먼저 적용되어야 하며 미적용 RPC 오류는
effect 전에 차단된다. 구 런타임/다른 인스턴스·Auth/provider·직접 DB 접근의 종료는 별도 증거다.

합성 Node/실제 Edge handler 대역 검사와 PG15/17 구문 검사, 준비된 rollback-only pgTAP source로
인수·순서·악성 action·중간 drift·응답 유실·기한·잘못된 terminal을 검사한다. 이는 실제 DB 결과가 아니다.
DB/SQL/pgTAP/Auth/provider/운영 활성화·초기화는 **NOT RUN**이다. 사진 삭제 HOLD 및
`coverage=NOT_INTEGRATED`, 전체 초기화 실행 비활성은 유지한다. 기존130 바이트와 기존135
분류를 재작성하지 않는다. 최종 DB 검사에서는 같은 최종 source bundle의 전체 migration과 함께 검증한다.

## 이번 source 검증 기록

- source136이 포함된 `c8d76e2` 통합 후 전체 `npm run ci:quality`: 199개 파일,
  5,379개 테스트와 typecheck/build PASS. 공식 `npm run edge:check` 전체 PASS이며
  실제 Edge handler의 세 action 대역 회귀를 포함한다.
- 관련 네 파일 172개 테스트 및 독립 검토자의 같은 172개 테스트 PASS, 최종 코드·문서 검토 차단 사항 없음.
- dev manifest137 검증과 역사 source130 생성물 일치 검사 PASS. PG15/17 AST 검사는
  실제 SQL 실행 없이 새 migration과 준비된 pgTAP의 구문만 확인했다.
- 통합 직후 관련 검사에서 미래 count 거부 fixture가 새 지원값137을 사용해 한 번 실패했다.
  거부 fixture를 미지원138로 바로잡고 관련 64개 테스트 및 위 전체 검증을 다시 통과했다.
- 실제 DB 동시성·권한·원장 효과와 pgTAP는 NOT RUN이며 위 결과로 검증 완료를 주장하지 않는다.
