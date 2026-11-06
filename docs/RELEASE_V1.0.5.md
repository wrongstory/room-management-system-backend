# v1.0.5 엘리베이터 동선 배정 수정

556·639호(C)와 623호(A)를 호수 숫자 차이 때문에 섞던 문제를 수정한다. 요금 차이 1객실 목표를 유지하면서 엘리베이터 → 층 → 호수 순으로 비교하고 구역별 인원 배분을 함께 탐색한다. 고정 업무·재청소 귀속·중복 객실 차단은 유지한다. UI는 기존 요약 카드에 실제 엘리베이터를 표시한다.

## 범위와 검증

- 기반 main d761e8e의 v1.0.4 알림 수정과 운영 migration152개를 보존한다. 이번 변경의 새 migration은 없다. 운영 API만 배포하고 다른 worker·알림 설정은 변경하지 않는다.
- core84개, 최종 main 기반 전체 품질234파일/6,366개·typecheck/build PASS. Edge 전체 검증은 PR에 실행 결과를 기록한다. 26객실·8명 회귀: 구역전환0·요금 차이≤30,000·층 이동합≤8. 실제 읽기 snapshot 재생은 요금 차이24,000, 실제 담당 쓰기0건.
- 350호 정정은 사용자 별도 확인으로 완료: 이전9월18일 미배정 target/원본 의무 취소, 최신9월22일 전체 행 유지, 감사1건. 재조회 snapshot에350호1건 확인. 예약/역사/수당은 보존한다.
- 사용자 승인 최종 전체 DB 1회 PASS: quality run42163687634 attempt1, 42분20초. fresh122→tip152·SQL/upgrade·정적 경고·KST clock·경합·cleanup·oracle·proof 모두 성공. proof `a9599c319342998efc0b6aa279fcb54927b2f5428c9fa6ce9ac81800dc39bc27`. main e62c114의 run42167968771은 동일 증거를 재사용했고 DB 재구축 없이 application/migration 모두 PASS.
- 전역 최적성을 보장하지 않으며 고정 업무 등으로 요금 목표 초과가 가능하다. 다른 과거 의무를 자동 취소하지 않는다.

## 운영 반영 결과

- [릴리스 PR610](https://github.com/wrongstory/room-management-system-backend/pull/610) 보호 squash 병합, tag `v1.0.5`. [전체 DB run](https://github.com/wrongstory/room-management-system-backend/actions/runs/42163687634), [main 동일 증거 검증](https://github.com/wrongstory/room-management-system-backend/actions/runs/42167968771).
- API62 ACTIVE/runtime1.0.5, health200, 익명 보호 조회401, 최신 main에서 다시 생성한161경로 OpenAPI와 운영 문서 일치. 내려받은 developer module을 같은 TS→JS 변환으로 비교해 릴리스 identity 일치 확인. API 직접 업로드413 후 동일 소스를 로컬 bundle(6.8MB)로 배포했다. 배포 DB 실행0회.
- 예약 scheduler24/photo-purge13/notification-delivery16/PIN-sync13의 버전 및 bundle hash 불변. migration152개/latest20261106010813 유지. Security Advisor는 기존 auth_leaked_password_protection WARN1개 동일, 신규 항목0.
- 화면 main5b005e1 배포 READY: SW2026-11-06-10, index SHA256 `ea290d2b5de5577f4f1993a84bb308c8a08971fdedf327c1d3947e5277a4fc22`. 기존 live runtime/feature flags 유지. 배포 파일4종 byte 일치, 익명 로그인/서비스워커5개 shell cache 및 관리자6·메이드4 화면4폭/콘솔 검사 PASS.
- 운영 읽기 snapshot의 내일26객실/9명 재생: 구역 혼합0, 요금48,000~60,000원(차이12,000원). 556/639/649=C,623=A. 실제 담당 저장·통보0건. 사용자 브라우저 사용과 탭별 제어 오류로 배포 후 실제 로그인 미리보기 클릭은 검증하지 않았다. 기존 사용자 초안은 보존했으며 새 화면에서 다시 자동 배정해야 한다.
- 이 dev 동기화는 릴리스 identity/증거만 옮긴다. dev의 이후 배정 전략·강제 회수 기능과 pending migration을 운영에 포함하지 않는다. 이번 dev PR은 manifest/application 검사이며 전체 DB 새 실행0회다.
- dev 동기화 검증: 로컬 기본 Node24 실행은 시간 제한/압축 byte 차이6건 실패로 기록했다. CI와 같은 Node22.23.4에서 기준 완화 없이 worker2개로 재실행해235파일/6,373개·typecheck/build PASS. 정적 secrets/OpenAPI/lint도 실행했으며 기존 경고101/정보77개는 수정하지 않았다. 이 dev 검사 결과를 운영 릴리스의 전체 DB 증거로 대신하지 않는다.
