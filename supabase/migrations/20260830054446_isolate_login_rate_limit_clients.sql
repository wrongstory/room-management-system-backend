-- Issue #42 security follow-up:
-- isolate abusive unauthenticated clients before per-login and project-wide
-- emergency limits. The preceding migration is not deployed to production,
-- but this remains append-only so every reviewed commit stays reproducible.

create or replace function private.consume_login_rate_limit_bucket(
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer,
  p_now timestamptz
)
returns table (
  allowed boolean,
  retry_after_seconds integer,
  remaining integer
)
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_row private.login_rate_limit_windows%rowtype;
begin
  insert into private.login_rate_limit_windows (
    key_hash,
    window_started_at,
    attempt_count,
    expires_at
  ) values (
    p_key_hash,
    p_now,
    1,
    p_now + make_interval(secs => p_window_seconds)
  )
  on conflict (key_hash) do update
  set
    window_started_at = case
      when private.login_rate_limit_windows.expires_at <= p_now then p_now
      else private.login_rate_limit_windows.window_started_at
    end,
    attempt_count = case
      when private.login_rate_limit_windows.expires_at <= p_now then 1
      else private.login_rate_limit_windows.attempt_count + 1
    end,
    expires_at = case
      when private.login_rate_limit_windows.expires_at <= p_now
        then p_now + make_interval(secs => p_window_seconds)
      else private.login_rate_limit_windows.expires_at
    end
  -- The first denied attempt records limit + 1. Further denied requests only
  -- read the saturated row, so attack traffic cannot force one DB update per hit.
  where private.login_rate_limit_windows.expires_at <= p_now
    or private.login_rate_limit_windows.attempt_count < p_limit + 1
  returning * into v_row;

  if not found then
    select * into strict v_row
    from private.login_rate_limit_windows windows
    where windows.key_hash = p_key_hash;
  end if;

  return query select
    v_row.attempt_count <= p_limit,
    case
      when v_row.attempt_count <= p_limit then 0
      else greatest(1, ceil(extract(epoch from (v_row.expires_at - p_now)))::integer)
    end,
    greatest(0, p_limit - v_row.attempt_count);
end;
$$;

create function public.consume_login_rate_limits(
  p_client_key_hash text,
  p_login_key_hash text,
  p_global_key_hash text,
  p_client_limit integer default 30,
  p_login_limit integer default 10,
  p_global_limit integer default 600,
  p_window_seconds integer default 60
)
returns table (
  allowed boolean,
  retry_after_seconds integer,
  remaining integer,
  blocked_scope text
)
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_result record;
begin
  if p_client_key_hash is null or p_client_key_hash !~ '^[0-9a-f]{64}$'
    or p_login_key_hash is null or p_login_key_hash !~ '^[0-9a-f]{64}$'
    or p_global_key_hash is null or p_global_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_KEY';
  end if;
  if p_client_key_hash = p_login_key_hash
    or p_client_key_hash = p_global_key_hash
    or p_login_key_hash = p_global_key_hash then
    raise exception using errcode = '22023', message = 'RATE_LIMIT_KEYS_MUST_DIFFER';
  end if;
  if p_login_limit < 1 or p_login_limit > 10000
    or p_client_limit < p_login_limit or p_client_limit > 10000
    or p_global_limit < p_client_limit or p_global_limit > 100000
    or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_CONFIGURATION';
  end if;

  delete from private.login_rate_limit_windows windows
  where windows.ctid in (
    select candidates.ctid
    from private.login_rate_limit_windows candidates
    where candidates.expires_at < v_now - interval '10 minutes'
    order by candidates.expires_at
    limit 64
    for update skip locked
  );

  select * into v_result
  from private.consume_login_rate_limit_bucket(
    p_client_key_hash,
    p_client_limit,
    p_window_seconds,
    v_now
  );
  if not v_result.allowed then
    return query select
      false,
      v_result.retry_after_seconds,
      v_result.remaining,
      'client'::text;
    return;
  end if;

  select * into v_result
  from private.consume_login_rate_limit_bucket(
    p_login_key_hash,
    p_login_limit,
    p_window_seconds,
    v_now
  );
  if not v_result.allowed then
    return query select
      false,
      v_result.retry_after_seconds,
      v_result.remaining,
      'login'::text;
    return;
  end if;

  select * into v_result
  from private.consume_login_rate_limit_bucket(
    p_global_key_hash,
    p_global_limit,
    p_window_seconds,
    v_now
  );
  return query select
    v_result.allowed,
    v_result.retry_after_seconds,
    v_result.remaining,
    case when v_result.allowed then null::text else 'global'::text end;
end;
$$;

revoke all on function private.consume_login_rate_limit_bucket(
  text, integer, integer, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.consume_login_rate_limits(
  text, text, integer, integer, integer
) from service_role;
revoke all on function public.consume_login_rate_limits(
  text, text, text, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.consume_login_rate_limits(
  text, text, text, integer, integer, integer, integer
) to service_role;
