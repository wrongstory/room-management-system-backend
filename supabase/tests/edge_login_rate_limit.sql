begin;

select plan(8);

select ok(
  has_function_privilege(
    'service_role',
    'public.consume_login_rate_limit(text,integer,integer)',
    'EXECUTE'
  ),
  'service role can consume the Edge login rate limit'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.consume_login_rate_limit(text,integer,integer)',
    'EXECUTE'
  ),
  'anonymous callers cannot consume the Edge login rate limit'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.consume_login_rate_limit(text,integer,integer)',
    'EXECUTE'
  ),
  'authenticated callers cannot consume the Edge login rate limit'
);

create temporary table login_rate_limit_results (
  attempt_number integer primary key,
  allowed boolean not null,
  retry_after_seconds integer not null,
  remaining integer not null
);
grant select, insert on login_rate_limit_results to service_role;

set local role service_role;

insert into login_rate_limit_results
select 1, result.*
from public.consume_login_rate_limit(repeat('a', 64), 2, 60) as result;

insert into login_rate_limit_results
select 2, result.*
from public.consume_login_rate_limit(repeat('a', 64), 2, 60) as result;

insert into login_rate_limit_results
select 3, result.*
from public.consume_login_rate_limit(repeat('a', 64), 2, 60) as result;

reset role;

select ok(
  (select allowed and remaining = 1 from login_rate_limit_results where attempt_number = 1),
  'first request is allowed and leaves one request'
);

select ok(
  (select allowed and remaining = 0 from login_rate_limit_results where attempt_number = 2),
  'request at the fixed-window limit is allowed'
);

select ok(
  (
    select not allowed and remaining = 0 and retry_after_seconds between 1 and 60
    from login_rate_limit_results
    where attempt_number = 3
  ),
  'request beyond the fixed-window limit is denied with Retry-After'
);

update private.login_rate_limit_windows
set
  window_started_at = clock_timestamp() - interval '2 minutes',
  expires_at = clock_timestamp() - interval '1 second'
where key_hash = repeat('a', 64);

set local role service_role;

insert into login_rate_limit_results
select 4, result.*
from public.consume_login_rate_limit(repeat('a', 64), 2, 60) as result;

reset role;

select ok(
  (select allowed and remaining = 1 from login_rate_limit_results where attempt_number = 4),
  'expired fixed window starts again at the first request'
);

set local role service_role;

select throws_ok(
  $$ select * from public.consume_login_rate_limit('not-a-hash', 10, 60) $$,
  '22023',
  'INVALID_RATE_LIMIT_KEY',
  'invalid rate-limit keys are rejected'
);

select * from finish();

rollback;
