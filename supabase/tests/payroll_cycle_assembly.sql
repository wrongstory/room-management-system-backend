begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('93000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

create function pg_temp.week_start(n integer) returns date language sql stable as $$
  select date_trunc('week', clock_timestamp() at time zone 'Asia/Seoul')::date
    + (n * 7)
$$;

insert into auth.users(id)
select pg_temp.pid(100 + n) from generate_series(1, 8) n;

insert into auth.sessions(id,user_id)
select pg_temp.pid(900+n),pg_temp.pid(100+n) from generate_series(1,8)n;

select public.bootstrap_first_developer_profile(
  pg_temp.pid(6), pg_temp.pid(106), 'payroll developer', 'payroll developer',
  '0093', repeat('d', 64), 'payroll-developer-bootstrap'
);

insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence,
  role, status, must_change_password
)
select
  pg_temp.pid(n), pg_temp.pid(100 + n), 'payroll-' || n,
  'payroll-' || n, 'payroll-' || n, 'payroll-' || n, 0,
  case when n in (1, 4) then 'admin' else 'maid' end::public.app_role,
  case
    when n = 4 then 'inactive'
    when n = 5 then 'upload_only'
    when n = 7 then 'departed'
    else 'active'
  end::public.account_status,
  false
from generate_series(1, 5) n
union all
select
  pg_temp.pid(7), pg_temp.pid(107), 'payroll-7', 'payroll-7',
  'payroll-7', 'payroll-7', 0, 'maid'::public.app_role,
  'departed'::public.account_status, false
union all
select
  pg_temp.pid(8), pg_temp.pid(108), 'payroll-8', 'payroll-8',
  'payroll-8', 'payroll-8', 0, 'admin'::public.app_role,
  'active'::public.account_status, false;

create function pg_temp.add_earning(
  n integer,
  maid_n integer,
  earned_on date,
  amount integer
)
returns uuid
language plpgsql
as $$
declare
  v_room public.rooms;
  v_target uuid := pg_temp.pid(1000 + n);
  v_assignment uuid := pg_temp.pid(2000 + n);
  v_attempt uuid := pg_temp.pid(3000 + n);
  v_submission uuid := pg_temp.pid(4000 + n);
  v_earning uuid := pg_temp.pid(5000 + n);
  v_at timestamptz := (earned_on::timestamp + time '12:00') at time zone 'Asia/Seoul';
begin
  select * into v_room
  from public.rooms
  order by room_number
  offset mod(n, greatest((select count(*)::integer from public.rooms), 1))
  limit 1;

  insert into public.cleaning_targets(
    id, room_id, cleaning_kind, source, source_key,
    original_service_date, effective_service_date, available_from, due_at,
    status, assignment_version, room_type_snapshot, fee_snapshot,
    template_snapshot, created_by
  ) values (
    v_target, v_room.id, 'additional', 'manual_room_request',
    'payroll-earning-' || n, earned_on, earned_on,
    v_at - interval '2 hours', v_at + interval '2 hours',
    'approved', 1, jsonb_build_object('id', v_room.room_type_id), amount,
    '{}'::jsonb, pg_temp.pid(1)
  );

  insert into public.cleaning_assignments(
    id, cleaning_target_id, maid_profile_id, service_date,
    sequence_number, revision, is_current, notified_at, changed_by
  ) values (
    v_assignment, v_target, pg_temp.pid(maid_n), earned_on,
    n + 1, 1, true, v_at - interval '2 hours', pg_temp.pid(1)
  );

  insert into public.cleaning_attempts(
    id, cleaning_target_id, assignment_id, maid_profile_id, attempt_number,
    status, assignment_revision, started_at, field_completed_at, ended_at,
    template_snapshot, room_snapshot
  ) values (
    v_attempt, v_target, v_assignment, pg_temp.pid(maid_n), 1,
    'approved', 1, v_at - interval '90 minutes', v_at, v_at,
    '{}'::jsonb, jsonb_build_object('roomId', v_room.id)
  );

  insert into public.cleaning_submissions(
    id, cleaning_attempt_id, client_submission_id, version, status,
    photo_manifest, submitted_by, submitted_at
  ) values (
    v_submission, v_attempt, pg_temp.pid(6000 + n), 1, 'approved',
    '{}'::jsonb, pg_temp.pid(maid_n), v_at + interval '10 minutes'
  );

  insert into public.inspection_decisions(
    submission_id, decision, reason_code, decided_by, decided_at
  ) values (
    v_submission, 'approved', 'QUALITY_OK', pg_temp.pid(1),
    v_at + interval '20 minutes'
  );

  insert into public.earnings(
    id, earning_entitlement_id, submission_id, maid_profile_id,
    earned_on, base_amount, bomb_room_bonus
  ) values (
    v_earning, v_submission, v_submission, pg_temp.pid(maid_n),
    earned_on, amount, 0
  );

  return v_earning;
end;
$$;

select pg_temp.add_earning(1, 2, pg_temp.week_start(-1), 16000);
select pg_temp.add_earning(2, 2, pg_temp.week_start(-1) + 3, 20000);
select pg_temp.add_earning(3, 2, pg_temp.week_start(-1) + 4, 0);
select pg_temp.add_earning(4, 3, pg_temp.week_start(-2), 0);
insert into public.payroll_cycles(maid_profile_id, week_start)
values(pg_temp.pid(7), pg_temp.week_start(-3));

select ok(
  (select value->'cycleId' = 'null'::jsonb
     and value->>'status' = 'open'
     and (value->>'version')::integer = 0
   from public.list_payroll_cycles(pg_temp.pid(1), pg_temp.week_start(-1), pg_temp.pid(3)) value),
  'missing cycle is an explicit null-id version-zero conceptual OPEN projection'
);

select is(
  (select count(*) from public.list_payroll_cycles(
    pg_temp.pid(1), pg_temp.week_start(-3), null
  )),
  4::bigint,
  'admin all-maid projection retains inactive/departed historical payroll scope'
);

select throws_ok(
  $$select public.list_payroll_cycles(pg_temp.pid(1), pg_temp.week_start(-1) + 1, null)$$,
  '22023', 'PAYROLL_WEEK_MUST_START_MONDAY',
  'projection rejects a non-Monday business week'
);

select throws_ok(
  $$select public.start_payroll_cycle(pg_temp.pid(1), pg_temp.pid(2), pg_temp.week_start(0), 0, 'payroll-current-week', repeat('1',64))$$,
  '22023', 'PAYROLL_WEEK_NOT_CLOSED',
  'current KST week cannot be started'
);

select throws_ok(
  $$select public.start_payroll_cycle(pg_temp.pid(1), pg_temp.pid(2), pg_temp.week_start(-1) + 1, 0, 'payroll-wrong-monday', repeat('2',64))$$,
  '22023', 'PAYROLL_WEEK_MUST_START_MONDAY',
  'start rejects a non-Monday business week'
);

select throws_ok(
  $$select public.start_payroll_cycle(pg_temp.pid(1), pg_temp.pid(3), pg_temp.week_start(-2), 0, 'payroll-zero-amount', repeat('3',64))$$,
  '22023', 'PAYROLL_NONPOSITIVE_REQUIRES_CARRY',
  'zero-total payroll is rejected atomically'
);

select is(
  (select count(*) from public.payroll_cycles
    where maid_profile_id = pg_temp.pid(3) and week_start = pg_temp.week_start(-2)),
  0::bigint,
  'failed zero-total start leaves no cycle'
);
select ok(
  not exists(select 1 from public.audit_events where event_type='payroll.payment_started')
    and not exists(select 1 from public.notifications where category='payroll_payment_started')
    and not exists(select 1 from public.payroll_events),
  'failed start rolls back every audit, notification, and payroll event side effect'
);

create temporary table payroll_results(label text primary key, value jsonb);
insert into payroll_results values (
  'first', public.start_payroll_cycle(
    pg_temp.pid(1), pg_temp.pid(2), pg_temp.week_start(-1), 0,
    'payroll-start-main', repeat('a',64)
  )
);

select is((select value->>'status' from payroll_results where label='first'), 'paying',
  'ended positive week starts a PAYING snapshot');
select is((select (value->>'version')::integer from payroll_results where label='first'), 1,
  'missing conceptual version zero advances to stored version one');
select is((select (value->>'totalAmount')::integer from payroll_results where label='first'), 36000,
  'locked amount is the database sum of positive earnings');
select is((select (value->>'itemCount')::integer from payroll_results where label='first'), 2,
  'start claims every positive earning and excludes zero-value provenance');
select is((select count(*) from public.payroll_items where maid_profile_id=pg_temp.pid(2)),2::bigint,
  'exact payroll item membership is persisted');

select is((select count(*) from public.payroll_events where maid_profile_id=pg_temp.pid(2)),1::bigint,
  'one immutable public payroll event is appended');
select is((select count(*) from public.audit_events where event_type='payroll.payment_started'),1::bigint,
  'one safe audit event is appended');
select is((select count(*) from public.notifications where category='payroll_payment_started'),1::bigint,
  'one maid notification is appended');
select is((select count(*) from private.notification_outbox outbox join public.notifications notice on notice.id=outbox.notification_id
  where notice.category='payroll_payment_started'),1::bigint,
  'one private delivery outbox row is appended atomically');
select ok((select request_hash is null and actor_display_name_snapshot is null
  and not (after_state ?| array['requestHash','maidProfileId','lockedAmount'])
  from public.audit_events where event_type='payroll.payment_started'),
  'payroll audit excludes request hash, raw body, and actor PII');
select ok(
  (select summary ?& array['weekStart','status','version','payrollEventId']
      and not (summary ?| array['requestHash','maidProfileId','lockedAmount'])
   from public.list_developer_audit_events(
     pg_temp.pid(6), array['payroll.payment_started'], null,
     clock_timestamp()-interval '1 day', clock_timestamp()+interval '1 day',
     null, null, 10
   ) limit 1),
  'developer audit allowlist returns only the fixed safe payroll summary'
);

insert into payroll_results values (
  'replay', public.start_payroll_cycle(
    pg_temp.pid(1), pg_temp.pid(2), pg_temp.week_start(-1), 0,
    'payroll-start-main', repeat('a',64)
  )
);
select is((select value from payroll_results where label='replay'),
  (select value from payroll_results where label='first'),
  'same actor/key/hash replays the exact prior result');
select is((select count(*) from public.payroll_events where maid_profile_id=pg_temp.pid(2)),1::bigint,
  'replay creates no duplicate side effects');

select throws_ok(
  $$select public.start_payroll_cycle(pg_temp.pid(1), pg_temp.pid(2), pg_temp.week_start(-1), 0, 'payroll-start-main', repeat('b',64))$$,
  '23505', 'IDEMPOTENCY_KEY_REUSED',
  'same actor and key with another payload hash conflicts'
);

select pg_temp.add_earning(6, 3, pg_temp.week_start(-2) + 2, 9000);
select lives_ok(
  $$select public.start_payroll_cycle(pg_temp.pid(8), pg_temp.pid(3), pg_temp.week_start(-2), 0, 'payroll-start-main', repeat('c',64))$$,
  'different actors can independently use the same raw idempotency key'
);

-- #103 narrows the pre-existing reopen reason to one fixed code. This direct
-- fixture proves that existing items remain and late earnings append on the
-- next exact OPEN-version start; command evidence is tested separately.
update public.payroll_cycles
set status='open', locked_amount=null, payment_started_by=null,
  payment_started_at=null, last_reopen_reason='NO_TRANSFER_CONFIRMED',
  last_reopened_by=pg_temp.pid(1), last_reopened_at=clock_timestamp(),
  version=version+1
where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week_start(-1);

select pg_temp.add_earning(7, 2, pg_temp.week_start(-1) + 5, 30000);
insert into payroll_results values (
  'reopened', public.start_payroll_cycle(
    pg_temp.pid(1), pg_temp.pid(2), pg_temp.week_start(-1), 2,
    'payroll-start-reopened', repeat('e',64)
  )
);
select is((select (value->>'itemCount')::integer from payroll_results where label='reopened'),3,
  'reopened OPEN cycle retains two items and appends one late earning');
select is((select (value->>'totalAmount')::integer from payroll_results where label='reopened'),66000,
  'reopened snapshot locks the retained plus late amount');
select is((select count(distinct earning_id)=count(*) from public.payroll_items),true,
  'each earning remains exclusively claimed across all cycles');

select pg_temp.add_earning(8, 2, pg_temp.week_start(-1) + 6, 7000);
select ok(
  (select (value->>'totalAmount')::integer=66000
      and (value->>'lateEarningCount')::integer=1
      and (value->>'lateEarningAmount')::integer=7000
   from public.list_payroll_cycles(pg_temp.pid(1),pg_temp.week_start(-1),pg_temp.pid(2)) value),
  'late confirmed earning after PAYING is visible separately without mutating locked total'
);

-- #96 large-fixture regression: exact totals remain independent from bounded
-- previews, start/replay never aggregate an unbounded receipt, and keyset
-- traversal returns every entry exactly once.
select pg_temp.add_earning(
  100 + n,
  3,
  pg_temp.week_start(-4) + (n % 7),
  1000
)
from generate_series(0, 119) n;

insert into payroll_results values (
  'large-first', public.start_payroll_cycle(
    pg_temp.pid(8), pg_temp.pid(3), pg_temp.week_start(-4), 0,
    'payroll-large-start', repeat('9',64)
  )
), (
  'large-replay', public.start_payroll_cycle(
    pg_temp.pid(8), pg_temp.pid(3), pg_temp.week_start(-4), 0,
    'payroll-large-start', repeat('9',64)
  )
);
select ok(
  (select (value->>'itemCount')::integer = 120
      and (value->>'totalAmount')::integer = 120000
      and jsonb_array_length(value->'items') = 10
      and (value->>'itemsHasMore')::boolean
   from payroll_results where label='large-first'),
  'large start returns exact totals with a ten-item bounded preview'
);
select is(
  (select value from payroll_results where label='large-replay'),
  (select value from payroll_results where label='large-first'),
  'large replay returns the same bounded logical result without rebuilding an unbounded aggregate'
);
select ok(
  (select pg_column_size(value) < 16384
   from payroll_results where label='large-first'),
  'large start receipt remains below sixteen KiB instead of scaling with earning count'
);

create temporary table large_entry_pages(page integer primary key, value jsonb);
insert into large_entry_pages values (
  1, public.list_payroll_entries_page(
    pg_temp.pid(8), pg_temp.week_start(-4), pg_temp.pid(3),
    'items', null, null, 50
  )
);
insert into large_entry_pages
select 2, public.list_payroll_entries_page(
  pg_temp.pid(8), pg_temp.week_start(-4), pg_temp.pid(3), 'items',
  (value->>'lastEarnedOn')::date, (value->>'lastEarningId')::uuid, 50
)
from large_entry_pages where page=1;
insert into large_entry_pages
select 3, public.list_payroll_entries_page(
  pg_temp.pid(8), pg_temp.week_start(-4), pg_temp.pid(3), 'items',
  (value->>'lastEarnedOn')::date, (value->>'lastEarningId')::uuid, 50
)
from large_entry_pages where page=2;
select is(
  (select string_agg(jsonb_array_length(value->'entries')::text, ',' order by page)
   from large_entry_pages),
  '50,50,20',
  'entry keyset pages enforce the DB max and finish without OFFSET'
);
select is(
  (select count(distinct entry->>'earningId')
   from large_entry_pages page
   cross join lateral jsonb_array_elements(page.value->'entries') entry),
  120::bigint,
  'entry keyset traversal has no duplicate or omitted earning'
);
select throws_ok(
  $$select public.list_payroll_entries_page(pg_temp.pid(8), pg_temp.week_start(-4), pg_temp.pid(3), 'items', null, null, 51)$$,
  '22023', 'PAYROLL_PAGE_LIMIT_INVALID',
  'database independently rejects entry page limits above fifty'
);
select throws_ok(
  $$select public.list_payroll_entries_page(pg_temp.pid(8), pg_temp.week_start(-4), pg_temp.pid(3), 'items', pg_temp.week_start(-4), null, 25)$$,
  '22023', 'PAYROLL_CURSOR_INVALID',
  'database rejects partial entry keysets'
);

insert into auth.users(id)
select pg_temp.pid(120 + n) from generate_series(0, 11) n;
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence,
  role, status, must_change_password
)
select
  pg_temp.pid(20 + n), pg_temp.pid(120 + n), 'page-maid-' || n,
  'page-maid-' || n, 'page-maid-' || n, 'page-maid-' || n, 0,
  'maid'::public.app_role, 'active'::public.account_status, false
from generate_series(0, 11) n;

create temporary table large_cycle_pages(page integer primary key, value jsonb);
insert into large_cycle_pages values (
  1, public.list_payroll_cycles_page(
    pg_temp.pid(8), pg_temp.week_start(-5), null, null, 10
  )
);
insert into large_cycle_pages
select 2, public.list_payroll_cycles_page(
  pg_temp.pid(8), pg_temp.week_start(-5), null,
  (value->>'lastMaidProfileId')::uuid, 10
)
from large_cycle_pages where page=1;
select is(
  (select count(distinct cycle->>'maidProfileId')
   from large_cycle_pages page
   cross join lateral jsonb_array_elements(page.value->'payroll') cycle),
  16::bigint,
  'admin-all cycle keyset traversal returns every maid exactly once'
);
select ok(
  (select (value->>'hasMore')::boolean from large_cycle_pages where page=1)
  and not (select (value->>'hasMore')::boolean from large_cycle_pages where page=2),
  'cycle continuation terminates after the final keyset page'
);
select throws_ok(
  $$select public.list_payroll_cycles_page(pg_temp.pid(8), pg_temp.week_start(-5), null, null, 11)$$,
  '22023', 'PAYROLL_PAGE_LIMIT_INVALID',
  'database independently rejects cycle page limits above ten'
);

select throws_ok($$select public.list_payroll_cycles(pg_temp.pid(2),pg_temp.week_start(-1),pg_temp.pid(3))$$,
  '42501','PAYROLL_ACCESS_REQUIRED','maid cannot IDOR another maid projection');
select throws_ok($$select public.list_payroll_cycles(pg_temp.pid(6),pg_temp.week_start(-1),null)$$,
  '42501','PAYROLL_ACCESS_REQUIRED','developer has no payroll business access');
select throws_ok($$select public.list_payroll_cycles(pg_temp.pid(4),pg_temp.week_start(-1),null)$$,
  '42501','PAYROLL_ACCESS_REQUIRED','inactive admin has no payroll access');
select throws_ok($$select public.list_payroll_cycles(pg_temp.pid(5),pg_temp.week_start(-1),null)$$,
  '42501','PAYROLL_ACCESS_REQUIRED','upload-only maid has no payroll access');
select throws_ok($$select public.start_payroll_cycle(pg_temp.pid(2),pg_temp.pid(2),pg_temp.week_start(-1),3,'maid-start-denied',repeat('f',64))$$,
  '42501','ADMIN_REQUIRED','maid cannot start payroll');

select lives_ok(
  $$select public.record_authorization_denial(pg_temp.pid(2),'edge.authorization.payroll','PAYROLL_ACCESS_REQUIRED',clock_timestamp())$$,
  'payroll authorization denial source and reason are accepted'
);
select is((select count(*) from private.actor_authorization_denial_aggregates
  where actor_profile_id=pg_temp.pid(2) and source='edge.authorization.payroll'
    and reason_code='PAYROLL_ACCESS_REQUIRED'),1::bigint,
  'payroll denial is recorded in one bounded aggregate row');

select ok(not exists(
  select 1
  from unnest(array['anon','service_role']) role_name
  cross join unnest(array[
    'public.earnings','public.payroll_cycles','public.payroll_items','public.payroll_events'
  ]) relation
  cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
  where has_table_privilege(role_name, relation, privilege)
), 'anon and service role have no raw payroll table privilege');

select ok(has_function_privilege('service_role','public.list_payroll_cycles(uuid,date,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.list_payroll_cycles_page(uuid,date,uuid,uuid,integer)','EXECUTE')
  and has_function_privilege('service_role','public.list_payroll_entries_page(uuid,date,uuid,text,date,uuid,integer)','EXECUTE')
  and has_function_privilege('service_role','public.start_payroll_cycle(uuid,uuid,date,bigint,text,text)','EXECUTE'),
  'service role can execute only bounded reviewed payroll projections and command');
select ok(not has_function_privilege('authenticated','public.start_payroll_cycle(uuid,uuid,date,bigint,text,text)','EXECUTE'),
  'authenticated clients cannot bypass the server-owned command');
select ok(has_function_privilege('authenticated','private.can_read_payroll_row(uuid)','EXECUTE')
  and not has_function_privilege('anon','private.can_read_payroll_row(uuid)','EXECUTE')
  and not has_function_privilege('service_role','private.can_read_payroll_row(uuid)','EXECUTE'),
  'only authenticated RLS evaluation can execute the private payroll read predicate');

create temporary table payroll_rls_expected as
select
  (select count(*) from public.earnings) as earnings_all,
  (select count(*) from public.payroll_cycles) as cycles_all,
  (select count(*) from public.payroll_items) as items_all,
  (select count(*) from public.payroll_events) as events_all,
  (select count(*) from public.earnings where maid_profile_id=pg_temp.pid(2)) as earnings_maid,
  (select count(*) from public.payroll_cycles where maid_profile_id=pg_temp.pid(2)) as cycles_maid,
  (select count(*) from public.payroll_items where maid_profile_id=pg_temp.pid(2)) as items_maid,
  (select count(*) from public.payroll_events where maid_profile_id=pg_temp.pid(2)) as events_maid;
grant select on payroll_rls_expected to authenticated;

update public.profiles
set must_change_password=true
where id in (pg_temp.pid(1),pg_temp.pid(2));

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000101';
set local request.jwt.claims = '{"sub":"93000000-0000-4000-8000-000000000101","session_id":"93000000-0000-4000-8000-000000000901"}';
select is((select count(*) from public.earnings),0::bigint,
  'active admin with a temporary password reads no earnings');
select is((select count(*) from public.payroll_cycles),0::bigint,
  'active admin with a temporary password reads no payroll cycles');
select is((select count(*) from public.payroll_items),0::bigint,
  'active admin with a temporary password reads no payroll items');
select is((select count(*) from public.payroll_events),0::bigint,
  'active admin with a temporary password reads no payroll events');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000102';
set local request.jwt.claims = '{"sub":"93000000-0000-4000-8000-000000000102","session_id":"93000000-0000-4000-8000-000000000902"}';
select is((select count(*) from public.earnings),0::bigint,
  'active maid with a temporary password reads no earnings');
select is((select count(*) from public.payroll_cycles),0::bigint,
  'active maid with a temporary password reads no payroll cycles');
select is((select count(*) from public.payroll_items),0::bigint,
  'active maid with a temporary password reads no payroll items');
select is((select count(*) from public.payroll_events),0::bigint,
  'active maid with a temporary password reads no payroll events');
reset role;

update public.profiles
set must_change_password=false
where id in (pg_temp.pid(1),pg_temp.pid(2));

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000101';
set local request.jwt.claims = '{"sub":"93000000-0000-4000-8000-000000000101","session_id":"93000000-0000-4000-8000-000000000901"}';
select is((select count(*) from public.earnings),
  (select earnings_all from pg_temp.payroll_rls_expected),
  'admin earnings access is restored after password change completion');
select is((select count(*) from public.payroll_cycles),
  (select cycles_all from pg_temp.payroll_rls_expected),
  'admin payroll cycle access is restored after password change completion');
select is((select count(*) from public.payroll_items),
  (select items_all from pg_temp.payroll_rls_expected),
  'admin payroll item access is restored after password change completion');
select is((select count(*) from public.payroll_events),
  (select events_all from pg_temp.payroll_rls_expected),
  'admin payroll event access is restored after password change completion');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000102';
set local request.jwt.claims = '{"sub":"93000000-0000-4000-8000-000000000102","session_id":"93000000-0000-4000-8000-000000000902"}';
select is((select count(*) from public.earnings),
  (select earnings_maid from pg_temp.payroll_rls_expected),
  'maid earnings access is restored with exact self scope after password change');
select is((select count(*) from public.payroll_cycles),
  (select cycles_maid from pg_temp.payroll_rls_expected),
  'maid payroll cycle access is restored with exact self scope after password change');
select is((select count(*) from public.payroll_items),
  (select items_maid from pg_temp.payroll_rls_expected),
  'maid payroll item access is restored with exact self scope after password change');
select is((select count(*) from public.payroll_events),
  (select events_maid from pg_temp.payroll_rls_expected),
  'maid payroll event access is restored with exact self scope after password change');
select is((select count(*) from public.earnings where maid_profile_id=pg_temp.pid(3)),0::bigint,
  'maid cannot IDOR another maid earnings');
select is((select count(*) from public.payroll_cycles where maid_profile_id=pg_temp.pid(3)),0::bigint,
  'maid cannot IDOR another maid payroll cycles');
select is((select count(*) from public.payroll_items where maid_profile_id=pg_temp.pid(3)),0::bigint,
  'maid cannot IDOR another maid payroll items');
select is((select count(*) from public.payroll_events where maid_profile_id=pg_temp.pid(3)),0::bigint,
  'maid cannot IDOR another maid payroll events');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000106';
set local request.jwt.claims = '{"sub":"93000000-0000-4000-8000-000000000106","session_id":"93000000-0000-4000-8000-000000000906"}';
select is((select count(*) from public.earnings),0::bigint,
  'developer RLS reads no earnings');
select is((select count(*) from public.payroll_cycles),0::bigint,
  'developer RLS reads no payroll cycles');
select is((select count(*) from public.payroll_items),0::bigint,
  'developer RLS reads no payroll items');
select is((select count(*) from public.payroll_events),0::bigint,
  'developer RLS reads no payroll events');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000105';
set local request.jwt.claims = '{"sub":"93000000-0000-4000-8000-000000000105","session_id":"93000000-0000-4000-8000-000000000905"}';
select is((select count(*) from public.earnings),0::bigint,
  'upload-only maid RLS reads no earnings');
select is((select count(*) from public.payroll_cycles),0::bigint,
  'upload-only maid RLS reads no payroll cycles');
select is((select count(*) from public.payroll_items),0::bigint,
  'upload-only maid RLS reads no payroll items');
select is((select count(*) from public.payroll_events),0::bigint,
  'upload-only maid RLS reads no payroll events');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000107';
set local request.jwt.claims = '{"sub":"93000000-0000-4000-8000-000000000107","session_id":"93000000-0000-4000-8000-000000000907"}';
select is((select count(*) from public.earnings),0::bigint,
  'departed maid RLS reads no earnings');
select is((select count(*) from public.payroll_cycles),0::bigint,
  'departed maid RLS reads no payroll cycles');
select is((select count(*) from public.payroll_items),0::bigint,
  'departed maid RLS reads no payroll items');
select is((select count(*) from public.payroll_events),0::bigint,
  'departed maid RLS reads no payroll events');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000104';
set local request.jwt.claims = '{"sub":"93000000-0000-4000-8000-000000000104","session_id":"93000000-0000-4000-8000-000000000904"}';
select is((select count(*) from public.earnings),0::bigint,
  'inactive admin RLS reads no earnings');
select is((select count(*) from public.payroll_cycles),0::bigint,
  'inactive admin RLS reads no payroll cycles');
select is((select count(*) from public.payroll_items),0::bigint,
  'inactive admin RLS reads no payroll items');
select is((select count(*) from public.payroll_events),0::bigint,
  'inactive admin RLS reads no payroll events');
reset role;

select throws_ok($$update public.payroll_events set locked_amount=1$$,
  '55000','PAYROLL_EVENT_IMMUTABLE','public payroll event ledger rejects UPDATE');
select throws_ok($$delete from public.payroll_events$$,
  '55000','PAYROLL_EVENT_IMMUTABLE','public payroll event ledger rejects DELETE');
select throws_ok($$update public.payroll_items set locked_amount=1$$,
  '55000','PAYROLL_ITEM_IMMUTABLE','payroll item ledger rejects UPDATE');
select throws_ok($$delete from public.payroll_cycles$$,
  '55000','PAYROLL_CYCLE_DELETE_FORBIDDEN','payroll cycles cannot be deleted');

select * from finish();
rollback;
