begin;

create temporary table availability_test_results (
  test_number integer primary key,
  description text not null,
  passed boolean not null
);

insert into auth.users (id) values
  ('12000000-0000-4000-8000-000000000001'),
  ('12000000-0000-4000-8000-000000000002'),
  ('12000000-0000-4000-8000-000000000003'),
  ('12000000-0000-4000-8000-000000000004'),
  ('12000000-0000-4000-8000-000000000005');

insert into public.profiles (
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status
) values
  (
    '22000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001',
    '가능일 관리자', '가능일 관리자', '가능일 관리자', '가능일 관리자', 0, 'admin', 'active'
  ),
  (
    '22000000-0000-4000-8000-000000000002',
    '12000000-0000-4000-8000-000000000002',
    '가능일 메이드1', '가능일 메이드1', '가능일 메이드1', '가능일 메이드1', 0, 'maid', 'active'
  ),
  (
    '22000000-0000-4000-8000-000000000003',
    '12000000-0000-4000-8000-000000000003',
    '가능일 메이드2', '가능일 메이드2', '가능일 메이드2', '가능일 메이드2', 0, 'maid', 'active'
  ),
  (
    '22000000-0000-4000-8000-000000000004',
    '12000000-0000-4000-8000-000000000004',
    '비활성 메이드', '비활성 메이드', '비활성 메이드', '비활성 메이드', 0, 'maid', 'inactive'
  ),
  (
    '22000000-0000-4000-8000-000000000005',
    '12000000-0000-4000-8000-000000000005',
    '업로드 전용 메이드', '업로드 전용 메이드',
    '업로드 전용 메이드', '업로드 전용 메이드', 0, 'maid', 'upload_only'
  );

do $$
declare
  v_first_id uuid;
  v_retry_id uuid;
  v_change_id uuid;
  v_decision_id uuid;
begin
  begin
    perform private.submit_weekly_availability_at(
      '22000000-0000-4000-8000-000000000002', '2026-08-31',
      array['2026-08-31'::date], 0, 'availability-boundary-1159',
      '2026-08-30 11:59:59+09'
    );
    insert into availability_test_results values (1, 'Sunday 11:59 is outside the submission window', false);
  exception when others then
    insert into availability_test_results values (
      1, 'Sunday 11:59 is outside the submission window', sqlerrm like '%OUTSIDE_AVAILABILITY_WINDOW%'
    );
  end;

  select (private.submit_weekly_availability_at(
    '22000000-0000-4000-8000-000000000002', '2026-08-31',
    array['2026-08-31'::date, '2026-09-02'::date], 0,
    'availability-submit-maid1-v1', '2026-08-30 12:00:00+09'
  )).id into v_first_id;
  insert into availability_test_results values (
    2, 'Sunday 12:00 creates version one',
    (select version = 1 and is_current from public.availability_versions where id = v_first_id)
  );
  insert into availability_test_results values (
    3, 'each submitted version stores all seven explicit weekdays',
    (select count(*) = 7 and count(*) filter (where available) = 2
      from public.availability_days where availability_version_id = v_first_id)
  );

  select (private.submit_weekly_availability_at(
    '22000000-0000-4000-8000-000000000002', '2026-08-31',
    array['2026-08-31'::date, '2026-09-02'::date], 0,
    'availability-submit-maid1-v1', '2026-08-30 12:00:00+09'
  )).id into v_retry_id;
  insert into availability_test_results values (
    4, 'an exact idempotent retry returns the original version',
    v_retry_id = v_first_id and (
      select count(*) = 1 from public.availability_versions
      where maid_profile_id = '22000000-0000-4000-8000-000000000002'
        and week_start = '2026-08-31'
    )
  );

  begin
    perform private.submit_weekly_availability_at(
      '22000000-0000-4000-8000-000000000002', '2026-08-31',
      array['2026-09-01'::date], 0,
      'availability-submit-maid1-v1', '2026-08-30 12:01:00+09'
    );
    insert into availability_test_results values (5, 'idempotency key reuse with another payload is rejected', false);
  exception when unique_violation then
    insert into availability_test_results values (
      5, 'idempotency key reuse with another payload is rejected', sqlerrm like '%IDEMPOTENCY_KEY_REUSED%'
    );
  end;

  begin
    perform private.submit_weekly_availability_at(
      '22000000-0000-4000-8000-000000000002', '2026-08-31',
      array['2026-09-01'::date], 0,
      'availability-stale-maid1', '2026-08-30 12:02:00+09'
    );
    insert into availability_test_results values (6, 'stale expectedVersion is rejected', false);
  exception when serialization_failure then
    insert into availability_test_results values (
      6, 'stale expectedVersion is rejected', sqlerrm like '%STALE_VERSION%'
    );
  end;

  perform private.submit_weekly_availability_at(
    '22000000-0000-4000-8000-000000000002', '2026-08-31',
    array['2026-09-01'::date, '2026-09-03'::date], 1,
    'availability-submit-maid1-v2', '2026-08-30 23:59:59+09'
  );
  insert into availability_test_results values (
    7, 'Sunday 23:59 creates a new current version and preserves version one',
    (select count(*) = 2 and count(*) filter (where is_current and version = 2) = 1
      and count(*) filter (where status = 'superseded' and version = 1) = 1
      from public.availability_versions
      where maid_profile_id = '22000000-0000-4000-8000-000000000002'
        and week_start = '2026-08-31')
  );

  begin
    perform private.submit_weekly_availability_at(
      '22000000-0000-4000-8000-000000000002', '2026-08-31',
      array['2026-08-31'::date], 2,
      'availability-boundary-monday', '2026-08-31 00:00:00+09'
    );
    insert into availability_test_results values (8, 'Monday 00:00 rejects normal submission', false);
  exception when others then
    insert into availability_test_results values (
      8, 'Monday 00:00 rejects normal submission', sqlerrm like '%OUTSIDE_AVAILABILITY_WINDOW%'
    );
  end;

  begin
    perform private.submit_weekly_availability_at(
      '22000000-0000-4000-8000-000000000004', '2026-08-31',
      array['2026-08-31'::date], 0,
      'availability-inactive-maid', '2026-08-30 12:00:00+09'
    );
    insert into availability_test_results values (9, 'inactive maid submission is rejected', false);
  exception when insufficient_privilege then
    insert into availability_test_results values (
      9, 'inactive maid submission is rejected', sqlerrm like '%ACTIVE_MAID_REQUIRED%'
    );
  end;

  begin
    perform private.submit_weekly_availability_at(
      '22000000-0000-4000-8000-000000000005', '2026-08-31',
      array['2026-08-31'::date], 0,
      'availability-upload-only', '2026-08-30 12:00:00+09'
    );
    insert into availability_test_results values (10, 'upload-only capability cannot submit availability', false);
  exception when insufficient_privilege then
    insert into availability_test_results values (
      10, 'upload-only capability cannot submit availability', sqlerrm like '%ACTIVE_MAID_REQUIRED%'
    );
  end;

  perform private.submit_weekly_availability_at(
    '22000000-0000-4000-8000-000000000003', '2026-08-31',
    array['2026-08-31'::date, '2026-09-04'::date], 0,
    'availability-submit-maid2-v1', '2026-08-30 12:05:00+09'
  );

  select (private.request_availability_change_at(
    '22000000-0000-4000-8000-000000000002', '2026-08-31',
    array['2026-08-31'::date, '2026-09-04'::date], 'SCHEDULE_CHANGED', 2,
    'availability-change-maid1', '2026-08-31 00:00:00+09'
  )).id into v_change_id;
  insert into availability_test_results values (
    11, 'post-deadline change creates a pending immutable request',
    (select status = 'pending' and source_version = 2
      from public.availability_change_requests where id = v_change_id)
  );

  begin
    perform private.request_availability_change_at(
      '22000000-0000-4000-8000-000000000002', '2026-08-31',
      array['2026-09-02'::date], 'ANOTHER_CHANGE', 2,
      'availability-change-maid1-second', '2026-08-31 00:01:00+09'
    );
    insert into availability_test_results values (12, 'a second pending request for the week is rejected', false);
  exception when unique_violation then
    insert into availability_test_results values (
      12, 'a second pending request for the week is rejected', sqlerrm like '%PENDING_CHANGE_REQUEST_EXISTS%'
    );
  end;

  select (private.decide_availability_change_at(
    '22000000-0000-4000-8000-000000000001', v_change_id, 'approved',
    'STAFFING_CONFIRMED', 2, 'availability-decision-maid1', '2026-08-31 08:00:00+09'
  )).id into v_decision_id;
  insert into availability_test_results values (
    13, 'administrator approval creates version three and records the decision',
    v_decision_id = v_change_id
      and (select status = 'approved' and approved_version_id is not null
        from public.availability_change_requests where id = v_change_id)
      and (select count(*) = 1 from public.availability_versions
        where maid_profile_id = '22000000-0000-4000-8000-000000000002'
          and week_start = '2026-08-31' and is_current and version = 3)
  );

  perform private.decide_availability_change_at(
    '22000000-0000-4000-8000-000000000001', v_change_id, 'approved',
    'STAFFING_CONFIRMED', 2, 'availability-decision-maid1', '2026-08-31 08:00:00+09'
  );
  insert into availability_test_results values (
    14, 'an exact decision retry does not create another version',
    (select count(*) = 3 from public.availability_versions
      where maid_profile_id = '22000000-0000-4000-8000-000000000002'
        and week_start = '2026-08-31')
  );

  begin
    perform private.decide_availability_change_at(
      '22000000-0000-4000-8000-000000000001', v_change_id, 'rejected',
      'STAFFING_REJECTED', 2, 'availability-decision-maid1', '2026-08-31 08:01:00+09'
    );
    insert into availability_test_results values (15, 'decision key reuse with another payload is rejected', false);
  exception when unique_violation then
    insert into availability_test_results values (
      15, 'decision key reuse with another payload is rejected', sqlerrm like '%IDEMPOTENCY_KEY_REUSED%'
    );
  end;
end;
$$;

insert into availability_test_results values (
  16,
  'availability commands persist canonical request hashes in the audit ledger',
  (
    select count(*) = 5
      and bool_and(length(after_state ->> 'requestHash') = 64)
    from public.audit_events
    where event_type like 'availability.%'
  )
);

insert into availability_test_results values (
  17,
  'authenticated and anon roles cannot mutate availability tables directly',
  not has_table_privilege('authenticated', 'public.availability_versions', 'INSERT')
    and not has_table_privilege('authenticated', 'public.availability_days', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.availability_change_requests', 'DELETE')
    and not has_table_privilege('anon', 'public.availability_versions', 'SELECT')
);

select '1..20';
select case when passed then 'ok ' else 'not ok ' end
  || test_number || ' - ' || description
from availability_test_results
order by test_number;

set local role authenticated;
select set_config('request.jwt.claim.sub', '12000000-0000-4000-8000-000000000001', true);

select case
  when (select count(*) from public.availability_candidates where work_date = '2026-08-31') = 2
    then 'ok 18 - active administrator sees only active available maid candidates'
  else 'not ok 18 - active administrator sees only active available maid candidates'
end;

select set_config('request.jwt.claim.sub', '12000000-0000-4000-8000-000000000002', true);

select case
  when (select count(*) from public.availability_versions where is_current) = 1
    then 'ok 19 - maid reads exactly her own current availability version'
  else 'not ok 19 - maid reads exactly her own current availability version'
end;

select case
  when (
    select count(*) from public.availability_versions
    where maid_profile_id = '22000000-0000-4000-8000-000000000003'
  ) = 0
    then 'ok 20 - maid cannot read another maid availability through RLS'
  else 'not ok 20 - maid cannot read another maid availability through RLS'
end;

reset role;
rollback;
