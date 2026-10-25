# #396 초기화 대상의 일회 보호 검토

2026-10-25 사용자는 D01-A(초기화 대상의 별도 일회 보호·복구 준비)를 선택했다.
시험·개발 자료만 있다는 L1 확인은 운영 개시 사실에 관한 입력이다. 두 선택 모두 실제
복사·DB 변경·Auth 삭제·복구 시험·초기화 실행 승인이 아니다. 정기 예약 백업의 범위는 유지한다.

## 기존 검토 경로에 연결

`reset-protection-plan.ts`는 기존 snapshot builder의 독립 census/content 및 FK/NULL 검사를
재사용한다. 현재 정본 191개 앱 관계와 `auth.users` ID 경계까지 빈 관계를 포함해 요구한다.
새 SQL, 수집기, 공개 API, CLI, 저장 위치, 키, 외부 호출이나 삭제 실행기는 추가하지 않는다.

같은 capture의 project/source/catalog/classification/content/snapshot binding과 명시 선택,
요청 지문, 기존 review의 최종 계획 지문을 함께 묶는다. 정상 검토의 논리 참조 24경로와
템플릿 7경로 검사는 기존 composition이 소유하며 최종 계획 지문에 포함된다. 이 모듈은
그 검사를 복제하거나 역사 snapshot을 현재 DB 참조로 다시 해석하지 않는다.

`keep` 행, 기존 preserve 관계 및 사진 HOLD 관계를 보존 시작점으로 삼아 실제 FK 대상 행을
반복 방문한다. 공유 부모와 순환은 한 번만 센다. 보존에 필요한 행이 `remove` 후보라면
충돌을 보고하며 `keep`으로 조용히 바꾸지 않는다. 후보 삭제 건수도 실행 허용 건수가 아니다.
`roomBaseline`/`templateSource`/`unresolved`는 계속 미결정 상태다. 새 템플릿 등록 계획은
과거 원본을 제거하거나 참조를 새 ID로 연결할 권한이 아니다.

기존 직접 keep→remove 충돌은 계속 `review=null`로 차단한다. 다른 구조 결함이 없고
독립 수집이 완료된 경우에만 최상위 `protection` 진단으로 관계·건수·고정 오류·지문을
제공한다. 이때 최종 review 계획은 생성되지 않았으므로 `CAPTURE_INTENT_ONLY`와
`RESET_PROTECTION_FINAL_REVIEW_NOT_COMPOSED`를 표시한다. FK/NULL·내용·census 누락,
혼합 snapshot, 불완전 catalog, 상한 초과 또는 수집 실패에는 완전 manifest를 만들지 않는다.
정상 경로와 같은 review envelope scope/형식/시각 및 개발자·Auth 연결 검사를 재사용한다.
이 진단 단계에서 내부 논리/template/gate evidence 검사를 완료했다고 주장하지 않는다.

## 보호와 복구의 구분

출력은 유한 관계별 captured/kept/removalCandidates/pending/requiredByPreservation/
preservationConflicts 건수와 도메인별 요구 조건뿐이다. 행 PK·UUID·HMAC row token,
원문 컬럼·provider locator·Auth 자료·키·SQL은 반환하거나 저장하지 않는다. 기존 strict
data copier의 4MiB/200,000-node 상한도 적용하며 초과는 부분 성공으로 바꾸지 않는다.

| 도메인 | 남는 증거 경계 |
|---|---|
| 개발자·보안·기준정보·영속 이력 | 원래 상태와 FK 부모의 현 위치 보존 및 검증 필요 |
| Auth | 현재 수집 범위는 ID뿐. identity·인증정보 복구와 session 종료 증거 없음 |
| PIN/Sheet | 암호문 keyVersion·AAD·nonce 이력의 복구 검증 필요. 물리 도어락은 DB 복구 밖 |
| 사진·증빙 | 삭제 HOLD 및 현 위치 보존. 실제 provider 객체 존재·내용은 미검증 |
| 청소·예약·주급 | 원래 행·불변 snapshot·참조 복구 검증 필요. outbox 재전송/송금 효과를 만들지 않음 |
| 템플릿 | 선택되지 않은 버전까지 원본 역사 보호 필요. 과거 참조 재작성 없음 |

모든 도메인의 `backup`/`restore`는 `NOT_OBSERVED`다. 빈 관계도 미래 실행 시점의 보호
불필요 증거가 아니므로 성공으로 표시하지 않는다. 예약28건 보호본의 저장·readback·복호화는
예약 전용 근거이며 전체 초기화 복구 근거로 받지 않는다. caller의 `backupProofHash`, 성공
Boolean 또는 외부 evidence 객체로 이 상태를 승격하는 입력 자체가 없다.

`manifestPrepared=true`는 이 내부 영향 모델을 구성했다는 뜻이다. 실제 capture의 실재성,
최신 권한, 저장·복구 성공이나 모든 경로의 보존 완전성을 인증하지 않는다. `executionEnabled`,
`executionGranted`, `liveDatabaseVerified`, `completeResetCoverage`, `backupVerified`,
`restoreVerified`, `reservationBackupAcceptedAsResetProof`는 모두 false다.

## 실행 전 남은 작업

같은 실제 계획에서 보호본의 정확한 범위와 접근권한·키 보존·위치·기간을 정하고, 기존 두
Free 프로젝트의 당시 잔여 용량과 복구 시험 가능성을 확인해야 한다. 과거 전체 DB/Auth
복제·로컬 백업 정책이나 예약 백업의 15일 자동 정리를 되살리지 않는다. 새 비용·계정·
유료 전환을 선택하지 않으며 용량이나 Auth 복구 가능성을 추측하지 않는다.

실제 저장 후 재조회·복호화와 도메인별 복구 시험, 유지보수/drain, 정확한 실행 승인 및
실행 직전 계획 재검증은 별도다. 사진 보존 부모와 삭제 후보가 충돌하면 보호본이 존재해도
현재 보존 행을 깨뜨릴 수 없다. 필요한 보존 범위를 포함한 구체 영향표로 남은 후보를 검토한다.
실제 DB/SQL/Auth/Drive/provider/복사/복구/삭제는 이번 소스 변경에서 모두 NOT RUN이다.

## 소스 검증

정책 통합 `d887ee9` 위에서 `ci:quality` 190파일/5,173 tests·typecheck·build PASS,
manifest135·기존 preview 생성 검사·compiled Node import PASS를 확인했다.
그 뒤 공통 review envelope parser 추출과 직접 충돌 경로의 혼합/누락/오류 회귀4건을
추가했고, 관련4파일88 tests·typecheck·build·compiled import·lint PASS로 재검증했다.
최신 보호 병합 dev53e585a 통합 tree가 원격과 동일함을 확인한 뒤 D01 변경을 복원하여
보호/기존 review/H1 관련5파일111 tests·typecheck·build PASS로 통합 검증했다.
독립 QA도 최신 보호/기존 composition/계획 재검증 4파일88 tests PASS와 소스 검토에서
차단 finding0이다. 사진→업무→계정→Auth 전이 참조, 순환/공유 부모, 보존 후보 충돌,
같은 계획 결합·변조/누락/원문 비출력, 개발자 근거 실패를 합성으로 검증했다.
Edge·Python·공개 API·SQL 입력은 변경하지 않았으므로 새로운 실제 Edge/DB 실행은 없다.
