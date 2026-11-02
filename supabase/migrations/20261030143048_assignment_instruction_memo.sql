-- #534: optional instructions belong to an immutable assignment revision.
-- Existing rows remain NULL. An empty INSERT default is an internal inheritance
-- marker, consumed by the trigger and never stored or returned. Explicit public
-- input is normalized first, so NULL / whitespace means clear, not inherit.
alter table public.cleaning_assignments add column instruction_memo text;
alter table public.cleaning_assignments alter column instruction_memo set default '';
alter table public.cleaning_assignments add constraint cleaning_assignment_instruction_shape
  check (instruction_memo is null or (char_length(instruction_memo) between 1 and 500));

create function private.normalize_assignment_instruction(p_value text)
returns text language plpgsql immutable set search_path='' as $$
declare normalized text; units integer; i integer;
begin
  if p_value is null then return null; end if;
  units:=char_length(p_value);
  if units>500 then
    raise exception using errcode='22023',message='ASSIGNMENT_INSTRUCTION_INVALID';
  end if;
  -- JavaScript/JSON maxLength is explicitly constrained to 500 UTF-16 units.
  for i in 1..char_length(p_value) loop
    if ascii(substr(p_value,i,1))>65535 then units:=units+1; end if;
  end loop;
  if units>500 then
    raise exception using errcode='22023',message='ASSIGNMENT_INSTRUCTION_INVALID';
  end if;
  -- Exactly ECMAScript String.trim's WhiteSpace + LineTerminator set.
  normalized:=nullif(btrim(p_value,
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),'');
  if normalized is not null and (
    normalized ~ $email$[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$email$
    or normalized ~* $url$https?://|www\.$url$
    or normalized ~ $phone$(^|[^0-9])(01[016789]|\+82[ -]?1[016789])[ -]?[0-9]{3,4}[ -]?[0-9]{4}([^0-9]|$)$phone$
    or normalized ~* $pin$(PIN|비밀번호|출입코드)([ \t\r\n]*[:=][ \t\r\n]*|[ \t\r\n]+)[0-9]{4,}$pin$
  ) then
    raise exception using errcode='22023',message='ASSIGNMENT_INSTRUCTION_INVALID';
  end if;
  return normalized;
end $$;
revoke all on function private.normalize_assignment_instruction(text) from public,anon,authenticated,service_role;

create function private.guard_assignment_instruction()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' then
    if new.instruction_memo is distinct from old.instruction_memo then
      raise exception using errcode='23514',message='ASSIGNMENT_SNAPSHOT_IMMUTABLE';
    end if;
    return new;
  end if;
  -- All same-target creators, including handover, checkout replans and midnight
  -- reassignment, serialize on the target. Never copy another room/target's text.
  perform 1 from public.cleaning_targets where id=new.cleaning_target_id for update;
  if not found then raise exception using errcode='P0002',message='CLEANING_TARGET_NOT_FOUND'; end if;
  if new.instruction_memo='' then
    select a.instruction_memo into new.instruction_memo
    from public.cleaning_assignments a
    where a.cleaning_target_id=new.cleaning_target_id and a.revision<new.revision
    order by a.revision desc limit 1;
    -- No non-null filter: the latest explicit clear must never resurrect text.
  end if;
  new.instruction_memo:=private.normalize_assignment_instruction(new.instruction_memo);
  return new;
end $$;
revoke all on function private.guard_assignment_instruction() from public,anon,authenticated,service_role;
create trigger cleaning_assignments_instruction_snapshot
before insert or update on public.cleaning_assignments
for each row execute function private.guard_assignment_instruction();

-- #328 narrowed browser SELECT to explicit columns. Add only this safe field;
-- the existing own-notified assignment RLS and private schedule packs remain.
grant select(instruction_memo) on public.cleaning_assignments to authenticated;

-- Owner-only projection helpers. Always use exact assignment identity; the
-- optimizer and unassigned-target DTO do not carry assignment instructions.
create function private.assignment_instruction_read(p_target_id uuid,p_assignment_id uuid)
returns text language sql stable set search_path='' as $$
  select a.instruction_memo from public.cleaning_assignments a
  where a.cleaning_target_id=p_target_id and a.id=p_assignment_id
$$;
revoke all on function private.assignment_instruction_read(uuid,uuid) from public,anon,authenticated,service_role;

-- The base attempt projection is also an audit snapshot. Never put text there:
-- enrich only authorized read endpoints, not execution audit/notification proof.
create function private.attempt_instruction_read(p_attempt public.cleaning_attempts)
returns jsonb language sql stable set search_path='' as $$
  select private.attempt_execution_projection(p_attempt)||jsonb_build_object(
    'instructionMemo',(select a.instruction_memo from public.cleaning_assignments a
      where a.id=p_attempt.assignment_id and a.revision=p_attempt.assignment_revision
        and a.cleaning_target_id=p_attempt.cleaning_target_id and a.maid_profile_id=p_attempt.maid_profile_id))
$$;
revoke all on function private.attempt_instruction_read(public.cleaning_attempts) from public,anon,authenticated,service_role;

-- Preserve public identity/ACL, all existing authorization, locks and replay
-- branches. Enrich only newly constructed responses, never an old receipt.
do $projection$
declare patch record; definition text; before_catalog jsonb; after_catalog jsonb; function_oid oid;
begin
  for patch in select * from (values
    ('public.save_cleaning_assignment_draft(uuid,uuid,uuid,integer,bigint,text,text)',
      $old$    'createdAt', v_assignment.created_at
  ) into v_response$old$,
      $new$    'createdAt', v_assignment.created_at,
    'instructionMemo', v_assignment.instruction_memo
  ) into v_response$new$),
    ('private.prestart_assignment_projection(uuid)',
      $old$'endedAt',a.ended_at,'createdAt',a.created_at)$old$,
      $new$'endedAt',a.ended_at,'createdAt',a.created_at,'instructionMemo',a.instruction_memo)$new$),
    ('private.assignment_target_read_rows(jsonb)',
      $old$(row->>'cleaningTargetId')::uuid,nullif(row->>'assignmentId','')::uuid));$old$,
      $new$(row->>'cleaningTargetId')::uuid,nullif(row->>'assignmentId','')::uuid)
      ||case when nullif(row->>'assignmentId','') is null then '{}'::jsonb else
        jsonb_build_object('instructionMemo',private.assignment_instruction_read(
          (row->>'cleaningTargetId')::uuid,(row->>'assignmentId')::uuid)) end);$new$),
    ('private.commit_and_notify_assignments_at(uuid,date,text,jsonb,text,text,timestamptz)',
      $old$      'notifiedAt', p_command_at
    ) || private.assignment_target_read_metadata$old$,
      $new$      'notifiedAt', p_command_at,
      'instructionMemo',private.assignment_instruction_read(v_candidate.target_id,v_candidate.assignment_id)
    ) || private.assignment_target_read_metadata$new$),
    ('public.get_current_cleaning_attempt(uuid,uuid)',
      $old$return private.attempt_execution_projection(v_attempt);$old$,
      $new$return private.attempt_instruction_read(v_attempt);$new$),
    ('public.get_limited_cleaning_attempt(uuid,uuid,uuid,bigint)',
      $old$'attempt',private.attempt_execution_projection(a)$old$,
      $new$'attempt',private.attempt_instruction_read(a)$new$),
    ('public.get_cleaning_attempt_lifecycle_impact(uuid,uuid,uuid)',
      $old$'attempt',private.attempt_execution_projection(a)$old$,
      $new$'attempt',private.attempt_instruction_read(a)$new$)
  ) edits(signature,old_text,new_text) loop
    function_oid:=to_regprocedure(patch.signature);
    if function_oid is null then raise exception 'ASSIGNMENT_INSTRUCTION_SOURCE_MISSING'; end if;
    select replace(pg_get_functiondef(p.oid),E'\r\n',E'\n'),to_jsonb(p)-'prosrc'
      into strict definition,before_catalog from pg_proc p where p.oid=function_oid;
    if (length(definition)-length(replace(definition,patch.old_text,'')))/length(patch.old_text)<>1 then
      raise exception 'ASSIGNMENT_INSTRUCTION_SOURCE_DRIFT: %',patch.signature;
    end if;
    execute replace(definition,patch.old_text,patch.new_text);
    select to_jsonb(p)-'prosrc' into strict after_catalog from pg_proc p where p.oid=function_oid;
    if after_catalog is distinct from before_catalog then raise exception 'ASSIGNMENT_INSTRUCTION_CATALOG_DRIFT'; end if;
  end loop;
end $projection$;

-- New named RPCs avoid default-argument overload ambiguity. HTTP chooses them
-- only when instructionMemo was explicitly present. The legacy call/hash and
-- the exact command receipt namespaces remain unchanged.
do $draft$
declare source text; args text; patch record;
begin
  select replace(prosrc,E'\r\n',E'\n'),pg_get_function_arguments(oid) into strict source,args
  from pg_proc where oid='public.save_cleaning_assignment_draft(uuid,uuid,uuid,integer,bigint,text,text)'::regprocedure;
  for patch in select * from (values
    ($old$  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));$old$,
     $new$  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));
  -- Revalidate after waiting and retain actor/recipient authorization to commit.
  perform 1 from public.profiles where id in (p_actor_profile_id,p_maid_profile_id) order by id for share;
  perform private.assert_room_admin(p_actor_profile_id);$new$),
    ($old$    changed_by,
    created_at
  ) values ($old$,
     $new$    changed_by,
    created_at,
    instruction_memo
  ) values ($new$),
    ($old$    p_actor_profile_id,
    v_now
  )
  returning * into v_assignment;$old$,
     $new$    p_actor_profile_id,
    v_now,
    private.normalize_assignment_instruction(p_instruction_memo)
  )
  returning * into v_assignment;$new$)
  ) edits(old_text,new_text) loop
    if (length(source)-length(replace(source,patch.old_text,'')))/length(patch.old_text)<>1 then
      raise exception 'ASSIGNMENT_INSTRUCTION_DRAFT_SOURCE_DRIFT';
    end if;
    source:=replace(source,patch.old_text,patch.new_text);
  end loop;
  execute format('create function public.save_cleaning_assignment_draft_with_instruction(%s,p_instruction_memo text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as %L',args,source);
end $draft$;
revoke all on function public.save_cleaning_assignment_draft_with_instruction(uuid,uuid,uuid,integer,bigint,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.save_cleaning_assignment_draft_with_instruction(uuid,uuid,uuid,integer,bigint,text,text,text) to service_role;

do $prestart$
declare source text; args text; old_text text; new_text text; lock_text text;
begin
  select replace(prosrc,E'\r\n',E'\n'),pg_get_function_arguments(oid) into strict source,args
  from pg_proc where oid='private.assignment_prestart_command_for_plan(uuid,text,uuid,uuid,bigint,uuid,integer,timestamptz,timestamptz,uuid,text,text,text,text,text,date)'::regprocedure;
  old_text:=$old$    insert into public.cleaning_assignments(cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at)
    values(t.id,p_maid,p_sequence,t.assignment_version,p_actor,case when was_notified then v_now end) returning * into next_a;$old$;
  new_text:=$new$    insert into public.cleaning_assignments(cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at,instruction_memo)
    values(t.id,p_maid,p_sequence,t.assignment_version,p_actor,case when was_notified then v_now end,
      private.normalize_assignment_instruction(p_instruction_memo)) returning * into next_a;$new$;
  if (length(source)-length(replace(source,old_text,'')))/length(old_text)<>1 then
    raise exception 'ASSIGNMENT_INSTRUCTION_PRESTART_SOURCE_DRIFT';
  end if;
  source:=replace(source,old_text,new_text);
  lock_text:=$lock$  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));$lock$;
  if (length(source)-length(replace(source,lock_text,'')))/length(lock_text)<>1 then
    raise exception 'ASSIGNMENT_INSTRUCTION_PRESTART_SOURCE_DRIFT';
  end if;
  source:=replace(source,lock_text,lock_text||E'\n  perform 1 from public.profiles where id=p_actor for share;\n  perform private.assert_room_admin(p_actor);');
  execute format('create function private.assignment_prestart_command_for_plan_with_instruction(%s,p_instruction_memo text) returns jsonb language plpgsql security definer set search_path='''' as %L',args,source);
end $prestart$;
revoke all on function private.assignment_prestart_command_for_plan_with_instruction(uuid,text,uuid,uuid,bigint,uuid,integer,timestamptz,timestamptz,uuid,text,text,text,text,text,date,text)
  from public,anon,authenticated,service_role;

create function public.change_cleaning_assignment_prestart_with_instruction(
  p_actor_profile_id uuid,p_cleaning_target_id uuid,p_expected_current_assignment_id uuid,
  p_expected_assignment_version bigint,p_maid_profile_id uuid,p_sequence_number integer,
  p_reason_code text,p_idempotency_key text,p_request_hash text,p_instruction_memo text,
  p_available_from timestamptz,p_due_at timestamptz)
returns jsonb language sql security definer set search_path='' as $$
  select private.assignment_prestart_command_for_plan_with_instruction(p_actor_profile_id,'change',
    p_cleaning_target_id,p_expected_current_assignment_id,p_expected_assignment_version,p_maid_profile_id,
    p_sequence_number,p_available_from,p_due_at,null,null,p_reason_code,null,p_idempotency_key,p_request_hash,null,p_instruction_memo)
$$;
revoke all on function public.change_cleaning_assignment_prestart_with_instruction(uuid,uuid,uuid,bigint,uuid,integer,text,text,text,text,timestamptz,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.change_cleaning_assignment_prestart_with_instruction(uuid,uuid,uuid,bigint,uuid,integer,text,text,text,text,timestamptz,timestamptz) to service_role;

create function public.change_cleaning_assignment_for_plan_with_instruction(
  p_actor_profile_id uuid,p_cleaning_target_id uuid,p_expected_current_assignment_id uuid,
  p_expected_assignment_version bigint,p_maid_profile_id uuid,p_sequence_number integer,
  p_reason_code text,p_idempotency_key text,p_request_hash text,p_service_date date,p_instruction_memo text,
  p_available_from timestamptz,p_due_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if p_service_date is null then raise exception using errcode='22023',message='ASSIGNMENT_INPUT_INVALID'; end if;
  return private.assignment_prestart_command_for_plan_with_instruction(p_actor_profile_id,'change',
    p_cleaning_target_id,p_expected_current_assignment_id,p_expected_assignment_version,p_maid_profile_id,
    p_sequence_number,p_available_from,p_due_at,null,null,p_reason_code,null,p_idempotency_key,p_request_hash,p_service_date,p_instruction_memo);
end $$;
revoke all on function public.change_cleaning_assignment_for_plan_with_instruction(uuid,uuid,uuid,bigint,uuid,integer,text,text,text,date,text,timestamptz,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.change_cleaning_assignment_for_plan_with_instruction(uuid,uuid,uuid,bigint,uuid,integer,text,text,text,date,text,timestamptz,timestamptz) to service_role;
