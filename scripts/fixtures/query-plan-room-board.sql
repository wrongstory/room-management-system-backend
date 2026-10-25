-- #416 LOCAL EMPTY-SEED DATABASE ONLY. All fixture rows and indexes roll back.
-- Real table INSERT/ANALYZE/index trials generate WAL and can leave dead tuples;
-- rollback is logical cleanup, not reversal of physical statistics or WAL.
begin;
set local statement_timeout = '90s';
set local lock_timeout = '2s';
set local idle_in_transaction_session_timeout = '30s';
set local search_path = pg_temp, pg_catalog;
do $$
begin
  if current_database()<>'postgres' or current_user<>'postgres'
    or (select count(*) from supabase_migrations.schema_migrations)<>111
    or (select count(*) from public.rooms)<>121
    or exists(select 1 from public.profiles) or exists(select 1 from auth.users)
    or exists(select 1 from auth.sessions) or exists(select 1 from public.reservations)
    or exists(select 1 from public.room_candle_events) or exists(select 1 from public.room_pin_sync_events)
    or (select md5(prosrc) from pg_proc where oid='public.get_room_board_projection(uuid,uuid,date,uuid)'::regprocedure)
      is distinct from 'dbcb3d36a8ee29447ca04854b6ad8909'
    or (select md5(prosrc) from pg_proc where oid='private.room_board_candle_count_at(uuid,timestamptz)'::regprocedure)
      is distinct from '4c58cb1564512e28dcb4327994acd376'
    or (select md5(prosrc) from pg_proc where oid='private.room_board_pin_sync_status_at(uuid,timestamptz)'::regprocedure)
      is distinct from 'ffae0161f594f1d11f048db47752c9c4'
  then raise exception 'PERF416_EMPTY_LOCAL_BASELINE_REQUIRED'; end if;
end $$;
create temporary table perf416_rpc_results(result jsonb) on commit drop;
create temporary table perf416_rpc_signatures(day_offset integer primary key, signature text) on commit drop;
grant select,insert on pg_temp.perf416_rpc_results,pg_temp.perf416_rpc_signatures to service_role;
insert into auth.users(id) select md5('perf416-user-'||n)::uuid from generate_series(1,2) n;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
  login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select md5('perf416-actor-'||n)::uuid,md5('perf416-user-'||n)::uuid,
  'perf416-'||n,'perf416-'||n,'perf416-'||n,'perf416-'||n,0,
  (case when n=1 then 'admin' else 'maid' end)::public.app_role,'active',false
from generate_series(1,2) n;
insert into auth.sessions(id,user_id)
select md5('perf416-session-'||n)::uuid,md5('perf416-user-'||n)::uuid from generate_series(1,2) n;
-- Actual FK/check/recording-order triggers stay enabled. No PIN secret is created.
insert into public.room_candle_events(room_id,count_before,count_after,physically_verified,
  reason_code,actor_profile_id,effective_at)
select r.id,0,n%5,false,'PERF416_SYNTHETIC',md5('perf416-actor-1')::uuid,
  statement_timestamp()-interval '3 days'+(n/3)*interval '1 hour'
from public.rooms r cross join generate_series(1,100) n;
insert into public.room_pin_sync_events(room_id,sync_status,reason_code,actor_profile_id,effective_at,recorded_at)
select r.id,'mismatch','PERF416_SYNTHETIC',md5('perf416-actor-1')::uuid,
  statement_timestamp()-interval '3 days'+(n/3)*interval '1 hour',
  statement_timestamp()-interval '2 days'+((n/3*7%101)/3)*interval '1 minute'
from public.rooms r cross join generate_series(1,100) n;
analyze public.room_candle_events;
analyze public.room_pin_sync_events;

do $$
<<bench>>
declare
  mode text; day_offset integer; sample integer; query text; observed json;
  signature text; expected text; index_bytes bigint; event_table text; denied integer;
begin
  foreach mode in array array['recorded_only','effective_candidate'] loop
    index_bytes:=0;
    if mode='effective_candidate' then
      create index perf416_candle_effective on public.room_candle_events(room_id,effective_at desc,recorded_at desc,id desc);
      create index perf416_pin_effective on public.room_pin_sync_events(room_id,effective_at desc,recorded_at desc,id desc);
      index_bytes:=pg_relation_size('public.perf416_candle_effective')+pg_relation_size('public.perf416_pin_effective');
    end if;
    -- Match the production RPC caller role, including actor/session validation.
    execute 'set local role service_role';
    denied:=0;
    begin
      perform * from public.get_room_board_projection(md5('perf416-actor-2')::uuid,md5('perf416-session-2')::uuid,null,null);
    exception when insufficient_privilege then
      if sqlerrm<>'ADMIN_REQUIRED' then raise; end if;
      denied:=denied+1;
    end;
    begin
      perform * from public.get_room_board_projection(md5('perf416-actor-1')::uuid,md5('perf416-missing-session')::uuid,null,null);
    exception when insufficient_privilege then
      if sqlerrm<>'SESSION_REVOKED' then raise; end if;
      denied:=denied+1;
    end;
    if denied<>2 then raise exception 'PERF416_AUTH_DENIAL_MISSING'; end if;
    foreach day_offset in array array[-2,0,1] loop
      query:=format('select * from public.get_room_board_projection(%L::uuid,%L::uuid,%L::date,null)',
        md5('perf416-actor-1')::uuid,md5('perf416-session-1')::uuid,
        (statement_timestamp() at time zone 'Asia/Seoul')::date+day_offset);
      -- All calls are in this DO statement: statement_timestamp is identical,
      -- so compare EVERY returned business/clock field, not a partial DTO.
      execute 'select md5(jsonb_agg(to_jsonb(r) order by r.id)::text) from ('||query||') r' into signature;
      if mode='recorded_only' then
        insert into pg_temp.perf416_rpc_signatures values(day_offset,signature);
      else
        select s.signature into strict expected from pg_temp.perf416_rpc_signatures s where s.day_offset=bench.day_offset;
        if signature is distinct from expected then raise exception 'PERF416_RPC_RESULT_MISMATCH'; end if;
      end if;
      for sample in 0..3 loop
        execute 'explain(analyze,buffers,wal,format json) '||query into observed;
        if sample>0 then
          insert into pg_temp.perf416_rpc_results values(jsonb_build_object('kind','read','mode',mode,
            'dayOffset',day_offset,'sample',sample,'extraIndexBytes',index_bytes,
            'resultEquivalent',true,'denials',denied,'plan',observed));
        end if;
      end loop;
    end loop;
    execute 'reset role';
    foreach event_table in array array['room_candle_events','room_pin_sync_events'] loop
      query:=case event_table when 'room_candle_events' then
        'insert into public.room_candle_events(room_id,count_before,count_after,physically_verified,reason_code,actor_profile_id,effective_at)
         select id,0,2,false,''PERF416_WRITE'',md5(''perf416-actor-1'')::uuid,statement_timestamp() from public.rooms returning id'
      else
        'insert into public.room_pin_sync_events(room_id,sync_status,reason_code,actor_profile_id,effective_at)
         select id,''mismatch'',''PERF416_WRITE'',md5(''perf416-actor-1'')::uuid,statement_timestamp() from public.rooms returning id' end;
      for sample in 0..3 loop
        -- Catch only our sentinel; real INSERT failures abort the whole run.
        -- PL/pgSQL variables retain the plan while this subtransaction rolls back.
        begin
          execute 'explain(analyze,buffers,wal,format json) '||query into observed;
          raise exception sqlstate 'P0416' using message='PERF416_ROLLBACK_WRITE_SAMPLE';
        exception when sqlstate 'P0416' then null;
        end;
        if sample>0 then
          insert into pg_temp.perf416_rpc_results values(jsonb_build_object('kind','write','mode',mode,
            'table',event_table,'sample',sample,'extraIndexBytes',index_bytes,'plan',observed));
        end if;
      end loop;
    end loop;
    if (select count(*) from public.room_candle_events)<>12100
      or (select count(*) from public.room_pin_sync_events)<>12100 then
      raise exception 'PERF416_WRITE_ROLLBACK_MISMATCH';
    end if;
  end loop;
end $$;
select jsonb_build_object('scope','local-room-board-rpc-and-event-write','serverVersion',current_setting('server_version'),
  'rooms',121,'eventsPerRoom',100,'results',jsonb_agg(result))::text from pg_temp.perf416_rpc_results;
rollback;
-- Success must include a post-rollback check; no fixture identities/indexes remain.
do $$ begin
  if exists(select 1 from public.profiles) or exists(select 1 from auth.users) or exists(select 1 from auth.sessions)
    or exists(select 1 from public.room_candle_events) or exists(select 1 from public.room_pin_sync_events)
    or to_regclass('public.perf416_candle_effective') is not null or to_regclass('public.perf416_pin_effective') is not null
  then raise exception 'PERF416_CLEANUP_FAILED'; end if;
end $$;
