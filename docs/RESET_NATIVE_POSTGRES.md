# #396 native 읽기 전용 연결

`inspectResetNativePostgres`는 closed collector를 실제 `pg.Client` 생성 경로에 연결하는 서버 내부 함수다.
caller client/factory/SQL, 환경 변수 fallback, 공개 route/CLI는 받지 않는다. 호출 전 독립 검토한
source catalog/binding과 명시 connection target/credential/CA를 요구한다. import만으로 연결하지 않는다.

기존 #378 `migrationPostgresConnectionInput`과 `migrationPostgresTlsIdentity`만 재사용한다.
history query 포트·migration writer·history 관측 capability는 변경하거나 재사용하지 않는다.
PG 8.23.1 기존 의존성을 사용하고 새 라이브러리를 추가하지 않는다.

명시된 Supabase direct 또는 session target만 허용한다. projectRef/database/role은 source와 일치해야
하며 direct hostname은 해당 프로젝트 hostname으로 제한한다. transaction pooler/6543/로컬 임의 host,
빈 password와 잘못된 CA는 연결 전에 거절한다. session mode의 사용자명은 검증한 role.projectRef다.
CA 유효기간·서명 CA 여부, TLS 1.2 이상, hostname 검증과 authorized native TLSSocket을 요구한다.
모든 쿼리 전후 같은 socket과 peer certificate를 다시 확인한다. 이는 지정 endpoint의 transport 관측이며
원격 프로젝트의 운영 소유권이나 sourceCommit의 실제 배포·최종 DB 검증을 대신하지 않는다.

startup부터 default_transaction_read_only, statement/lock/idle timeout과 UTF8/text codec을 고정한다.
고정 nonce와 RR/SET/LOCK/독립 census/content 확인은 기존 closed collector가 수행한다. native 포트는
그 함수 내부에서만 존재하며 호출자에게 임의 query handle을 반환하지 않는다.

pg의 sslconnect 시점에 TLS data listener를 앞에 붙여 startup/authentication부터 누적16MiB를 제한한다.
연결은4초, 수집 전체는4.5초, 종료는350ms의 기존 collector 경계에 포함한다. abort/error/초과/peer 변경은
소유 socket만 destroy하고 end는1회만 시작한다. 실패한 연결·쿼리·close에 native 오류 원문을 포함하지 않는다.
종료/파기 시 client/config의 password 참조와 listener를 정리한다. caller 메모리와 JS heap의 물리적 삭제,
서버에서 진행 중인 query의 실제 중단·rollback 완료를 이 동작만으로 보장하지 않는다.
정리 대상 listener는 TLS data·sslconnect·abort다. client error listener는 늦은 native error가
uncaught EventEmitter 오류가 되지 않도록 남겨 두며, 이미 파기된 연결에서는 원문 없이 동일한 정리만 수행한다.

반환값의 `liveDatabaseVerified=false`, `executionEnabled=false`를 그대로 유지한다.
실제 드라이버 생성 경로가 있다는 사실과 이번 개발에서 실제 연결·SQL을 검증했다는 사실은 다르다.
합성 테스트는 pg 모듈만 대체하고 실제 closed collector와 기존 CA/TLS 검증 함수를 통과한다.
실제 소켓 연결은 차단하고 올바른 TLS/정확 target, 잘못된 SAN/CA/role/codec/wire 상한,
취소/무응답 close/비밀 해제를 검증한다. 실제 DB 연결·SQL·migration·reset·backup/restore는0회다.

## 남은 연결과 결정의 구분

- 독립 공통 구현: native client 생성/TLS/대상 결합/wire 상한/정리와 closed collector 합성 연결은 이 단위에서 완료한다.
- 실제 실행 입력: 최종 source/catalog, 대상 프로젝트/role, 현재 자격 증명과 CA의 일치는 구체 실행 때 확인한다.
  기존 승인된 자격 증명을 재사용할 수 있으며 이것은 신규 비밀번호 재설정 요청이 아니다. secret은 Git/문서에 기록하지 않는다.
- 최종 DB 검증: 실제 PG type/equality/lock/RR/취소/권한과 기능 회귀는 승인된 격리/최종 DB 실행에 남는다.
- 정책·보호 의존 연결: D01 복구 대상/방식, 유지할 템플릿 상태와 history 보호, preview/재인증 유효 정책,
  확정 row/field 처리 계획과 durable receipt/명시 승인 연결 후에만 삭제 executor를 구체화할 수 있다.
  이 함수는 미결정 row 그룹·사진 HOLD를 바꾸거나 실제 reset authority를 제공하지 않는다.
- registry/template/admission/receipt는 각 내부 검증 단위를 실제 같은 snapshot/계획에 결합해야 한다.
  순수 함수나 합성 입력의 PASS를 전체 초기화·운영 배포 완료로 표시하지 않는다.

개발 검증: 전체 `ci:quality` 173파일/4,781 tests, native 합성16 tests, manifest132 및
compiled import PASS다. 독립 source/doc QA와 native/closed-collector 2파일43 tests PASS, 차단 결함0이다.
