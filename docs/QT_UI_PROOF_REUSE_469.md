# #469 Qt UI 안정화 및 한정 DB 증거 재사용

## 사용자 결정 (2026-10-22)

UI만 변경되고 DB/API 입력이 동일하면 기존 전체 DB 검증 증거를 재사용한다.
전체 DB 재실행은 금지한다. application/독립 QA/보호 병합은 유지한다.

## 원인과 보완 범위

main CI39697768379 attempt3는 Edge/application 소스 검사 후 Python/Qt
계정 생성 UI 테스트의 event loop에서 native segfault(exit139)로 종료됐다.
성공/실패/완료 callback의 GUI thread affinity와 receiver 수명을 보완한다.
로그인 및 계정 생성의 익명 widget callback을 QObject-bound queued Slot으로
교체한다. 파괴된 receiver에는 Qt가 연결을 끊으며 API 호출은 worker에 유지한다.
휴대전화/비밀번호 즉시 지움 및 한 번만 보여주는 동작을 유지한다.
관측한 crash stack만으로 모든 native crash의 단일 원인을 확정하지 않는다.
Windows/PySide6 6.10.3 최소 진단에서 기존 finished lambda도 GUI thread에서
실행됐다. 따라서 sender-thread 실행이 이번 crash의 확정 원인이라고 주장하지 않는다.
성공·실패·완료의 명시적 UI thread 실행과 삭제된 receiver의 늦은 callback 차단을
별도로 회귀 검증한다. 관련 Qt 계약: https://doc.qt.io/qtforpython-6.10/overviews/qtcore-signalsandslots.html

빠른 worker 완료에서 queued callback이 전달되기 전에 신호 소유 객체가 해제되는
4건을 추가 재현했다. dialog가 worker를 finished 처리까지 보존하고 이후 해제하도록
보완한 뒤 성공/실패 GUI thread 검사 4건이 통과했다. 삭제된 receiver 검사는 원본
4건 FAIL, 후보 4건 PASS로 확인했다. 이는 CI native crash 단일 원인의 확정은 아니다.

## 정책 bridge

- 이번 hotfix/qt-ui-proof-reuse → main과 그 병합 commit에만 적용한다.
- 기준 main a6af664b28c9df752b1f4ad21b5382733d9b09bf의 전체 v1 지문을
  #468 원본 proof 011aad8431e281707c23652036f238483febe433e0ced2a8bb11d24f0792d943과 대조한다.
- 원본 PR468/commit6619298/run39678174846 attempt1의 전체 DB 성공을 API로 확인한다.
  실패·취소·다른 attempt·증거 API 오류·재사용 표식만 있는 run은 거부한다.
- ui.py/test_ui.py 및 이번 gate/test 파일 네 개와 기존 서술 문서 제외만 허용한다.
  SQL/API/worker/의존성/lock/workflow 등 나머지 모든 Git mode/blob/path는 같아야 한다.
- 허용 파일 삭제/심볼릭 링크 전환도 거부한다. 비교 실패는 full DB 실행으로 fallback하지 않는다.
- gate 자체 변경은 이번 사용자 승인·독립 QA·보호 PR로 검토하며 일반적인 무제한
  UI 디렉터리 제외 규칙으로 확대하지 않는다. 이후 다른 릴리스는 기존 strict 정책을 따른다.
- 새 full proof를 생성하지 않고 원본 성공을 직접 참조한다.

## 현재 상태

로컬 Node 3132건(2 workers), gate 47건, Python 113건 PASS.
Python ruff/format/mypy 26파일 PASS. 독립 소스 QA P0/P1/P2 없음.
전체 DB NOT RUN(재실행 금지), 운영 migration/API 미실행. 원격 application CI는 대기.
프런트 사진 재시도 계약은 #464를 유지하며 최종 배포 성공 전 운영 반영으로 표시하지 않는다.
