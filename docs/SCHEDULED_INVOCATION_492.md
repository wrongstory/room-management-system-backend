# #492 예약 호출의 장기 키 전달 제거

상태: source 후보. 운영 SQL, Function Secrets, Cron 변경·발송은 실행하지 않았다.
기존 배포의 기본 호출 방식은 유지하며 운영 전환은 구체 실행 승인 후 진행한다.

## 발견 근거와 범위

2026-10-25 production에서 pg_net queue SELECT 권한과 Cron 구조를 boolean/count만
조회했다. anon/authenticated/service_role에 queue SELECT 권한이 있고, 활성
`reservation-transition-every-minute`는 Vault `scheduler_invoke_secret`를
`x-scheduler-secret` 헤더에 전달한다. queue 행/실제 헤더 값/키는 조회하지 않았다.
이 관측은 실제 제3자 열람이나 유출 사고의 증명이 아니다.

[Supabase 공식 설명](https://supabase.com/kb/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net)은
queue 헤더의 역할별 가시성과 프로젝트별 권한 변경 미지원 경계를 명시한다.
queue 권한을 임의로 바꾸거나 기록을 지우지 않고, 새 호출에는 장기 키를 보내지 않는다.

## 계약

`SCHEDULER_INVOKE_MODE`, `NOTIFICATION_DELIVERY_INVOKE_MODE`,
`RESERVATION_BACKUP_MONITOR_INVOKE_MODE`는 미설정 또는 정확한 `legacy`이면 기존 방식,
정확한 `signed-v1`이면 새 방식이다. 다른 값은 서비스 설정 오류로 거부한다.
새 방식에서는 legacy 비밀 헤더가 함께 있어도 거부하며 자동 fallback하지 않는다.

서명은 HMAC-SHA256이며 입력은 아래 UTF-8 문자열이다. 마지막 LF는 없다.

```text
rms-scheduled-invocation-v1
<function>:<fixed-project>
<unix-seconds>
<16-byte-random-lowercase-hex-nonce>
POST
```

전송 헤더는 `x-rms-invoke-at`, `x-rms-invoke-nonce`, `x-rms-invoke-signature`다.
정수 시각과 고정 길이 소문자 hex만 허용하고 `-5초 <= 현재-서명시각 < 60초`를 검사한다.
nonce는 중복 기록 DB가 아니므로 이 시간창 안에서 **동일 고정 작업의 재생은 가능**하다.
서버 clock과 기존 DB claim/idempotency·알림 중복 억제를 계속 신뢰한다. 단일 사용 토큰이나
정확히 한 번 전송을 보장하지 않는다. 만료된 대기열 요청은 실패하며 창을 자동 연장하지 않는다.

| 함수/대상 | HMAC 키 | 호출 입력 |
| --- | --- | --- |
| reservation-scheduler / production | 기존 SCHEDULER_INVOKE_SECRET UTF-8 | POST·정확한 두 runtime 경로·query 없음. signed 모드에서는 본문 전체를 무시하고 서버 현재 분을 사용 |
| notification-delivery / production | 기존 NOTIFICATION_DELIVERY_INVOKE_SECRET UTF-8 | 기존 정확한 경로·query 없음·빈 본문 제한 유지 |
| reservation-backup-monitor / recovery | 기존 호출 키의 SHA-256 **binary digest** | 고정 recovery 상태 검사. 본문은 대상·시각·수신자를 바꿀 수 없음 |

backup의 `RESERVATION_BACKUP_MONITOR_KEY_SHA256`은 signed 모드에서 **인증 키**다.
이 digest도 공개 hash 메타데이터로 출력하면 안 된다. 기존 32-byte 난수 호출 키를
재설정할 필요 없이 기존 비공개 설정을 쓸 수 있다. DB 접속 비밀번호·백업 복호화 키·
service-role·GitHub token은 서명이나 queue 헤더에 쓰지 않는다.

## 설치 source와 실행 경계

| 파일 | 지정 대상 | 동작 | 기본 비활성/불변 |
| --- | --- | --- | --- |
| ops/reservation-scheduler/install-signed.sql | production | Vault 기존 키로 고정 서명을 만드는 private 함수 | 기존 Cron을 수정·정지·활성화하지 않음 |
| ops/notification-delivery/install.sql | production | private 서명 함수와 매분 Cron | 같은 transaction에서 Cron inactive. 기존 Vault 키가 정확히 1개 있어야 함 |
| ops/reservation-backup-monitor/install.sql | recovery | backup_ops 서명 함수·전용 Vault 키·매시17분 Cron | inactive, 기존 설치명 존재 시 중단 |

세 파일은 자동 migration 목록 밖의 운영 설치 후보다. 각 정확한 파일/hash·대상·영향을
승인받기 전 실행하지 않는다. 관리 도구의 project target을 고정하고 원격 상태·기존 이름을
재확인한다. 키 생성·교체·전달은 SQL source에 원문을 넣지 않는 별도 보호된 입력 경로를
검토해야 한다. production 읽기 확인에서 `notification_delivery_invoke` Vault 항목은 0개여서
현재 installer는 의도대로 실패한다. 기존 Function Secret 존재/값 일치는 아직 확인하지 않았다.
delivery/scheduler의 기존 Function Secret loader는 trim하므로 앞뒤 공백 없는 동일 키를
등록해야 한다. SQL helper도 앞뒤 whitespace 키를 거부하며 원문을 오류에 포함하지 않는다.

## 전환·중지 순서

1. 현재 main/worker 소스, 정확한 SQL, 키의 존재/일치와 알림 대상을 검토한다.
2. 과거 raw header 사용 키를 그대로 재사용할지 **호출 전용 키만 교체**할지 결정한다.
   교체는 기존 키의 과거 queue 가시성을 없애지 않지만 향후 인증 사용을 막는다.
   DB 비밀번호 재설정과 관계없으며 이미 완료한 백업 보안 입력을 다시 받지 않는다.
3. 승인된 SQL은 helper/비활성 job까지만 설치한다. 기존 scheduler 전환은 정확한 기존 job을
   잠시 정지한 뒤 signed-v1 설정·명령 변경·1회 검증·재개 순서로 별도 수행한다.
   새 notification/backup job도 실제 검증 뒤 마지막에 활성화한다.
4. 알림은 실제 대상에게 발송될 수 있고 예약 scheduler는 업무 상태를 바꾸므로 실제 smoke의
   범위·횟수·유효 시간을 고정한다. backup 감시는 실제 GitHub 알림 수신도 확인한다.
5. 실패 시 해당 job을 멈추고 상태를 조사한다. legacy로 자동 복귀하거나 오래된 요청을
   재전송하지 않는다. 관련 없는 Cron·backup 객체·queue 기록·업무 데이터는 삭제하지 않는다.

notification은 `net.http_post(body := NULL::jsonb)`로 빈 본문을 요청한다. 현재 pg_net 함수가
NULL을 받아 queue로 전달하는 source는 읽었지만 실제 hosted HTTP body parity는 **NOT RUN**이다.
SQL HMAC/WebCrypto parity·실제 clock/queue 지연·중복 claim·전환 중 미실행·첫 정기 실행까지
운영 확인해야 한다. 코드 검증만으로 이 항목이나 #492를 운영 완료 처리하지 않는다.

## 자동 검증

Node crypto 독립 HMAC oracle, 시간 경계/목적/키/nonce 변조, 잘못된 설정과 downgrade 거부,
세 handler의 positive/negative·기존 모드 회귀를 합성 검사한다. Deno는 모의 worker/RPC만
사용하고 실제 DB·Vault·provider에 연결하지 않는다. 전체 application·Edge·독립 QA와 required
CI 결과는 PR의 exact source에 기록한다. 실제 SQL/운영/알림 수신은 별도 승인 대기다.

Refs #14, #112, #12, #492.
