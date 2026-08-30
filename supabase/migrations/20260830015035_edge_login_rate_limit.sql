create table private.login_rate_limit_windows (
  key_hash text primary key
    check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  attempt_count integer not null
    check (attempt_count >= 1),
  expires_at timestamptz not null
    check (expires_at > window_started_at)
);

create index login_rate_limit_windows_expires_at_idx
  on private.login_rate_limit_windows (expires_at);

revoke all on table private.login_rate_limit_windows
  from public, anon, authenticated;

create function public.consume_login_rate_limit(
  p_key_hash text,
  p_limit integer default 10,
  p_window_seconds integer default 60
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
  v_now timestamptz := clock_timestamp();
  v_attempt_count integer;
  v_expires_at timestamptz;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_KEY';
  end if;
  if p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_MAX';
  end if;
  if p_window_seconds < 10 or p_window_seconds > 3600 then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_WINDOW';
  end if;

  delete from private.login_rate_limit_windows
  where expires_at < v_now - interval '10 minutes';

  insert into private.login_rate_limit_windows (
    key_hash,
    window_started_at,
    attempt_count,
    expires_at
  ) values (
    p_key_hash,
    v_now,
    1,
    v_now + make_interval(secs => p_window_seconds)
  )
  on conflict (key_hash) do update
  set
    window_started_at = case
      when login_rate_limit_windows.expires_at <= v_now then v_now
      else login_rate_limit_windows.window_started_at
    end,
    attempt_count = case
      when login_rate_limit_windows.expires_at <= v_now then 1
      else least(login_rate_limit_windows.attempt_count + 1, 32767)
    end,
    expires_at = case
      when login_rate_limit_windows.expires_at <= v_now
        then v_now + make_interval(secs => p_window_seconds)
      else login_rate_limit_windows.expires_at
    end
  returning
    login_rate_limit_windows.attempt_count,
    login_rate_limit_windows.expires_at
  into v_attempt_count, v_expires_at;

  allowed := v_attempt_count <= p_limit;
  retry_after_seconds := case
    when allowed then 0
    else greatest(1, ceil(extract(epoch from (v_expires_at - v_now)))::integer)
  end;
  remaining := greatest(0, p_limit - v_attempt_count);
  return next;
end;
$$;

revoke all on function public.consume_login_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_login_rate_limit(text, integer, integer)
  to service_role;
