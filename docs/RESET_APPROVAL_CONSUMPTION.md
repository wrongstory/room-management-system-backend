# 초기화 승인 기록의 일회 소비 (#396)

`reset-approval.ts`는 기존 초기화 명령의 정확한 지문과 **이미 존재하는 owner-protected operator 승인 기록**을
결합하고, exclusive marker를 한 번만 저장하는 서버 내부 공통부다. 승인 문서를 만들거나 사용자 대신
정책/TTL/삭제 범위를 정하지 않는다. 실제 승인 파일 읽기·소비, DB/Auth/provider/삭제 호출은 NOT RUN이다.

## 승인 관측과 실행의 분리

`prepareResetApprovalRequest(command, nowMs)`는 기존 순수 receipt command 전체를 엄격하게 복사해
고정 지문만 만든다. actor/Auth/session/password-version, project/source, catalog/content/plan,
postcondition, policy/approval-scope/backup, idempotency key, 단계 순서와 생성/만료 시각이 모두 포함된다.
추가 필드·getter·비정상 prototype을 거부하고 결과를 freeze한다. 메모리 소유권으로 clone/hash-only request를
거부하지만 이 소유권도 사람 승인이나 최신 상태 검증이 아니다. 재시작하면 원래 exact command로 요청을 재구성한다.

`consumeResetApproval({request, approvalId, runId, ioBudgetMs})`는 이 모듈이 만든 request만 받는다.
입력에 승인 Boolean, 원문 비밀번호/세션, 삭제 SQL, 임의 경로, provider callback을 넣을 수 없다.
반환 `CONSUMED`는 아래 기록의 검증·소비만 관측했다는 뜻이다.
`executionEnabled=false`, `retryExecutionAllowed=false`이며 live 상태·drain·backup·coverage·실행 permit은 반환하지 않는다.
실제 실행기를 연결할 때는 소비한 request와 실행할 명령의 정확한 동일성을 유지하고, 최신 권한/재인증/
운영 잠금/내용 재검증/백업·보호 범위/실제 drain을 별도로 확인해야 한다. 기존135 STARTED RPC에 자동 연결하지 않는다.

## 기존 승인 기록의 형식

신뢰하는 operator는 사용자의 **구체 실행에 대한 실제 명시 승인 이후에만** 기록을 별도 준비할 수 있다.
일반 자동 개발 승인이나 다른 대상/정책/소스의 승인을 복사해 새 승인으로 만들면 안 된다.
이 모듈에는 문서 발급·갱신·예제 승인 파일 생성·기본 TTL 기능이 없다.

고정 위치는 `$HOME/.codex/approvals/room-management-resets/<approvalId>.json`이다.
기존 #378 migration 승인 폴더와 action을 재사용하지 않아 서로 대체할 수 없다.
정확한 필드만 있는 UTF-8 `JSON.stringify(document, null, 2)`와 마지막 LF를 받는다.

| 필드 | 계약 |
|---|---|
| format | `reset-owner-approval-v1` |
| approvalId | 파일명과 같은 UUID |
| action | `EXECUTE_EXACT_RESET_ONCE` |
| requestSha256 / commandHash | 준비된 exact command의 지문과 순수 receipt 명령 지문 |
| projectRef / sourceCommit | 같은 대상 프로젝트와 source commit |
| issuedAtMs / expiresAtMs | 명시한 시각. 명령 생성 이후 발급, 현재 유효, 명령 만료 이내 |
| humanDecision | 실제 승인 근거의 `threadId`, `turnId` UUID 두 개 |

`humanDecision`을 대화 API로 조회하거나 암호학적 승인 서명으로 인증하지 않는다.
operator가 실제 사람 승인과 exact 명령의 대응을 확인해야 한다. caller가 임의로 보낸 hash/Boolean을 검증했다고
실제 승인을 확인한 것으로 부르지 않는다. 같은 owner가 승인 파일이나 실행 runtime을 악성으로 변조하는 상황은
이 계약의 방어 범위가 아니다. sourceCommit 일치는 입력 결합이며 실제 checkout/릴리스 상태 증명은 별도다.
백업 hash도 이 모듈이 백업 존재나 복구 성공을 독립 확인했다는 뜻이 아니다.

## 일회 소비와 실패

폴더와 파일의 실제 경로, regular file/no symlink, 소유자와 쓰기 ACL, 8KiB 크기,
열기 전/후 inode·device·크기·수정 시각을 확인한다. Windows는 본인/SYSTEM/Administrators 외 쓰기 allow ACE를
거부하고 Unix는 본인 소유와 group/world write 금지를 요구한다. 알려지지 않은 필드·중복 JSON key·잘못된 UTF-8도 거부한다.

모든 검증 뒤 `<approvalId>.consumed.json`을 `wx`/mode0600으로 생성한다. marker에는 승인/run/request/command 지문,
소비 시각과 humanDecision 지문만 저장하고 file fsync를 한다. POSIX에서는 directory entry도 sync한다.
Windows의 지원되는 file fsync를 전원 장애 후 저장 장치의 영구 보존 보장으로 과장하지 않는다.
마커 생성 이후 write/sync/close 실패, 관측 timeout, 프로세스 종료, 후속 실행 실패가 나도 marker를 지우지 않는다.
따라서 새 프로세스나 새 request 객체로 같은 승인 ID를 다시 소비할 수 없다.
이 cross-process 일회성은 marker가 생성된 뒤에 성립한다. 그 이전의 문서/권한 검증 실패에는
영속 marker가 없을 수 있지만 실제 초기화 효과도 수행되지 않는다. 같은 인스턴스의 실패 시도는 재사용하지 않는다.

한 request 인스턴스는 한 번만 시도한다. 별도 request가 경쟁해도 exclusive create가 한 번만 성공한다.
`ioBudgetMs`는 호출자가 지정하는 1~30,000ms의 기술적 관측 한도이며 제품의 승인 유효기간/reauth TTL이 아니다.
deadline을 넘으면 고정 오류 `RESET_APPROVAL_UNAVAILABLE`만 반환하고 native 경로/ACL/parse/IO 오류를 노출하지 않는다.
파일 I/O는 관측 timeout 뒤 끝날 수 있어 늦게 생긴 빈 marker도 소비된 것으로 유지한다.
오류는 미소비/rollback 증명이 아니며 caller는 UNKNOWN으로 멈춰 조사해야 한다. 자동 재호출·marker 삭제·
새 key/승인 ID를 통한 자동 재승인은 없다. 다른 실행이 필요하면 다시 검토한 exact 명령에 대한 새로운 사람 승인이 필요하다.

## 검증과 남은 경계

테스트는 메모리 파일시스템/ACL만 사용한다. exact 1회, 모든 command binding 변경, 단계/기한/key 변경,
동시 경쟁, process-style 재구성, write/sync/close 실패 후 재사용, timeout 뒤 late marker, prefix/경로/파일 교체,
추가 필드/getter/중복 JSON/만료/원문 오류 비노출을 검사한다. 실제 owner 승인 기록은 생성하거나 소비하지 않는다.
신규 DB migration·공개 API·기존 #378 실행 코드 변경은 없으며, D01/D02 정책과 실제 승인/운영 실행은 별도다.

Node 배포물은 기존 strict copier `scripts/lib/migration-evidence-input.mjs`를 함께 제공해야 한다.
빌드한 `dist/modules/developer-reset/reset-approval.js`의 상대 import가 이 경계를 따른다.
Edge graph에는 이 모듈을 연결하지 않는다.

2026-10-25 source 검증: dev80f766f 기반 `npm run ci:quality` 183파일/5,023 tests와 build PASS,
독립 approval/receipt/store 105 tests PASS, 컴파일된 모듈의 실제 import PASS.
새 승인 소비 검사는 메모리 FS/ACL 50건이며 승인 문서·marker의 실제 접근은 0회다.
Edge graph/생성물/SQL을 변경하지 않아 이 단위의 추가 Edge·DB 실행은 NOT RUN/해당 없음으로 구분한다.

PR513의 dev5d59ee8을 충돌 없이 정상 통합한 뒤 approval/receipt/store와 composition/내용·참조·템플릿의
관련 12파일/358 tests, typecheck/build/compiled import, manifest135 및 생성물 정합성 검사를 통과했다.
통합 입력인 PR513은 전체5,019/184 및 Edge65/560/68 PASS이며 이 브랜치의 통합된 Edge 소스·생성기·package 입력은
그 검증본과 동일하다. 기존 전체5,023 PASS와 이 통합 관련 검사를 구분하며 새 전체 수를 추정하지 않는다.
