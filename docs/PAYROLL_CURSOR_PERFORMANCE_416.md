# #416 주급 목록 응답의 서명 키 준비 중복 제거

## 범위

2026-10-13 개발 후보, 운영 미배포. DB/migration/manifest/schema/API 변경 없음.
기존 PR449의 DB 집계 후보와 별개로 Edge 주급 목록 응답 조립 과정만 최적화한다.

최대10명 목록에 각 수익/지연 수익 cursor와 목록 cursor가 모두 있으면 서명21개가
필요하다. 기존에는 각 서명마다 WebCrypto key import를 수행했다. 한 응답의 encoder가
진행 중인 key import Promise를 공유한다. 서명 자체는 여전히21회이며 DB RPC는 기존1회다.
입력 cursor 검증용 key import는 별도이고 그 경로를 변경하지 않는다.
다음 페이지가 없으면 key import도 시작하지 않는다.

## 보존 계약과 안전 경계

- 전역 캐시 없음: encoder는 listPayroll 호출마다 생성하고 반환/실패 후 보존하지 않는다.
- actor/role/week/maid/kind/sort 범위, 토큰 v1/서명 알고리즘/출력 바이트/길이 제한 유지.
- 기존 DB 최신 권한 확인과 no-store, 응답 크기, 목록 순서·상한·금액은 변경하지 않는다.
- 매 서명 요청에서 현재 설정의 길이·다른 용도 키 재사용 금지를 재검사한다.
  키가 교체되면 새 키를 준비하고 삭제/불량 설정이면 실패한다.
- 실패한 준비 Promise는 현재 항목과 같을 때만 제거해 다른 키의 새 작업을 지우지 않는다.
- 키는 non-extractable이며 출력/로그/Git에 실키를 넣지 않는다.
- Node는 동기 HMAC 구조라 이번 변경 대상이 아니다. Swagger/ERD/DBML 계약 변경 없음.

## 검증

변경 전 Node 119파일/2991 tests PASS. 변경 후 ci:quality 2991/typecheck/build PASS.
Edge 첫 실행은 신규3파일 서식 검사 FAIL로 중단됐고 해당 파일만 정리해 재실행한다.
새 Deno 검사는21개 cursor의 키 준비1회·별도 요청격리·빈 cursor0회·기존토큰과 동일한
바이트·키교체/삭제/재사용 거부·공유 실패 후 재시도를 확인한다.
서식 보완 후 전체 Edge 검사 PASS(bundle19,305,239 bytes), 변경3파일 lint PASS.
독립 QA는 고정 Deno 환경에서 payroll-api.deno.ts 24 tests PASS, P0/P1/P2 없음이다.
21개 cursor 사례의 키 import1회와 다음 요청의 별도 import, 기존 바이트 동일성을 확인했다.
원격 CI 결과는 PR의 최신 checkpoint를 따른다.

단계 호출 수 감소는 전체 화면 응답시간 개선률이 아니다. 실제 DB 병목이나
주급 목록/송금 표시 별도 요청 간 중복은 이 변경으로 해결되지 않는다.
실제 성능 측정·기존 pending migration·운영 배포는 하지 않았다.
마이그레이션 실행 전 사전 승인 정책은 그대로다.

## 인계 및 롤백

프런트 변경/재연결 필요 없음. 운영 적용 후 같은 규모로 목록 응답시간을 비교한다.
문제가 있으면 기존 encodePayrollCursor 경로로 되돌리는 코드 릴리스가 가능하며
DB 롤백은 필요 없다. 운영 배포 자체는 이번에 수행하지 않는다.
