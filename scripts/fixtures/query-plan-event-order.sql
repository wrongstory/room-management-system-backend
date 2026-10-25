-- #416 component benchmark only: synthetic rows, session-local objects, rollback.
-- No application tables, roles, functions, indexes or migration history are changed.
begin;
set local statement_timeout = '45s';
set local lock_timeout = '2s';
set local idle_in_transaction_session_timeout = '60s';
set local search_path = pg_temp, pg_catalog;

create temporary table perf416_rooms(id uuid primary key) on commit drop;
create temporary table perf416_events(
  id uuid primary key, room_id uuid not null,
  effective_at timestamptz not null, recorded_at timestamptz not null,
  value integer not null
) on commit drop;
create index perf416_recorded on perf416_events(room_id, recorded_at desc);
create temporary table perf416_results(result jsonb) on commit drop;
create temporary table perf416_signatures(size integer, cutoff text, signature text, primary key(size,cutoff)) on commit drop;
insert into pg_temp.perf416_rooms select md5('synthetic-room-' || n)::uuid from generate_series(1,121) n;

do $$
<<bench>>
declare
  size integer; cutoff text; mode text; sample integer; at_time timestamptz;
  query text; plan json; signature text; expected text; index_bytes bigint;
begin
  foreach size in array array[1,100,1000] loop
    truncate pg_temp.perf416_events;
    -- Equal effective/recorded timestamps deliberately exercise the UUID tie-breaker.
    -- Recorded order also differs from effective order, as backdated events can do.
    insert into pg_temp.perf416_events
      select md5(room.id::text || ':' || n)::uuid, room.id,
        timestamptz '2026-01-01 00:00:00+00' + (n / 3) * interval '1 minute',
        timestamptz '2026-01-01 00:00:00+00' + ((n / 3 * 7 % 101) / 3) * interval '1 minute', n % 5
      from pg_temp.perf416_rooms room cross join generate_series(1,size) n;
    if size>1 and not exists(select 1 from pg_temp.perf416_events
      group by room_id,effective_at,recorded_at having count(*)>1) then
      raise exception 'PERF416_TIE_FIXTURE_MISSING';
    end if;
    analyze pg_temp.perf416_rooms;
    analyze pg_temp.perf416_events;
    foreach mode in array array['recorded_only','effective_candidate'] loop
      if mode = 'effective_candidate' then
        create index perf416_effective on pg_temp.perf416_events(room_id,effective_at desc,recorded_at desc,id desc);
      end if;
      index_bytes := 0;
      if mode='effective_candidate' then
        index_bytes := pg_relation_size('pg_temp.perf416_effective');
      end if;
      foreach cutoff in array array['before','middle','latest'] loop
        at_time := case cutoff
          when 'before' then timestamptz '2025-12-31 23:59:00+00'
          when 'middle' then timestamptz '2026-01-01 00:00:00+00' + (size/6)*interval '1 minute'
          else timestamptz '2026-01-02 00:00:00+00' end;
        query := format('select room.id, event.id as event_id, coalesce(event.value,0) as value
          from pg_temp.perf416_rooms room left join lateral (
            select e.id,e.value from pg_temp.perf416_events e
            where e.room_id=room.id and e.effective_at<=%L::timestamptz
            order by e.effective_at desc,e.recorded_at desc,e.id desc limit 1
          ) event on true order by room.id', at_time);
        execute 'select md5(jsonb_agg(row_to_json(row))::text) from ('||query||') row' into signature;
        if mode='recorded_only' then
          insert into pg_temp.perf416_signatures values(size,cutoff,signature);
        else
          select s.signature into strict expected from pg_temp.perf416_signatures s where s.size=bench.size and s.cutoff=bench.cutoff;
          if signature is distinct from expected then raise exception 'PERF416_RESULT_MISMATCH'; end if;
        end if;
        -- Warm each mode separately, then retain three samples without latency thresholds.
        for sample in 0..3 loop
          execute 'explain (analyze,buffers,format json) '||query into plan;
          if sample>0 then
            insert into pg_temp.perf416_results values(jsonb_build_object(
              'eventsPerRoom',size,'cutoff',cutoff,'mode',mode,'sample',sample,
              'extraIndexBytes',index_bytes,'resultEquivalent',true,'plan',plan));
          end if;
        end loop;
      end loop;
      if mode='effective_candidate' then drop index pg_temp.perf416_effective; end if;
    end loop;
  end loop;
end $$;
select jsonb_build_object('serverVersion',current_setting('server_version'),
  'scope','synthetic-event-order-component','rooms',121,'results',jsonb_agg(result))::text
from pg_temp.perf416_results;
rollback;
