# v1.0.0 개발·배포 준비 상태

2026-10-25 기준. 공통 구현 PR515 이후 **사용자가 선택한 방향의 준비 코드를 dev에 통합했다.**
현장 사실은 PR517, 선택 정책은 PR518, 과거 이력의 검증 설계는 PR519,
초기화 대상의 보호 계획은 PR520, 과거 DB 이력의 관측·검증 준비는 PR521,
함수 선언 호환은 PR522, S1 템플릿 인계 효과·감사 보존은 PR523,
청소 진행 변경의 완료 관측은 PR524까지 통합했다. 첫 사전검증에 사용한 코드 기준은
`a17f97a1b54ac0899cc3c31c6e3d4f55c9de128f`다.
정책별 초기화 실행 구현과 실제 검증·배포가 남아 있으며 릴리스 후보는 아직 동결하지 않았다.
source/dev 통합, 실제 DB 검증, 운영 배포, 실제 기기 확인을 별도로 기록한다.
이 문서는 실행 승인이 아니다. 사용자 결정·실행 승인 자료는 현재 진행 채팅의
`USER_DECISIONS.md` 한 곳에서만 유지한다.

## #526 사전검증 실패와 수정 준비

2026-10-25 사용자가 승인한 D03-P 격리 설치1회는 위 source의 migration126에서
SQLSTATE42601로 실패했다. helper 두 호출 사이의 미완성 IF 본문이 원인이며 후속
metadata/13개 회귀는 NOT RUN, 자동 재실행0이다. 신규 자원 정리와 기존 자원 목록 보존은
대조했고 실제 운영 DB는 변경하지 않았다. #526은 원격 미적용126의 counter 치환을
한 번에 완결하도록 수정하고 소스 회귀4개를 추가했다. 전체5,383 tests·typecheck/build 및
dev137/과거 manifest 검사는 PASS다. 새 지문은 manifest와 기존 upgrade의
정확한126 소스 검사에 함께 반영하며 검사 예외를 넓히지 않는다.
[원인·직접 수정 근거·검증 한계](PHOTO_UPLOAD_BATCH_411.md)를 따른다.
수정본 설치와 photo batch SQL 회귀를 포함한 다음 격리 검증은 새 입력의 별도 승인 후에만
수행한다. 실패한 검증이나 소스 parser 통과를 최종 Full DB 성공 증거로 재사용하지 않는다.

## 2026-10-25 추천 방향 선택 후 재개

사용자는 공통 개발 종료 후 제시한 추천안을 선택했고, 실제 DB 실행 승인은 정확한 대상이
확정된 뒤 따로 확인하도록 했다. 초기화 대상에 한정한 일회 보호·복구 준비, 현재 게시
템플릿만 새 초안으로 등록한 뒤 검증·게시, 최근 비밀번호 확인 5분을 선택했다. 기존 DB
이력 공백은 이력을 보존한 별도 검증 정책을 설계한다. 설계 선택은 baseline 수용이 아니다.

백업은 예약 전용·매일03:00 KST·최소15일과 GitHub 알림을 유지한다. 업무 알림 정기 실행,
서명 호출과 호출 전용 키 교체, 별도 프런트 사진 연동의 준비를 진행한다. 운영 DB 비밀번호나
백업키 재입력을 요구하지 않는다. 현재 미실행인 SQL·삭제·키·Cron·발송·정기 활성화를
추천안 선택만으로 실행한 것으로 표시하지 않는다.

사용자가 직접 확인한 현장 사실은 다음과 같다. 실제 실행 직전의 관측과 기기 검증은 별도다.

| 항목 | 확인 내용 | 적용 경계 |
| --- | --- | --- |
| 운영 시작 | 현재 자료는 시험·개발 자료만 있음 | DB lifecycle/운영 시작 잠금 전환이나 실제 초기화 승인이 아님 |
| 기본/최대 인원 | standard2/2, premium2/3, oceanFamily4/6, oceanPremium2/4 | 현행 값 보존, 새 backfill 없음. 이후 developer 영향 미리보기·CAS·예약 충돌 검사로 변경 |
| 608호 | 차단 유지, 나중에 사용자가 해제 | 영구 invariant/seed를 만들거나 자동 해제하지 않음 |
| 관리자·메이드 기기 | 우선 갤럭시 | 실제 브라우저/OS·알림 권한·사진/수신 결과는 시험 때 기록 |
| PIN 시트 | 현재 미사용, 실제 운영에서 사용할 예정 | 아래 production 대상 확인·최소 권한·현재 버전 확인 전 기존 pending 작업을 실행하지 않음 |

### 별도 프런트 연동의 최소 범위

대상 정본은 `makee-ham/room-management-system`이다. 이 백엔드의 범위 정의만으로
다른 채팅 메시지·프런트 저장소 변경·실기기 검증이 완료됐다고 처리하지 않는다.

| 항목 | 연결할 계약 | 확인할 동작 |
| --- | --- | --- |
| 사진 목록 | `GET /v1/photos/{photoId}/thumbnail` | private/no-store 이미지, 미지원 시 실패 표시. 원본 조회는 별도 요청이며 확대는 기존 content |
| 같은 묶음 두 전송 | 기존 upload-batches 예약 후 최대2개의 binary 전송 | 두 item key·원래 collection revision 고정, 응답 유실은 같은 입력 재사용. 선택 순서 고정은 보장하지 않음 |
| 갤럭시 실사용 | 기존 1장 경로와 새 경로의 역할/회차 권한·재시도 | 1/5/20장·중단/재접속·오래된 배정·제출 충돌을 구분하고 실제 결과만 기록 |

사진 수량·보존·권한·입력 크기 계약은 [썸네일](PHOTO_THUMBNAIL_411.md)과
[두 전송](PHOTO_UPLOAD_BATCH_411.md)을 따른다. source 개선을 실제 속도 개선이나
프런트 연동 완료로 보고하지 않는다. 보호·복구와 정책별 source 작업을 마친 뒤
최종 후보와 검증 입력을 다시 고정하고 필요한 DB 실행 승인만 따로 확인한다.

## 개발 범위와 현재 근거

| 항목 | 통합/검증 근거 | 남은 단계 |
| --- | --- | --- |
| #300 비밀번호 변경 원장 검사 | PR482 / dev f107c2e / CI40152473122 | 실제 SQL 회귀 |
| #345 지연 알림 전달 시각 | PR483 / dev f2f4538 / CI40152896541 | migration123·실제 worker 검사 |
| #415 배정 카드 묶음 조회 | PR456 / dev fed9331 / CI40154044290 | migration124·동일 조건 성능 측정 |
| #442 공통 인증 조회 | v0.9.5 이후 운영 반영, v0.9.9 전체 DB CI39911377194 근거는 기존 이슈에 보존 | 동일 조건 p50/p95·호출 수·쓰기 실사용 측정; 재구현하지 않음 |
| #411 비공개 썸네일 | PR491 / dev a355ba0 / CI40154656657 | 실제 Drive·프런트 연결·기기 확인 |
| #396 읽기 전용 초기화 미리보기 | PR402 / dev4bb1d72 / CI40155598074 | migration125 실제 SQL; 삭제 기능 아님 |
| #492 장기 호출 키 대신 서명 호출 | PR493 / devd27d69e / CI40156336314 | 실제 키/SQL/worker/Cron 전환·첫 실행 |
| #378 유한·원자 운영 변경 실행기 | PR392 / dev9a29044 / CI40157027352 | 실제 PG/TLS·원자성·응답 손실·운영 검증 |
| #14 배포 크기 보완 | PR495 / devf25e5b6 / CI40158118738, 실제 candidate19,620,587B | 후속 통합에도 기존20MB 제한과 같은 회귀 검사 유지 |
| #411 안전한 2장 업로드 | PR494 / dev60cd6af / CI40157463321 | migration126·SQL/Drive·프런트 확인 |
| #396 행/FK 영향 | PR496 / dev80b679f / CI40158707931, app4389/159 | migration127 실제 SQL·Auth ID census·FK 지원 범위 검증; 삭제 권한 없음 |
| #378 TLS·원자 실행 fixture | PR498 / devae7d759 / CI40159620354 | 준비된 8개 실제 PG fixture 검사 NOT RUN |
| #396 운영 잠금·재인증 공통 계약 | PR497 / dev943f220 / CI40159977126 | migration128·실제 Auth/DB 검증. 시험 자료/5분 정책은 확정됐으며 실제 control 설정은 별도 |
| #396 전체 템플릿 inventory | PR499 / dev11e7cf3 / CI40160509940 | migration129 실제 SQL; 확정된 새 초안→검증→게시의 실행 연결 |
| #396 내용 snapshot | PR500 / dev5776959 / CI40161054266 | 실제 같은 snapshot과 실행 계획의 결합 |
| #396 실행 관측 receipt | PR501 / devb4422dc / CI40161368759 | 정확한 계획/승인 연결; 순수 모델은 실행 권한 아님 |
| #396 HTTP 쓰기/감사 진입 제어 | PR502 / dev8b40efd / CI40161793967 | migration130/131 실제 SQL; Auth/외부 효과 UNKNOWN은 별도 종료 증거 필요 |
| #396 템플릿 재등록 후보 생성 | PR503 / deva97c84e / CI40162887968 | 현재 게시본 선택 확정. 과거 이력 보호와 새 등록·게시의 실제 검증 |
| #396 알림 worker 진입 제어 | PR504 / dev9abe806 / CI40162316668 | migration132·실제 완료/실패/중단·활성화 검증 |
| #396 닫힌 읽기 수집기 | PR505 / dev9558ff9 / CI40162619689 | 실제 PG 권한/격리/lock/취소/내용 수집 검증 |
| #396 논리 참조 20개 표면 검사 | PR506 / dev42c3f4c / CI40163244532 | 같은 실제 snapshot·선택된 계획과 결합; 외부 파일 존재 검증 별도 |
| #396 native PG 읽기 연결 | PR507 / devdae6987 / CI40163826696, app4834/175 | 실제 TLS/DB 연결·후속 계획 결합 |
| #396 예약 scheduler 진입 제어 | PR508 / dev9d6428b / CI40164226762, app4845/176·최종관련111 | migration133 실제 SQL·기존 두 transaction의 부분 적용/heartbeat 검증 |
| #396 PIN 증분 worker 진입 제어 | PR509 / dev1e6557d / CI40164678173, app4896/179 | migration134 실제 SQL·기존 local-only 대상/정확한 시트 입력 검증, full-resync HOLD |
| #396 사진 삭제 HOLD 진입점 | PR510 / devb60e508 / CI40164986370, app4909/180·Edge65/560/68 | 실제 배포·기존 요청 종료 관측; 삭제/정리 활성화 없음 |
| #378 기존 history 표현 | PR511 / dev5d4166e / CI40165362275, app4936/180 | 신규 apply 불변, 기존110개 대응·현재 baseline 미완료12개 차단 |
| #396 영속 receipt 저장 | PR512 / dev80f766f / CI40166052564, app4973/182·Edge65/560/68·독립60 | migration135 실제 SQL·동시성·Auth·저장 결과 검증; 저장 확인은 실행 승인 아님 |
| #396 동일 snapshot 검토 결합 | PR513 / dev5d59ee8 / CI40166870690, app5019/184·Edge65/560/68·독립255+71/root97 | 명시 정책과 실제 증거 연결·최종 DB/외부 효과 검증 |
| #396 승인 일회 소비 | PR514 / deva15c6cd / CI40167140701, app5023/183·통합관련358·독립105·compiled import | 실제 승인/보호 증거 발급·지정 대상 실행과 구분 |
| #396 같은 승인 계획의 재검증 | PR515 / dev5b2d8ed / CI40167731766, app5104/187·compiled import·독립61/root25 | 실제 계획·승인과 효과 연결; 기존 일회 snapshot 지문을 재사용하지 않음 |
| #396 선택된 인계 정책 | PR518 / dev4d3df96 / CI40171337361, app5133/188·독립116/root54 | R1 5분/T1 현재 게시본/S1 초안→검증→게시의 계획 결합. 실제 설정·등록·게시 NOT RUN |
| #14 과거 DB 이력 검증 설계 | PR519 / dev53e585a / CI40171913594, app5127/188·통합349+46·root23 | 현재 source 재현8건/별도 원본4건 구분. 실제 catalog 대조·baseline 수용과 실행 권한 없음 |
| #396 일회 보호 계획 | PR520 / dev91cc525 / CI40172497106, app5173/190·후속111·독립88/root44 | 192개 관계·선택 계획 결합과 사진/이력 FK 부모 충돌 진단. 실제 보호·복구·실행 권한 없음 |
| #14 과거 DB 이력 관측·검증 준비 | PR521 / dev4ab83ec / CI40174366081, app5288/194·독립264+11/root27 | hash-only metadata 및 승인된 최종 검증의 source122 checkpoint. 실제 DB 관측·baseline 수용·전체 DB NOT RUN |
| #378 함수 선언 출력 설정 | PR522 / dev8f32a7d / CI40175403534, app5294/194·독립107 | 함수의 정확한 UTC/ISO 선언만 지원. 원문·본문 검토 및 실제 실행 차단 유지 |
| #396 S1 템플릿 인계 효과·감사 보존 | PR523 / devc8d76e2 / CI40176373907, app5337/197·독립85+7 | source136의 실제 시각·초안 검증·게시·슬롯·감사 readback 준비. 공개 실행 비활성, 실제 DB/보호/복구/초기화 NOT RUN |
| #396 청소 진행 변경의 완료 관측 | PR524 / deva17f97a / CI40177317552, app5379/199·Edge·독립172 | source137의 단일 경로·세 공개 action만 정확한 기존 원장과 결합. 나머지26 OPAQUE 및 실제 DB/운영 활성화 차단 유지 |
| #12/#273 예약 전용 백업 | PR484/489 인계, 실제 예약28건 암호화 저장/readback/복호화 확인 | main·독립 감시 설치·정기 활성화·첫 정기 실행 |
| #112 알림 운영 | 과거 실제 Push 수신 근거 보존 | 현재 heartbeat/Cron·대기 작업·실제 수신 재확인 |
| #13 역할별 실제 사용 | 자동 검사와 프런트 계약 대조 | 실제 기기/UAT·현장 입력 |

각 dev PR의 migration PASS는 manifest/source 검사다. **이번 진행에서 신규 SQL·전체 DB·
운영 migration/reset은 NOT RUN**이다. CI 실패를 숨기지 않는다. PR402의 Python 수치 실패,
PR392의 생성 manifest 입력 hash 실패 등은 후속 source 보완과 새 exact CI로 해결했다.
과거 PR392의 실제 SQL 회귀 실패는 이번 합성 검사로 성공 처리하지 않는다.
공통 단계의 전체 애플리케이션 검사는 187파일/5,104 tests PASS였으며,
후속 PR524 통합에서는 199파일/5,379 tests·typecheck/build가 PASS다.
PR523 Edge는 65/560/68 tests·report19,906,630B·backup99,006B였으며, 변경된 PR524 입력도
정본 Edge 검사에 통과했다. PR524 출력에서 전체 suite별 수와 report 크기를 별도 확보하지
못했으므로 이전 수치로 대신하지 않는다. 기존20MB 제한은 유지했으며 실제 배포 결과가 아니다.

### #396 구현과 아직 완료하지 않은 부분

통합한 구성요소는 [내용 snapshot](RESET_CONTENT_SNAPSHOT.md),
[읽기 수집기](RESET_READONLY_COLLECTOR.md), [논리 참조](RESET_LOGICAL_REFERENCES.md),
[템플릿 후보](TEMPLATE_HANDOVER_PLAN_BUILDER.md), [실행 관측 모델](RESET_EXECUTION_RECEIPT.md),
[영속 저장](RESET_RECEIPT_STORE.md), [같은 snapshot 검토](RESET_REVIEW_COMPOSITION.md),
[승인 기록 소비](RESET_APPROVAL_CONSUMPTION.md), [계획 재관측](RESET_PLAN_REVALIDATION.md),
[일회 보호 계획](RESET_PROTECTION_PLAN.md), [S1 효과 준비](RESET_TEMPLATE_HANDOVER_EFFECT.md),
[운영 안전 장치](DEVELOPER_OPERATION_GATES.md)에 명시돼 있다.
HTTP와 worker의 source 진입 제어는 실제 운영에 설치된 전체 coverage 증명이 아니다.
기존 세션·Auth 관리 API·owner SQL·Drive 직접 작업·초기 설치 전 진행 작업을 포함해
쓰기 가능 경로와 미종료 효과를 확인해야 한다. 기한 경과나 나중의 성공으로 UNKNOWN을
해제하지 않으며, 미확인 경로가 있으면 초기화는 계속 차단된다.

남은 전체 초기화 구현의 전제는 삭제 대상에 맞는 보호·복구 방식, 실제 FK/catalog와
사진 보존 부모 충돌을 반영한 행/필드별 계획, Auth/PIN 복구·종료 근거다. S1의 새 초안·검증·게시와
과거 참조·감사 보존은 source136으로 준비했지만 실제 SQL 및 전체 삭제 효과는 미검증이다.
운영 상태/재인증 5분의 실제 설정, 정확한 승인 권한과 공개 실행의 연결도 별도로 남는다.
별도로 정책값을 고정하지 않는 같은 snapshot의 catalog·내용·참조·템플릿·운영 상태 연결과
신뢰된 영속 원장의 최신 head/CAS는 PR512, snapshot 조립은 PR513으로 통합했다.
정확한 승인 결합·일회 소비는 PR514, 같은 계획의 별도 비교·재검증 공통부는 PR515로
정책값을 고정하지 않고 구현·검증·통합했다. 어느 구성요소도 실행 권한을 자동 발급하지 않는다.
실제 승인·보호 근거의 발급과 구체적 대상 실행·재조정은 선택한 정책·실제 증거를 연결해야 한다.
순수 검사와 source adapter의 통과를 이 전체 기능의 완성으로 보고하지 않는다.
선택에 앞서 되돌리기 어려운 삭제 정책이나 허용 기본값을 정하지 않았다.

현재 확인된 작은 source 누락은 PR524까지 보완했다. 다음 개발에는 최신 schema의 실제
FK/catalog와 source136/137의 권한·참조·원자적 rollback 결과가 필요하다. 전체 초기화가
미완성인 지금 release PR을 검증용으로 만들지 않는다. 이를 최종 릴리스 전 별도 격리 DB에서
검사하려면 [최종1회 정책](FINAL_DB_VALIDATION.md)의 **개발 선행 사전검증 예외 1회**를
정확한 source·전용 대상·검사·정리 범위로 별도 승인받아야 한다. 승인 전에는 해당 실행을
대기하며, 사전검증 성공도 Full DB proof·H1 baseline 수용·운영 배포 또는 초기화 완료가 아니다.

## 실제 운영과 source의 차이

2026-10-25 읽기 확인에서 production은 migration122, API54, scheduler22,
notification-delivery13이다. health는200/ok, 공개 OpenAPI는154경로166동작이다.
API54의 원본 파일 조회는 서버 오류로 실패했으므로 현재 dev/main과의 source 정합성은
UNKNOWN이다. 배포 번호나 health 성공만으로 소스 일치를 주장하지 않는다.

14:02/14:03 KST의 운영 history metadata 읽기에서122개 이름·순서는 source와 일치했고
중복·미등록은 없었다. timestamp는45개 일치/77개 차이이며 마지막 운영
`20261023060721`은 source `20261022135443_post_approval_memo_only.sql`에 대응한다.
최초 LF 지문 비교 뒤 원시 bytes를 재대조해48개 원문·7개 끝CRLF추가·55개 CRLF변환후
끝CRLF추가의 정확한 대응을 확인했다. 기존 whole-file 한 원소 history는 신규 apply의
CLI split 표현과 달라 PR511에서 고정된 과거 표현 비교를 추가했다. 나머지12개는
현재 baseline 대응이 완료되지 않아 차단한다. 추가 읽기에서12개 중10개의 원인은 exact raw SHA로
확인했다. 7개는 #458의 유한 timeout·transaction wrapper, 1개는 전체 줄 주석/끝 공백 제거,
`harden_data_api_grants`는 과거 Git blob, index112는
[#425에 기록된 실제 wrapper](https://github.com/wrongstory/room-management-system-backend/issues/425#issuecomment-6080544897)와 일치한다.
`initial_core_schema`와99B의 `complaint_deadlines_non_blocking`은 원본 대응이 미확정이다.
이 조사로 허용 변환을 늘리거나 현재 source·DB schema와 동등하다고 간주하지 않는다.
현재 codec의110개 대응과 추가10개 원인 확인은 서로 다른 근거이며,12개 차단은 유지한다.
두 원본을 복원할 출처가 없으면 현재 catalog·권한·후속 migration의 독립 대조에 기반한
별도 baseline 검증이 필요하다. 사용자는 H1의 설계·준비를 선택했고
[검증 설계](MIGRATION_BASELINE_REVIEW_POLICY.md)를 PR519로 통합했다.
원인 설명10건과 현재 source에서 재현한8건을 구분하며 실제 baseline 수용은 아직 하지 않았다.
PR521의 [관측·검증 준비](MIGRATION_BASELINE_METADATA.md)는 업무 원문 대신 고정된
history·catalog·권한의 해시와 건수만 수집한다. 승인된 최종 Full DB 검증의 기존 fresh 단계에서
source122까지 재구축한 구조를 관측한 뒤 같은 고정 소스의 최종 tip을 적용하도록 준비했다.
추가 reset을 반복하거나 운영 DB를 변경하지 않는다. 실제 검사는 NOT RUN이며,
부분 catalog·정의 해시만으로 과거 데이터 효과나 전체 권한의 동등성을 증명하지 않는다.
이 metadata 대조는 strict history codec·전체 내용·실제 schema 정합의 성공 증거가 아니다.
전체 mapping과 실행기의 baseline/pre/post 계약을 고정하기 전 history repair나
이미 적용된 SQL의 재실행으로 차이를 덮지 않는다. 실제 변경은0회다.

[#442 최신 배포 기록](https://github.com/wrongstory/room-management-system-backend/issues/442)은
공통 인증 조회 통합의 운영 반영을 확인한다. 과거 성능 문서의 구현 후보 표현으로 이 상태를
되돌리지 않는다. 다른 날짜·API 버전·데이터의 로그 분포를 개선 전후 실측으로 섞지 않는다.
배포 후 같은 역할·입력·데이터·요청 수로 auth/me, rooms, assignments, payroll,
notifications와 사진을 구분해 p50/p95·DB 호출 수·오류를 비교한다. 사진은 원본/썸네일,
1장/2장 전송과 기기·네트워크·이미지 형식을 구분하며 합성 시간은 운영 속도로 보고하지 않는다.

알림 delivery heartbeat가 없고 대기10건은 당시 모두24시간 이상이었다. 활성 Cron은
reservation-transition-every-minute만 확인했다. 이 과거 집계는 미래 발송 승인이 아니며
실제 전환 직전에 대상·건수·만료 상태를 다시 확인한다.

12:27 KST 읽기 집계에서 room-pin-sheet-sync11은 worker 상태idle, heartbeat0,
pending2건이다. 활성 Cron은 여전히 예약 전이 하나다. 배포 목록의 ACTIVE는 함수가
배포돼 있다는 의미이며 정기 실행 성공을 뜻하지 않는다. 기존 PIN 시트 증분 대기 작업은
실제 대상·현재 PIN 버전·시트 방향과 현장 사용 여부 확인 전 실행하지 않는다.
사용자가 현재 미사용·운영 시 사용 예정임을 확인했으므로 기존 증분 경로의 정확한 production
대상·최소 권한·현재 PIN 버전·실제 시트 방향을 고정해 활성화를 준비한다. 미확인 pending2건을
유효한 운영 데이터로 가정하지 않는다. 범위에서 제외한 full-resync #137은 확대하지 않는다.
photo-purge11도 배포 목록에 있으나 사진 삭제 HOLD와 Cron 미활성 경계를 유지한다.

OpenAPI의 기존 계약 표기0.6.0과 npm package 표기0.1.0은 현재 source 값이다.
source OpenAPI·Pages·계약 검사는 157경로169동작이며 운영의154/166과 다르다.
[v0.7.0](RELEASE_V0.7.0.md)과 [v0.9.4](RELEASE_V0.9.4_DEPLOYED.md)의 기존 방침대로
Git 제품 릴리스, HTTP 계약 버전, private npm package 버전을 별도로 관리한다.
v1 태그를 위해 계약을 임의로 1.0.0으로 올리지 않는다. 최종 릴리스에서는 tag/main SHA,
DB history/manifest, API·worker의 실제 배포 artifact hash와 공개 계약을 함께 대조한다.

## 최종 검증과 배포 순서

1. 위 공통 source의 애플리케이션/Edge/계약·독립 QA·dev 통합 완료 근거를 확인한다.
2. 최신 dev의 정확한 source·검증 입력 지문·pending SQL·운영 설치 SQL을 동결하고,
   사용자 결정 문서에 실제 선택지/추천·영향·비용·미실행 항목을 한 번에 제시한다.
   결정으로 source가 달라지면 변경 구현·QA·dev 통합을 먼저 마친 뒤 후보를 다시 고정한다.
   그 전에 아직 모르는 최종 SQL이나 재실행을 포괄 승인받지 않는다.
3. 해당 source의 `release/v1.0.0 → main` PR 생성/push가 유발하는 전체 DB 검증은
   **구체적으로 승인된 1회**만 수행한다. 실패/취소/입력 변경 후 재실행은 별도 승인이다.
   [최종 DB 검증 정책](FINAL_DB_VALIDATION.md)의 동일 PR/입력 성공 proof만 재사용한다.
4. 보호 조건·전체 검사·독립 QA·미해결 대화를 확인해 release를 main에 반영한다.
   main의 동일 입력 proof 확인이 성공하기 전 운영 배포하지 않는다.
5. 실제 운영 history/version/name/내용을 대조한 pending만 별도 실행 승인 범위에서
   순서대로 적용하고 readback한다. history repair·자동 전체 db push는 사용하지 않는다.
   APPLIED/NOT_APPLIED/UNKNOWN 판정과 중단은 [실행기 계약](MIGRATION_EXECUTION_RUNTIME.md)을 따른다.
6. 호환 API/필요 worker·공개 OpenAPI/Swagger를 반영하고 안전 smoke를 확인한다.
   변경된 DB에 호환되지 않는 옛 API를 단독 복귀시키지 않는다.
7. 승인된 백업·감시·알림·예약 작업의 실제 실행과 실패 처리, 역할별 UAT를 확인한다.
   정확한 source/운영 일치와 인계가 끝난 뒤 v1.0.0 tag/Release를 기록한다.

실제 데이터 초기화는 일반 배포 단계에 섞지 않는다. 별도 보호·복구 범위, 운영 시작 전
상태, 개발자 재인증, 중단/진행 중 작업 증거, 정확한 대상과 1회 승인까지 충족해야 한다.
예약 백업은 Auth/PIN/사진/청소/주급을 보호하지 않는다. 사진 삭제 HOLD를 우회하지 않는다.

## 프런트 및 현장 확인 경계

정본은 `makee-ham/room-management-system`이다. 11:35 KST 읽기 기준 main
`f9fe28d91c2b5b012489273a9756cdaaa5dbef8c`, dev
`a76f0fee099bdd052d64478cb7c43019c79120f3`의 DOCS32/33/35/37/38/39를 대조했다.
기존 한 장씩 업로드·같은 키/Blob/CAS 재시도, 인증 사진 조회 동시4개, snapshot 사용 계약을
보존한다. 새 썸네일·2장 batch는 별도 프런트 연결과 검증이 필요하다.

최소 현장 확인은 관리자/메이드의 사진 실패 후 동일 입력 재시도, 모바일/HEIC·20장,
배정/오늘·내일/자정 이월, 알림 상세 접근과 권한, PIN Excel preview/apply다.
Drive PIN import는 현재 프런트에서 OFF인 별도 경계이며 임의로 켜지 않는다.
실제 PIN 변경·업무 생성·수신자 발송은 안전 읽기 smoke로 취급하지 않는다.
자동 검사가 사용자의 실제 기기 결과를 대신하지 않는다.

## 운영 인계에서 남겨야 할 증거

- final main/tag·manifest·실제 history mapping·pending 적용별 readback과 호환 배포 hash
- health/인증거부/권한별 안전 조회·OpenAPI/Swagger의 source 일치
- 예약 전용 백업 저장·readback·복구 조회·15일 보관·첫 정기 성공·감시와 실제 알림 수신
- scheduler/알림 heartbeat·실패/재시도/UNKNOWN 중단 절차와 책임 범위
- UAT 결과와 미확인 현장 값, 초기화/사진 삭제 등 대기 정책

#14의 2026-10-24 범위에서 제외한 사진 purge 활성화 #9, 운영 콘솔 확대 #44,
Sheets full-resync #137, 근거 없는 성능/CI 확장을 되살리지 않는다.

Refs #14, #13, #12, #112, #378, #396, #411, #492.
