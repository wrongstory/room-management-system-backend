# #396 내부 내용 snapshot builder

`src/modules/developer-reset/snapshot-builder.ts`는 실제 collector를 연결할 수 있는 Node 내부
검증 경계다. 공개 API, DB 연결, reset 실행, 복구 또는 정책 선택은 없다. 실제 collector의 구현과
SQL 실행 검증은 별도로 필요하며 이 문서의 합성 검증을 그 성공으로 사용하지 않는다.

## 입력과 신뢰 경계

서버가 검토한 project/source/catalog/classification binding, 관계별 컬럼 이름·PG type·PK,
FK target·NULL/MATCH 형태를 builder 생성 시 복사한다. 수집 결과의 선언을 이 독립 예상 목록과
비교하므로 fingerprint 문자열만 재사용하며 컬럼·FK target·관계 목록을 바꾸는 입력은 거절한다.
이 예상 목록 자체는 catalog-v2 검증 결과에서 얻어야 한다. 클라이언트가 보낸 목록은 증거가 아니다.

`ResetSnapshotSource.collect(signal)`의 실제 adapter는 다음을 동일 DB snapshot에서 수집해야 한다.

- 검토된 schema projection과 실제 일관성 범위 식별자
- 모든 관계의 독립 `COUNT`(빈 관계도 포함), 행별 검토된 keep/remove 후보
- 모든 컬럼의 내용과 모든 PK의 손실 없는 typed text, 실제 FK equality로 해결한 대상 PK
- 앞의 행 배열에서 만든 결과가 아닌 독립 내용 조회 stream

한 STABLE 함수의 동일 calling statement snapshot은 `stable-statement`로 표기한다.
실제 READ ONLY REPEATABLE READ transaction에서 수집한 경우에만 `repeatable-read`를 사용한다.
STABLE 여러 호출을 같은 snapshot으로 합치거나 그 이름만으로 RR 보장을 주장하지 않는다.
source 포트의 식별자는 trusted adapter가 만들며 HTTP body에서 받지 않는다. 현재 builder는
입력의 정합성을 검증할 뿐 실제 DB transaction isolation이나 독립 SQL 실행 여부를 증명하지 않는다.

각 값은 고정된 손실 없는 PG text codec을 사용한다. 숫자·시간·byte 값을 JS number로 바꾸지 않는다.
relation/type/컬럼 이름과 NULL을 포함한 canonical token을 만든다. 서로 다른 SQL 타입의 문자열을
같은 identity로 합치지 않는다. FK는 JS 값 비교로 추정하지 않으며 SQL에서 일치한 target의 PK를
전달한다. 일반 typed 값 검사는 실제 PG parser/encoding/collation 검증을 대신하지 않는다.
Auth의 허용 목록은 `auth.users.id` 하나다. 비밀번호·토큰·credential 컬럼은 거절한다.

## 내용 결합과 수명

한 builder는 한 번만 사용한다. 32-byte 임시 key로 snapshot, typed opaque PK identity,
전체 행 내용을 domain-separated HMAC-SHA256으로 묶는다. key를 입력받거나 재사용하는 기능은 없다.
독립 stream에서도 직접 같은 token을 만든 뒤 건수·키 중복·전체 content fingerprint를 비교한다.
동일 건수 내용 변경과 행 교체를 실패로 처리한다. 기존 reference checker가 보존→제거 참조,
FK 누락과 MATCH/NULL 모순을 검증한다. 분류 미정 행을 임의 keep/remove로 변환하지 않는다.

반환값은 validity, 고정 blocker, aggregate count, 일회 비교 지문과 일관성 종류뿐이다.
원문·PK·row token·key·schema 이름은 반환하거나 로깅하지 않는다. 원래 source 객체를 변경하지 않는다.
임시 key buffer는 성공/실패/취소 후 0으로 덮는다. JavaScript 문자열이나 crypto 내부 복사본의
확정적인 heap 삭제를 보장하지 않으며, 비밀 원문을 source adapter 밖으로 보관하지 않아야 한다.
매번 key가 다르므로 두 build의 지문은 같은 데이터여도 다르다. 이 지문은 승인 recheck token,
bearer capability, 백업/복원 proof 또는 TTL이 아니다.

## 상한과 취소

최대 1,000관계, 10,000행(각 독립 pass), 16MiB 입력 예산, 5초 로컬 deadline이다.
호출자는 이 한계를 낮출 수만 있다. 운영 정책 TTL과는 관계없다. 누락·초과·오류·취소는
부분 성공 없이 `snapshotValid=false`, null fingerprint/counts로 반환한다.
getter·non-plain object·순환·sparse array·추가 필드도 거절한다.

dispose/외부 signal/deadline은 collector signal을 abort하고 기다리던 promise를 종료한다.
stream cleanup은 best effort이며 응답을 무기한 기다리지 않는다. adapter는 signal을 실제 SQL
cancel/connection cleanup으로 전달해야 한다. 무응답 원격 작업의 중단, CPU를 영구 점유하는
악성 callback, 이미 실행된 효과의 취소를 이 builder가 보장하는 것은 아니다.

## 검증 경계

합성 fixture로 내용 drift/동일 건수 PK 교체, 독립 census 누락·중복, source/catalog 교체,
타입·PK 불일치, FK NULL/보존 충돌, 키 재사용 거절·buffer zeroing, 상한과 취소를 검사한다.
실제 DB·SQL collector·hosted cancel·backup/restore·초기화/삭제 실행은 NOT RUN이다.
D01 보호 범위/방식, template 상태 선택, 사진 HOLD, 실행 승인과 정책 TTL은 여전히 별도다.

개발 검증: `ci:quality` 160파일/4,430 tests PASS, focused snapshot79 tests와 typecheck/lint PASS.
독립 QA에서 전체 builder/경계/테스트를 검토하고 별도79 tests PASS, 주요 차단0을 확인했다.

최신 dev943f220 통합 후 `ci:quality` 163파일/4,478 tests와 manifest128/기존 generator 검사 PASS.
Edge·Python·DB source는 해당 dev와 동일하며 이 단위에서 별도 실행하지 않았다. 전체 DB NOT RUN.
