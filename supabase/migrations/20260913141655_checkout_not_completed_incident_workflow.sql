-- Issue #133: a maid-reported guest-presence conflict after scheduled checkout.
-- The incident is a separate lifecycle axis: immutable work history is retained,
-- while every future execution path is fail-closed until an admin decision.

create table public.checkout_presence_incidents (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  checkout_obligation_id uuid not null references public.checkout_cleaning_obligations(id) on delete restrict,
  cleaning_target_id uuid not null references public.cleaning_targets(id) on delete restrict,
  assignment_id uuid not null references public.cleaning_assignments(id) on delete restrict,
  attempt_id uuid not null references public.cleaning_attempts(id) on delete restrict,
  reported_by uuid not null references public.profiles(id) on delete restrict,
  reason_code text not null check (reason_code = 'GUEST_STILL_PRESENT'),
  status text not null default 'open' check (status in ('open','resolved')),
  reservation_version bigint not null check (reservation_version > 0),
  target_assignment_version bigint not null check (target_assignment_version > 0),
  assignment_revision bigint not null check (assignment_revision > 0),
  attempt_execution_version bigint not null check (attempt_execution_version > 0),
  pin_version_snapshot bigint check (pin_version_snapshot is null or pin_version_snapshot > 0),
  version bigint not null default 1 check (version > 0),
  current_decision_id uuid,
  reported_at timestamptz not null,
  resolved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (isfinite(reported_at)),
  check ((status = 'open' and current_decision_id is null and resolved_at is null)
    or (status = 'resolved' and current_decision_id is not null and resolved_at is not null)),
  unique (id, cleaning_target_id),
  unique (id, attempt_id),
  unique (attempt_id)
);

create unique index checkout_presence_incidents_one_open_target
  on public.checkout_presence_incidents(cleaning_target_id) where status = 'open';
create index checkout_presence_incidents_reservation_idx
  on public.checkout_presence_incidents(reservation_id, reported_at desc, id desc);
create index checkout_presence_incidents_room_idx
  on public.checkout_presence_incidents(room_id, status, reported_at desc, id desc);
create index checkout_presence_incidents_reporter_idx
  on public.checkout_presence_incidents(reported_by, reported_at desc, id desc);

create table public.checkout_presence_incident_decisions (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.checkout_presence_incidents(id) on delete restrict,
  incident_version bigint not null check (incident_version > 0),
  decision text not null check (decision in ('EXTEND_CHECKOUT','CONFIRM_DEPARTED','FALSE_REPORT')),
  reason_code text not null check (reason_code in (
    'GUEST_STILL_PRESENT_EXTENDED','GUEST_DEPARTURE_CONFIRMED','REPORT_FALSE_CONFIRMED'
  )),
  decided_by uuid not null references public.profiles(id) on delete restrict,
  decided_at timestamptz not null,
  new_checkout_at timestamptz,
  next_assignment_id uuid not null references public.cleaning_assignments(id) on delete restrict,
  next_attempt_id uuid references public.cleaning_attempts(id) on delete restrict,
  check (isfinite(decided_at)),
  check (new_checkout_at is null or isfinite(new_checkout_at)),
  check (reason_code = case decision
    when 'EXTEND_CHECKOUT' then 'GUEST_STILL_PRESENT_EXTENDED'
    when 'CONFIRM_DEPARTED' then 'GUEST_DEPARTURE_CONFIRMED'
    else 'REPORT_FALSE_CONFIRMED' end),
  check ((decision = 'EXTEND_CHECKOUT') = (new_checkout_at is not null)),
  unique (incident_id, incident_version),
  unique (id, incident_id)
);
create index checkout_presence_decisions_actor_idx
  on public.checkout_presence_incident_decisions(decided_by, decided_at desc, id desc);

alter table public.checkout_presence_incidents
  add constraint checkout_presence_incidents_current_decision_fk
  foreign key (current_decision_id, id)
  references public.checkout_presence_incident_decisions(id, incident_id)
  deferrable initially deferred;

alter table public.checkout_presence_incidents enable row level security;
alter table public.checkout_presence_incident_decisions enable row level security;

create function private.checkout_incident_rls_actor_can_read(
  p_reported_by uuid,
  p_cleaning_target_id uuid
) returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_actor uuid;
begin
  if not private.complaint_rls_session_is_active() then return false; end if;
  v_actor := private.current_profile_id();
  return exists (
    select 1 from public.profiles p
    where p.id=v_actor and p.status='active' and not p.must_change_password
      and (p.role='admin' or (p.role='maid' and (
        p.id=p_reported_by or exists (
          select 1 from public.cleaning_assignments a
          where a.cleaning_target_id=p_cleaning_target_id and a.maid_profile_id=p.id
            and a.notified_at is not null
        )
      )))
  );
end $$;
revoke all on function private.checkout_incident_rls_actor_can_read(uuid,uuid)
from public,anon,authenticated,service_role;
grant execute on function private.checkout_incident_rls_actor_can_read(uuid,uuid) to authenticated;

create policy checkout_presence_incidents_read on public.checkout_presence_incidents
for select to authenticated using (
  (select private.checkout_incident_rls_actor_can_read(reported_by,cleaning_target_id))
);
create policy checkout_presence_decisions_read on public.checkout_presence_incident_decisions
for select to authenticated using (exists (
  select 1 from public.checkout_presence_incidents i where i.id=incident_id
    and (select private.checkout_incident_rls_actor_can_read(i.reported_by,i.cleaning_target_id))
));

revoke all on table public.checkout_presence_incidents,
  public.checkout_presence_incident_decisions from public,anon,authenticated,service_role;
grant select on table public.checkout_presence_incidents,
  public.checkout_presence_incident_decisions to authenticated;

create function private.checkout_incident_projection(p_incident public.checkout_presence_incidents)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'incidentId',p_incident.id,'reservationId',p_incident.reservation_id,
    'roomId',p_incident.room_id,'cleaningTargetId',p_incident.cleaning_target_id,
    'assignmentId',p_incident.assignment_id,'attemptId',p_incident.attempt_id,
    'reportedBy',p_incident.reported_by,'reasonCode',p_incident.reason_code,
    'status',p_incident.status,'version',p_incident.version,
    'reportedAt',p_incident.reported_at,'resolvedAt',p_incident.resolved_at,
    'currentDecisionId',p_incident.current_decision_id
  ))
$$;
revoke all on function private.checkout_incident_projection(public.checkout_presence_incidents)
from public,anon,authenticated,service_role;

create function private.checkout_incident_decision_projection(
  p_decision public.checkout_presence_incident_decisions
) returns jsonb language sql stable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'decisionId',p_decision.id,'incidentId',p_decision.incident_id,
    'incidentVersion',p_decision.incident_version,'decision',p_decision.decision,
    'reasonCode',p_decision.reason_code,'decidedBy',p_decision.decided_by,
    'decidedAt',p_decision.decided_at,'newCheckoutAt',p_decision.new_checkout_at,
    'nextAssignmentId',p_decision.next_assignment_id,'nextAttemptId',p_decision.next_attempt_id
  ))
$$;
revoke all on function private.checkout_incident_decision_projection(public.checkout_presence_incident_decisions)
from public,anon,authenticated,service_role;

create function private.checkout_incident_impact_fingerprint(p_incident_id uuid)
returns text language sql stable security definer set search_path='' as $$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'incident',jsonb_build_array(i.id,i.status,i.version,i.current_decision_id),
    'reservation',jsonb_build_array(r.id,r.status,r.version,r.check_out_at,r.actual_checkout_at),
    'obligation',jsonb_build_array(o.id,o.status,o.version,o.planned_cleaning_target_id,
      o.current_cleaning_target_id,o.effective_service_date,o.available_from,o.due_at),
    'target',jsonb_build_array(t.id,t.status,t.assignment_version,t.effective_service_date,
      t.available_from,t.due_at),
    'assignment',jsonb_build_array(a.id,a.maid_profile_id,a.revision,a.is_current,a.notified_at,a.ended_at),
    'attempt',jsonb_build_array(ca.id,ca.assignment_id,ca.maid_profile_id,ca.status,
      ca.execution_version,ca.field_completed_at,ca.ended_at)
  )::text,'UTF8'),'sha256'),'hex')
  from public.checkout_presence_incidents i
  join public.reservations r on r.id=i.reservation_id
  join public.checkout_cleaning_obligations o on o.id=i.checkout_obligation_id
  join public.cleaning_targets t on t.id=i.cleaning_target_id
  join public.cleaning_assignments a on a.id=i.assignment_id
  join public.cleaning_attempts ca on ca.id=i.attempt_id
  where i.id=p_incident_id
$$;
revoke all on function private.checkout_incident_impact_fingerprint(uuid)
from public,anon,authenticated,service_role;

create function private.checkout_incident_is_open(p_target uuid, p_attempt uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.checkout_presence_incidents i
    where i.status='open' and i.cleaning_target_id=p_target
      and (p_attempt is null or i.attempt_id=p_attempt))
$$;
revoke all on function private.checkout_incident_is_open(uuid,uuid)
from public,anon,authenticated,service_role;

create function private.guard_checkout_incident_projection()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then
    raise exception using errcode='55000',message='CHECKOUT_INCIDENT_DELETE_FORBIDDEN';
  end if;
  if coalesce(current_setting('app.checkout_incident_writer_mode',true),'')<>'typed_v1'
    or new.id is distinct from old.id
    or new.reservation_id is distinct from old.reservation_id
    or new.room_id is distinct from old.room_id
    or new.checkout_obligation_id is distinct from old.checkout_obligation_id
    or new.cleaning_target_id is distinct from old.cleaning_target_id
    or new.assignment_id is distinct from old.assignment_id
    or new.attempt_id is distinct from old.attempt_id
    or new.reported_by is distinct from old.reported_by
    or new.reason_code is distinct from old.reason_code
    or new.reservation_version is distinct from old.reservation_version
    or new.target_assignment_version is distinct from old.target_assignment_version
    or new.assignment_revision is distinct from old.assignment_revision
    or new.attempt_execution_version is distinct from old.attempt_execution_version
    or new.pin_version_snapshot is distinct from old.pin_version_snapshot
    or new.reported_at is distinct from old.reported_at
    or new.created_at is distinct from old.created_at
    or old.status<>'open' or new.status<>'resolved'
    or new.version<>old.version+1 or new.current_decision_id is null
    or new.resolved_at is null then
    raise exception using errcode='55000',message='CHECKOUT_INCIDENT_IMMUTABLE';
  end if;
  return new;
end $$;
revoke all on function private.guard_checkout_incident_projection()
from public,anon,authenticated,service_role;
create trigger checkout_incident_projection_guard
before update or delete on public.checkout_presence_incidents
for each row execute function private.guard_checkout_incident_projection();

create function private.guard_checkout_incident_decision()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception using errcode='55000',message='CHECKOUT_INCIDENT_DECISION_IMMUTABLE';
end $$;
revoke all on function private.guard_checkout_incident_decision()
from public,anon,authenticated,service_role;
create trigger checkout_incident_decision_guard
before update or delete on public.checkout_presence_incident_decisions
for each row execute function private.guard_checkout_incident_decision();

-- Extend immutable revocation reason catalogs without rewriting any history.
alter table private.attempt_capability_revocations
  drop constraint attempt_capability_revocations_reason_code_check;
alter table private.attempt_capability_revocations
  add constraint attempt_capability_revocations_reason_code_check check(reason_code in (
    'FIELD_COMPLETED','HANDOVER','ACCOUNT_CHANGED','CHECKOUT_NOT_COMPLETED'
  ));
alter table private.offline_work_lease_revocations
  drop constraint offline_work_lease_revocations_reason_code_check;
alter table private.offline_work_lease_revocations
  add constraint offline_work_lease_revocations_reason_code_check check(reason_code in (
    'ACCOUNT_CHANGED','ATTEMPT_CHANGED','CHECKOUT_NOT_COMPLETED'
  ));

create function private.guard_checkout_incident_workflow()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_target uuid;
begin
  if coalesce(current_setting('app.checkout_incident_writer_mode',true),'')='typed_v1' then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_table_name='cleaning_targets' then
    v_target:=case when tg_op='DELETE' then old.id else new.id end;
  else
    v_target:=case when tg_op='DELETE' then old.cleaning_target_id else new.cleaning_target_id end;
  end if;
  if private.checkout_incident_is_open(v_target,null) then
    raise exception using errcode='55000',message='CHECKOUT_INCIDENT_OPEN';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.guard_checkout_incident_workflow()
from public,anon,authenticated,service_role;

create trigger checkout_incident_attempt_guard
before insert or update or delete on public.cleaning_attempts
for each row execute function private.guard_checkout_incident_workflow();
create trigger checkout_incident_assignment_guard
before insert or update or delete on public.cleaning_assignments
for each row execute function private.guard_checkout_incident_workflow();
create trigger checkout_incident_target_guard
before update or delete on public.cleaning_targets
for each row execute function private.guard_checkout_incident_workflow();
create trigger checkout_incident_pin_access_guard
before insert or update or delete on public.room_pin_access_leases
for each row execute function private.guard_checkout_incident_workflow();

create function private.guard_checkout_incident_reservation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if coalesce(current_setting('app.checkout_incident_writer_mode',true),'')<>'typed_v1'
    and exists(select 1 from public.checkout_presence_incidents i
      where i.reservation_id=coalesce(new.id,old.id) and i.status='open') then
    raise exception using errcode='55000',message='CHECKOUT_INCIDENT_OPEN';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.guard_checkout_incident_reservation()
from public,anon,authenticated,service_role;
create trigger checkout_incident_reservation_guard
before update or delete on public.reservations
for each row execute function private.guard_checkout_incident_reservation();

create function private.guard_checkout_incident_reveal_lease()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if coalesce(current_setting('app.checkout_incident_writer_mode',true),'')<>'typed_v1'
    and coalesce(new.attempt_id,old.attempt_id) is not null
    and exists(select 1 from public.cleaning_attempts a
      where a.id=coalesce(new.attempt_id,old.attempt_id)
        and private.checkout_incident_is_open(a.cleaning_target_id,a.id)) then
    raise exception using errcode='55000',message='CHECKOUT_INCIDENT_OPEN';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.guard_checkout_incident_reveal_lease()
from public,anon,authenticated,service_role;
create trigger checkout_incident_reveal_lease_guard
before insert or update or delete on private.room_pin_reveal_leases
for each row execute function private.guard_checkout_incident_reveal_lease();

create function private.guard_checkout_incident_submission()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_attempt uuid; v_target uuid;
begin
  if coalesce(current_setting('app.checkout_incident_writer_mode',true),'')='typed_v1' then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  v_attempt:=coalesce(new.cleaning_attempt_id,old.cleaning_attempt_id);
  select attempt.cleaning_target_id into v_target
  from public.cleaning_attempts attempt where attempt.id=v_attempt;
  if v_target is not null and private.checkout_incident_is_open(v_target,v_attempt) then
    raise exception using errcode='55000',message='CHECKOUT_INCIDENT_OPEN';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.guard_checkout_incident_submission()
from public,anon,authenticated,service_role;
create trigger checkout_incident_submission_guard
before insert or update or delete on public.cleaning_submissions
for each row execute function private.guard_checkout_incident_submission();

create function private.guard_checkout_incident_inspection()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_attempt uuid; v_target uuid;
begin
  if coalesce(current_setting('app.checkout_incident_writer_mode',true),'')='typed_v1' then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  select submission.cleaning_attempt_id,attempt.cleaning_target_id into v_attempt,v_target
  from public.cleaning_submissions submission
  join public.cleaning_attempts attempt on attempt.id=submission.cleaning_attempt_id
  where submission.id=coalesce(new.submission_id,old.submission_id);
  if v_target is not null and private.checkout_incident_is_open(v_target,v_attempt) then
    raise exception using errcode='55000',message='CHECKOUT_INCIDENT_OPEN';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.guard_checkout_incident_inspection()
from public,anon,authenticated,service_role;
create trigger checkout_incident_inspection_guard
before insert or update or delete on public.inspection_decisions
for each row execute function private.guard_checkout_incident_inspection();

-- Add typed notification families using the existing safe cleaningTarget deep link.
drop trigger notification_event_catalog_immutable on private.notification_event_catalog;
insert into private.notification_event_catalog(
  event_family,category,source_entity_kind,recipient_capability,requires_action,
  push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind
) values
  ('checkout.presence_reported_admin','checkout_presence_reported','checkout_presence_incident',
    'admin.assignment_decider',true,true,'checkout_incident_terminal','cleaningTarget',
    'checkout_presence_reported','room'),
  ('checkout.presence_resolved_maid','checkout_presence_resolved','checkout_presence_incident_decision',
    'maid.assignment_party',false,true,'none','cleaningTarget',
    'checkout_presence_resolved','room'),
  ('checkout.presence_previous_maid_resolved','checkout_presence_resolved','checkout_presence_incident_decision',
    'maid.assignment_party',false,true,'none','cleaningTarget',
    'checkout_presence_resolved','room');
create trigger notification_event_catalog_immutable
before update or delete on private.notification_event_catalog
for each row execute function private.guard_notification_catalog_ledgers();

create function private.emit_checkout_incident_notification(
  p_event_family text,p_actor uuid,p_recipient uuid,p_incident uuid,
  p_decision uuid,p_occurred_at timestamptz
) returns uuid language plpgsql security definer set search_path='' as $$
declare i public.checkout_presence_incidents; d public.checkout_presence_incident_decisions;
  c private.notification_event_catalog; g private.notification_groups; n uuid; source_id text;
  title_text text; body_text text;
begin
  select * into i from public.checkout_presence_incidents where id=p_incident;
  select * into c from private.notification_event_catalog where event_family=p_event_family;
  if i.id is null or c.event_family is null or p_occurred_at is null then
    raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
  end if;
  if p_event_family='checkout.presence_reported_admin' then
    if p_decision is not null or p_actor<>i.reported_by or i.status<>'open'
      or not exists(select 1 from public.profiles p where p.id=p_recipient and p.role='admin'
        and p.status='active' and not p.must_change_password) then
      raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
    end if;
    source_id:=i.id::text;
    title_text:=(select room_number from public.rooms where id=i.room_id)||'호 퇴실 미진행';
    body_text:='현장 확인 및 청소 재배정이 필요합니다.';
  elsif p_event_family='checkout.presence_resolved_maid' then
    select * into d from public.checkout_presence_incident_decisions where id=p_decision and incident_id=i.id;
    if d.id is null or p_actor<>d.decided_by or i.current_decision_id<>d.id
      or not exists(select 1 from public.cleaning_assignments a where a.id=d.next_assignment_id
        and a.maid_profile_id=p_recipient and a.notified_at is not null) then
      raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
    end if;
    source_id:=d.id::text;
    title_text:=(select room_number from public.rooms where id=i.room_id)||'호 청소 일정 확정';
    body_text:='관리자 확인이 완료되었습니다. 최신 배정 일정을 확인해 주세요.';
  elsif p_event_family='checkout.presence_previous_maid_resolved' then
    select * into d from public.checkout_presence_incident_decisions where id=p_decision and incident_id=i.id;
    if d.id is null or p_actor<>d.decided_by or i.current_decision_id<>d.id
      or not exists(select 1 from public.cleaning_assignments previous_assignment
        join public.cleaning_assignments next_assignment on next_assignment.id=d.next_assignment_id
        where previous_assignment.id=i.assignment_id and previous_assignment.maid_profile_id=p_recipient
          and previous_assignment.maid_profile_id<>next_assignment.maid_profile_id) then
      raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
    end if;
    source_id:=d.id::text;
    title_text:=(select room_number from public.rooms where id=i.room_id)||'호 기존 청소 업무 종료';
    body_text:='관리자 확인으로 기존 청소 업무가 종료되었습니다.';
  else
    raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'notification-group:v1:'||p_recipient::text||':'||c.group_family||':room:'||i.room_id::text,0));
  select * into g from private.notification_groups x where x.recipient_profile_id=p_recipient
    and x.group_family=c.group_family and x.scope_kind='room' and x.scope_id=i.room_id
    and p_occurred_at>=x.started_at and p_occurred_at<x.ends_at
    order by x.started_at desc,x.id desc limit 1;
  if g.id is null then
    insert into private.notification_groups(recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at)
    values(p_recipient,c.group_family,'room',i.room_id,p_occurred_at,p_occurred_at+interval '10 minutes')
    returning * into g;
  end if;
  insert into public.notifications(recipient_profile_id,category,title,body,room_id,cleaning_target_id,
    dedupe_key,requires_action,occurred_at,contract_version,actor_profile_id,event_family,
    source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,notification_group_id)
  values(p_recipient,c.category,title_text,body_text,i.room_id,i.cleaning_target_id,
    'notification:v1:'||p_event_family||':'||source_id,c.requires_action,p_occurred_at,1,p_actor,
    p_event_family,c.source_entity_kind,source_id,'cleaningTarget',i.cleaning_target_id,g.id)
  on conflict(recipient_profile_id,dedupe_key) where dedupe_key is not null do nothing returning id into n;
  if n is null then select id into n from public.notifications where recipient_profile_id=p_recipient
    and dedupe_key='notification:v1:'||p_event_family||':'||source_id; end if;
  if n is null then raise exception using errcode='23505',message='NOTIFICATION_DEDUPE_CONFLICT'; end if;
  if p_actor<>p_recipient then
    insert into private.notification_delivery_outbox(notification_id,event_family,enqueued_at)
    values(n,p_event_family,p_occurred_at) on conflict(notification_id) do nothing;
  end if;
  return n;
end $$;
revoke all on function private.emit_checkout_incident_notification(text,uuid,uuid,uuid,uuid,timestamptz)
from public,anon,authenticated,service_role;

-- Extend the typed notification resolver without weakening any earlier
-- resolver. Checkout report audit evidence terminates the old assignment
-- action, and the immutable admin decision terminates the admin incident card.
alter function private.notification_resolution_is_valid(text,text,text,text,text)
rename to notification_resolution_is_valid_before_checkout_presence;
revoke all on function private.notification_resolution_is_valid_before_checkout_presence(text,text,text,text,text)
from public,anon,authenticated,service_role;
create function private.notification_resolution_is_valid(
  p_event_family text,p_source_kind text,p_source_id text,p_terminal_kind text,p_terminal_id text
) returns boolean language plpgsql volatile security definer set search_path='' as $$
declare v_source uuid; v_terminal uuid; terminal_audit public.audit_events;
begin
  if p_terminal_kind='audit_event' then
    begin
      v_terminal:=p_terminal_id::uuid;
    exception when invalid_text_representation then
      return false;
    end;
    select * into terminal_audit from public.audit_events where id=v_terminal;
    if p_source_kind='cleaning_assignment'
      and p_event_family in (
        'assignment.commit_notified','assignment.prestart_new_notified',
        'assignment.prestart_same_maid_changed','reservation.manual_checkout_rescheduled'
      )
      and terminal_audit.event_type='checkout.presence_reported' then
      begin
        v_source:=p_source_id::uuid;
      exception when invalid_text_representation then
        return false;
      end;
      return nullif(terminal_audit.after_state->>'assignmentId','')::uuid=v_source;
    end if;
    if p_source_kind='checkout_presence_incident'
      and p_event_family='checkout.presence_reported_admin'
      and terminal_audit.event_type='checkout.presence_decided' then
      begin
        v_source:=p_source_id::uuid;
      exception when invalid_text_representation then
        return false;
      end;
      return terminal_audit.entity_id=v_source;
    end if;
  end if;
  return private.notification_resolution_is_valid_before_checkout_presence(
    p_event_family,p_source_kind,p_source_id,p_terminal_kind,p_terminal_id
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end $$;
revoke all on function private.notification_resolution_is_valid(text,text,text,text,text)
from public,anon,authenticated,service_role;

create function public.report_checkout_presence_incident(
  p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,
  p_expected_execution_version bigint,p_expected_assignment_id uuid,
  p_expected_assignment_revision bigint,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; a public.cleaning_attempts; s public.cleaning_assignments;
  t public.cleaning_targets; r public.reservations; o public.checkout_cleaning_obligations;
  i public.checkout_presence_incidents; replay jsonb; result jsonb; at_time timestamptz;
  v_pin_version bigint;
  report_audit_id uuid;
  previous_terminal_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_terminal_id text:=current_setting('app.notification_terminal_id',true);
  previous_writer_mode text:=current_setting('app.checkout_incident_writer_mode',true);
begin
  if p_attempt_id is null or p_expected_assignment_id is null
    or p_expected_execution_version is null or p_expected_execution_version<1
    or p_expected_assignment_revision is null or p_expected_assignment_revision<1 then
    raise exception using errcode='22023',message='INVALID_CHECKOUT_INCIDENT_REPORT';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  at_time:=clock_timestamp();
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  if actor.role<>'maid' then raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  replay:=private.replay_command(p_actor_profile_id,'checkout.presence.report',p_idempotency_key,p_request_hash);
  if replay is not null then return replay; end if;
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  perform 1 from auth.sessions where id=p_session_id and user_id=actor.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;

  select * into a from public.cleaning_attempts where id=p_attempt_id;
  if a.id is null or a.maid_profile_id<>p_actor_profile_id then
    raise exception using errcode='42501',message='CHECKOUT_INCIDENT_REPORT_REQUIRED';
  end if;
  select * into r from public.reservations where id=(select reservation_id from public.cleaning_targets where id=a.cleaning_target_id) for update;
  select * into o from public.checkout_cleaning_obligations where reservation_id=r.id for update;
  select * into t from public.cleaning_targets where id=a.cleaning_target_id for update;
  select * into s from public.cleaning_assignments where id=a.assignment_id for update;
  select * into a from public.cleaning_attempts where id=p_attempt_id for update;
  if r.id is null or o.id is null or t.id is null or s.id is null
    or t.cleaning_kind<>'checkout' or t.reservation_id<>r.id or t.checkout_obligation_id<>o.id
    or t.room_id<>r.room_id or o.room_id<>r.room_id
    or r.status<>'checked_out' or r.actual_checkout_at is null
    or o.status<>'materialized' or o.current_cleaning_target_id<>t.id
    or not s.is_current or s.notified_at is null or s.id<>p_expected_assignment_id
    or s.maid_profile_id<>p_actor_profile_id or s.revision<>p_expected_assignment_revision
    or t.assignment_version<>s.revision or a.assignment_revision<>s.revision
    or a.execution_version<>p_expected_execution_version
    or a.status not in ('scheduled','in_progress') or a.field_completed_at is not null then
    raise exception using errcode='40001',message='CHECKOUT_INCIDENT_REPORT_CONFLICT';
  end if;
  if not exists(
    select 1
    from (
      select occupancy.room_id,occupancy.event_type,occupancy.effective_at
      from public.room_occupancy_events occupancy
      where occupancy.reservation_id=r.id
        and occupancy.event_type in ('manual_checkout','scheduled_checkout')
      order by occupancy.recorded_at desc,occupancy.id desc
      limit 1
    ) latest_checkout
    where latest_checkout.room_id=r.room_id
      and latest_checkout.event_type='scheduled_checkout'
      and latest_checkout.effective_at=r.actual_checkout_at
  ) then
    raise exception using errcode='40001',message='CHECKOUT_INCIDENT_REPORT_CONFLICT';
  end if;
  if exists(
    select 1
    from public.checkout_presence_incidents existing_incident
    where existing_incident.status='open'
      and (existing_incident.attempt_id=a.id or existing_incident.cleaning_target_id=t.id)
  ) then
    raise exception using errcode='40001',message='CHECKOUT_INCIDENT_REPORT_CONFLICT';
  end if;
  select current_pin.pin_version into v_pin_version
  from private.room_current_pin current_pin where current_pin.room_id=t.room_id;
  perform set_config('app.checkout_incident_writer_mode','typed_v1',true);
  insert into public.checkout_presence_incidents(
    reservation_id,room_id,checkout_obligation_id,cleaning_target_id,assignment_id,attempt_id,
    reported_by,reason_code,reservation_version,target_assignment_version,assignment_revision,
    attempt_execution_version,pin_version_snapshot,reported_at
  ) values(r.id,t.room_id,o.id,t.id,s.id,a.id,p_actor_profile_id,'GUEST_STILL_PRESENT',
    r.version,t.assignment_version,s.revision,a.execution_version,v_pin_version,at_time)
  returning * into i;
  update public.room_pin_access_leases set revoked_at=at_time,revoke_reason_code='CHECKOUT_NOT_COMPLETED'
    where attempt_id=a.id and revoked_at is null;
  insert into private.offline_work_lease_revocations(lease_id,revoked_at,reason_code,metadata_expires_at)
    select l.id,at_time,'CHECKOUT_NOT_COMPLETED',l.metadata_expires_at
    from private.offline_work_leases l where l.attempt_id=a.id
    on conflict(lease_id) do nothing;
  insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
    select g.id,at_time,'CHECKOUT_NOT_COMPLETED',p_actor_profile_id
    from private.attempt_capability_grants g where g.attempt_id=a.id
    on conflict(capability_id) do nothing;
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,
    actor_display_name_snapshot,effective_at,recorded_at,reason_code,after_state,idempotency_key)
  values('checkout.presence_reported','checkout_presence_incident',i.id,p_actor_profile_id,
    actor.display_name,at_time,clock_timestamp(),'GUEST_STILL_PRESENT',
    jsonb_build_object('incidentId',i.id,'reservationId',r.id,'roomId',t.room_id,
      'cleaningTargetId',t.id,'assignmentId',s.id,'attemptId',a.id,'status','open','version',1),
    private.audit_command_key(p_actor_profile_id,'checkout.presence.report',p_idempotency_key))
  returning id into report_audit_id;
  perform set_config('app.notification_terminal_kind','audit_event',true);
  perform set_config('app.notification_terminal_id',report_audit_id::text,true);
  perform private.resolve_notifications_v1(
    'assignment.commit_notified','cleaning_assignment',s.id::text,at_time
  );
  perform private.resolve_notifications_v1(
    'assignment.prestart_new_notified','cleaning_assignment',s.id::text,at_time
  );
  perform private.resolve_notifications_v1(
    'assignment.prestart_same_maid_changed','cleaning_assignment',s.id::text,at_time
  );
  perform private.resolve_notifications_v1(
    'reservation.manual_checkout_rescheduled','cleaning_assignment',s.id::text,at_time
  );
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  perform private.emit_checkout_incident_notification('checkout.presence_reported_admin',p_actor_profile_id,
    admin_profile.id,i.id,null,at_time)
  from public.profiles admin_profile where admin_profile.role='admin' and admin_profile.status='active'
    and not admin_profile.must_change_password;
  result:=private.checkout_incident_projection(i)||jsonb_build_object(
    'impactFingerprint',private.checkout_incident_impact_fingerprint(i.id));
  perform set_config('app.checkout_incident_writer_mode',coalesce(previous_writer_mode,''),true);
  perform private.complete_command(p_actor_profile_id,'checkout.presence.report',p_idempotency_key,
    p_request_hash,i.id,result);
  return result;
end $$;

create function public.get_checkout_presence_incident(
  p_actor_profile_id uuid,p_session_id uuid,p_incident_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; i public.checkout_presence_incidents; d public.checkout_presence_incident_decisions;
begin
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  select * into i from public.checkout_presence_incidents where id=p_incident_id;
  if i.id is null then raise exception using errcode='P0002',message='CHECKOUT_INCIDENT_NOT_FOUND'; end if;
  if actor.role='maid' and actor.id<>i.reported_by and not exists(
    select 1 from public.cleaning_assignments a where a.cleaning_target_id=i.cleaning_target_id
      and a.maid_profile_id=actor.id and a.notified_at is not null
  ) then raise exception using errcode='42501',message='CHECKOUT_INCIDENT_ACCESS_REQUIRED'; end if;
  if actor.role not in ('admin','maid') then
    raise exception using errcode='42501',message='CHECKOUT_INCIDENT_ACCESS_REQUIRED'; end if;
  if i.current_decision_id is not null then
    select * into d from public.checkout_presence_incident_decisions where id=i.current_decision_id;
  end if;
  return private.checkout_incident_projection(i)||jsonb_build_object(
    'impactFingerprint',private.checkout_incident_impact_fingerprint(i.id),
    'decision',case when d.id is null then null else private.checkout_incident_decision_projection(d) end
  );
end $$;

create function public.decide_checkout_presence_incident(
  p_actor_profile_id uuid,p_session_id uuid,p_incident_id uuid,p_expected_version bigint,
  p_expected_impact_fingerprint text,p_decision text,p_reason_code text,
  p_new_checkout_at timestamptz,p_reassignment jsonb,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; maid public.profiles; i public.checkout_presence_incidents;
  d public.checkout_presence_incident_decisions; r public.reservations; o public.checkout_cleaning_obligations;
  t public.cleaning_targets; s public.cleaning_assignments; a public.cleaning_attempts;
  ns public.cleaning_assignments; na public.cleaning_attempts; replay jsonb; result jsonb;
  next_maid uuid; next_sequence integer; next_date date; next_from timestamptz; next_due timestamptz;
  at_time timestamptz; wk date; event_key text; v_attempt_number integer;
  decision_audit_id uuid;
  previous_terminal_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_terminal_id text:=current_setting('app.notification_terminal_id',true);
  previous_writer_mode text:=current_setting('app.checkout_incident_writer_mode',true);
begin
  if p_incident_id is null or p_expected_version is null or p_expected_version<1
    or p_expected_impact_fingerprint is null
    or p_expected_impact_fingerprint !~ '^[0-9a-f]{64}$'
    or p_decision is null or p_decision not in ('EXTEND_CHECKOUT','CONFIRM_DEPARTED','FALSE_REPORT')
    or p_reason_code<>(case p_decision when 'EXTEND_CHECKOUT' then 'GUEST_STILL_PRESENT_EXTENDED'
      when 'CONFIRM_DEPARTED' then 'GUEST_DEPARTURE_CONFIRMED' else 'REPORT_FALSE_CONFIRMED' end)
    or jsonb_typeof(p_reassignment) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(p_reassignment) k)
      is distinct from array['availableFrom','dueAt','maidProfileId','sequenceNumber','serviceDate']::text[]
    or jsonb_typeof(p_reassignment->'sequenceNumber')<>'number' then
    raise exception using errcode='22023',message='INVALID_CHECKOUT_INCIDENT_DECISION';
  end if;
  begin
    next_maid:=(p_reassignment->>'maidProfileId')::uuid;
    next_sequence:=(p_reassignment->>'sequenceNumber')::integer;
    next_date:=(p_reassignment->>'serviceDate')::date;
    next_from:=(p_reassignment->>'availableFrom')::timestamptz;
    next_due:=(p_reassignment->>'dueAt')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
    raise exception using errcode='22023',message='INVALID_CHECKOUT_INCIDENT_DECISION';
  end;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  if actor.role<>'admin' then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  replay:=private.replay_command(p_actor_profile_id,'checkout.presence.decision',p_idempotency_key,p_request_hash);
  if replay is not null then return replay; end if;
  if next_maid is null or next_sequence is null or next_sequence<1 or next_date is null
    or next_from is null or next_due is null or not isfinite(next_from) or not isfinite(next_due)
    or next_due<=next_from or next_from<>date_trunc('minute',next_from)
    or next_due<>date_trunc('minute',next_due)
    or (p_decision='EXTEND_CHECKOUT' and (p_new_checkout_at is null
      or not isfinite(p_new_checkout_at) or p_new_checkout_at<>date_trunc('minute',p_new_checkout_at)
      or next_from<>p_new_checkout_at
      or next_date<>(p_new_checkout_at at time zone 'Asia/Seoul')::date))
    or (p_decision<>'EXTEND_CHECKOUT' and p_new_checkout_at is not null) then
    raise exception using errcode='22023',message='INVALID_CHECKOUT_INCIDENT_DECISION';
  end if;
  select * into i from public.checkout_presence_incidents where id=p_incident_id for update;
  if i.id is null then raise exception using errcode='P0002',message='CHECKOUT_INCIDENT_NOT_FOUND'; end if;
  select * into r from public.reservations where id=i.reservation_id for update;
  select * into o from public.checkout_cleaning_obligations where id=i.checkout_obligation_id for update;
  select * into t from public.cleaning_targets where id=i.cleaning_target_id for update;
  select * into s from public.cleaning_assignments where id=i.assignment_id for update;
  select * into a from public.cleaning_attempts where id=i.attempt_id for update;
  -- assert_room_pin_actor_session() already holds the actor row FOR SHARE for
  -- the transaction. Re-locking that row FOR NO KEY UPDATE after the global
  -- reservation lock inverts the legacy reservation command order
  -- (actor SHARE -> global lock) and can deadlock. Lock only the assignee here;
  -- the actor's role/status remains protected by the existing SHARE lock.
  perform 1 from public.profiles where id=next_maid for no key update;
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  select * into maid from public.profiles where id=next_maid;
  if i.status<>'open' or i.version<>p_expected_version
    or r.id is null or o.id is null or t.id is null or s.id is null or a.id is null
    or r.status<>'checked_out' or r.actual_checkout_at is null
    or o.current_cleaning_target_id<>t.id or t.reservation_id<>r.id
    or t.cleaning_kind<>'checkout' or s.id<>a.assignment_id
    or maid.role<>'maid' or maid.status<>'active' or maid.must_change_password then
    raise exception using errcode='40001',message='CHECKOUT_INCIDENT_VERSION_CONFLICT';
  end if;
  if private.checkout_incident_impact_fingerprint(i.id)<>p_expected_impact_fingerprint then
    raise exception using errcode='40001',message='CHECKOUT_INCIDENT_IMPACT_CHANGED';
  end if;
  wk:=next_date-(extract(isodow from next_date)::integer-1);
  perform pg_advisory_xact_lock(hashtextextended('availability:'||next_maid::text||':'||wk::text,0));
  if not exists(select 1 from public.availability_versions v join public.availability_days ad
    on ad.availability_version_id=v.id where v.maid_profile_id=next_maid and v.week_start=wk
      and v.is_current and ad.work_date=next_date and ad.available) then
    raise exception using errcode='23514',message='ASSIGNMENT_MAID_UNAVAILABLE';
  end if;
  if exists(select 1 from public.cleaning_assignments x where x.is_current
    and x.maid_profile_id=next_maid and x.service_date=next_date
    and x.sequence_number=next_sequence and x.id<>s.id) then
    raise exception using errcode='23514',message='ASSIGNMENT_SEQUENCE_CONFLICT';
  end if;
  -- Reuse the canonical execution/handover interval contract after every
  -- reservation/target/assignment/availability lock and current-state check.
  -- This preserves the KST service-day boundary and the next check-in buffer
  -- before any incident, assignment, attempt, notification, or receipt write.
  perform private.assert_handover_schedule(t,next_date,next_from,next_due);
  -- This clock sample deliberately occurs after every domain lock and current
  -- state/fingerprint revalidation. A request that waited on a lock cannot
  -- materialize an assignment whose due boundary elapsed while it waited.
  at_time:=clock_timestamp();
  if next_due<=at_time
    or (p_decision='EXTEND_CHECKOUT' and p_new_checkout_at<=at_time)
    or (p_decision<>'EXTEND_CHECKOUT' and (next_from>at_time
      or next_date<>(at_time at time zone 'Asia/Seoul')::date)) then
    raise exception using errcode='22023',message='INVALID_CHECKOUT_INCIDENT_DECISION';
  end if;
  perform set_config('app.checkout_incident_writer_mode','typed_v1',true);
  update public.room_pin_access_leases set revoked_at=coalesce(revoked_at,at_time),
    revoke_reason_code=case when revoked_at is null then 'CHECKOUT_NOT_COMPLETED' else revoke_reason_code end
    where attempt_id=a.id;
  insert into private.offline_work_lease_revocations(lease_id,revoked_at,reason_code,metadata_expires_at)
    select l.id,at_time,'CHECKOUT_NOT_COMPLETED',l.metadata_expires_at from private.offline_work_leases l
    where l.attempt_id=a.id on conflict(lease_id) do nothing;
  insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
    select g.id,at_time,'CHECKOUT_NOT_COMPLETED',p_actor_profile_id from private.attempt_capability_grants g
    where g.attempt_id=a.id on conflict(capability_id) do nothing;
  update public.cleaning_attempts set status=case when status='in_progress' then 'interrupted'::public.attempt_status
      else 'superseded'::public.attempt_status end,ended_at=at_time,end_reason='CHECKOUT_NOT_COMPLETED',
      execution_version=execution_version+1 where id=a.id and status in ('scheduled','in_progress');
  update public.cleaning_assignments set is_current=false,ended_at=at_time,
    change_reason_code='CHECKOUT_NOT_COMPLETED' where id=s.id and is_current;
  update public.cleaning_targets set effective_service_date=next_date,available_from=next_from,due_at=next_due,
    assignment_version=assignment_version+1,status='notified' where id=t.id returning * into t;
  insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,
    available_from,due_at,reason_code,changed_by)
  values(t.id,t.assignment_version,next_date,next_from,next_due,p_reason_code,p_actor_profile_id);
  insert into public.cleaning_assignments(cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at)
  values(t.id,next_maid,next_sequence,t.assignment_version,p_actor_profile_id,at_time) returning * into ns;

  if p_decision='EXTEND_CHECKOUT' then
    update public.reservations set check_out_at=p_new_checkout_at,status='active',actual_checkout_at=null,
      version=version+1,updated_by=p_actor_profile_id where id=r.id returning * into r;
    update public.checkout_cleaning_obligations set status='private',effective_service_date=next_date,
      available_from=next_from,due_at=next_due,current_cleaning_target_id=null,
      planned_cleaning_target_id=t.id,version=version+1 where id=o.id returning * into o;
    event_key:=private.audit_command_key(p_actor_profile_id,'checkout.presence.occupancy_resumed',p_idempotency_key);
    insert into public.room_occupancy_events(event_key,room_id,reservation_id,event_type,effective_at,
      actor_profile_id,reason_code,before_state,after_state)
    values(event_key,r.room_id,r.id,'occupancy_resumed',at_time,p_actor_profile_id,p_reason_code,
      jsonb_build_object('occupied',false),jsonb_build_object('occupied',true));
  else
    update public.checkout_cleaning_obligations set status='materialized',effective_service_date=next_date,
      available_from=next_from,due_at=next_due,current_cleaning_target_id=t.id,
      planned_cleaning_target_id=t.id,version=version+1 where id=o.id returning * into o;
    select coalesce(max(existing_attempt.attempt_number),0)+1 into v_attempt_number
    from public.cleaning_attempts existing_attempt where existing_attempt.cleaning_target_id=t.id;
    insert into public.cleaning_attempts(cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
      assignment_revision,template_snapshot,room_snapshot)
    select t.id,ns.id,next_maid,v_attempt_number,'scheduled',ns.revision,
      t.template_snapshot,t.room_type_snapshot||jsonb_build_object('roomId',room.id,
        'roomNumber',room.room_number,'elevatorZone',room.elevator_zone)
    from public.rooms room where room.id=t.room_id returning * into na;
  end if;

  insert into public.checkout_presence_incident_decisions(incident_id,incident_version,decision,reason_code,
    decided_by,decided_at,new_checkout_at,next_assignment_id,next_attempt_id)
  values(i.id,i.version,p_decision,p_reason_code,p_actor_profile_id,at_time,p_new_checkout_at,ns.id,na.id)
  returning * into d;
  update public.checkout_presence_incidents set status='resolved',current_decision_id=d.id,
    resolved_at=at_time,version=version+1 where id=i.id returning * into i;
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,
    actor_display_name_snapshot,effective_at,recorded_at,reason_code,after_state,idempotency_key)
  values('checkout.presence_decided','checkout_presence_incident',i.id,p_actor_profile_id,
    actor.display_name,at_time,clock_timestamp(),p_reason_code,
    jsonb_build_object('incidentId',i.id,'decisionId',d.id,'decision',p_decision,
      'reservationId',r.id,'roomId',r.room_id,'cleaningTargetId',t.id,
      'nextAssignmentId',ns.id,'nextAttemptId',na.id,'version',i.version),
    private.audit_command_key(p_actor_profile_id,'checkout.presence.decision',p_idempotency_key))
  returning id into decision_audit_id;
  perform set_config('app.notification_terminal_kind','audit_event',true);
  perform set_config('app.notification_terminal_id',decision_audit_id::text,true);
  perform private.resolve_notifications_v1('checkout.presence_reported_admin','checkout_presence_incident',i.id::text,at_time);
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  perform private.emit_checkout_incident_notification('checkout.presence_resolved_maid',p_actor_profile_id,
    ns.maid_profile_id,i.id,d.id,at_time);
  perform private.emit_notification_v1(
    'assignment.commit_notified',p_actor_profile_id,ns.maid_profile_id,
    'cleaning_assignment',ns.id::text,
    coalesce(t.room_type_snapshot->>'roomNumber','객실')||'호 청소 배정',
    t.effective_service_date::text||' · '||ns.sequence_number||'번째 청소가 배정되었습니다.',
    t.room_id,t.id,t.id,at_time
  );
  if s.maid_profile_id<>ns.maid_profile_id then
    perform private.emit_checkout_incident_notification('checkout.presence_previous_maid_resolved',p_actor_profile_id,
      s.maid_profile_id,i.id,d.id,at_time);
  end if;
  result:=private.checkout_incident_projection(i)||jsonb_build_object(
    'impactFingerprint',private.checkout_incident_impact_fingerprint(i.id),
    'decision',private.checkout_incident_decision_projection(d));
  perform set_config('app.checkout_incident_writer_mode',coalesce(previous_writer_mode,''),true);
  perform private.complete_command(p_actor_profile_id,'checkout.presence.decision',p_idempotency_key,
    p_request_hash,i.id,result);
  return result;
end $$;

-- Extend the developer audit projection with the two typed checkout-presence
-- events. The wrapper keeps every earlier allowlist intact and projects only
-- source-controlled identifiers/status; raw before/after state and request
-- hashes remain private.
alter function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) rename to list_developer_audit_events_before_checkout_presence;
revoke all on function private.list_developer_audit_events_before_checkout_presence(
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
  id uuid,event_type text,entity_type text,entity_id uuid,actor_profile_id uuid,
  actor_display_name text,effective_at timestamptz,recorded_at timestamptz,
  reason_code text,summary jsonb
) language plpgsql security definer set search_path='' as $$
declare
  v_checkout_types constant text[]:=array[
    'checkout.presence_reported','checkout.presence_decided'
  ];
  v_previous_types text[];
  v_from timestamptz:=coalesce(p_from,clock_timestamp()-interval '7 days');
  v_to timestamptz:=coalesce(p_to,clock_timestamp());
begin
  if p_event_types is not null and coalesce(cardinality(p_event_types),0)=0 then
    raise exception using errcode='22023',message='INVALID_AUDIT_QUERY';
  end if;
  if p_event_types is null then
    v_previous_types:=null;
  else
    select coalesce(array_agg(requested),array[]::text[]) into v_previous_types
    from unnest(p_event_types) requested where not requested=any(v_checkout_types);
    if cardinality(v_previous_types)=0 then
      v_previous_types:=array['account.created'];
    end if;
  end if;
  return query select merged.* from (
    select previous.*
    from private.list_developer_audit_events_before_checkout_presence(
      p_actor_profile_id,v_previous_types,p_filter_actor_profile_id,p_from,p_to,
      p_before_recorded_at,p_before_id,p_limit
    ) previous
    where p_event_types is null or previous.event_type=any(p_event_types)
    union all
    select audit.id,audit.event_type,audit.entity_type,audit.entity_id,audit.actor_profile_id,
      audit.actor_display_name_snapshot,audit.effective_at,audit.recorded_at,audit.reason_code,
      jsonb_strip_nulls(jsonb_build_object(
        'incidentId',audit.after_state->'incidentId',
        'reservationId',audit.after_state->'reservationId',
        'roomId',audit.after_state->'roomId',
        'cleaningTargetId',audit.after_state->'cleaningTargetId',
        'assignmentId',audit.after_state->'assignmentId',
        'attemptId',audit.after_state->'attemptId',
        'status',audit.after_state->'status',
        'version',audit.after_state->'version',
        'decisionId',audit.after_state->'decisionId',
        'checkoutDecision',audit.after_state->'decision',
        'nextAssignmentId',audit.after_state->'nextAssignmentId',
        'nextAttemptId',audit.after_state->'nextAttemptId'
      ))
    from public.audit_events audit
    where audit.event_type=any(v_checkout_types)
      and (p_event_types is null or audit.event_type=any(p_event_types))
      and audit.recorded_at>=v_from and audit.recorded_at<=v_to
      and (p_filter_actor_profile_id is null or audit.actor_profile_id=p_filter_actor_profile_id)
      and (p_before_recorded_at is null or (audit.recorded_at,audit.id)<(p_before_recorded_at,p_before_id))
    order by recorded_at desc,id desc limit p_limit
  ) merged order by merged.recorded_at desc,merged.id desc limit p_limit;
end $$;

revoke all on function public.report_checkout_presence_incident(uuid,uuid,uuid,bigint,uuid,bigint,text,text)
from public,anon,authenticated;
revoke all on function public.get_checkout_presence_incident(uuid,uuid,uuid)
from public,anon,authenticated;
revoke all on function public.decide_checkout_presence_incident(uuid,uuid,uuid,bigint,text,text,text,timestamptz,jsonb,text,text)
from public,anon,authenticated;
revoke all on function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) from public,anon,authenticated;
grant execute on function public.report_checkout_presence_incident(uuid,uuid,uuid,bigint,uuid,bigint,text,text) to service_role;
grant execute on function public.get_checkout_presence_incident(uuid,uuid,uuid) to service_role;
grant execute on function public.decide_checkout_presence_incident(uuid,uuid,uuid,bigint,text,text,text,timestamptz,jsonb,text,text) to service_role;
grant execute on function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) to service_role;

-- Actual check-in must remain fail-closed while the previous checkout has an
-- unresolved physical-presence conflict. Reservation allocation still passes
-- a null preparation identity and is intentionally not blocked by this reason.
create or replace function private.room_block_reason_codes(
  p_room_id uuid,p_at timestamptz,p_include_occupancy boolean default true,
  p_include_cleaning boolean default true,p_preparation_reservation_id uuid default null
) returns text[] language plpgsql stable security definer
set search_path=pg_catalog,public,private as $$
declare v_reasons text[]:=array[]::text[]; v_room public.rooms; v_pin_status text;
begin
  select * into v_room from public.rooms where id=p_room_id;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if p_include_occupancy and exists(select 1 from public.reservations r where r.room_id=p_room_id
    and r.status='active' and r.actual_check_in_at is not null and r.actual_check_in_at<=p_at
    and r.actual_checkout_at is null) then v_reasons:=array_append(v_reasons,'OCCUPIED'); end if;
  if p_include_cleaning and exists(select 1 from public.preparation_obligations po
    join public.reservations r on r.id=po.reservation_id where po.room_id=p_room_id and r.status='active'
      and (p_preparation_reservation_id is null or po.reservation_id=p_preparation_reservation_id)
      and po.status<>'approved') then v_reasons:=array_append(v_reasons,'CLEANING_REQUIRED'); end if;
  if private.current_candle_count(p_room_id)>0 then v_reasons:=array_append(v_reasons,'CANDLE_PRESENT'); end if;
  if exists(select 1 from public.room_operation_blocks b where b.room_id=p_room_id and b.released_at is null
    and b.starts_at<=p_at and (b.ends_at is null or b.ends_at>p_at)) then
    v_reasons:=array_append(v_reasons,'OPERATION_BLOCKED'); end if;
  if exists(select 1 from public.room_issues x where x.room_id=p_room_id and x.status='open'
    and x.blocks_guest_assignment) then v_reasons:=array_append(v_reasons,'ROOM_ISSUE_BLOCKED'); end if;
  if p_preparation_reservation_id is not null then
    v_pin_status:=private.current_pin_sync_status(p_room_id);
    if v_pin_status='mismatch' then v_reasons:=array_append(v_reasons,'PIN_MISMATCH');
    elsif v_pin_status='unconfigured' then v_reasons:=array_append(v_reasons,'DATA_UNCONFIRMED'); end if;
    if exists(select 1 from public.checkout_presence_incidents i where i.room_id=p_room_id and i.status='open') then
      v_reasons:=array_append(v_reasons,'CHECKOUT_NOT_COMPLETED');
    end if;
  end if;
  if v_room.data_status<>'verified' and not ('DATA_UNCONFIRMED'=any(v_reasons)) then
    v_reasons:=array_append(v_reasons,'DATA_UNCONFIRMED'); end if;
  return v_reasons;
end $$;
revoke all on function private.room_block_reason_codes(uuid,timestamptz,boolean,boolean,uuid)
from public,anon,authenticated,service_role;

comment on table public.checkout_presence_incidents is
'#133 typed guest-presence conflict. No guest/PIN/free-text material is stored. The open row freezes work until an immutable admin decision.';
comment on table public.checkout_presence_incident_decisions is
'#133 append-only admin decisions. Existing checkout target and execution history are retained; new responsibility uses a new assignment revision.';
