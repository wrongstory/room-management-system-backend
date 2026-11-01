# v0.9.10 이번 주 근무가능일 승인

## 범위와 승인

2026-11-02 사용자는 메이드도 이번 주 근무가능일을 수정 요청하되 관리자 승인을
받도록 결정했고, 구현·dev 병합 뒤 DB 검증과 운영 반영 진행을 명시적으로 승인했다.
이번 승인 대상은 이 기능의 격리 CI 최종 DB 검증과 운영 DB/API/프런트 반영이다.

운영 기준 main `d3ecff164d99eba8837d14d302ca213e4be17353`의 기존124개 migration에
이번 기능1개만 더한 hotfix다. 별도 PR553의 v1.0.0/초기화·사진·메모 등 미배포
개발 기능을 포함하지 않는다. 기존 운영 이력의 timestamp 차이를 repair하거나
전체 dev migration을 db push하지 않는다. 새 migration의 source SHA-256은
`2fc3eac43ef780f8ea00eaf79c51e07f9384645a33b74d727f5412269cdac5f2`다.

## 동작

- 이번 주 직접 제출은409 `AVAILABILITY_APPROVAL_REQUIRED`, 변경 요청 후 관리자 승인으로 반영한다.
- 최초 미제출 주도 sourceVersion0으로 요청할 수 있다. 승인 전 기존 가능일/배정 후보는 유지한다.
- 지난 날짜 변경, 메이드 자기 승인, 오래된 CAS, 통보 배정 충돌은 차단한다.
- 다음 주 직접 제출은 유지한다. 기존 이력·감사·멱등성 및 RLS를 보존한다.
- 운영 branch에는 HTTP admission helper가 없으므로 같은 SQL이 helper를 생성하더라도
  PUBLIC/anon/authenticated의 실행 권한을 명시적으로 회수한다. 업무 endpoint를 추가로 열지 않는다.

## 검증과 반영 순서

로컬 타입/빌드/전체 Node3172검사(새 검사 기대문구1건 수정 후 해당 파일 재검사),
availability Edge33검사, lint/secret/OpenAPI/manifest125 검사를 통과했다.
실제 SQL/upgrade/경합은 hotfix→main PR의 기존 quality 전체 DB job에서1회 검증한다.
그 성공과 exact input proof, 필수 application/migration 및 보호 병합을 확인하기 전
운영 migration은 실행하지 않는다. 실패 시 증거를 보존하고 재실행 여부를 별도 보고한다.

main 병합 뒤 동일 입력 proof 재사용을 확인하고 운영124개 이력/새 pending1개와
Security Advisor를 재확인한다. 새 SQL/이력의 원자적 적용 후 함수 정의·제약·권한·
이력을 읽기 검증하고 API→Swagger/프런트를 배포한다. health/OpenAPI/CORS·배포 byte와
합성 브라우저 시나리오를 확인한다. 실제 메이드/관리자 업무 요청은 생성하지 않는다.
완료 전 DB 성공·운영 적용·실계정 UAT를 완료로 표시하지 않는다. hotfix는 별도 PR로 dev에 반영한다.
