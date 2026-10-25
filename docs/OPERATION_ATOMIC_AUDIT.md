# 감사와 읽음 상태의 원자 진입 (#396, source 131)

민감 정보 GET, 로그인 실패, 권한 거절도 감사 기록을 쓰므로 HTTP 변경 메서드 목록만으로
초기화 장벽을 만들 수 없다. 이 단위는 기존 감사 3개와 알림 읽음 1개 RPC를 유한 목록으로
감싸 동일 DB transaction 안에서 진입·원래 효과·완료를 함께 처리한다. 실제 적용·활성화·삭제는 없다.

`execute_operation_atomic_rpc`는 service_role 전용이다. 이름·필수/선택 인수와 8KiB 입력을 검사하고
control row를 잠근 상태에서 target/version/lifecycle/maintenance를 재검사한다. 설정된 control은
128의 admission을 먼저 만든 뒤 원래 RPC를 실행하고 완료한다. 오류는 효과와 admission을 함께
rollback한다. 원래 권한·입력 검사는 그대로 적용하며 실패 로그인에 유효한 활성 세션을 새로 요구하지 않는다.
선택한 시각 인수가 없으면 기존 DB 시각 기본값을 사용하고, 명시적 null은 원래 오류를 보존한다.
임의 SQL·RPC·권한 승격·별도 completion 호출은 허용하지 않는다.

Node 정본 `operation-atomic-rpc.ts`를 generator로 Edge에 복사한다. 실제 전역 설치는 HTTP 연동
단위에서 인증 전 수행하며 unwrapped transport를 사용해 재귀 호출을 막는다. 읽음 RPC에는
일반 OPAQUE admission을 중복 발급하지 않는다. Node/Edge 연결 전 이 파일만으로 coverage를 주장하지 않는다.

server opt-in이 꺼져 있으면 기존 업무 계약을 유지한다. required mode에서는 관측 RPC와 효과 RPC가
하나의 로컬 deadline을 공유하고, transport가 AbortSignal을 무시해도 무한 대기는 하지 않는다.
응답 오류와 제한 시간 초과는 고정 unavailable 코드로 종료하고 효과를 자동 재시도하지 않는다.
이는 이미 실행 중인 DB statement의 취소 확인이 아니다. 함수의 SET statement_timeout만으로
호출 statement 전체의 서버 deadline을 증명하지 않으며 실제 hosted timeout·경합 검증은 남아 있다.

control 부재 관측도 같은 효과 transaction에서 다시 확인한다. 부재 때에는 원래 동작만 수행하며
준비 완료 receipt를 만들지 않는다. control의 최초 설치와 진행 중 요청 사이의 전환은 별도 drain
절차가 필요하다. 설정된 UNKNOWN/REQUESTED/다른 target/version이면 효과를 실행하지 않는다.
감사를 조용히 버린 뒤 요청 성공으로 돌려주는 우회는 없다.

합성 검증은 네 RPC의 반환·기본값, 변조된 인수/관측, 변경된 control, 응답 유실, 공통 시간 예산,
원본 도메인 오류 보존과 생성 소스 일치를 확인한다. PG15/17 AST 검사는 외부 SQL 문법 검사이며
PL/pgSQL 실행·RLS·경합 증거가 아니다. 준비된 pgTAP는 승인된 최종 전체 DB 검증에 포함한다.
실제 DB/Auth/provider 호출, SQL 적용, 운영 활성화와 초기화는 NOT RUN이다.
