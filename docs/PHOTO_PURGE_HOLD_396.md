# 사진 삭제 보류의 실행 경계 — #396

사용자의 사진 삭제 보류를 배포 source 진입점에 명시한다. 이 변경은 실제 배포나
운영 설정 변경이 아니며, 현재 호스트의 Cron/secret/worker 상태를 확인했다고 주장하지 않는다.
미배포 source가 현재 실행 중인 worker를 멈추거나 기존 요청의 완료를 증명하지도 않는다.

변경 전 `photo-purge` entry는 유효한 invoke secret과 빈 POST를 받으면 DB client와 Drive
provider를 만들고 기존 삭제 worker를 실행했다. 변경 후 해당 entry는 정확한 POST 경로에서
`503 PHOTO_PURGE_HELD`와 `no-store`를 반환한다. header/body, 환경변수와 credential을 읽지
않고 DB claim·heartbeat·provider 호출을 시작하지 않는다. 삭제뿐 아니라 orphan/빈 폴더
정리도 이 경계에서 함께 보류된다. 다른 경로·query는 404, 다른 method는 405다.

해제하는 env mode, 요청 Boolean, secret, 새 승인 정책은 추가하지 않는다. 기존 순수 worker와
legacy handler source는 회귀·향후 검토를 위해 보존하지만 배포 entry에서 연결하지 않는다.
해제는 별도 사용자 결정과 검토된 source 변경을 요구하며 이 변경 자체로 해제 권한을 만들지 않는다.
사진 보존 기간, 저장·열람·업로드·제출 계약이나 실제 삭제 알고리즘도 바꾸지 않는다.

배포 후에는 기존에 purge를 호출하던 감시자가 정상 결과 대신 명시적 HOLD 503을 받게 된다.
이 실패 응답을 성공 heartbeat로 기록하거나 삭제 backlog가 없다는 뜻으로 해석하지 않는다.
운영자는 실제 배포 source, 이미 실행 중이던 작업의 종료, 외부 직접 호출과 스케줄을 별도
관측해야 한다. owner SQL/직접 Drive 삭제/legacy source 실행까지 막는 전역 coverage 증거가 아니다.

Node와 실제 Edge entry의 합성 테스트는 header/body 접근이 예외를 던져도 HOLD가 유지되는지,
유효해 보이는 secret·unlock flag·alias가 실행 경로가 되지 않는지 검사한다. 기존 worker 회귀는
fake provider로 계속 실행한다. 실제 DB/SQL/TLS/Drive 호출, 삭제, secret 조회 및 배포는 NOT RUN이다.

2026-10-25 source 검증: 전체 `ci:quality` PASS(176 files / 4,809 tests,
typecheck/build 포함), 전체 Edge PASS(65 / 560 / 68, report 19,894,903 bytes,
backup 99,006 bytes), 독립 검토와 관련 2파일 37 tests PASS. 정본 photo generator와
기존 report artifact 입력 검사가 통과했고 source134 migration/hash는 변경하지 않았다.
