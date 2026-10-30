# #543 비밀번호 효과 반영 후 완료 기록 누락

2026-10-31: 변경된 비밀번호로 로그인은 사용자 확인 완료. 재변경은 미완료 receipt 때문에409.
운영 최근 관리자 요청의 Auth version은 effect marker와 일치하고 원 세션은 존재하지 않는다.
이는 #535 반환값 누락/미실행 복구와 다른 단계다. 새 문의번호9347eeac-ecd2-4a4b-8634-9520540052d1의 개별로그연결은 미확인이다.

## 수정 후보

공통 assert/inspect/prepare의 최신세션 검사는 그대로다. complete만 활성계정·Auth연결·원sessiondigest·request hash·claim을 묶고 Auth사용자/shadowversion 잠금 아래 실제effect를 검증한다.
원세션이 없을 때는 auth_pending과 아직유효한lease가 필수이며 잠금대기후 재확인한다. reset준비/다른version/NULL fingerprint/다른session/비활성계정은 거부한다.
기존 gate·감사·receipt 완료와 다른세션종료를 동일transaction으로 처리한다. 새세션이나토큰은 생성하지 않는다.
세션이없어진뒤204라면 후속auth/me401은 새비밀번호재로그인 안내로 처리한다. 프런트기존 passwordChanged 분기는 이 흐름과 호환되며 일반409안내는 frontend271에인계한다.

## 운영 복구 경계

기존 관리자 pending은 이미lease만료이므로 새완료RPC에 그대로재전송하지않는다. #535 unstarted helper도 적용금지다.
별도효과증명 운영복구는 exactreceipt/생성·변경시각/Authversion/감사없음/reset없음과 요청종료를 확인하고 gate·감사·receipt를 원자적으로 완료해야 한다. 세션정리 영향과 실행범위 승인 전에는 운영자료를 변경하지 않는다. 현재 복구 실행파일은 아직 미작성이다.

## 검증 상태

새 migration124 (운영 main123 기반) 작성만 완료. manifest/source 검사 가능, 실제SQL/경합/운영migration/계정복구 NOT RUN.
전체DB는 최종릴리스에서 새입력에 대한 사전승인 후1회만 실행한다. #537의 다른입력 성공을 이 후보에 재사용하지 않는다.
최초 dev142 후보는 소스5666/독립QA233 PASS이나 Edge크기초과로FAIL. dev후보를stash로보존하고 운영main123+수정1로분리했다. 긴급후보 ci:quality 전체3169 PASS, 추가exact-source 관련161 PASS, Edge전체PASS(bundle19,431,880 bytes), 독립QA204 PASS. 실제DB는NOT RUN.
독립QA의 NULL hash 및효과변경/reset/inconsistent/cross-auth 음성검사 보완 반영. 소스전체/Edge 검증결과는 issue543에기록한다.

Refs: #543, #535. 공개API/Swagger계약 변경없음. 운영반영전완료로표기하지않는다.
