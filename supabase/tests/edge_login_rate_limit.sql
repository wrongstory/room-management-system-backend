begin;

select plan(16);

select ok(
  has_function_privilege(
    'service_role',
    'public.consume_login_rate_limits(text,text,text,integer,integer,integer,integer)',
    'EXECUTE'
  ),
  'service role can consume the bounded Edge login limits'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.consume_login_rate_limits(text,text,text,integer,integer,integer,integer)',
    'EXECUTE'
  ),
  'anonymous callers cannot consume the Edge login limits'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.consume_login_rate_limits(text,text,text,integer,integer,integer,integer)',
    'EXECUTE'
  ),
  'authenticated callers cannot consume the Edge login limits'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.consume_login_rate_limits(text,text,integer,integer,integer)',
    'EXECUTE'
  ),
  'the client-unaware limiter RPC is retired'
);

create temporary table login_rate_limit_results (
  attempt_number integer primary key,
  allowed boolean not null,
  retry_after_seconds integer not null,
  remaining integer not null,
  blocked_scope text
);
grant select, insert on login_rate_limit_results to service_role;

set local role service_role;

insert into login_rate_limit_results
select 1, result.*
from public.consume_login_rate_limits(
  repeat('a', 64), repeat('b', 64), repeat('c', 64), 100, 2, 1000, 60
) as result;

insert into login_rate_limit_results
select 2, result.*
from public.consume_login_rate_limits(
  repeat('a', 64), repeat('b', 64), repeat('c', 64), 100, 2, 1000, 60
) as result;

insert into login_rate_limit_results
select 3, result.*
from public.consume_login_rate_limits(
  repeat('a', 64), repeat('b', 64), repeat('c', 64), 100, 2, 1000, 60
) as result;

reset role;

select ok(
  (
    select allowed and blocked_scope is null
    from login_rate_limit_results
    where attempt_number = 1
  ),
  'first request passes client, login, and emergency limits'
);

select ok(
  (
    select allowed and blocked_scope is null
    from login_rate_limit_results
    where attempt_number = 2
  ),
  'request at the per-login fixed-window limit is allowed'
);

select ok(
  (
    select not allowed
      and remaining = 0
      and retry_after_seconds between 1 and 60
      and blocked_scope = 'login'
    from login_rate_limit_results
    where attempt_number = 3
  ),
  'request beyond the per-login limit is denied with its scope'
);

create temporary table rotating_login_results as
select sequence_number, result.*
from generate_series(1, 100) sequence_number
cross join lateral public.consume_login_rate_limits(
  repeat('d', 64),
  'e' || lpad(to_hex(sequence_number), 63, '0'),
  repeat('f', 64),
  5,
  5,
  100,
  60
) result;

select is(
  (select count(*)::integer from rotating_login_results where allowed),
  5,
  'rotating login IDs cannot bypass the global request limit'
);

select ok(
  (
    select count(*) <= 6
    from private.login_rate_limit_windows
    where key_hash = repeat('d', 64) or key_hash like 'e%'
  ),
  'rotating login IDs cannot create more rows than the client bound plus its bucket'
);

select is(
  (
    select attempt_count
    from private.login_rate_limit_windows
    where key_hash = repeat('d', 64)
  ),
  6,
  'a saturated client bucket stops writing after the first denied attempt'
);

set local role service_role;
insert into login_rate_limit_results
select 5, result.*
from public.consume_login_rate_limits(
  repeat('8', 64), repeat('9', 64), repeat('f', 64), 5, 5, 100, 60
) as result;
reset role;

select ok(
  (select allowed from login_rate_limit_results where attempt_number = 5),
  'an attacker client exhausting its bucket does not block a normal admin client'
);

update private.login_rate_limit_windows
set
  window_started_at = clock_timestamp() - interval '2 minutes',
  expires_at = clock_timestamp() - interval '1 second'
where key_hash in (repeat('a', 64), repeat('b', 64), repeat('c', 64));

set local role service_role;

insert into login_rate_limit_results
select 4, result.*
from public.consume_login_rate_limits(
  repeat('a', 64), repeat('b', 64), repeat('c', 64), 100, 2, 1000, 60
) as result;

reset role;

select ok(
  (select allowed from login_rate_limit_results where attempt_number = 4),
  'expired client, login, and emergency windows restart together'
);

set local role service_role;

select throws_ok(
  $$ select * from public.consume_login_rate_limits('not-a-hash', repeat('a', 64), repeat('b', 64), 30, 10, 600, 60) $$,
  '22023',
  'INVALID_RATE_LIMIT_KEY',
  'invalid rate-limit keys are rejected'
);

select throws_ok(
  $$ select * from public.consume_login_rate_limits(repeat('a', 64), repeat('a', 64), repeat('b', 64), 30, 10, 600, 60) $$,
  '22023',
  'RATE_LIMIT_KEYS_MUST_DIFFER',
  'global and login bucket keys must be domain separated'
);

select throws_ok(
  $$ select * from public.consume_login_rate_limits(repeat('a', 64), repeat('b', 64), repeat('c', 64), 5, 6, 600, 60) $$,
  '22023',
  'INVALID_RATE_LIMIT_CONFIGURATION',
  'the per-login limit cannot exceed the global limit'
);

reset role;

insert into private.login_rate_limit_windows (
  key_hash, window_started_at, attempt_count, expires_at
)
select
  '7' || lpad(to_hex(sequence_number), 63, '0'),
  clock_timestamp() - interval '20 minutes',
  1,
  clock_timestamp() - interval '11 minutes'
from generate_series(1, 100) sequence_number;

set local role service_role;
select * from public.consume_login_rate_limits(
  repeat('1', 64), repeat('2', 64), repeat('3', 64), 60, 10, 600, 60
);
reset role;

select is(
  (
    select count(*)::integer
    from private.login_rate_limit_windows
    where key_hash like '7%'
  ),
  36,
  'hot-path cleanup deletes at most 64 stale buckets per request'
);

select * from finish();

rollback;
