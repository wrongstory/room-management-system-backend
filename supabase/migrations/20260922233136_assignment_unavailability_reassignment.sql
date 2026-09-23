-- #264: an admin can end an unavailable maid's current responsibility without
-- inventing a successor.  The room remains explicit unassigned work and the
-- ordinary draft/commit flow owns the later reassignment.

create table private.assignment_unavailability_cancellations (
  id uuid primary key default gen_random_uuid(),
  cleaning_target_id uuid not null references public.cleaning_targets(id) on delete restrict,
  assignment_id uuid not null references public.cleaning_assignments(id) on delete restrict,
  attempt_id uuid references public.cleaning_attempts(id) on delete restrict,
  maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  reason_code text not null check (reason_code in ('MAID_DEPARTED','MAID_INJURED','MAID_UNAVAILABLE')),
  target_assignment_version bigint not null check (target_assignment_version > 0),
  assignment_revision bigint not null check (assignment_revision > 0),
  attempt_execution_version bigint check (attempt_execution_version is null or attempt_execution_version > 0),
  replacement_target_id uuid references public.cleaning_targets(id) on delete restrict,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (assignment_id),
  check ((attempt_id is null) = (attempt_execution_version is null)),
  check (isfinite(occurred_at) and isfinite(recorded_at))
);

create index assignment_unavailability_target_idx
  on private.assignment_unavailability_cancellations(cleaning_target_id,occurred_at desc,id desc);
create index assignment_unavailability_replacement_idx
  on private.assignment_unavailability_cancellations(replacement_target_id)
  where replacement_target_id is not null;

alter table private.assignment_unavailability_cancellations enable row level security;
alter table private.assignment_unavailability_cancellations force row level security;
revoke all on table private.assignment_unavailability_cancellations
  from public,anon,authenticated,service_role;

alter table private.attempt_capability_revocations
  drop constraint attempt_capability_revocations_reason_code_check;
alter table private.attempt_capability_revocations
  add constraint attempt_capability_revocations_reason_code_check
  check(reason_code in ('FIELD_COMPLETED','HANDOVER','ACCOUNT_CHANGED','ASSIGNMENT_UNAVAILABLE'));

create function private.guard_assignment_unavailability_cancellation()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op<>'INSERT' then
    raise exception using errcode='55000',message='IMMUTABLE_LEDGER';
  end if;
  if not exists(
    select 1 from public.cleaning_assignments a
    join public.cleaning_targets t on t.id=a.cleaning_target_id
    where a.id=new.assignment_id and a.cleaning_target_id=new.cleaning_target_id
      and a.maid_profile_id=new.maid_profile_id and not a.is_current
      and a.revision=new.assignment_revision and a.ended_at=new.occurred_at
      and t.assignment_version=new.target_assignment_version+1
  ) then
    raise exception using errcode='23514',message='ASSIGNMENT_UNAVAILABILITY_IDENTITY_INVALID';
  end if;
  if new.attempt_id is not null and not exists(
    select 1 from public.cleaning_attempts x
    where x.id=new.attempt_id and x.cleaning_target_id=new.cleaning_target_id
      and x.assignment_id=new.assignment_id and x.maid_profile_id=new.maid_profile_id
      and x.assignment_revision=new.assignment_revision
      and x.execution_version=new.attempt_execution_version+1
      and x.status in ('superseded','interrupted') and x.ended_at=new.occurred_at
  ) then
    raise exception using errcode='23514',message='ASSIGNMENT_UNAVAILABILITY_IDENTITY_INVALID';
  end if;
  return new;
end $$;
revoke all on function private.guard_assignment_unavailability_cancellation()
  from public,anon,authenticated,service_role;
create trigger assignment_unavailability_cancellation_immutable
before insert or update or delete on private.assignment_unavailability_cancellations
for each row execute function private.guard_assignment_unavailability_cancellation();

-- A proven unavailability cancellation is another terminal responsibility
-- boundary, alongside the existing immediate handover evidence.
create or replace function private.attempt_blocks_assignment(p_attempt public.cleaning_attempts)
returns boolean language sql stable security definer set search_path='' as $$
  select p_attempt.status<>'superseded'
    and not (p_attempt.status='interrupted' and (
      exists(
        select 1 from private.attempt_handover_events h
        join public.cleaning_attempts n on n.id=h.next_attempt_id
        join public.cleaning_assignments s on s.id=p_attempt.assignment_id
        where h.previous_attempt_id=p_attempt.id and n.id<>p_attempt.id
          and n.cleaning_target_id=p_attempt.cleaning_target_id
          and n.attempt_number>p_attempt.attempt_number
          and n.assignment_revision>p_attempt.assignment_revision
          and p_attempt.ended_at=h.occurred_at and not s.is_current and s.ended_at is not null
      )
      or exists(
        select 1 from private.assignment_unavailability_cancellations c
        join public.cleaning_assignments s on s.id=c.assignment_id
        where c.attempt_id=p_attempt.id and c.cleaning_target_id=p_attempt.cleaning_target_id
          and c.assignment_id=p_attempt.assignment_id and c.maid_profile_id=p_attempt.maid_profile_id
          and c.assignment_revision=p_attempt.assignment_revision
          and c.attempt_execution_version+1=p_attempt.execution_version
          and c.occurred_at=p_attempt.ended_at and not s.is_current and s.ended_at=c.occurred_at
      )
    ));
$$;
revoke all on function private.attempt_blocks_assignment(public.cleaning_attempts)
  from public,anon,authenticated,service_role;

-- Add the administrator action notification to the immutable source catalog.
drop trigger notification_event_catalog_immutable on private.notification_event_catalog;
insert into private.notification_event_catalog(
  event_family,category,source_entity_kind,recipient_capability,requires_action,
  push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind
) values (
  'assignment.reassignment_required','assignment_reassignment_required',
  'assignment_unavailability_cancellation','admin.assignment_decider',true,true,
  'none','cleaningTarget','assignment_reassignment_required','room'
);
create trigger notification_event_catalog_immutable
before update or delete on private.notification_event_catalog
for each row execute function private.guard_notification_catalog_ledgers();

alter function private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)
  rename to notification_source_is_valid_before_assignment_unavailability;

create function private.notification_source_is_valid(
  p_event_family text,p_actor uuid,p_recipient uuid,p_source_id text,
  p_room uuid,p_cleaning_target uuid,p_deep_link_entity uuid
) returns boolean language plpgsql volatile security definer set search_path='' as $$
declare
  c private.assignment_unavailability_cancellations;
  t public.cleaning_targets;
  source_uuid uuid;
begin
  if p_event_family='assignment.reassignment_required' then
    begin source_uuid:=p_source_id::uuid;
    exception when invalid_text_representation then return false; end;
    select cancellation.* into c
    from private.assignment_unavailability_cancellations cancellation
    where cancellation.id=source_uuid;
    select * into t from public.cleaning_targets where id=coalesce(c.replacement_target_id,c.cleaning_target_id);
    return c.id is not null and c.actor_profile_id=p_actor
      and exists(select 1 from public.profiles p where p.id=p_recipient and p.role='admin'
        and p.status='active' and not p.must_change_password)
      and p_room is not distinct from t.room_id
      and p_cleaning_target is not distinct from t.id
      and p_deep_link_entity is not distinct from t.id;
  end if;
  return private.notification_source_is_valid_before_assignment_unavailability(
    p_event_family,p_actor,p_recipient,p_source_id,p_room,p_cleaning_target,p_deep_link_entity
  );
end $$;
revoke all on function private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid),
  private.notification_source_is_valid_before_assignment_unavailability(text,uuid,uuid,text,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;

-- Extend only the source-controlled command allowlist. Existing receipt and
-- notification coverage semantics remain unchanged.
create or replace function private.replay_command(
  p_actor_profile_id uuid,p_command_type text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare v_existing private.command_executions%rowtype;
begin
  perform set_config('app.notification_writer_mode','',true);
  perform set_config('app.notification_terminal_kind','',true);
  perform set_config('app.notification_terminal_id','',true);
  perform set_config('app.notification_legacy_suppressed_count','0',true);
  perform set_config('app.notification_typed_emit_count','0',true);
  begin
    if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
      raise exception using errcode='22023',message='INVALID_IDEMPOTENCY_KEY';
    end if;
    if p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='22023',message='INVALID_REQUEST_HASH';
    end if;
    perform set_config('app.notification_writer_mode',case when p_command_type in (
      'reservation.change','reservation.cancel','reservation.manual_checkout',
      'cleaning.manual_request.cancel','assignment.commit_notify',
      'assignment.prestart_change','assignment.prestart_unassign',
      'assignment.cancellation_request','assignment.cancellation_decision',
      'assignment.unavailability_cancel',
      'assignment.process_due_lifecycle','cleaning.lifecycle.allow_finish',
      'cleaning.lifecycle.allow_upload','cleaning.lifecycle.interrupt_handover',
      'cleaning.lifecycle.expire_scheduled','cleaning.limited.complete_field_work',
      'cleaning.attempt.start','submission.create','inspection.approved','inspection.rejected',
      'complaint.create','complaint.decide','complaint.respond','complaint.correct',
      'complaint.close','complaint.materialize_rework','payroll.adjustment.correct',
      'payroll.adjustment.reverse','payroll.late_earning.carry','payroll.start',
      'payroll.carry_forward','payroll.payment.check','payroll.payment.paid',
      'payroll.payment.reopen'
    ) then 'typed_v1' else '' end,true);
    perform pg_advisory_xact_lock(hashtextextended(
      p_actor_profile_id::text||':'||p_command_type||':'||p_idempotency_key,0));
    select * into v_existing from private.command_executions ce
    where ce.actor_profile_id=p_actor_profile_id and ce.command_type=p_command_type
      and ce.idempotency_key=p_idempotency_key;
    if not found then return null; end if;
    if v_existing.request_hash<>p_request_hash then
      raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED';
    end if;
    perform set_config('app.notification_writer_mode','',true);
    perform set_config('app.notification_legacy_suppressed_count','',true);
    perform set_config('app.notification_typed_emit_count','',true);
    return v_existing.response_payload;
  exception when others then
    perform set_config('app.notification_writer_mode','',true);
    perform set_config('app.notification_terminal_kind','',true);
    perform set_config('app.notification_terminal_id','',true);
    perform set_config('app.notification_legacy_suppressed_count','',true);
    perform set_config('app.notification_typed_emit_count','',true);
    raise;
  end;
end $$;

create function private.assignment_unavailability_projection(
  p_event private.assignment_unavailability_cancellations
) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'cancellationId',p_event.id,
    'cleaningTargetId',p_event.cleaning_target_id,
    'assignmentId',p_event.assignment_id,
    'attemptId',p_event.attempt_id,
    'maidProfileId',p_event.maid_profile_id,
    'reasonCode',p_event.reason_code,
    'replacementTargetId',p_event.replacement_target_id,
    'status','unassigned',
    'targetAssignmentVersion',t.assignment_version,
    'effectiveAt',p_event.occurred_at,
    'recordedAt',p_event.recorded_at
  ) from public.cleaning_targets t
  where t.id=coalesce(p_event.replacement_target_id,p_event.cleaning_target_id);
$$;
revoke all on function private.assignment_unavailability_projection(
  private.assignment_unavailability_cancellations
) from public,anon,authenticated,service_role;

create function private.cancel_unavailable_cleaning_assignment_at(
  p_actor_profile_id uuid,p_session_id uuid,p_cleaning_target_id uuid,
  p_expected_assignment_id uuid,p_expected_assignment_version bigint,
  p_expected_attempt_id uuid,p_expected_execution_version bigint,
  p_reason_code text,p_idempotency_key text,p_request_hash text,p_command_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor public.profiles%rowtype; t public.cleaning_targets%rowtype;
  a public.cleaning_assignments%rowtype; x public.cleaning_attempts%rowtype;
  origin_t public.cleaning_targets%rowtype; replacement public.cleaning_targets%rowtype;
  event_row private.assignment_unavailability_cancellations%rowtype;
  response jsonb; at_time timestamptz:=coalesce(p_command_at,clock_timestamp()); admin_row record; item record;
begin
  actor:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,true);
  if p_cleaning_target_id is null or p_expected_assignment_id is null
    or p_expected_assignment_version is null or p_expected_assignment_version<1
    or (p_expected_attempt_id is null)<>(p_expected_execution_version is null)
    or (p_expected_execution_version is not null and p_expected_execution_version<1)
    or p_reason_code not in ('MAID_DEPARTED','MAID_INJURED','MAID_UNAVAILABLE') then
    raise exception using errcode='22023',message='ASSIGNMENT_UNAVAILABILITY_INPUT_INVALID';
  end if;
  response:=private.replay_command(p_actor_profile_id,'assignment.unavailability_cancel',
    p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into t from public.cleaning_targets where id=p_cleaning_target_id for update;
  if t.id is null then raise exception using errcode='P0002',message='ASSIGNMENT_NOT_FOUND'; end if;
  select * into a from public.cleaning_assignments
    where cleaning_target_id=t.id and is_current for update;
  if a.id is null then raise exception using errcode='P0002',message='ASSIGNMENT_NOT_FOUND'; end if;
  select * into x from public.cleaning_attempts
    where cleaning_target_id=t.id and private.attempt_blocks_assignment(cleaning_attempts)
    order by attempt_number desc,id desc limit 1 for update;

  if a.id<>p_expected_assignment_id or a.revision<>t.assignment_version
    or t.assignment_version<>p_expected_assignment_version
    or x.id is distinct from p_expected_attempt_id
    or x.execution_version is distinct from p_expected_execution_version then
    raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT';
  end if;
  if t.status in ('approved','cancelled') or (x.id is not null and x.status not in ('scheduled','in_progress')) then
    raise exception using errcode='55000',message='ASSIGNMENT_UNAVAILABILITY_INVALID_TRANSITION';
  end if;

  if x.id is not null then
    update public.cleaning_attempts set
      status=case when x.status='scheduled' then 'superseded'::public.attempt_status
        else 'interrupted'::public.attempt_status end,
      ended_at=at_time,end_reason=p_reason_code,execution_version=execution_version+1
    where id=x.id returning * into x;
    insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
      select id,at_time,'ASSIGNMENT_UNAVAILABLE',p_actor_profile_id from private.attempt_capability_grants
      where attempt_id=x.id and kind in ('finish_current','upload_submit','evidence_upload')
      on conflict(capability_id) do nothing;
  end if;

  update public.cleaning_assignments set is_current=false,ended_at=at_time,
    change_reason_code=p_reason_code where id=a.id returning * into a;

  if t.source='inspection_reclean' then
    select parent.* into origin_t from public.cleaning_attempts origin_attempt
      join public.cleaning_targets parent on parent.id=origin_attempt.cleaning_target_id
      where origin_attempt.id=t.reclean_of_attempt_id;
    if origin_t.id is null or origin_t.fee_snapshot<0 then
      raise exception using errcode='23514',message='RECLEAN_ORIGIN_NOT_FOUND';
    end if;
    update public.cleaning_targets set status='cancelled',assignment_version=assignment_version+1,
      cancellation_reason_code=p_reason_code,cancelled_at=at_time,cancelled_by=p_actor_profile_id
      where id=t.id returning * into t;
    insert into public.cleaning_targets(
      room_id,reservation_id,cleaning_kind,source,source_key,original_service_date,
      effective_service_date,carryover_count,available_from,due_at,status,assignment_version,
      room_type_snapshot,fee_snapshot,template_snapshot,created_by
    ) values (
      t.room_id,null,'additional','manual_room_request','unavailability-replacement:'||a.id::text,
      t.original_service_date,t.effective_service_date,t.carryover_count,t.available_from,t.due_at,
      'unassigned',1,t.room_type_snapshot,origin_t.fee_snapshot,origin_t.template_snapshot,p_actor_profile_id
    ) returning * into replacement;
    insert into public.cleaning_target_schedule_revisions(
      cleaning_target_id,revision,effective_service_date,available_from,due_at,reason_code,changed_by
    ) values (replacement.id,1,replacement.effective_service_date,replacement.available_from,
      replacement.due_at,p_reason_code,p_actor_profile_id);
  else
    update public.cleaning_targets set status='unassigned',assignment_version=assignment_version+1
      where id=t.id returning * into t;
  end if;

  insert into private.assignment_unavailability_cancellations(
    cleaning_target_id,assignment_id,attempt_id,maid_profile_id,actor_profile_id,reason_code,
    target_assignment_version,assignment_revision,attempt_execution_version,replacement_target_id,
    occurred_at
  ) values (
    t.id,a.id,x.id,a.maid_profile_id,p_actor_profile_id,p_reason_code,
    p_expected_assignment_version,a.revision,p_expected_execution_version,replacement.id,at_time
  ) returning * into event_row;

  for item in select event_family,source_entity_kind,source_entity_id
    from public.notifications where contract_version=1 and source_entity_kind='cleaning_assignment'
      and source_entity_id=a.id::text and resolved_at is null
  loop
    perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,at_time);
  end loop;
  if a.notified_at is not null then
    perform private.emit_notification_v1('assignment.prestart_unassigned',p_actor_profile_id,a.maid_profile_id,
      'cleaning_assignment',a.id::text,'청소 배정이 취소되었습니다',
      '수행 불가 처리로 기존 담당이 종료되었습니다.',t.room_id,t.id,t.id,at_time);
  end if;
  for admin_row in select id from public.profiles
    where role='admin' and status='active' and not must_change_password order by id
  loop
    perform private.emit_notification_v1('assignment.reassignment_required',p_actor_profile_id,admin_row.id,
      'assignment_unavailability_cancellation',event_row.id::text,'청소 재배정이 필요합니다',
      '수행 불가 처리된 객실이 미배정 상태입니다.',
      coalesce(replacement.room_id,t.room_id),coalesce(replacement.id,t.id),
      coalesce(replacement.id,t.id),at_time);
  end loop;

  response:=private.assignment_unavailability_projection(event_row);
  insert into public.audit_events(
    actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
    effective_at,reason_code,after_state,request_hash,idempotency_key
  ) values (
    p_actor_profile_id,actor.display_name,'assignment.unavailability_cancelled',
    'assignment_unavailability_cancellation',event_row.id,at_time,p_reason_code,
    jsonb_strip_nulls(jsonb_build_object(
      'cleaningTargetId',event_row.cleaning_target_id,'assignmentId',event_row.assignment_id,
      'attemptId',event_row.attempt_id,'maidProfileId',event_row.maid_profile_id,
      'reasonCode',event_row.reason_code,'replacementTargetId',event_row.replacement_target_id,
      'targetAssignmentVersion',coalesce(replacement.assignment_version,t.assignment_version)
    )),p_request_hash,private.audit_command_key(
      p_actor_profile_id,'assignment.unavailability_cancel',p_idempotency_key)
  );
  perform private.complete_command(p_actor_profile_id,'assignment.unavailability_cancel',
    p_idempotency_key,p_request_hash,event_row.id,response);
  return response;
end $$;
revoke all on function private.cancel_unavailable_cleaning_assignment_at(
  uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text,timestamptz
) from public,anon,authenticated,service_role;

create function public.cancel_unavailable_cleaning_assignment(
  p_actor_profile_id uuid,p_session_id uuid,p_cleaning_target_id uuid,
  p_expected_assignment_id uuid,p_expected_assignment_version bigint,
  p_expected_attempt_id uuid,p_expected_execution_version bigint,
  p_reason_code text,p_idempotency_key text,p_request_hash text
) returns jsonb language sql security definer set search_path='' as $$
  select private.cancel_unavailable_cleaning_assignment_at(
    p_actor_profile_id,p_session_id,p_cleaning_target_id,p_expected_assignment_id,
    p_expected_assignment_version,p_expected_attempt_id,p_expected_execution_version,
    p_reason_code,p_idempotency_key,p_request_hash,null
  );
$$;
revoke all on function public.cancel_unavailable_cleaning_assignment(
  uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text
) from public,anon,authenticated;
grant execute on function public.cancel_unavailable_cleaning_assignment(
  uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text
) to service_role;

comment on table private.assignment_unavailability_cancellations is
  'Immutable evidence that an unavailable maid responsibility ended without a successor; normal assignment flow owns reassignment.';

-- Add the new domain event to the bounded developer projection without
-- exposing the immutable ledger's raw states, request hash, or command key.
alter function private.developer_audit_event_types()
  rename to developer_audit_event_types_before_assignment_unavailability;
revoke all on function private.developer_audit_event_types_before_assignment_unavailability()
  from public,anon,authenticated,service_role;

create function private.developer_audit_event_types()
returns text[] language sql immutable set search_path='' as $$
  select array_append(
    private.developer_audit_event_types_before_assignment_unavailability(),
    'assignment.unavailability_cancelled'
  )
$$;
revoke all on function private.developer_audit_event_types()
  from public,anon,authenticated,service_role;

alter function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) rename to list_developer_audit_events_before_assignment_unavailability;
revoke all on function private.list_developer_audit_events_before_assignment_unavailability(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) from public,anon,authenticated,service_role;

create function public.list_developer_audit_events(
  p_actor_profile_id uuid,
  p_event_types text[] default null,
  p_filter_actor_profile_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns table(
  id uuid,event_type text,entity_type text,entity_id uuid,
  actor_profile_id uuid,actor_display_name text,effective_at timestamptz,
  recorded_at timestamptz,reason_code text,summary jsonb
)
language plpgsql security definer set search_path='' as $$
declare
  v_new_type constant text:='assignment.unavailability_cancelled';
  v_allowed_types constant text[]:=private.developer_audit_event_types();
  v_previous_types text[];
  v_from timestamptz:=coalesce(p_from,clock_timestamp()-interval '7 days');
  v_to timestamptz:=coalesce(p_to,clock_timestamp());
begin
  if p_event_types is not null and (
    coalesce(cardinality(p_event_types),0)=0
    or exists(select 1 from unnest(p_event_types) requested
      where requested<>all(v_allowed_types))
  ) then
    raise exception using errcode='22023',message='INVALID_AUDIT_QUERY';
  end if;
  if p_event_types is null then
    v_previous_types:=null;
  else
    select coalesce(array_agg(requested),array[]::text[]) into v_previous_types
    from unnest(p_event_types) requested where requested<>v_new_type;
    if cardinality(v_previous_types)=0 then
      v_previous_types:=array['account.created'];
    end if;
  end if;

  return query
  select merged.* from (
    select previous.*
    from private.list_developer_audit_events_before_assignment_unavailability(
      p_actor_profile_id,v_previous_types,p_filter_actor_profile_id,
      p_from,p_to,p_before_recorded_at,p_before_id,p_limit
    ) previous
    where p_event_types is null or previous.event_type=any(p_event_types)
    union all
    select audit.id,audit.event_type,audit.entity_type,audit.entity_id,
      audit.actor_profile_id,audit.actor_display_name_snapshot,
      audit.effective_at,audit.recorded_at,audit.reason_code,
      jsonb_strip_nulls(jsonb_build_object(
        'cleaningTargetId',audit.after_state->'cleaningTargetId',
        'assignmentId',audit.after_state->'assignmentId',
        'attemptId',audit.after_state->'attemptId',
        'maidProfileId',audit.after_state->'maidProfileId',
        'reasonCode',audit.after_state->'reasonCode',
        'replacementTargetId',audit.after_state->'replacementTargetId',
        'targetAssignmentVersion',audit.after_state->'targetAssignmentVersion'
      ))
    from public.audit_events audit
    where audit.event_type=v_new_type
      and (p_event_types is null or audit.event_type=any(p_event_types))
      and audit.recorded_at>=v_from and audit.recorded_at<=v_to
      and (p_filter_actor_profile_id is null
        or audit.actor_profile_id=p_filter_actor_profile_id)
      and (p_before_recorded_at is null
        or (audit.recorded_at,audit.id)<(p_before_recorded_at,p_before_id))
    order by recorded_at desc,id desc limit p_limit
  ) merged order by merged.recorded_at desc,merged.id desc limit p_limit;
end
$$;
revoke all on function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) from public,anon,authenticated;
grant execute on function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) to service_role;

comment on function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) is 'Lists bounded safe developer audit projections, including assignment-unavailability cancellation evidence, without raw audit states or request hashes.';
