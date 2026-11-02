# 초기화 전용 실행 관측 원장 모델 (#396)

`reset-receipt.ts`는 초기화 실행기의 입력 결합·재시도·부분 실패를 검증하는 내부 순수 모델이다.
DB migration 실행 receipt와 구분하며 실제 삭제, DB/Auth/provider 호출, 공개 API, 정책 선택을 하지 않는다.
모든 공개 요약의 `executionEnabled`와 `retryExecutionAllowed`는 false다.

## 고정 입력과 재시도

서버가 검토한 actor/Auth user/session/password-version, project/source/catalog/content/plan,
예상 사후 상태, 정책·정확한 승인 범위·검증 백업의 지문을 하나의 명령에 결합한다.
실제 원문 비밀번호·토큰·개인정보·삭제 행은 입력으로 받지 않는다. 원장에는 actor ID 대신
결합 hash, idempotency key digest, 명시한 생성/만료 시각과 순서가 고정된 단계만 담는다.
만료 시각의 기본값이 없으며 운영 TTL을 임의로 선택하지 않는다.

같은 key와 정확히 같은 명령은 기존 관측 결과만 재조회한다. actor, 세션, password version,
프로젝트, 소스, 내용, 정책, 승인, 백업, 단계 순서 또는 만료 시각을 바꾸면 같은 receipt를
재사용할 수 없다. 새 key나 새 receipt를 만들었다는 사실도 새 실행 승인이 되지 않는다.

## 상태 전이

`PREPARED → RUNNING → VERIFIED`는 **전달된 관측의 정합성**을 나타낸다. 순서상 다음 단계만
STARTED를 기록할 수 있고, 이전 단계가 확정 APPLIED일 때만 다음 단계로 이동할 수 있다.
HTTP 성공이나 시간 만료는 APPLIED 근거로 받지 않는다. 시작한 단계의 UNKNOWN은 이후 독립적인
readback 근거로 APPLIED 또는 NOT_APPLIED를 기록할 수 있지만, 같은 효과를 다시 시작할 수 없다.

NOT_APPLIED는 해당 단계의 확정 실패이며 후속 단계 실행을 열지 않는다. 이미 적용된 앞 단계가
있으면 `partialEffects=true`를 유지한다. 실패나 불확실성을 초기 상태로 되돌리는 전이는 없다.
실행 중 deadline을 넘으면 UNKNOWN이며, 시작되지 않은 남은 단계는 만료 후 시작할 수 없다.
만료 후에도 기존 효과의 읽기 관측과 최종 검증 기록은 가능하다. 이것은 실행 재개가 아니다.

모든 단계의 APPLIED만으로 최종 VERIFIED가 되지 않는다. 계획에 고정된 사후 상태 지문과
외부 작업 종료를 확인한 별도의 최종 readback 근거가 필요하다. 원장 결과는 검증된 입력을
해석할 뿐 실제 운영 초기화 완료를 자체적으로 선언하지 않는다.

## 지속성과 신뢰 경계

추가는 원본 배열을 변경하지 않고 새 sequence/이전 event hash/관측 시각을 결합한다.
수정된 header, 중간 event 누락·순서 변경·변조, 미래/역행 시각, stale expectedVersion을 거부한다.
100단계·1,000event로 제한하고 외부 요약에는 합계·상태·고정 오류만 반환한다.

이 hash chain은 사람 승인 서명, 악성 DB owner 방어 또는 영속 append-only 원장이 아니다.
마지막 event들을 잘라낸 정상 prefix만으로는 suffix rollback을 검출할 수 없다. 실제 저장 adapter가
별도 신뢰된 최신 head hash/version, actor/project별 key 유일성, transaction CAS와 append-only 권한을
강제해야 한다. 전달된 prefix의 valid는 전체 최신 이력을 읽었다는 뜻이 아니다.
입력 지문과 readback Boolean도 클라이언트 자기 신고가 아니라 검증된 서버 adapter에서 와야 한다.
전체 hash를 다시 만드는 공격자를 이 순수 모델이 인증하지 않는다.

관측 evidence의 실재성, 최신 developer 권한·재인증·운영 잠금, 실제 유지보수 drain과 모든 외부 효과,
일회 승인 연결, 대상별 복구·최종 보존 검증을 연결하기 전에는 실행할 수 없다. snapshot builder의
일회용 내용 지문을 지속적인 승인 재검증 토큰으로 오용하지 않으며 별도 검증된 비교 계약이 필요하다.
삭제 순서·템플릿 상태·사진 HOLD·보호 방식과 TTL은 이 모델이 선택하지 않는다.

## 검증

합성 테스트로 전체 전이, 정확 입력 재조회, 13개 결합 필드의 변경, 부분 적용 후 실패,
응답 유실/UNKNOWN, 만료 후 관측, stale version, header/event 변조, 사후 상태와 외부 종료 검증을 확인한다.
실제 DB CAS/SQL/Auth/provider/삭제/복구·운영 인계 검증은 NOT RUN이다.

135의 [영속 저장 adapter](./RESET_RECEIPT_STORE.md)가 별도 private head/events와 서버 전용 RPC로
CAS·append-only·정확 readback을 구현한다. 위 순수 API는 유지하며 실제 DB 검증은 여전히 NOT RUN이다.

[승인 기록의 일회 소비](./RESET_APPROVAL_CONSUMPTION.md)는 별도 서버 내부 공통부다.
owner 승인 기록의 exact 명령 결합과 exclusive 소비만 제공하며 STARTED 기록이나 소비 성공 자체가
승인·백업·drain 실재성 또는 실행 권한을 증명하지 않는다. 실제 승인 파일 소비는 NOT RUN이다.
