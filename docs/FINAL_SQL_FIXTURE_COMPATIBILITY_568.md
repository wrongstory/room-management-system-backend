# #568 최종147 SQL fixture 정합성

## R5 실제 결과와 최종 소스 지문 보완

승인된 FINAL-147-R5 후보1c5751f의 run41393708726 attempt1은 FAIL이다.
28개 upgrade는 모두 PASS이고, 최종 SQL118파일/6482개 중 단1개 assertion이 실패했다.
`db_static_warning_remediation.sql`의 첫 검사(81개 중1개)이며 나머지117파일은 PASS다.
이전13개 실패 파일 중12개는 전체 PASS이고, photo batch의 실제44개/plan도 PASS다.
후속 static-warning upgrade/KST/직접경합12/proof는 NOT RUN·artifact0이다.
Stop은 PASS이며 Supabase volume은 보존됐다. 전체 잔여0 census나 추가 DB 실행은 없다.

실패한 검사는 함수 `public.list_cleaning_inspections_page(uuid,uuid,timestamptz,uuid,integer)`의
최종 본문을 과거101의 MD5 `a8138f7f69f796fc0dd1d8d7d8b72569`와 비교했다.
승인된 #532의 migration138이 취소된 청소를 검수 대기에서 제외하는 WHERE 필터를
같은 함수에 추가하므로, 최종 정본은 `69f85dd6e4dc95fd1b17973e7fe8e5cc`다.
원본 pagination 함수 →101 미사용 변수 제거 →138 정확한 필터 치환을 소스에서 재현해
각 단계의 지문과 실제 관측값을 대조했다. 최종 SQL 검사만 새 정확값과 설명으로 정정한다.
이 변경은 함수나 migration의 변경이 아니며 다른 본문을 허용하는 예외도 추가하지 않는다.

역사적100→101의 별도 runner는 기존 LF/CRLF 정본·정확지문·15개 무단변경 거부를
그대로 유지한다. DB 없는 회귀 검사는 원문 migration에서 최종 본문을 재구성하고,
최종 SQL과 역사적 runner가 서로 다른 정확한 정본을 검사하는지 확인한다.
아래는 R4 후 보완 당시의 분석/검증 이력이며 실제 R5 결과는 이 절이 우선한다.
이번 추가 보완 입력의 실제 DB 재검증은 NOT RUN이다. 새 실행은 별도 승인받는다.

FINAL-147-R4의 실제 run41380296381 attempt1은 28개 upgrade PASS 후 최종SQL에서 실패했다.
118파일·6017 TAP관측 중13파일 불성공: SQL중단9, assertion실패파일3/10건,
단독plan불일치1이다. 앞20/21 메모·일정 보완은 실제 PASS였다.
후속static/KST/직접경합/proof는 미실행이며 성공증거는 없다.

## 원인과 보완

| 구분 | 파일/대상 | 보완 및 유지 계약 |
|---|---|---|
| 메모 내부 기본표식 | warning fixture/ledger/room change/work history | replica 모드는 BEFORE trigger를 끄므로 빈문자 INSERT 기본표식이 CHECK에 걸린다. 기존6개 INSERT 값/열을 CTE로 유지하고 rowtype에 명시NULL을 채운다. CHECK/트리거 상태·RPC는 유지한다. |
| Auth AMR | developer_operation_reauth | 필수 claim ID를 기존 합성 UUID 생성기로 지정한다. password AMR·nonce·fresh session 검사를 유지한다. |
| 개발자 보호 | preview/receipt/S1 | 금지된 password-state UPDATE는 보호 오류 자체를 검증한다. 정상적으로 변할 수 있는 session 만료/lock으로 최신 인증 거부와 post-write 전체rollback을 검사한다. |
| 정식 객실 유형 | S1 | 기존standard ID를 재사용한다. 빈template/slot 전제를 확인하고 원본 전체snapshot·room types 보존, source retirement 외 필드 불변·새1버전/3슬롯을 검증한다. 기존 게시본을 강제 퇴역시키거나 객실 유형을 추가하지 않는다. |
| 예약 시간 | READY | 한 번 캡처한 분단위 시각으로 두 예약 호출을 구성한다. 기존예약충돌 재현→확인정정→예약성공 oracle는 유지한다. |
| 설치 후속 함수 | limited-session discovery | 승인된5개 signature/OID·helper횟수·volatility·owner·ACL·proconfig를 정확히 추가한다. 원래101의6/18/core2 및 unknown overload 거부는 유지한다. |
| password provenance | offline admission | 원문 암호 복원도 version을 새로 발급한다. 변경과 예상거절을 throws_ok의 동일subtransaction으로 묶어 모두롤백한다. 예상외 성공도 다른오류로롤백해후속사례를오염시키지않는다. 최신version검사는 유지한다. |
| TAP 상태 | photo batch | no_plan 캐시는rollback되지만 출력43개는남는다. 기존43개 assertion은그대로이고 마지막rollback밖에서전체상태복원 SHA256을검증하는1개를추가한다. 실제TAP44/plan성공은미확인이다. |
| 감사 종류 | room status | 기존정본73+승인된2종=75의 정확한중복없는목록으로정정하고 OpenAPI enum과 source test를결합한다. >= 완화는없다. |

## 과거 fixture와 보안 경계

`jsonb_populate_record`는 pre140 rowtype에 없는 memo 키를 무시하며 JSON null을 SQL NULL로
채운다([PostgreSQL17 정본](https://www.postgresql.org/docs/17/functions-json.html)).
원래 INSERT의 열/SELECT/VALUES는 동일하다. 제공되던 id/is_current를 보존하고,
생략되던 비NULL 기본값 created_at=now()도 명시적으로 보존한다.
공유 pre110 upgrade·경합 fixture 경계와 그 외 SQL문은 바꾸지 않는다.

제품API·원문migration·권한·보호함수·업무정책 변경은 없다. 테스트를 삭제하거나 보호
trigger/constraint를 끄거나 원장/nonce/receipt 검사를 생략하지 않는다.
S1은 fresh fixture의 단일 현재게시본 전제를 명시한다. 다수게시본을 임의로퇴역시키거나
객실유형code를발명하지 않는다. 전체reset 공개실행·사진HOLD·운영백업 범위도변경없다.

## 검증과 미실행

- PG15/17 AST로6개 INSERT의 원래 열/값과 나머지SQL을 대조했다.
- PG17 outer AST·savepoint 이후 실제oracle·password subtransaction·최신OpenAPI parity와
  JSON연산자결합순서를 DB 없이 검사한다. AST는 schema/type/runtime 성공증거가 아니다.
- 관련 독립source QA와 typecheck/lint/전체Node/build를 수행한다.
- 새입력의 실제SQL/PLpgSQL/과거interval/경합은 NOT RUN이다. R4 결과는 FAIL 그대로다.
- 새동결입력·도구·범위·정리의 정확한 승인 뒤 최종DB1회가 필요하다. 운영migration도별도승인이다.

Refs #563, #534, #396, #532, #431
