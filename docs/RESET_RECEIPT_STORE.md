# 초기화 실행 관측의 영속 저장 (#396)

`reset-receipt-store.ts`와 append135는 기존 순수 `reset-receipt.ts`의 header/event를
서버 내부 Supabase RPC로 저장·재조회한다. 초기화 단계 실행기나 공개 HTTP API는 아니다.
`CONFIRMED`는 원장 저장·조회 응답의 정합성만 뜻하며 `executionEnabled`와
`retryExecutionAllowed`는 항상 false다. 실제 DB 적용·Auth 호출·삭제는 수행하지 않았다.

## 저장 계약

- `private.developer_reset_receipt_heads`: actor/project/key digest 유일성, 불변 binding/header,
  최신 version/head hash. profile/Auth FK를 만들지 않아 별도 승인된 업무 정리에도 기록을 유지한다.
- `private.developer_reset_receipt_events`: head FK와 `(receipt_id, sequence)` PK를 갖는 append-only event.
  overwrite/delete/truncate trigger와 직접 table 권한 차단으로 일반 역할의 변경을 거부한다.
- `public.store_developer_reset_receipt`: service_role만 호출하는 고정 CREATE/READ/APPEND RPC.
  CREATE 충돌은 기존 원장 조회만 하며 다른 header/binding으로 같은 key를 재사용할 수 없다.
  APPEND는 head row lock, exact expected version/head, 단일 신규 event, 상태 전이 검증,
  head CAS, 실제 저장 행 readback을 같은 transaction에서 수행한다.

RPC는 READ COMMITTED에서 현재 유일 developer의 profile/Auth/session/password gate를 전후 확인한다.
원 session은 RPC 인수로만 전달하며 저장하지 않는다. 원장에는 UUID, 고정 enum, 정수 시각,
원문 payload 없이 결합 hash만 허용하고 추가 필드·원문 payload를 거부한다.
password version은 비밀번호의 hash가 아닌 기존 비밀 아닌 version을 domain-separated digest로 묶는다.
관측 시간·단계 100개·event 1,000개·입력 크기를 제한한다. lock 2초, PostgREST RPC statement 7초와
내부 5초 관측 경계를 사용한다. function-level statement_timeout의 직접 SQL 호출 효력은
PostgREST 사전 설정과 같다고 가정하지 않는다. 실제 runtime/SQL 검증은 최종 승인 실행의 범위다.

## adapter와 응답 유실

생성자는 신뢰하는 서버 RPC transport, 정확한 HTTPS `<projectRef>.supabase.co`, 검증된 actor/Auth/session,
명시한 1~7,000ms 관측 budget을 받는다. 자동으로 키·정책·승인·만료 시각을 만들지 않는다.
하나의 adapter 인스턴스는 한 receipt key에만 결합되고 동시 RPC는 하나로 제한된다.
다른 key는 새 인스턴스를 써야 하며, 인스턴스의 anchor map은 한 항목을 넘지 않는다.
호출별 `create(command, now)`, `read(command, anchor, now)`,
`append(command, receipt, event, {anchor, now})`는 기존 순수 모델 입력을 사용한다.

반환된 header/전체 event chain/최신 durable head를 대조하고, 이미 알고 있는 별도 anchor의
version/hash보다 뒤로 돌아간 정상 prefix도 거부한다. 재시작한 composition은 마지막 확인 anchor를
별도로 유지하여 READ에 전달해야 한다. anchor 없이 새 instance에서 잘린 정상 prefix를 받는 경우,
DB head와 event를 함께 되돌리는 관리자/복원 작업까지 검출하는 외부 witness는 제공하지 않는다.

timeout/abort/통신 오류/불일치 응답은 UNKNOWN이다. Abort는 원격 rollback이나 실행 종료의 증거가 아니다.
자동 재호출은 없고 해당 인스턴스의 이후 쓰기는 막힌다. 명시 READ가 실패한 쓰기의 **정확한 제안 prefix**를
실제로 관측해야 latch가 풀린다. 쓰기보다 먼저 읽힌 이전 snapshot이나 NOT FOUND는 늦은 commit을 배제하지
못하므로 해제 근거가 아니다. DB CAS 충돌 후에는 임의 새 key로 실행하지 않으며 검토·재관측이 필요하다.
동시 READ/APPEND는 원격 호출 없이 UNKNOWN을 반환해 응답 순서 역전으로 최신 anchor가 낮아지지 않는다.

## 신뢰 경계와 보존 분류

RPC의 권한은 서비스 자격과 최신 DB identity에 의존한다. 서비스 자격이 유출된 공격자나 DB owner에 대한
방어, 사람의 실제 승인 인증, 관측 evidence의 원격 효과 실재성은 보장하지 않는다. 주어진 hash와
`remoteQuiescent`는 검토된 서버 관측 입력이어야 하며 저장 성공 자체가 그 내용을 증명하지 않는다.
운영 control이 있으면 project target도 대조한다. control 미설치 시 DB 자체가 hosted project identity를
독립 확인하는 값이 없으므로 서버의 검증된 연결/URL이 신뢰 경계다. 이 저장기가 control을 설치하지 않는다.

새 두 관계는 명시 보존 후보로만 추가해 inventory 189→191, preserve 7→9가 된다.
기존 127/128 migration은 변경하지 않는다. `reset-row-impact-baseline127.json`에 127의 생성 입력을 고정하고,
현재 분류의 disposition/rowImpact 함수와 새 fingerprint는 135에서만 교체한다. 129의 combined collector가
inventory/rowImpact/gateEvidence/templateEvidence를 같은 snapshot에서 반환하는 계약과 전후 Auth wrapper는 유지한다.
다른 business/사진/Auth 분류나 삭제 범위를 바꾸지 않으며 이후 관계 추가도 새 append source로 처리한다.

## 검증 경계

Node fake RPC는 CAS 경쟁, 손상/잘린 readback, 같은 key 충돌, timeout과 늦은 commit, 자동 재호출 금지,
응답 역전 차단, 유한 instance 수명, strict target 및 현재 preview 분류 연동을 검증한다.
PG15/17 parser와 생성물 검사는 SQL 구문/소스 검사다. rollback-only pgTAP에는 권한, 실제 head/event CAS,
불변 trigger, revoked session, JS hash golden 교차 검사를 준비한다. 실제 SQL·DB 경합·Auth·provider·삭제·배포는
NOT RUN이며 migration 검증 완료 또는 운영 초기화 완료로 보고하지 않는다.

2026-10-25 source 검증: 최신 dev5d4166e 통합 뒤 `npm run ci:quality` 182파일/4,973 tests,
`npm run edge:check` 65/560/68 tests, manifest135, PG15/17 AST, 생성물 정합성 PASS.
report bundle 19,898,760B와 API 19,233,059B는 기존 크기 한도 안이다. 독립 QA 60 tests PASS 뒤
같은 key 동시 호출의 응답 역전/유한 인스턴스 경계를 확인했고 현재 차단 finding은 없다.
첫 SQL 생성 검사에서 replacement의 `$$` 손상 FAIL을 고쳤고, 첫 전체 검사에서는 새 관계 수와
허용 migration tail의 이전 fixture 기대값 2건 FAIL을 정정한 후 위 전체 검사를 통과했다.
이 이력은 실제 SQL 실행 성공 증거가 아니다.
