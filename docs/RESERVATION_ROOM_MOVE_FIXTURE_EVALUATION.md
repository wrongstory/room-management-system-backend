# #393 예약 이동 fixture의 평가 경계

예약 이동 SQL 회귀 검사에서 비활성 예약을 조회하는 64번째 assertion이
`SOURCE_ROOM_VERSION_CONFLICT`로 중단됐다. #378 CI 37262541980 및 #318의
새 로컬 DB 전체 검사에서 재현됐으며, 109개 중 앞선 63개 assertion은 통과했다.

세 조회는 RPC 인자가 의존하지 않는 stay/segment 조인을 포함한다. RPC 호출 전에
정확한 예약·구간·객실·CAS 버전 조회가 완료되도록 MATERIALIZED CTE로 경계를 만든다.
대상은 same-instant checkout, cancelled reservation, A→B→A preview다.
원래 109개 assertion, 시각 조건, 권한, RPC 및 운영 migration은 유지한다.

원본 fixture의 canonical SHA256:
`1d8ad5563ab844394bcc99c59ae3e9d4af7ac0cca833c8115e13dede19555167`

수정 fixture의 canonical SHA256:
`7fa7d8d19e4d7ea3d8e8be5c4c86b1168dbd2059a92aa8a37514ceef4423089a`

## 검증

- #318 clock 수정 스키마104에서 default, join/from collapse=1,
  hash/merge join 비활성 세 설정 각각 실제 pgTAP 109/109 PASS.
- 각 실행은 transaction rollback 뒤 합성 fixture 잔여 데이터가 없음을 확인했다.
- 원본의 별도 EXPLAIN은 관찰 당시 RPC가 최종 조인 뒤에 있었다.
  따라서 실패 당시 실행 계획을 직접 포착한 증거로 사용하지 않는다.
- `npm run ci:quality`: 75파일/1,771 tests, typecheck, build PASS.
- 최신 dev104 fresh reset 및 전체 SQL: 82파일/5,119 tests PASS.
  원본 480개 파일 hash 불변을 확인했다. 전체 SQL 로그 SHA256은
  `d9741886757e249814895edd5b3e49b7832c449482b31435aa31ac413eb645ea`이다.
- 독립 QA 및 원격 CI: 진행 중.

최초 진단 보조 실행은 pgTAP search_path 준비 누락으로 중단됐다. 보조 runner의
transaction 안에서 pgTAP을 준비한 뒤 세 설정 검사를 완료했다.
이 변경은 테스트의 평가 순서만 고정하며 API 계약이나 운영 데이터에 영향을 주지 않는다.
