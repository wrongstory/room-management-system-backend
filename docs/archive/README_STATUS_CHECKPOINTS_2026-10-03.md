# README 과거 상태 checkpoint — 2026-10-03 정리

이 문서는 정리 전 README 머리말의 원문 내용을 보존하며 상대 링크만 이동 위치에 맞게 재기준화한다. 아래 소스/운영 수치와 후보·PENDING 표현은 각 작성 시점의 이력이며 현재 운영 정본이 아니다. 현재 상태는 README·API_STATUS_MATRIX 및 해당 exact-head PR/릴리스 readback을 따른다. 기존 FAIL 이력이나 사용자 UAT 결과를 소급 변경하지 않는다.

# CASTLE THE ART 객실관리 백엔드

> 2026-10-03 #331 구현 후보: #324 [PR #359](https://github.com/wrongstory/room-management-system-backend/pull/359)가 통합된 `dev@8481e219d7fbd92fe3587081efca9f3bc632bba6`/98 migrations를 기준으로 송금 표시 on/off와 금액 근거 재확인 API를 추가했다. 후보는 99 migrations·137 paths/148 operations이며, 실제 지급 원장은 변경하지 않는다. 검증·독립 QA·CI·통합 상태는 [표시 계약](../PAYROLL_REMITTANCE_MARKER.md)을 따른다. 아래 과거 dev/운영 수치는 당시 checkpoint이며 이번 작업의 운영 배포를 뜻하지 않는다.

> 2026-10-03 최신 기준: #325는 [PR #358](https://github.com/wrongstory/room-management-system-backend/pull/358), source `78582789ce66a92d9aae3072b7b8fbc6d5fa9843` → dev squash `d65f4f600f856bd990b52762cf57530830970f12`로 source/dev 완료했다. exact tree CI `37093733970` application/migration PASS·독립 QA98/100이며 초기 CI 실패는 이력으로 보존한다. 아래 #325 후보 표현은 과거 checkpoint다. 현재 #324의 객실별 확정/미확정 주급 근거 조회는 이 dev/97 migrations에서 시작한 후보이며 [조회 계약](../PAYROLL_WORK_DETAILS.md)을 따른다. 운영·프런트·main·recovery는 변경하지 않는다.

> 2026-10-03 현재: #327은 [PR #357](https://github.com/wrongstory/room-management-system-backend/pull/357)의 source `22cbf0be9ed2c5e228e6c5091059c2052a61adce` → dev squash `b6f799811416fad6f80dba3d721ba279159c0aa8`로 완료했다. source/dev/CI merge tree 동일, required CI `37086130779` application/migration PASS·독립 QA98/100이다. 아래 #327 후보·#328 Draft 문구는 과거 checkpoint다. #325는 이 dev/96 migrations에서 최신 주급 조정 원장 CAS 조회를 추가하는 별도 후보다. [조회 계약과 검증 상태](../PAYROLL_ADJUSTMENT_BOOK.md)를 따르며, 운영·프런트 제공 완료를 뜻하지 않는다.

`room-management-system` 정적 와이어프레임을 실제 운영 서버로 전환하기 위한 TypeScript 백엔드입니다. 인증 경계, 단일 개발자와 관리자·메이드 개별 계정 수명주기, 객실·예약 원자 명령, Supabase 스키마·RLS, 121개 객실 초기 마스터와 자동 테스트가 들어 있습니다.

운영 Git 정본은 `main@10a1f814649e92260e9e7353ab242400311b429e`이고, 최신 기능 통합 지점은 `dev@1a28263567b44661a1d6fdc3e4f99be8f55ff8de`입니다. 개발 정본은 79 migrations / OpenAPI `0.5.1` 129 paths / 139 operations이며 #256 사진 정규화, #250 진행 중 메이드의 후속 계획 허용, #264 수행 불가 취소·재배정을 포함합니다. 마지막으로 검증된 운영 API는 78 migrations, Supabase `api` ACTIVE v24, OpenAPI `0.5.1` 128 paths / 138 operations이며 Pages도 그 배포본과 artifact parity를 완료했습니다. 기존 관리자 UAT에서 예약 가능 미리보기의 `guestCount` 생략·`null`·양수와 예약 현황 인원 표시, 객실 유형별 최소·최대 인원 적용을 확인했습니다. 개발 정본의 후속 기능은 release 승격 전까지 운영 API에서 사용할 수 없고, `v0.5.1` tag와 GitHub Release도 아직 발행하지 않았습니다.
