# 사진 업로드 지연 최적화 — #301

## 관측과 범위

2026-09-26 KST 사용자가 api v34에서 실제 스마트폰 업로드 성공과 느린 완료 시간을 보고했다.
운영 로그는 읽기 전용 집계만 확인했다. 최근 24시간의 v34 업로드 HTTP200 표본 3건:

| 지표 | 서버 execution_time_ms |
|---|---:|
| 최소 | 6,594 |
| 중앙값 | 7,222 |
| 평균 | 8,022 |
| 최대 | 10,251 |

모두 ap-northeast-2 실행이다. 작은 표본이며 촬영/파일 선택, 클라이언트 전송, 완료 후 화면 재조회 시간을
개별 분리한 측정은 아니다. 각 단계의 기여도나 p95를 이 표로 확정하지 않는다. 요청 ID/사용자/객실/사진/인증정보를 기록하지 않았다.

## 1차 구현: Drive 왕복과 직렬 대기 감소

- 새 작업의 날짜 폴더 후보/객실 폴더 후보/파일 ID를 `files.generateIds?count=3` 한 번으로 받는다.
  정확히 3개의 유효하고 서로 다른 ID여야 한다. batch 후보는 DB registry의 승자가 아니며, 기존 RPC가 선택한 폴더만 생성한다.
- `ensureFolder`의 부모 metadata와 대상 metadata GET만 동시에 실행한다. 부모의 비공개/폴더/미삭제 검사를 통과하기 전에 create하지 않는다.
  날짜→객실 폴더 생성 순서는 유지한다. 조회 결과를 요청 사이에 cache하지 않는다.
- 실제 저장 파일의 GET/SHA·MIME·크기·부모·비공개·createdTime 검증, checksum 없는 경우의 bounded read는 유지한다.
- 인증/admission/quota/CAS/lease/idempotency, 실패 후 같은 identity 복구, 5MiB 입력·300KiB 출력·정규화 bytes는 변경하지 않는다.
- accepted replay 또는 기존 provider identity가 있으면 새 ID batch를 발급하지 않는다.

기존 날짜/객실 폴더가 있고 Drive checksum이 있는 정상 경로, quota refresh와 DB 호출 제외:

| Drive/OAuth 경로 | 이전 | 변경 후 |
|---|---:|---:|
| ID 발급 HTTP | 3 | 1 |
| 부모/대상 폴더 GET | 4 | 4 |
| 업로드 POST + 저장 검증 GET | 2 | 2 |
| cold OAuth 포함 HTTP 합계 | 10 | 8 |
| cold OAuth 포함 순차 대기 단계 | 10 | 6 |

모든 HTTP 응답을 100ms로 고정한 **가상 시간 테스트**에서 변경 후 600ms를 확인한다(이전 순차 모델은 1,000ms).
이 40%는 해당 합성 네트워크 경로의 비교이며 전체 운영 업로드가 40% 빨라진다는 주장이 아니다.
새 폴더 생성, cold WASM, checksum fallback, OAuth/Drive 변동, 클라이언트 전송 및 DB 대기는 별도다.

근거: [Google Drive generateIds 공식 계약](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds).

## 추가 단축 순서

### 우선순위 1 — 프런트의 완료 후 전체 재조회 제거

프런트 정본 `makee-ham/room-management-system@d509b44b1371f25d73891e04d355b0cb0e923f5f`의
`WIREFRAME/index.html`에서 `uploadLiveCleaningPhoto` → `runLiveCleaningMutation`은 `reload=true`로
`loadLiveCleaning` 전체가 끝날 때까지 기다린다. maid 경로는 배정 N개/attempt가 존재하는 M개에 대해
대략 `2 + N + 2M` GET(선택적 알림 조회 제외)을 매 사진 완료 뒤 수행한다.

- 업로드 전용 경로에서 전체 reload를 끄고 해당 assignment/current attempt와 해당 attempt/photo-slots만 재조회한다.
- accepted 응답과 slot의 verified/current revision을 확인한 뒤 해당 카드만 갱신한다. 저장 완료와 화면 갱신 실패를 분리한다.
- 인증 세대/화면 이탈/작업 version 경합, 409, 응답 유실의 기존 same-key 복구를 유지한다.
- 재조회 실패를 업로드 실패로 오인하여 새 key로 재업로드하지 않는다. 현재 권한을 낡은 cache로 대체하지 않는다.
- 검증: 1/10/20개 배정에서 업로드 1회당 후속 GET 수를 일정하게 제한하고, 다른 카드/제출 가능 조건/로그아웃 회귀를 확인한다.
- 이번 backend PR에는 프런트 변경을 포함하지 않는다. 가장 먼저 별도 프런트 PR로 진행할 항목이다.
  후속: [프런트 #189](https://github.com/makee-ham/room-management-system/issues/189).

### 우선순위 2 — 선택적 전송 전 축소

현재 프런트는 `rawBody:file`로 원본을 그대로 보낸다. 약 2~3MiB JPEG를 전송 전에 긴 변 1280px,
300KiB 이하 JPEG/WebP로 준비하면 전송량을 줄일 여지가 있다. 저속 모바일 네트워크에서 우선 평가한다.

- 서버 정규화/EXIF 제거/크기·magic·권한 검증은 그대로 유지한다. 브라우저의 검증 결과를 신뢰하지 않는다.
- 재시도 시 같은 key에는 최초 준비한 동일 Blob을 재사용한다. 매 재시도마다 재인코딩하여 bytes를 바꾸지 않는다.
- 원본은 localStorage/IndexedDB/로그에 남기지 않고 메모리에서만 유지·해제한다.
- HEIC/HEIF 또는 browser decode 실패는 기존 5MiB 원본 경로로 fallback한다. 실패를 가짜 JPEG로 감추지 않는다.
- 저사양 Android의 decode 비용, 회전/색감/선명도, 직접 촬영/갤러리, HEIC 원본 fallback을 실기기로 검증한다.
- 전송량 감소율과 전체 시간 감소율을 분리한다. 화질 기준은 유지하며 더 작은 목표로 임의 하향하지 않는다.

### 우선순위 3 — 실제 단계별 측정 후 추가 서버 개선

- 승인된 기존 QA 대상에서 동일 사진/네트워크로 cold/warm을 분리하여 최소 20회 측정한다. 새 운영 fixture는 만들지 않는다.
- 촬영/준비, upload 요청, server body/decode/DB/Drive, accepted 후 verified 재조회 시간을 분리한다.
- 필요 시 기간·접근이 제한된 진단 모드로 고정 단계명과 소요시간만 수집한다. 원본/filename/사용자·객실 ID/token/hash/URL/query는 수집하지 않는다.
- v34와 1차 적용본의 전체 시간/서버 시간 중앙값 및 p95, 성공률·중복·CAS 오류율을 비교한다. 작은 표본의 백분위는 성과로 발표하지 않는다.
- DB 대기가 우세하면 RPC 통합을 별도 설계한다. 현재 검증·lease·짧은 transaction 경계 보존과 migration 승인이 선행돼야 한다.
- cold WASM이 우세하면 import/초기화 측정부터 한다. 현재 decoder/OAuth는 worker 내 재사용 중이므로 중복 cache를 추가하지 않는다.
- region 최적화는 DB/호출 지역 차이가 확인된 경우에만 검토한다. 현재 요청이 서울에서 실행되므로 근거 없이 지역을 바꾸지 않는다.

## 완료 판정과 운영 경계

- 이번 source 검증: malformed/중복 batch 거부, 폴더 동시 생성 winner, shared 부모 거부, privacy 재검사,
  저장 후 실제 metadata 확인, 응답 유실/409/same-key 및 checksum fallback 회귀를 통과해야 한다.
- typecheck/test/build와 생성 Edge drift/check/bundle, 독립 QA, required CI를 통과한 뒤 dev로 통합한다.
- production 배포와 실제 지연 개선 확인은 별도 승인/실기기 gate다. 현재 단계에서 "운영 시간 단축 완료"로 표시하지 않는다.
- API/DB/Secrets 변경 없음. 되돌려도 정규화 bytes와 idempotency hash는 그대로다.
- 폴더 비공개 검사 생략, 무제한 동시 업로드, 인증/권한 cache, 클라이언트 Drive 직업로드, public URL 우회는 사용하지 않는다.
