begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('10800000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

insert into auth.users(id) select pg_temp.pid(100 + n) from generate_series(1, 7) n;
insert into auth.sessions(id, user_id) values
  (pg_temp.pid(901), pg_temp.pid(101)),
  (pg_temp.pid(902), pg_temp.pid(102)),
  (pg_temp.pid(903), pg_temp.pid(103)),
  (pg_temp.pid(904), pg_temp.pid(104)),
  (pg_temp.pid(905), pg_temp.pid(105)),
  (pg_temp.pid(906), pg_temp.pid(106));

select public.bootstrap_first_developer_profile(
  pg_temp.pid(7), pg_temp.pid(107), 'notification developer', 'notification developer',
  '0108', repeat('d', 64), 'notification-developer-bootstrap'
);
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized, login_id, login_id_normalized,
  login_sequence, role, status, must_change_password
) values
  (pg_temp.pid(1), pg_temp.pid(101), 'notice-admin', 'notice-admin', 'notice-admin', 'notice-admin', 0, 'admin', 'active', false),
  (pg_temp.pid(2), pg_temp.pid(102), 'notice-maid', 'notice-maid', 'notice-maid', 'notice-maid', 0, 'maid', 'active', false),
  (pg_temp.pid(3), pg_temp.pid(103), 'notice-other', 'notice-other', 'notice-other', 'notice-other', 0, 'maid', 'active', false),
  (pg_temp.pid(4), pg_temp.pid(104), 'notice-inactive', 'notice-inactive', 'notice-inactive', 'notice-inactive', 0, 'admin', 'inactive', false),
  (pg_temp.pid(5), pg_temp.pid(105), 'notice-temp', 'notice-temp', 'notice-temp', 'notice-temp', 0, 'maid', 'active', true),
  (pg_temp.pid(6), pg_temp.pid(106), 'notice-mismatch', 'notice-mismatch', 'notice-mismatch', 'notice-mismatch', 0, 'admin', 'active', false);

insert into public.notifications(
  id, recipient_profile_id, category, title, body, dedupe_key, group_key,
  requires_action, occurred_at, created_at
) values
  (pg_temp.pid(1001), pg_temp.pid(1), 'admin_notice', '관리자 알림', '관리자 본문', 'admin:1', 'admin-group', false, '2026-09-11T01:00:00Z', '2026-09-11T01:00:00Z'),
  (pg_temp.pid(1002), pg_temp.pid(2), 'maid_notice', '메이드 최신', '메이드 본문 최신', 'maid:1', 'maid-group', true, '2026-09-11T02:00:00Z', '2026-09-11T02:00:00Z'),
  (pg_temp.pid(1003), pg_temp.pid(2), 'maid_notice', '메이드 동률 상위', '동률 상위', 'maid:2', 'maid-group', false, '2026-09-11T01:30:00Z', '2026-09-11T01:30:00Z'),
  (pg_temp.pid(1004), pg_temp.pid(2), 'maid_notice', '메이드 동률 하위', '동률 하위', 'maid:3', 'maid-group', false, '2026-09-11T01:30:00Z', '2026-09-11T01:30:00Z'),
  (pg_temp.pid(1005), pg_temp.pid(2), 'maid_notice', '메이드 과거', '과거 본문', 'maid:4', 'maid-group', false, '2026-09-11T01:00:00Z', '2026-09-11T01:00:00Z'),
  (pg_temp.pid(1006), pg_temp.pid(3), 'other_notice', '다른 메이드', '다른 메이드 본문', 'other:1', 'other-group', false, '2026-09-11T03:00:00Z', '2026-09-11T03:00:00Z');

select ok(has_function_privilege(
  'service_role', 'public.list_notifications_page(uuid,uuid,timestamptz,uuid,integer)', 'EXECUTE'
), 'service role may execute the bounded notification list RPC');
select ok(has_function_privilege(
  'service_role', 'public.mark_notification_read(uuid,uuid,uuid)', 'EXECUTE'
), 'service role may execute markRead');
select ok(not has_function_privilege(
  'authenticated', 'public.list_notifications_page(uuid,uuid,timestamptz,uuid,integer)', 'EXECUTE'
), 'authenticated cannot execute the privileged list RPC directly');
select ok(not has_function_privilege(
  'authenticated', 'public.mark_notification_read(uuid,uuid,uuid)', 'EXECUTE'
), 'authenticated cannot execute markRead directly');
select ok(not has_function_privilege(
  'anon', 'public.mark_notification_read(uuid,uuid,uuid)', 'EXECUTE'
), 'anon cannot execute markRead');
select ok(not has_table_privilege('authenticated', 'public.notifications', 'SELECT'),
  'raw authenticated Data API SELECT is revoked');
select ok(not has_table_privilege('authenticated', 'public.notifications', 'UPDATE'),
  'raw authenticated Data API UPDATE is revoked');
select ok(not has_table_privilege('service_role', 'public.notifications', 'SELECT'),
  'raw service-role Data API SELECT is revoked');
select ok(not has_table_privilege('service_role', 'public.notifications', 'UPDATE'),
  'raw service-role Data API UPDATE is revoked');

create temporary table notification_pages(label text primary key, value jsonb);
insert into notification_pages values ('maid-first', public.list_notifications_page(
  pg_temp.pid(2), pg_temp.pid(902), null, null, 2
));
select is((select jsonb_array_length(value->'notifications') from notification_pages where label='maid-first'), 2,
  'first page obeys the requested limit');
select is((select value->'notifications'->0->>'id' from notification_pages where label='maid-first'), pg_temp.pid(1002)::text,
  'notifications order by occurredAt descending first');
select is((select value->'notifications'->1->>'id' from notification_pages where label='maid-first'), pg_temp.pid(1004)::text,
  'same-time notifications order by id descending');
select ok((select (value->>'hasMore')::boolean from notification_pages where label='maid-first'),
  'page reports continuation');
select ok((select not (value->'notifications'->0 ? 'dedupeKey')
  and not (value->'notifications'->0 ? 'groupKey')
  and not (value->'notifications'->0 ? 'recipientProfileId')
  from notification_pages where label='maid-first'),
  'public projection excludes recipient and dedupe/group internals');

insert into notification_pages values ('maid-second', public.list_notifications_page(
  pg_temp.pid(2), pg_temp.pid(902),
  (select (value->>'lastOccurredAt')::timestamptz from notification_pages where label='maid-first'),
  (select (value->>'lastId')::uuid from notification_pages where label='maid-first'), 2
));
select is((select string_agg(item->>'id', ',' order by ordinal)
  from notification_pages, jsonb_array_elements(value->'notifications') with ordinality page(item, ordinal)
  where label='maid-second'), pg_temp.pid(1003)::text || ',' || pg_temp.pid(1005)::text,
  'continuation has no tie-time gap or duplicate');
select is((select count(distinct item->>'id') from notification_pages,
  jsonb_array_elements(value->'notifications') item where label in ('maid-first','maid-second')), 4::bigint,
  'two pages return each own notification exactly once');
select is((select jsonb_array_length(value->'notifications') from notification_pages where label='maid-second'), 2,
  'second page returns the remaining own rows only');
insert into notification_pages values ('maid-empty', public.list_notifications_page(
  pg_temp.pid(2), pg_temp.pid(902), '2026-09-11T01:00:00Z', pg_temp.pid(1005), 2
));
select is((select jsonb_array_length(value->'notifications') from notification_pages where label='maid-empty'), 0,
  'cursor after the final row returns a stable empty page');
select ok((select value->'lastId' = 'null'::jsonb and not (value->>'hasMore')::boolean
  from notification_pages where label='maid-empty'), 'empty page has no continuation');

select is((public.list_notifications_page(pg_temp.pid(1), pg_temp.pid(901), null, null, 50)
  ->'notifications'->0->>'id'), pg_temp.pid(1001)::text,
  'admin sees only the admin own inbox rather than other recipients');
select throws_ok($$select public.list_notifications_page(pg_temp.pid(7), pg_temp.pid(901), null, null, 50)$$,
  '42501', 'NOTIFICATION_ACCESS_REQUIRED', 'developer has no business inbox access');
select throws_ok($$select public.list_notifications_page(pg_temp.pid(4), pg_temp.pid(904), null, null, 50)$$,
  '42501', 'NOTIFICATION_ACCESS_REQUIRED', 'inactive admin is denied');
select throws_ok($$select public.list_notifications_page(pg_temp.pid(5), pg_temp.pid(905), null, null, 50)$$,
  '42501', 'NOTIFICATION_ACCESS_REQUIRED', 'temporary-password maid is denied');
select throws_ok($$select public.list_notifications_page(pg_temp.pid(6), null, null, null, 50)$$,
  '42501', 'NOTIFICATION_ACCESS_REQUIRED', 'missing session is denied');
select throws_ok($$select public.list_notifications_page(pg_temp.pid(6), pg_temp.pid(999), null, null, 50)$$,
  '42501', 'NOTIFICATION_ACCESS_REQUIRED', 'nonexistent or revoked session is denied');
select throws_ok($$select public.list_notifications_page(pg_temp.pid(6), pg_temp.pid(903), null, null, 50)$$,
  '42501', 'NOTIFICATION_ACCESS_REQUIRED', 'session belonging to another user is denied');
select throws_ok($$select public.list_notifications_page(pg_temp.pid(2), pg_temp.pid(902), null, null, 101)$$,
  '22023', 'NOTIFICATION_PAGE_LIMIT_INVALID', 'DB independently caps notification pages at 100');
select throws_ok($$select public.list_notifications_page(pg_temp.pid(2), pg_temp.pid(902), now(), null, 50)$$,
  '22023', 'INVALID_NOTIFICATION_CURSOR', 'partial keyset position is rejected');

create temporary table read_results(label text primary key, value jsonb);
insert into read_results values ('first', public.mark_notification_read(pg_temp.pid(2), pg_temp.pid(902), pg_temp.pid(1002)));
insert into read_results values ('replay', public.mark_notification_read(pg_temp.pid(2), pg_temp.pid(902), pg_temp.pid(1002)));
select ok((select value->>'readAt' is not null from read_results where label='first'),
  'markRead records a server timestamp');
select is((select value->>'readAt' from read_results where label='replay'),
  (select value->>'readAt' from read_results where label='first'),
  'markRead replay preserves the first timestamp');
select throws_ok($$select public.mark_notification_read(pg_temp.pid(3), pg_temp.pid(903), pg_temp.pid(1002))$$,
  'P0002', 'NOTIFICATION_NOT_FOUND', 'cross-recipient markRead uses stable not-found anti-enumeration');

select throws_ok($$update public.notifications set read_at = null where id=pg_temp.pid(1002)$$,
  '55000', 'NOTIFICATION_READ_AT_IMMUTABLE', 'readAt can never be cleared');
select throws_ok($$update public.notifications set read_at = clock_timestamp()+interval '1 day' where id=pg_temp.pid(1003)$$,
  '42501', 'NOTIFICATION_MARK_READ_COMMAND_REQUIRED', 'future or arbitrary readAt requires the narrow command');
select throws_ok($$update public.notifications set title='mutated' where id=pg_temp.pid(1003)$$,
  '55000', 'NOTIFICATION_CONTENT_IMMUTABLE', 'notification content is immutable');
select throws_ok($$delete from public.notifications where id=pg_temp.pid(1003)$$,
  '55000', 'NOTIFICATION_DELETE_FORBIDDEN', 'notification ledger rows cannot be deleted');

set local role service_role;
select throws_ok($$update public.notifications set resolved_at=clock_timestamp() where id='10800000-0000-4000-8000-000000001003'$$,
  '42501', null, 'raw service-role resolution is denied by table privileges');
reset role;

-- Temporarily expose SELECT inside this rolled-back test to exercise RLS itself.
grant select on public.notifications to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', pg_temp.pid(102), 'role', 'authenticated', 'session_id', pg_temp.pid(902)
)::text, true);
select is((select count(*) from public.notifications), 4::bigint,
  'defense-in-depth RLS permits only the exact recipient rows');
reset role;

select * from finish();
rollback;
