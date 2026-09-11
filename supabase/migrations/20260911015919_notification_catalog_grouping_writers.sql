-- #109 source-controlled notification catalog, typed provenance, fixed grouping,
-- and atomic writer cutover. Existing rows and the legacy outbox are preserved.

create table private.notification_event_catalog (
  event_family text primary key,
  category text not null,
  source_entity_kind text not null,
  recipient_capability text not null,
  requires_action boolean not null,
  push_eligible boolean not null,
  resolver_kind text not null,
  deep_link_kind text not null,
  group_family text not null,
  group_scope_kind text not null,
  contract_version smallint not null default 1 check (contract_version = 1),
  check (event_family ~ '^[a-z][a-z0-9_.]{2,95}$'),
  check (category ~ '^[a-z][a-z0-9_]{2,95}$'),
  check (source_entity_kind ~ '^[a-z][a-z0-9_]{2,63}$'),
  check (recipient_capability in (
    'maid.assignment_party','maid.limited_grantee','admin.assignment_decider',
    'admin.inspection_queue','maid.inspection_subject','maid.complaint_party',
    'admin.complaint_decider','maid.rework_assignee','maid.payroll_owner'
  )),
  check (not push_eligible or requires_action),
  check (deep_link_kind in (
    'cleaningTarget','assignmentRequest','submission','complaintCase','payrollCycle','payrollProfile'
  )),
  check (group_scope_kind in ('room','payrollCycle','payrollProfile'))
);

insert into private.notification_event_catalog (
  event_family,category,source_entity_kind,recipient_capability,requires_action,
  push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind
) values
  ('assignment.commit_notified','cleaning_assignment_notified','cleaning_assignment','maid.assignment_party',true,true,'assignment_terminal','cleaningTarget','cleaning_assignment_notified','room'),
  ('assignment.prestart_new_notified','cleaning_assignment_notified','cleaning_assignment','maid.assignment_party',true,true,'assignment_terminal','cleaningTarget','cleaning_assignment_notified','room'),
  ('attempt.handover_next_notified','cleaning_assignment_notified','cleaning_assignment','maid.assignment_party',true,true,'assignment_terminal','cleaningTarget','cleaning_assignment_notified','room'),
  ('reservation.extension_revoked','cleaning_assignment_revoked','cleaning_assignment','maid.assignment_party',false,false,'none','cleaningTarget','cleaning_assignment_revoked','room'),
  ('reservation.cancelled_revoked','cleaning_assignment_revoked','cleaning_assignment','maid.assignment_party',false,false,'none','cleaningTarget','cleaning_assignment_revoked','room'),
  ('cleaning_request.cancelled_revoked','cleaning_assignment_revoked','cleaning_assignment','maid.assignment_party',false,false,'none','cleaningTarget','cleaning_assignment_revoked','room'),
  ('assignment.prestart_old_revoked','cleaning_assignment_revoked','cleaning_assignment','maid.assignment_party',false,false,'none','cleaningTarget','cleaning_assignment_revoked','room'),
  ('assignment.prestart_unassigned','cleaning_assignment_revoked','cleaning_assignment','maid.assignment_party',false,false,'none','cleaningTarget','cleaning_assignment_revoked','room'),
  ('attempt.handover_previous_revoked','cleaning_assignment_revoked','cleaning_assignment','maid.assignment_party',false,false,'none','cleaningTarget','cleaning_assignment_revoked','room'),
  ('reservation.manual_checkout_rescheduled','cleaning_schedule_changed','cleaning_assignment','maid.assignment_party',true,true,'assignment_terminal','cleaningTarget','cleaning_schedule_changed','room'),
  ('assignment.prestart_same_maid_changed','cleaning_assignment_changed','cleaning_assignment','maid.assignment_party',true,true,'assignment_terminal','cleaningTarget','cleaning_assignment_changed','room'),
  ('assignment.cancellation_requested','assignment_cancellation_requested','assignment_change_request','admin.assignment_decider',true,true,'assignment_request_terminal','assignmentRequest','assignment_cancellation_requested','room'),
  ('assignment.cancellation_approved','assignment_cancellation_approved','assignment_change_request','maid.assignment_party',false,false,'none','assignmentRequest','assignment_cancellation_approved','room'),
  ('assignment.cancellation_rejected','assignment_cancellation_rejected','assignment_change_request','maid.assignment_party',false,false,'none','assignmentRequest','assignment_cancellation_rejected','room'),
  ('assignment.scheduled_rolled_over','cleaning_assignment_rolled_over','cleaning_assignment','maid.assignment_party',false,false,'none','cleaningTarget','cleaning_assignment_rolled_over','room'),
  ('capability.finish_current_issued','cleaning_capability_changed','attempt_capability_grant','maid.limited_grantee',true,true,'capability_terminal','cleaningTarget','cleaning_capability_changed','room'),
  ('capability.upload_submit_admin_issued','cleaning_capability_changed','attempt_capability_grant','maid.limited_grantee',true,true,'capability_terminal','cleaningTarget','cleaning_capability_changed','room'),
  ('capability.upload_submit_self_issued','cleaning_capability_changed','attempt_capability_grant','maid.limited_grantee',true,true,'capability_terminal','cleaningTarget','cleaning_capability_changed','room'),
  ('capability.evidence_upload_handover_issued','cleaning_capability_changed','attempt_capability_grant','maid.limited_grantee',true,true,'capability_terminal','cleaningTarget','cleaning_capability_changed','room'),
  ('capability.upload_submit_offline_resolution_issued','cleaning_capability_changed','attempt_capability_grant','maid.limited_grantee',true,true,'capability_terminal','cleaningTarget','cleaning_capability_changed','room'),
  ('submission.initial_requested','cleaning_inspection_requested','cleaning_submission','admin.inspection_queue',true,true,'submission_terminal','submission','cleaning_inspection_requested','room'),
  ('submission.reinspection_requested','cleaning_reinspection_requested','cleaning_submission','admin.inspection_queue',true,true,'submission_terminal','submission','cleaning_reinspection_requested','room'),
  ('inspection.original_approved','cleaning_inspection_approved','inspection_decision','maid.inspection_subject',false,false,'none','submission','cleaning_inspection_approved','room'),
  ('inspection.reclean_approved','cleaning_inspection_approved','inspection_decision','maid.inspection_subject',false,false,'none','submission','cleaning_inspection_approved','room'),
  ('inspection.complaint_rework_approved','cleaning_inspection_approved','inspection_decision','maid.inspection_subject',false,false,'none','submission','cleaning_inspection_approved','room'),
  ('inspection.original_rejected_reclean_created','cleaning_inspection_rejected','inspection_decision','maid.inspection_subject',true,true,'reclean_submission','cleaningTarget','cleaning_inspection_rejected','room'),
  ('inspection.complaint_rework_rejected','cleaning_inspection_rejected','inspection_decision','maid.inspection_subject',false,false,'none','submission','cleaning_inspection_rejected','room'),
  ('complaint.received','complaint_received','complaint_case_event','maid.complaint_party',false,false,'none','complaintCase','complaint_received','room'),
  ('complaint.decided','complaint_decided','complaint_case_event','maid.complaint_party',true,true,'complaint_response','complaintCase','complaint_decided','room'),
  ('complaint.corrected','complaint_corrected','complaint_case_event','maid.complaint_party',false,false,'none','complaintCase','complaint_corrected','room'),
  ('complaint.acknowledged','complaint_acknowledged','complaint_case_event','admin.complaint_decider',false,false,'none','complaintCase','complaint_acknowledged','room'),
  ('complaint.appealed','complaint_appealed','complaint_case_event','admin.complaint_decider',true,true,'complaint_admin_response','complaintCase','complaint_appealed','room'),
  ('complaint.closed','complaint_closed','complaint_case_event','maid.complaint_party',false,false,'none','complaintCase','complaint_closed','room'),
  ('complaint.rework_assigned','complaint_rework_assigned','complaint_compensation_decision','maid.rework_assignee',true,true,'rework_submission','cleaningTarget','complaint_rework_assigned','room'),
  ('payroll.adjustment_recorded','payroll_adjustment_recorded','payroll_adjustment','maid.payroll_owner',false,false,'none','payrollProfile','payroll_adjustment_recorded','payrollProfile'),
  ('payroll.adjustment_reversed','payroll_adjustment_reversed','payroll_adjustment','maid.payroll_owner',false,false,'none','payrollProfile','payroll_adjustment_reversed','payrollProfile'),
  ('payroll.late_earning_carried','payroll_late_earning_carried','payroll_adjustment','maid.payroll_owner',false,false,'none','payrollProfile','payroll_late_earning_carried','payrollProfile'),
  ('payroll.payment_started','payroll_payment_started','payroll_payment_attempt','maid.payroll_owner',false,false,'none','payrollCycle','payroll_payment_started','payrollCycle'),
  ('payroll.offset_settled','payroll_offset_settled','payroll_offset_settlement','maid.payroll_owner',false,false,'none','payrollCycle','payroll_offset_settled','payrollCycle'),
  ('payroll.payment_check_recorded','payroll_payment_check','payroll_payment_result','maid.payroll_owner',false,false,'none','payrollCycle','payroll_payment_check','payrollCycle'),
  ('payroll.payment_paid','payroll_payment_paid','payroll_payment_result','maid.payroll_owner',false,false,'none','payrollCycle','payroll_payment_paid','payrollCycle'),
  ('payroll.payment_reopened','payroll_payment_reopened','payroll_payment_result','maid.payroll_owner',false,false,'none','payrollCycle','payroll_payment_reopened','payrollCycle');

create table private.notification_groups (
  id uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid not null references public.profiles(id) on delete restrict,
  group_family text not null,
  scope_kind text not null check (scope_kind in ('room','payrollCycle','payrollProfile')),
  scope_id uuid not null,
  started_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (isfinite(started_at) and isfinite(ends_at)),
  check (ends_at = started_at + interval '10 minutes')
);
create index notification_groups_fixed_lookup_idx
  on private.notification_groups(recipient_profile_id,group_family,scope_kind,scope_id,ends_at desc,id desc);

-- The pre-v1 partial key remains strict for legacy history and is renamed to
-- state its v1 meaning: exactly one recipient row per logical event. Group
-- identity is deliberately not part of this key and is stored separately.
drop index public.notifications_dedupe;
create unique index notifications_recipient_logical_event_dedupe_uq
  on public.notifications(recipient_profile_id,dedupe_key)
  where dedupe_key is not null;

alter table public.notifications
  add column contract_version smallint,
  add column actor_profile_id uuid references public.profiles(id) on delete restrict,
  add column event_family text references private.notification_event_catalog(event_family) on delete restrict,
  add column source_entity_kind text,
  add column source_entity_id text,
  add column deep_link_kind text,
  add column deep_link_entity_id uuid,
  add column notification_group_id uuid references private.notification_groups(id) on delete restrict,
  add constraint notifications_typed_provenance_check check (
    (contract_version is null and actor_profile_id is null and event_family is null
      and source_entity_kind is null and source_entity_id is null and deep_link_kind is null
      and deep_link_entity_id is null and notification_group_id is null)
    or
    (contract_version = 1 and actor_profile_id is not null and event_family is not null
      and source_entity_kind is not null and source_entity_id ~ '^[A-Za-z0-9._:-]{1,160}$'
      and deep_link_kind in ('cleaningTarget','assignmentRequest','submission','complaintCase','payrollCycle','payrollProfile')
      and deep_link_entity_id is not null and notification_group_id is not null)
  );
create index notifications_typed_source_idx
  on public.notifications(event_family,source_entity_kind,source_entity_id,recipient_profile_id)
  where contract_version = 1 and resolved_at is null;
create index notifications_typed_actor_idx
  on public.notifications(actor_profile_id)
  where contract_version = 1;
create index notifications_typed_group_idx
  on public.notifications(notification_group_id)
  where contract_version = 1;

create table private.notification_delivery_outbox (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null unique references public.notifications(id) on delete restrict,
  event_family text not null references private.notification_event_catalog(event_family) on delete restrict,
  delivery_status text not null default 'pending' check (delivery_status = 'pending'),
  enqueued_at timestamptz not null default clock_timestamp()
);
create index notification_delivery_outbox_event_family_idx
  on private.notification_delivery_outbox(event_family,enqueued_at,id);

alter table private.notification_event_catalog enable row level security;
alter table private.notification_groups enable row level security;
alter table private.notification_delivery_outbox enable row level security;
revoke all on private.notification_event_catalog,private.notification_groups,
  private.notification_delivery_outbox,private.notification_outbox
from public,anon,authenticated,service_role;

comment on table private.notification_outbox is
'LEGACY_DO_NOT_DELIVER: provenance-less pre-#109 history. No worker may read or claim this table.';
comment on table private.notification_delivery_outbox is
'#109 typed-only pending queue. #111 may add claim/lease/attempt/dead-letter contracts; no current worker access.';

create function private.guard_notification_catalog_ledgers()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception using errcode='55000',message='NOTIFICATION_CATALOG_LEDGER_IMMUTABLE';
end $$;
revoke all on function private.guard_notification_catalog_ledgers() from public,anon,authenticated,service_role;
create trigger notification_event_catalog_immutable before update or delete on private.notification_event_catalog
for each row execute function private.guard_notification_catalog_ledgers();
create trigger notification_groups_immutable before update or delete on private.notification_groups
for each row execute function private.guard_notification_catalog_ledgers();
create trigger notification_delivery_outbox_immutable before update or delete on private.notification_delivery_outbox
for each row execute function private.guard_notification_catalog_ledgers();

-- All current command writers call replay_command before domain mutation. This
-- transaction-local flag suppresses only their legacy notification/outbox blocks;
-- direct legacy fixtures and historical rows remain untouched.
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
      'assignment.process_due_lifecycle','cleaning.lifecycle.allow_finish',
      'cleaning.lifecycle.allow_upload','cleaning.lifecycle.interrupt_handover',
      'cleaning.lifecycle.expire_scheduled','cleaning.limited.complete_field_work',
      'submission.create','inspection.approved','inspection.rejected',
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
    perform set_config('app.notification_legacy_suppressed_count','0',true);
    perform set_config('app.notification_typed_emit_count','0',true);
    return v_existing.response_payload;
  exception when others then
    perform set_config('app.notification_writer_mode','',true);
    perform set_config('app.notification_terminal_kind','',true);
    perform set_config('app.notification_terminal_id','',true);
    perform set_config('app.notification_legacy_suppressed_count','0',true);
    perform set_config('app.notification_typed_emit_count','0',true);
    raise;
  end;
end $$;

create or replace function private.complete_command(
  p_actor_profile_id uuid,p_command_type text,p_idempotency_key text,p_request_hash text,
  p_entity_id uuid,p_response_payload jsonb
) returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
  begin
    if current_setting('app.notification_writer_mode',true)='typed_v1'
      and coalesce(nullif(current_setting('app.notification_legacy_suppressed_count',true),''),'0')::integer>0
      and coalesce(nullif(current_setting('app.notification_typed_emit_count',true),''),'0')::integer
        <coalesce(nullif(current_setting('app.notification_legacy_suppressed_count',true),''),'0')::integer then
      raise exception using errcode='23514',message='NOTIFICATION_TYPED_WRITER_COVERAGE_GAP';
    end if;
    insert into private.command_executions(actor_profile_id,command_type,idempotency_key,request_hash,entity_id,response_payload)
    values(p_actor_profile_id,p_command_type,p_idempotency_key,p_request_hash,p_entity_id,p_response_payload);
    perform set_config('app.notification_writer_mode','',true);
    perform set_config('app.notification_terminal_kind','',true);
    perform set_config('app.notification_terminal_id','',true);
    perform set_config('app.notification_legacy_suppressed_count','0',true);
    perform set_config('app.notification_typed_emit_count','0',true);
  exception when others then
    perform set_config('app.notification_writer_mode','',true);
    perform set_config('app.notification_terminal_kind','',true);
    perform set_config('app.notification_terminal_id','',true);
    perform set_config('app.notification_legacy_suppressed_count','0',true);
    perform set_config('app.notification_typed_emit_count','0',true);
    raise;
  end;
end $$;

create function private.suppress_legacy_notification_writer()
returns trigger language plpgsql set search_path='' as $$
begin
  if current_setting('app.notification_writer_mode',true)='typed_v1' and new.contract_version is null then
    perform set_config('app.notification_legacy_suppressed_count',
      (coalesce(nullif(current_setting('app.notification_legacy_suppressed_count',true),''),'0')::integer+1)::text,true);
    return null;
  end if;
  return new;
end $$;
revoke all on function private.suppress_legacy_notification_writer() from public,anon,authenticated,service_role;
create trigger aa_notification_typed_writer_cutover before insert on public.notifications
for each row execute function private.suppress_legacy_notification_writer();

create function private.suppress_legacy_outbox_writer()
returns trigger language plpgsql set search_path='' as $$
begin
  if current_setting('app.notification_writer_mode',true)='typed_v1' then return null; end if;
  return new;
end $$;
revoke all on function private.suppress_legacy_outbox_writer() from public,anon,authenticated,service_role;
create trigger notification_legacy_outbox_cutover before insert on private.notification_outbox
for each row execute function private.suppress_legacy_outbox_writer();

create function private.notification_source_is_valid(
  p_event_family text,p_actor uuid,p_recipient uuid,p_source_id text,
  p_room uuid,p_cleaning_target uuid,p_deep_link_entity uuid
) returns boolean language plpgsql volatile security definer set search_path='' as $$
declare
  v_id uuid; v_assignment public.cleaning_assignments; v_target public.cleaning_targets;
  v_request public.assignment_change_requests; v_grant private.attempt_capability_grants;
  v_attempt public.cleaning_attempts; v_submission public.cleaning_submissions;
  v_decision public.inspection_decisions; v_case_event public.complaint_case_events;
  v_case public.complaint_cases; v_comp public.complaint_compensation_decisions;
  v_adjustment public.payroll_adjustments; v_cycle public.payroll_cycles;
  v_payment_attempt public.payroll_payment_attempts; v_payment_result public.payroll_payment_results;
  v_settlement public.payroll_offset_settlements;
begin
  if p_event_family like 'complaint.%' and p_event_family<>'complaint.rework_assigned' then
    select * into v_case_event from public.complaint_case_events where id=p_source_id::bigint;
    select * into v_case from public.complaint_cases where id=v_case_event.complaint_case_id;
    if v_case_event.id is null or v_case.id is null or v_case_event.actor_profile_id is distinct from p_actor
      or v_case_event.event_type is distinct from split_part(p_event_family,'.',2)
      or p_room is distinct from v_case.room_id or p_cleaning_target is distinct from v_case.cleaning_target_id
      or p_deep_link_entity is distinct from v_case.id then return false; end if;
    if p_event_family in ('complaint.acknowledged','complaint.appealed') then
      return exists(select 1 from public.complaint_decisions d
        where d.id=v_case_event.decision_id and d.decided_by=p_recipient);
    end if;
    return p_recipient=v_case.maid_profile_id;
  end if;

  v_id:=p_source_id::uuid;
  if p_event_family like 'assignment.%' or p_event_family like 'reservation.%'
      or p_event_family='attempt.handover_next_notified'
      or p_event_family='attempt.handover_previous_revoked'
      or p_event_family='cleaning_request.cancelled_revoked' then
    if p_event_family in ('assignment.cancellation_requested','assignment.cancellation_approved',
        'assignment.cancellation_rejected') then
      select * into v_request from public.assignment_change_requests where id=v_id;
      select * into v_target from public.cleaning_targets where id=v_request.cleaning_target_id;
      if v_request.id is null or p_room is distinct from v_target.room_id
        or p_cleaning_target is distinct from v_target.id or p_deep_link_entity is distinct from v_request.id then return false; end if;
      if p_event_family='assignment.cancellation_requested' then
        return p_actor=v_request.maid_profile_id and exists(
          select 1 from public.profiles where id=p_recipient and role='admin');
      end if;
      return p_recipient=v_request.maid_profile_id and p_actor=v_request.decided_by
        and v_request.status=case when p_event_family='assignment.cancellation_approved' then 'approved' else 'rejected' end;
    end if;
    select * into v_assignment from public.cleaning_assignments where id=v_id;
    select * into v_target from public.cleaning_targets where id=v_assignment.cleaning_target_id;
    return v_assignment.id is not null and p_recipient=v_assignment.maid_profile_id
      and p_room is not distinct from v_target.room_id and p_cleaning_target is not distinct from v_target.id
      and p_deep_link_entity=v_target.id;
  elsif p_event_family like 'capability.%' then
    select * into v_grant from private.attempt_capability_grants where id=v_id;
    select * into v_attempt from public.cleaning_attempts where id=v_grant.attempt_id;
    select * into v_target from public.cleaning_targets where id=v_attempt.cleaning_target_id;
    if not (v_grant.id is not null and p_actor=v_grant.granted_by and p_recipient=v_grant.actor_profile_id
      and p_room is not distinct from v_target.room_id and p_cleaning_target is not distinct from v_target.id
      and p_deep_link_entity=v_target.id) then return false; end if;
    if p_event_family='capability.finish_current_issued' then
      return v_grant.kind='finish_current'
        and current_setting('app.notification_source_event_type',true)='cleaning.finish_current_allowed';
    elsif p_event_family='capability.upload_submit_admin_issued' then
      return v_grant.kind='upload_submit' and v_grant.granted_by<>v_grant.actor_profile_id
        and current_setting('app.notification_source_event_type',true)='cleaning.upload_only_allowed';
    elsif p_event_family='capability.upload_submit_self_issued' then
      return v_grant.kind='upload_submit' and v_grant.granted_by=v_grant.actor_profile_id
        and current_setting('app.notification_source_event_type',true)='cleaning.field_completed'
        and coalesce(current_setting('app.notification_source_reason_code',true),'')='';
    elsif p_event_family='capability.upload_submit_offline_resolution_issued' then
      return v_grant.kind='upload_submit' and v_grant.granted_by<>v_grant.actor_profile_id
        and current_setting('app.notification_source_event_type',true)='cleaning.field_completed'
        and current_setting('app.notification_source_reason_code',true)='OFFLINE_CORRECTION_APPROVED';
    elsif p_event_family='capability.evidence_upload_handover_issued' then
      return v_grant.kind='evidence_upload'
        and current_setting('app.notification_source_event_type',true)='cleaning.interrupted_handover'
        and exists(select 1 from private.attempt_handover_events h
        where h.previous_attempt_id=v_grant.attempt_id and h.actor_profile_id=v_grant.granted_by
          and h.occurred_at=v_grant.issued_at);
    end if;
    return false;
  elsif p_event_family in ('submission.initial_requested','submission.reinspection_requested') then
    select * into v_submission from public.cleaning_submissions where id=v_id;
    select * into v_attempt from public.cleaning_attempts where id=v_submission.cleaning_attempt_id;
    select * into v_target from public.cleaning_targets where id=v_attempt.cleaning_target_id;
    return v_submission.id is not null and p_actor=v_submission.submitted_by
      and exists(select 1 from public.profiles where id=p_recipient and role='admin')
      and p_room is not distinct from v_target.room_id and p_cleaning_target is not distinct from v_target.id
      and p_deep_link_entity=v_submission.id
      and (p_event_family='submission.initial_requested')=(v_target.source not in ('inspection_reclean','post_approval_complaint_reclean'));
  elsif p_event_family like 'inspection.%' then
    select * into v_decision from public.inspection_decisions where id=v_id;
    select * into v_submission from public.cleaning_submissions where id=v_decision.submission_id;
    select * into v_attempt from public.cleaning_attempts where id=v_submission.cleaning_attempt_id;
    select * into v_target from public.cleaning_targets where id=v_attempt.cleaning_target_id;
    if v_decision.id is null or p_actor<>v_decision.decided_by or p_recipient<>v_attempt.maid_profile_id
      or p_room is distinct from v_target.room_id then return false; end if;
    if p_event_family='inspection.original_rejected_reclean_created' then
      return v_decision.decision='rejected' and v_target.source<>'post_approval_complaint_reclean'
        and exists(select 1 from public.cleaning_targets rt where rt.id=p_deep_link_entity
          and rt.reclean_of_inspection_decision_id=v_decision.id and p_cleaning_target=rt.id);
    end if;
    return p_deep_link_entity=v_submission.id and p_cleaning_target=v_target.id
      and ((p_event_family in ('inspection.original_approved','inspection.reclean_approved',
          'inspection.complaint_rework_approved') and v_decision.decision='approved')
        or (p_event_family='inspection.complaint_rework_rejected' and v_decision.decision='rejected'
          and v_target.source='post_approval_complaint_reclean'));
  elsif p_event_family='complaint.rework_assigned' then
    select * into v_comp from public.complaint_compensation_decisions where id=v_id;
    select * into v_target from public.cleaning_targets where complaint_compensation_decision_id=v_comp.id;
    return v_comp.id is not null and p_actor=v_comp.decided_by and p_recipient=v_comp.assignee_maid_profile_id
      and p_room is not distinct from (select room_id from public.complaint_cases where id=v_comp.complaint_case_id)
      and p_cleaning_target=v_target.id and p_deep_link_entity=v_target.id;
  elsif p_event_family like 'payroll.adjustment_%' or p_event_family='payroll.late_earning_carried' then
    select * into v_adjustment from public.payroll_adjustments where id=v_id;
    return v_adjustment.id is not null and p_actor=v_adjustment.created_by
      and p_recipient=v_adjustment.maid_profile_id and p_room is null and p_cleaning_target is null
      and p_deep_link_entity=v_adjustment.maid_profile_id;
  elsif p_event_family='payroll.payment_started' then
    select * into v_payment_attempt from public.payroll_payment_attempts where id=v_id;
    select * into v_cycle from public.payroll_cycles where id=v_payment_attempt.payroll_cycle_id;
    return v_payment_attempt.id is not null and p_actor=v_cycle.payment_started_by
      and p_recipient=v_cycle.maid_profile_id and p_room is null and p_cleaning_target is null
      and p_deep_link_entity=v_cycle.id;
  elsif p_event_family='payroll.offset_settled' then
    select * into v_settlement from public.payroll_offset_settlements where id=v_id;
    return v_settlement.id is not null and p_actor=v_settlement.settled_by
      and p_recipient=v_settlement.maid_profile_id and p_room is null and p_cleaning_target is null
      and p_deep_link_entity=v_settlement.payroll_cycle_id;
  elsif p_event_family in ('payroll.payment_check_recorded','payroll.payment_paid','payroll.payment_reopened') then
    select * into v_payment_result from public.payroll_payment_results where id=v_id;
    select * into v_payment_attempt from public.payroll_payment_attempts where id=v_payment_result.payment_attempt_id;
    select * into v_cycle from public.payroll_cycles where id=v_payment_attempt.payroll_cycle_id;
    return v_payment_result.id is not null and p_actor=v_payment_result.actor_profile_id
      and p_recipient=v_cycle.maid_profile_id and p_room is null and p_cleaning_target is null
      and p_deep_link_entity=v_cycle.id
      and v_payment_result.result_type=case p_event_family
        when 'payroll.payment_check_recorded' then 'check' when 'payroll.payment_paid' then 'paid' else 'reopened' end;
  end if;
  return false;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;
revoke all on function private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)
from public,anon,authenticated,service_role;

create function private.emit_notification_v1(
  p_event_family text,p_actor uuid,p_recipient uuid,p_source_kind text,p_source_id text,
  p_title text,p_body text,p_room uuid,p_cleaning_target uuid,p_deep_link_entity uuid,
  p_occurred_at timestamptz
) returns uuid language plpgsql security definer set search_path='' as $$
declare c private.notification_event_catalog; g private.notification_groups; v_scope uuid;
  v_notice uuid; v_dedupe text;
begin
  select * into c from private.notification_event_catalog where event_family=p_event_family;
  if c.event_family is null or c.source_entity_kind<>p_source_kind or p_actor is null or p_recipient is null
    or p_source_id is null or p_source_id!~'^[A-Za-z0-9._:-]{1,160}$'
    or p_deep_link_entity is null or p_occurred_at is null or not isfinite(p_occurred_at)
    or nullif(btrim(p_title),'') is null or char_length(p_title)>120
    or nullif(btrim(p_body),'') is null or char_length(p_body)>500 then
    raise exception using errcode='23514',message='NOTIFICATION_CATALOG_CONTRACT_VIOLATION';
  end if;
  if not private.notification_source_is_valid(p_event_family,p_actor,p_recipient,p_source_id,
      p_room,p_cleaning_target,p_deep_link_entity) then
    raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
  end if;
  v_scope:=case c.group_scope_kind when 'room' then p_room else p_deep_link_entity end;
  if v_scope is null then raise exception using errcode='23514',message='NOTIFICATION_GROUP_SCOPE_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'notification-group:v1:'||p_recipient::text||':'||c.group_family||':'||c.group_scope_kind||':'||v_scope::text,0));
  select * into g from private.notification_groups x
  where x.recipient_profile_id=p_recipient and x.group_family=c.group_family
    and x.scope_kind=c.group_scope_kind and x.scope_id=v_scope
    and p_occurred_at>=x.started_at and p_occurred_at<x.ends_at
  order by x.started_at desc,x.id desc limit 1;
  if g.id is null then
    insert into private.notification_groups(recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at)
    values(p_recipient,c.group_family,c.group_scope_kind,v_scope,p_occurred_at,p_occurred_at+interval '10 minutes')
    returning * into g;
  end if;
  v_dedupe:='notification:v1:'||p_event_family||':'||p_source_kind||':'||p_source_id;
  insert into public.notifications(recipient_profile_id,category,title,body,room_id,cleaning_target_id,
    dedupe_key,requires_action,occurred_at,contract_version,actor_profile_id,event_family,
    source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,notification_group_id)
  values(p_recipient,c.category,p_title,p_body,p_room,p_cleaning_target,v_dedupe,c.requires_action,p_occurred_at,
    1,p_actor,p_event_family,p_source_kind,p_source_id,c.deep_link_kind,p_deep_link_entity,g.id)
  on conflict(recipient_profile_id,dedupe_key) where dedupe_key is not null
  do nothing returning id into v_notice;
  if v_notice is null then
    select id into v_notice from public.notifications
    where recipient_profile_id=p_recipient and dedupe_key=v_dedupe and contract_version=1
      and actor_profile_id=p_actor and category=c.category and requires_action=c.requires_action
      and room_id is not distinct from p_room and cleaning_target_id is not distinct from p_cleaning_target
      and event_family=p_event_family and source_entity_kind=p_source_kind and source_entity_id=p_source_id
      and deep_link_kind=c.deep_link_kind and deep_link_entity_id=p_deep_link_entity
      and notification_group_id=g.id;
  end if;
  if v_notice is null then raise exception using errcode='23505',message='NOTIFICATION_DEDUPE_CONFLICT'; end if;
  if c.push_eligible and c.requires_action and p_actor<>p_recipient and exists(
    select 1 from public.profiles r where r.id=p_recipient and r.status='active'
      and not r.must_change_password and r.role in ('admin','maid')) then
    insert into private.notification_delivery_outbox(notification_id,event_family,enqueued_at)
    values(v_notice,p_event_family,p_occurred_at) on conflict(notification_id) do nothing;
  end if;
  perform set_config('app.notification_typed_emit_count',
    (coalesce(nullif(current_setting('app.notification_typed_emit_count',true),''),'0')::integer+1)::text,true);
  return v_notice;
end $$;
revoke all on function private.emit_notification_v1(text,uuid,uuid,text,text,text,text,uuid,uuid,uuid,timestamptz)
from public,anon,authenticated,service_role;

create function private.notification_resolution_is_valid(
  p_event_family text,p_source_kind text,p_source_id text,p_terminal_kind text,p_terminal_id text
) returns boolean language plpgsql volatile security definer set search_path='' as $$
declare
  c private.notification_event_catalog; v_source uuid; v_terminal uuid;
  ae public.audit_events; a public.cleaning_assignments; t public.cleaning_targets;
  source_submission public.cleaning_submissions;
  grant_row private.attempt_capability_grants; source_case_event public.complaint_case_events;
  terminal_case_event public.complaint_case_events; comp public.complaint_compensation_decisions;
begin
  select * into c from private.notification_event_catalog where event_family=p_event_family;
  if c.event_family is null or c.source_entity_kind<>p_source_kind or c.resolver_kind='none'
    or p_terminal_kind not in ('audit_event','capability_revocation','capability_expired') then return false; end if;
  v_terminal:=p_terminal_id::uuid;

  if c.resolver_kind in ('complaint_response','complaint_admin_response') and p_terminal_kind='audit_event' then
    select * into ae from public.audit_events where id=v_terminal;
    select * into source_case_event from public.complaint_case_events where id=p_source_id::bigint;
    select * into terminal_case_event from public.complaint_case_events where complaint_case_id=source_case_event.complaint_case_id
      and actor_profile_id=ae.actor_profile_id and occurred_at=ae.effective_at
      and event_type=split_part(ae.event_type,'.',2) order by id desc limit 1;
    if c.resolver_kind='complaint_response' then
      return source_case_event.event_type='decided'
        and ((ae.event_type in ('complaint.acknowledged','complaint.appealed')
            and terminal_case_event.decision_id=source_case_event.decision_id)
          or (ae.event_type='complaint.closed'
            and terminal_case_event.complaint_case_id=source_case_event.complaint_case_id));
    end if;
    return source_case_event.event_type='appealed' and ae.event_type in ('complaint.corrected','complaint.closed')
      and terminal_case_event.complaint_case_id=source_case_event.complaint_case_id;
  end if;

  v_source:=p_source_id::uuid;
  if c.resolver_kind='assignment_terminal' and p_terminal_kind='audit_event' then
    select * into ae from public.audit_events where id=v_terminal;
    select * into a from public.cleaning_assignments where id=v_source;
    select * into t from public.cleaning_targets where id=a.cleaning_target_id;
    if ae.id is null or a.id is null then return false; end if;
    if ae.event_type in ('reservation.changed','reservation.cancelled','reservation.manual_checkout') then
      return t.reservation_id=ae.entity_id;
    elsif ae.event_type='cleaning.manual_request.cancelled' then return t.id=ae.entity_id;
    elsif ae.event_type='assignment.prestart_changed' then
      return nullif(ae.after_state->>'previousAssignmentId','')::uuid=a.id;
    elsif ae.event_type='assignment.prestart_unassigned' then return ae.entity_id=a.id;
    elsif ae.event_type in ('cleaning.attempt_started','cleaning.interrupted_handover') then
      return exists(select 1 from public.cleaning_attempts x where x.id=ae.entity_id and x.assignment_id=a.id);
    elsif ae.event_type='assignment.rolled_over' then
      return ae.entity_id=t.id and nullif(ae.after_state->>'assignmentId','')::uuid=a.id;
    elsif ae.event_type='submission.created' then
      return exists(select 1 from public.cleaning_submissions s join public.cleaning_attempts x
        on x.id=s.cleaning_attempt_id where s.id=ae.entity_id and x.assignment_id=a.id);
    end if;
  elsif c.resolver_kind='assignment_request_terminal' and p_terminal_kind='audit_event' then
    select * into ae from public.audit_events where id=v_terminal;
    return ae.event_type='assignment.cancellation_decided' and ae.entity_id=v_source
      and exists(select 1 from public.assignment_change_requests q where q.id=v_source and q.status in ('approved','rejected'));
  elsif c.resolver_kind='capability_terminal' then
    select * into grant_row from private.attempt_capability_grants where id=v_source;
    if grant_row.id is null then return false; end if;
    if p_terminal_kind='capability_revocation' then
      return v_terminal=grant_row.id and exists(select 1 from private.attempt_capability_revocations r
        where r.capability_id=grant_row.id);
    elsif p_terminal_kind='capability_expired' then
      return v_terminal=grant_row.id and grant_row.expires_at<=clock_timestamp();
    end if;
    select * into ae from public.audit_events where id=v_terminal;
    if ae.event_type='submission.created' then
      return exists(select 1 from public.cleaning_submissions s where s.id=ae.entity_id
        and s.cleaning_attempt_id=grant_row.attempt_id);
    end if;
  elsif c.resolver_kind='submission_terminal' and p_terminal_kind='audit_event' then
    select * into ae from public.audit_events where id=v_terminal;
    select * into source_submission from public.cleaning_submissions where id=v_source;
    if ae.event_type in ('inspection.approved','inspection.rejected') then
      return exists(select 1 from public.inspection_decisions d where d.id=ae.entity_id and d.submission_id=v_source);
    elsif ae.event_type='submission.created' then
      return source_submission.status='superseded' and exists(select 1 from public.cleaning_submissions s
        where s.id=ae.entity_id and s.cleaning_attempt_id=source_submission.cleaning_attempt_id);
    end if;
  elsif c.resolver_kind='reclean_submission' and p_terminal_kind='audit_event' then
    select * into ae from public.audit_events where id=v_terminal;
    return ae.event_type='submission.created' and exists(select 1 from public.cleaning_submissions s
      join public.cleaning_attempts x on x.id=s.cleaning_attempt_id
      join public.cleaning_targets target_row on target_row.id=x.cleaning_target_id
      where s.id=ae.entity_id and target_row.reclean_of_inspection_decision_id=v_source);
  elsif c.resolver_kind='rework_submission' and p_terminal_kind='audit_event' then
    select * into ae from public.audit_events where id=v_terminal;
    select * into comp from public.complaint_compensation_decisions where id=v_source;
    return ae.event_type='submission.created' and exists(select 1 from public.cleaning_submissions s
      join public.cleaning_attempts x on x.id=s.cleaning_attempt_id
      join public.cleaning_targets target_row on target_row.id=x.cleaning_target_id
      where s.id=ae.entity_id and target_row.complaint_compensation_decision_id=comp.id);
  end if;
  return false;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;
revoke all on function private.notification_resolution_is_valid(text,text,text,text,text)
from public,anon,authenticated,service_role;

create function private.resolve_notifications_v1(
  p_event_family text,p_source_kind text,p_source_id text,p_resolved_at timestamptz
) returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer; v_previous text:=current_setting('app.notification_write_mode',true); v_resolver text;
begin
  if p_resolved_at is null or not isfinite(p_resolved_at) then
    raise exception using errcode='22023',message='NOTIFICATION_RESOLUTION_TIME_INVALID';
  end if;
  select resolver_kind into v_resolver from private.notification_event_catalog where event_family=p_event_family;
  if v_resolver='none' then return 0; end if;
  if v_resolver is null or not private.notification_resolution_is_valid(p_event_family,p_source_kind,p_source_id,
      current_setting('app.notification_terminal_kind',true),current_setting('app.notification_terminal_id',true)) then
    raise exception using errcode='23514',message='NOTIFICATION_RESOLVER_CONTRACT_VIOLATION';
  end if;
  perform set_config('app.notification_write_mode','resolve_typed_v1',true);
  begin
    update public.notifications set resolved_at=greatest(p_resolved_at,occurred_at)
    where contract_version=1 and event_family=p_event_family and source_entity_kind=p_source_kind
      and source_entity_id=p_source_id and resolved_at is null;
    get diagnostics v_count=row_count;
  exception when others then
    perform set_config('app.notification_write_mode',coalesce(v_previous,''),true); raise;
  end;
  perform set_config('app.notification_write_mode',coalesce(v_previous,''),true);
  return v_count;
end $$;
revoke all on function private.resolve_notifications_v1(text,text,text,timestamptz)
from public,anon,authenticated,service_role;

create or replace function private.guard_notification_ledger()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception using errcode='55000',message='NOTIFICATION_DELETE_FORBIDDEN'; end if;
  if new.id is distinct from old.id or new.recipient_profile_id is distinct from old.recipient_profile_id
    or new.category is distinct from old.category or new.title is distinct from old.title
    or new.body is distinct from old.body or new.room_id is distinct from old.room_id
    or new.cleaning_target_id is distinct from old.cleaning_target_id
    or new.dedupe_key is distinct from old.dedupe_key or new.group_key is distinct from old.group_key
    or new.requires_action is distinct from old.requires_action or new.occurred_at is distinct from old.occurred_at
    or new.created_at is distinct from old.created_at or new.contract_version is distinct from old.contract_version
    or new.actor_profile_id is distinct from old.actor_profile_id or new.event_family is distinct from old.event_family
    or new.source_entity_kind is distinct from old.source_entity_kind
    or new.source_entity_id is distinct from old.source_entity_id
    or new.deep_link_kind is distinct from old.deep_link_kind
    or new.deep_link_entity_id is distinct from old.deep_link_entity_id
    or new.notification_group_id is distinct from old.notification_group_id then
    raise exception using errcode='55000',message='NOTIFICATION_CONTENT_IMMUTABLE';
  end if;
  if old.read_at is not null and new.read_at is distinct from old.read_at then
    raise exception using errcode='55000',message='NOTIFICATION_READ_AT_IMMUTABLE';
  end if;
  if old.read_at is null and new.read_at is not null then
    if current_user<>'postgres' or coalesce(current_setting('app.notification_write_mode',true),'')<>'mark_read' then
      raise exception using errcode='42501',message='NOTIFICATION_MARK_READ_COMMAND_REQUIRED';
    end if;
    new.read_at:=clock_timestamp();
  end if;
  if old.resolved_at is not null and new.resolved_at is distinct from old.resolved_at then
    raise exception using errcode='55000',message='NOTIFICATION_RESOLVED_AT_IMMUTABLE';
  end if;
  if old.resolved_at is null and new.resolved_at is not null then
    if old.contract_version=1 then
      if current_user='postgres' and coalesce(current_setting('app.notification_write_mode',true),'')<>'resolve_typed_v1' then
        -- Compatibility shield: pre-#109 broad domain UPDATE statements cannot
        -- resolve typed rows. The audit dispatcher applies the exact resolver.
        return old;
      elsif current_user<>'postgres' or coalesce(current_setting('app.notification_write_mode',true),'')<>'resolve_typed_v1' then
        raise exception using errcode='42501',message='NOTIFICATION_DOMAIN_RESOLUTION_REQUIRED';
      end if;
      if new.resolved_at<old.occurred_at then
        raise exception using errcode='22023',message='NOTIFICATION_RESOLUTION_TIME_INVALID';
      end if;
    elsif current_user<>'postgres' then
      raise exception using errcode='42501',message='NOTIFICATION_DOMAIN_RESOLUTION_REQUIRED';
    end if;
  end if;
  return new;
end $$;

create or replace function private.notification_public_projection(p_notice public.notifications)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id',p_notice.id,'category',p_notice.category,'title',p_notice.title,'body',p_notice.body,
    'roomId',p_notice.room_id,'cleaningTargetId',p_notice.cleaning_target_id,
    'deepLink',case when p_notice.contract_version=1 then jsonb_build_object(
      'kind',p_notice.deep_link_kind,'entityId',p_notice.deep_link_entity_id) else null end,
    'groupId',p_notice.notification_group_id,'requiresAction',p_notice.requires_action,
    'readAt',p_notice.read_at,'resolvedAt',p_notice.resolved_at,'occurredAt',p_notice.occurred_at)
$$;

create index attempt_capability_grants_expiry_notification_idx
  on private.attempt_capability_grants(expires_at,id);

create function public.resolve_expired_notification_capabilities(
  p_actor_profile_id uuid,p_session_id uuid,p_limit integer default 100
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; item record; v_count integer:=0; v_now timestamptz:=clock_timestamp();
  previous_terminal_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_terminal_id text:=current_setting('app.notification_terminal_id',true);
begin
  v_actor:=private.assert_notification_actor(p_actor_profile_id,p_session_id);
  if v_actor.role<>'admin' then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 then
    raise exception using errcode='22023',message='NOTIFICATION_EXPIRY_LIMIT_INVALID';
  end if;
  for item in
    select distinct n.event_family,n.source_entity_kind,n.source_entity_id,g.id
    from private.attempt_capability_grants g
    join public.notifications n on n.contract_version=1 and n.resolved_at is null
      and n.source_entity_kind='attempt_capability_grant' and n.source_entity_id=g.id::text
    where g.expires_at<=v_now
    order by g.id limit p_limit
  loop
    perform set_config('app.notification_terminal_kind','capability_expired',true);
    perform set_config('app.notification_terminal_id',item.id::text,true);
    v_count:=v_count+private.resolve_notifications_v1(
      item.event_family,item.source_entity_kind,item.source_entity_id,v_now);
  end loop;
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  return jsonb_build_object('resolvedCount',v_count,'resolvedAt',v_now,'limit',p_limit);
end $$;
revoke all on function public.resolve_expired_notification_capabilities(uuid,uuid,integer)
from public,anon,authenticated,service_role;
grant execute on function public.resolve_expired_notification_capabilities(uuid,uuid,integer) to service_role;

create function private.resolve_revoked_notification_capability()
returns trigger language plpgsql security definer set search_path='' as $$
declare item record;
  previous_terminal_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_terminal_id text:=current_setting('app.notification_terminal_id',true);
begin
  perform set_config('app.notification_terminal_kind','capability_revocation',true);
  perform set_config('app.notification_terminal_id',new.capability_id::text,true);
  for item in select event_family from public.notifications
    where contract_version=1 and source_entity_kind='attempt_capability_grant'
      and source_entity_id=new.capability_id::text and resolved_at is null
  loop perform private.resolve_notifications_v1(item.event_family,'attempt_capability_grant',new.capability_id::text,new.revoked_at); end loop;
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  return null;
end $$;
revoke all on function private.resolve_revoked_notification_capability() from public,anon,authenticated,service_role;
create trigger attempt_capability_notification_resolve after insert on private.attempt_capability_revocations
for each row execute function private.resolve_revoked_notification_capability();

create function private.dispatch_notification_from_audit()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  xact xid:=pg_current_xact_id()::text::xid;
  a public.cleaning_assignments; old_a public.cleaning_assignments;
  t public.cleaning_targets; attempt public.cleaning_attempts; s public.cleaning_submissions;
  d public.inspection_decisions; cc public.complaint_cases; ce public.complaint_case_events;
  cd public.complaint_decisions; cr public.complaint_maid_responses;
  cap private.attempt_capability_grants; adj public.payroll_adjustments;
  cyc public.payroll_cycles; pa public.payroll_payment_attempts; pr public.payroll_payment_results;
  os public.payroll_offset_settlements; comp public.complaint_compensation_decisions;
  o public.checkout_cleaning_obligations; r public.reservations; item record;
  fam text; title_text text; body_text text; deep_id uuid; reclean_id uuid;
  previous_terminal_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_terminal_id text:=current_setting('app.notification_terminal_id',true);
  previous_source_event_type text:=current_setting('app.notification_source_event_type',true);
  previous_source_reason_code text:=current_setting('app.notification_source_reason_code',true);
begin
  if current_setting('app.notification_writer_mode',true)<>'typed_v1' then return null; end if;
  perform set_config('app.notification_terminal_kind','audit_event',true);
  perform set_config('app.notification_terminal_id',new.id::text,true);
  perform set_config('app.notification_source_event_type',new.event_type,true);
  perform set_config('app.notification_source_reason_code',coalesce(new.reason_code,''),true);

  if new.event_type='assignment.notified' then
    select * into a from public.cleaning_assignments where id=new.entity_id;
    select * into t from public.cleaning_targets where id=a.cleaning_target_id;
    if a.id is not null then perform private.emit_notification_v1('assignment.commit_notified',new.actor_profile_id,
      a.maid_profile_id,'cleaning_assignment',a.id::text,coalesce(t.room_type_snapshot->>'roomNumber','객실')||'호 청소 배정',
      t.effective_service_date::text||' · '||a.sequence_number||'번째 청소가 배정되었습니다.',t.room_id,t.id,t.id,new.recorded_at); end if;

  elsif new.event_type='reservation.changed' then
    select ca.* into old_a from public.cleaning_assignments ca join public.cleaning_targets ct on ct.id=ca.cleaning_target_id
    where ct.reservation_id=new.entity_id and ca.change_reason_code='RESERVATION_EXTENDED' and ca.xmin=xact
    order by ca.ended_at desc limit 1;
    if old_a.id is not null then
      select * into t from public.cleaning_targets where id=old_a.cleaning_target_id;
      perform private.resolve_notifications_v1('assignment.commit_notified','cleaning_assignment',old_a.id::text,new.recorded_at);
      perform private.resolve_notifications_v1('assignment.prestart_new_notified','cleaning_assignment',old_a.id::text,new.recorded_at);
      perform private.resolve_notifications_v1('attempt.handover_next_notified','cleaning_assignment',old_a.id::text,new.recorded_at);
      perform private.resolve_notifications_v1('assignment.prestart_same_maid_changed','cleaning_assignment',old_a.id::text,new.recorded_at);
      perform private.resolve_notifications_v1('reservation.manual_checkout_rescheduled','cleaning_assignment',old_a.id::text,new.recorded_at);
      perform private.emit_notification_v1('reservation.extension_revoked',new.actor_profile_id,old_a.maid_profile_id,
        'cleaning_assignment',old_a.id::text,'청소 배정이 회수되었습니다','예약 퇴실 시간이 연장되어 기존 청소 배정이 회수되었습니다.',
        t.room_id,t.id,t.id,new.recorded_at);
    end if;

  elsif new.event_type='reservation.manual_checkout' then
    select * into r from public.reservations where id=new.entity_id;
    select * into o from public.checkout_cleaning_obligations where reservation_id=r.id;
    select * into old_a from public.cleaning_assignments where cleaning_target_id=o.planned_cleaning_target_id
      and change_reason_code='MANUAL_CHECKOUT_RESCHEDULE' and xmin=xact order by ended_at desc limit 1;
    select * into a from public.cleaning_assignments where cleaning_target_id=o.planned_cleaning_target_id and is_current;
    select * into t from public.cleaning_targets where id=o.planned_cleaning_target_id;
    if old_a.id is not null then
      for item in select event_family,source_entity_kind,source_entity_id from public.notifications
        where contract_version=1 and source_entity_kind='cleaning_assignment' and source_entity_id=old_a.id::text
          and resolved_at is null
      loop perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,new.recorded_at); end loop;
    end if;
    if a.id is not null and a.notified_at is not null then perform private.emit_notification_v1(
      'reservation.manual_checkout_rescheduled',new.actor_profile_id,a.maid_profile_id,'cleaning_assignment',a.id::text,
      '청소 시작 시간이 변경되었습니다','수동 체크아웃 처리로 청소 가능 시간이 변경되었습니다.',
      t.room_id,t.id,t.id,new.recorded_at); end if;

  elsif new.event_type='reservation.cancelled' then
    select ca.* into old_a from public.cleaning_assignments ca join public.cleaning_targets ct on ct.id=ca.cleaning_target_id
    where ct.reservation_id=new.entity_id and ca.change_reason_code='RESERVATION_CANCELLED' and ca.xmin=xact
    order by ca.ended_at desc limit 1;
    if old_a.id is not null and old_a.notified_at is not null then
      select * into t from public.cleaning_targets where id=old_a.cleaning_target_id;
      for item in select event_family,source_entity_kind,source_entity_id from public.notifications
        where contract_version=1 and source_entity_kind='cleaning_assignment' and source_entity_id=old_a.id::text and resolved_at is null
      loop perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,new.recorded_at); end loop;
      perform private.emit_notification_v1('reservation.cancelled_revoked',new.actor_profile_id,old_a.maid_profile_id,
        'cleaning_assignment',old_a.id::text,'청소 배정이 회수되었습니다','예약이 취소되어 기존 청소 배정이 회수되었습니다.',
        t.room_id,t.id,t.id,new.recorded_at);
    end if;

  elsif new.event_type='cleaning.manual_request.cancelled' then
    select * into t from public.cleaning_targets where id=new.entity_id;
    select * into old_a from public.cleaning_assignments where cleaning_target_id=t.id
      and change_reason_code='REQUEST_CANCELLED' and xmin=xact order by ended_at desc limit 1;
    if old_a.id is null then select * into old_a from public.cleaning_assignments where cleaning_target_id=t.id
      and not is_current and notified_at is not null order by ended_at desc limit 1; end if;
    if old_a.id is not null and old_a.notified_at is not null then
      for item in select event_family,source_entity_kind,source_entity_id from public.notifications
        where contract_version=1 and source_entity_kind='cleaning_assignment' and source_entity_id=old_a.id::text and resolved_at is null
      loop perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,new.recorded_at); end loop;
      perform private.emit_notification_v1('cleaning_request.cancelled_revoked',new.actor_profile_id,old_a.maid_profile_id,
        'cleaning_assignment',old_a.id::text,'청소 요청이 취소되었습니다','관리자가 추가 청소 요청을 취소했습니다.',
        t.room_id,t.id,t.id,new.recorded_at);
    end if;

  elsif new.event_type='assignment.prestart_changed' then
    select * into a from public.cleaning_assignments where id=new.entity_id;
    select * into t from public.cleaning_targets where id=a.cleaning_target_id;
    select * into old_a from public.cleaning_assignments where id=nullif(new.after_state->>'previousAssignmentId','')::uuid;
    if a.notified_at is not null then
      if old_a.id is not null then
        for item in select event_family,source_entity_kind,source_entity_id from public.notifications
          where contract_version=1 and source_entity_kind='cleaning_assignment' and source_entity_id=old_a.id::text and resolved_at is null
        loop perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,new.recorded_at); end loop;
      end if;
      if old_a.id is not null and old_a.maid_profile_id<>a.maid_profile_id then
        perform private.emit_notification_v1('assignment.prestart_old_revoked',new.actor_profile_id,old_a.maid_profile_id,
          'cleaning_assignment',old_a.id::text,'청소 배정 변경','기존 청소 배정이 변경되었습니다.',t.room_id,t.id,t.id,new.recorded_at);
        fam:='assignment.prestart_new_notified'; title_text:='청소 배정'; body_text:='새 청소 배정이 등록되었습니다.';
      else fam:='assignment.prestart_same_maid_changed'; title_text:='청소 배정 변경'; body_text:='청소 순서 또는 시간이 변경되었습니다.'; end if;
      perform private.emit_notification_v1(fam,new.actor_profile_id,a.maid_profile_id,'cleaning_assignment',a.id::text,
        title_text,body_text,t.room_id,t.id,t.id,new.recorded_at);
    end if;

  elsif new.event_type='assignment.prestart_unassigned' then
    select * into old_a from public.cleaning_assignments where id=new.entity_id;
    select * into t from public.cleaning_targets where id=old_a.cleaning_target_id;
    for item in select event_family,source_entity_kind,source_entity_id from public.notifications
      where contract_version=1 and source_entity_kind='cleaning_assignment' and source_entity_id=old_a.id::text and resolved_at is null
    loop perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,new.recorded_at); end loop;
    if old_a.notified_at is not null then perform private.emit_notification_v1('assignment.prestart_unassigned',new.actor_profile_id,
      old_a.maid_profile_id,'cleaning_assignment',old_a.id::text,'청소 배정 해제','기존 청소 배정이 해제되었습니다.',
      t.room_id,t.id,t.id,new.recorded_at); end if;

  elsif new.event_type='assignment.cancellation_requested' then
    select * into t from public.cleaning_targets where id=(new.after_state->>'cleaningTargetId')::uuid;
    for item in select id from public.profiles where role='admin' and status='active' order by id loop
      perform private.emit_notification_v1('assignment.cancellation_requested',new.actor_profile_id,item.id,
        'assignment_change_request',new.entity_id::text,'담당 취소 요청','메이드가 담당 취소를 요청했습니다.',
        t.room_id,t.id,new.entity_id,new.recorded_at); end loop;

  elsif new.event_type='assignment.cancellation_decided' then
    select * into item from public.assignment_change_requests where id=new.entity_id;
    select * into t from public.cleaning_targets where id=item.cleaning_target_id;
    perform private.resolve_notifications_v1('assignment.cancellation_requested','assignment_change_request',new.entity_id::text,new.recorded_at);
    fam:=case when item.status='approved' then 'assignment.cancellation_approved' else 'assignment.cancellation_rejected' end;
    perform private.emit_notification_v1(fam,new.actor_profile_id,item.maid_profile_id,'assignment_change_request',new.entity_id::text,
      case when item.status='approved' then '담당 취소 승인' else '담당 취소 반려' end,
      case when item.status='approved' then '담당 취소 요청이 승인되었습니다.' else '담당 취소 요청이 반려되었습니다.' end,
      t.room_id,t.id,new.entity_id,new.recorded_at);

  elsif new.event_type='cleaning.attempt_started' then
    select * into attempt from public.cleaning_attempts where id=new.entity_id;
    for item in select event_family,source_entity_kind,source_entity_id from public.notifications
      where contract_version=1 and source_entity_kind='cleaning_assignment' and source_entity_id=attempt.assignment_id::text and resolved_at is null
    loop perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,new.recorded_at); end loop;

  elsif new.event_type='assignment.rolled_over' then
    select * into t from public.cleaning_targets where id=new.entity_id;
    select * into old_a from public.cleaning_assignments where id=nullif(new.after_state->>'assignmentId','')::uuid;
    if old_a.id is not null then
      for item in select event_family,source_entity_kind,source_entity_id from public.notifications
        where contract_version=1 and source_entity_kind='cleaning_assignment' and source_entity_id=old_a.id::text and resolved_at is null
      loop perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,new.recorded_at); end loop;
      perform private.emit_notification_v1('assignment.scheduled_rolled_over',new.actor_profile_id,old_a.maid_profile_id,
        'cleaning_assignment',old_a.id::text,'미착수 청소 배정이 이월되었습니다',
        '미착수 청소 배정이 다음 업무일의 재배정 대상으로 변경되었습니다.',t.room_id,t.id,t.id,new.recorded_at);
    end if;

  elsif new.event_type in ('cleaning.finish_current_allowed','cleaning.upload_only_allowed','cleaning.field_completed') then
    select * into attempt from public.cleaning_attempts where id=new.entity_id;
    select * into t from public.cleaning_targets where id=attempt.cleaning_target_id;
    if new.after_state ? 'capabilityKind' and new.after_state ? 'expiresAt' then
      select * into cap from private.attempt_capability_grants
      where attempt_id=attempt.id and kind=new.after_state->>'capabilityKind'
        and granted_by=new.actor_profile_id
        and expires_at=(new.after_state->>'expiresAt')::timestamptz
      order by issued_at desc,id desc limit 1;
    elsif new.event_type='cleaning.field_completed' and new.reason_code='OFFLINE_CORRECTION_APPROVED' then
      select * into cap from private.attempt_capability_grants
      where attempt_id=attempt.id and kind='upload_submit' and granted_by=new.actor_profile_id
        and issued_at=new.recorded_at
      order by id desc limit 1;
    end if;
    if cap.id is not null then
      fam:=case when cap.kind='finish_current' then 'capability.finish_current_issued'
        when new.event_type='cleaning.field_completed' and cap.actor_profile_id=new.actor_profile_id then 'capability.upload_submit_self_issued'
        when new.event_type='cleaning.field_completed' then 'capability.upload_submit_offline_resolution_issued'
        else 'capability.upload_submit_admin_issued' end;
      perform private.emit_notification_v1(fam,new.actor_profile_id,cap.actor_profile_id,'attempt_capability_grant',cap.id::text,
        '업무 권한 변경 안내','기존 업무의 제한된 수행 또는 증빙 권한이 변경되었습니다. 앱에서 만료 시각을 확인해 주세요.',
        t.room_id,t.id,t.id,new.recorded_at);
    end if;

  elsif new.event_type='cleaning.interrupted_handover' then
    select * into attempt from public.cleaning_attempts where id=new.entity_id;
    select * into t from public.cleaning_targets where id=attempt.cleaning_target_id;
    select * into cap from private.attempt_capability_grants
    where attempt_id=attempt.id and kind='evidence_upload' and granted_by=new.actor_profile_id
      and issued_at=new.effective_at and expires_at=(new.after_state->>'expiresAt')::timestamptz
    limit 1;
    if cap.id is not null then perform private.emit_notification_v1('capability.evidence_upload_handover_issued',new.actor_profile_id,
      cap.actor_profile_id,'attempt_capability_grant',cap.id::text,'업무 권한 변경 안내','기존 업무의 증빙 권한이 변경되었습니다.',
      t.room_id,t.id,t.id,new.recorded_at); end if;
    select * into old_a from public.cleaning_assignments where id=attempt.assignment_id;
    select * into a from public.cleaning_assignments where cleaning_target_id=t.id and is_current;
    for item in select event_family,source_entity_kind,source_entity_id from public.notifications
      where contract_version=1 and source_entity_kind='cleaning_assignment' and source_entity_id=old_a.id::text and resolved_at is null
    loop perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,new.recorded_at); end loop;
    perform private.emit_notification_v1('attempt.handover_previous_revoked',new.actor_profile_id,old_a.maid_profile_id,
      'cleaning_assignment',old_a.id::text,'청소 배정 변경','진행 중 업무가 새 담당자에게 인계되었습니다.',t.room_id,t.id,t.id,new.recorded_at);
    perform private.emit_notification_v1('attempt.handover_next_notified',new.actor_profile_id,a.maid_profile_id,
      'cleaning_assignment',a.id::text,'청소 배정','인계된 청소 업무가 배정되었습니다.',t.room_id,t.id,t.id,new.recorded_at);

  elsif new.event_type='submission.created' then
    select * into s from public.cleaning_submissions where id=new.entity_id;
    select * into attempt from public.cleaning_attempts where id=s.cleaning_attempt_id;
    select * into t from public.cleaning_targets where id=attempt.cleaning_target_id;
    for item in select id from public.cleaning_submissions where cleaning_attempt_id=attempt.id and status='superseded' and xmin=xact
    loop
      perform private.resolve_notifications_v1('submission.initial_requested','cleaning_submission',item.id::text,new.recorded_at);
      perform private.resolve_notifications_v1('submission.reinspection_requested','cleaning_submission',item.id::text,new.recorded_at);
    end loop;
    for item in select event_family,source_entity_kind,source_entity_id from public.notifications
      where contract_version=1 and resolved_at is null and (
        (source_entity_kind='cleaning_assignment' and source_entity_id=attempt.assignment_id::text)
        or (source_entity_kind='attempt_capability_grant' and source_entity_id in (
          select id::text from private.attempt_capability_grants where attempt_id=attempt.id and kind='upload_submit'))
        or (t.reclean_of_inspection_decision_id is not null and source_entity_kind='inspection_decision'
          and source_entity_id=t.reclean_of_inspection_decision_id::text)
        or (t.complaint_compensation_decision_id is not null and source_entity_kind='complaint_compensation_decision'
          and source_entity_id=t.complaint_compensation_decision_id::text))
    loop perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,new.recorded_at); end loop;
    fam:=case when t.source in ('inspection_reclean','post_approval_complaint_reclean')
      then 'submission.reinspection_requested' else 'submission.initial_requested' end;
    for item in select id from public.profiles where role='admin' and status='active' order by id loop
      perform private.emit_notification_v1(fam,new.actor_profile_id,item.id,'cleaning_submission',s.id::text,
        case when fam='submission.initial_requested' then '청소 검수 요청' else '청소 재검수 요청' end,
        case when fam='submission.initial_requested' then '새 청소 제출을 검수해 주세요.' else '재청소 제출을 검수해 주세요.' end,
        t.room_id,t.id,s.id,new.recorded_at); end loop;

  elsif new.event_type in ('inspection.approved','inspection.rejected') then
    select * into d from public.inspection_decisions where id=new.entity_id;
    select * into s from public.cleaning_submissions where id=d.submission_id;
    select * into attempt from public.cleaning_attempts where id=s.cleaning_attempt_id;
    select * into t from public.cleaning_targets where id=attempt.cleaning_target_id;
    perform private.resolve_notifications_v1('submission.initial_requested','cleaning_submission',s.id::text,new.recorded_at);
    perform private.resolve_notifications_v1('submission.reinspection_requested','cleaning_submission',s.id::text,new.recorded_at);
    if d.decision='approved' then
      fam:=case when t.source='post_approval_complaint_reclean' then 'inspection.complaint_rework_approved'
        when t.source='inspection_reclean' then 'inspection.reclean_approved' else 'inspection.original_approved' end;
      deep_id:=s.id;
    elsif t.source='post_approval_complaint_reclean' then fam:='inspection.complaint_rework_rejected';deep_id:=s.id;
    else fam:='inspection.original_rejected_reclean_created';deep_id:=nullif(new.after_state->>'recleanTargetId','')::uuid; end if;
    perform private.emit_notification_v1(fam,new.actor_profile_id,attempt.maid_profile_id,'inspection_decision',d.id::text,
      case when d.decision='approved' then '청소 검수 승인' else '청소 검수 반려' end,
      case when d.decision='approved' then '제출한 청소가 승인되었습니다.'
        when t.source='post_approval_complaint_reclean' then '컴플레인 재작업 제출이 반려되었습니다.'
        else '제출한 청소가 반려되어 재청소가 필요합니다.' end,
      t.room_id,case when deep_id=s.id then t.id else deep_id end,deep_id,new.recorded_at);

  elsif new.event_type in ('complaint.received','complaint.decided','complaint.corrected','complaint.acknowledged','complaint.appealed','complaint.closed') then
    select * into cc from public.complaint_cases where id=new.entity_id;
    select * into ce from public.complaint_case_events where complaint_case_id=cc.id
      and event_type=split_part(new.event_type,'.',2) and actor_profile_id=new.actor_profile_id
      and occurred_at=new.effective_at order by id desc limit 1;
    fam:=new.event_type;
    if fam in ('complaint.acknowledged','complaint.appealed') then
      select * into cd from public.complaint_decisions where id=ce.decision_id;
      deep_id:=cd.decided_by;
    else deep_id:=cc.maid_profile_id; end if;
    if fam in ('complaint.acknowledged','complaint.appealed','complaint.closed') then
      for item in select event_family,source_entity_kind,source_entity_id from public.notifications
        where contract_version=1 and deep_link_kind='complaintCase' and deep_link_entity_id=cc.id and resolved_at is null
          and event_family='complaint.decided'
      loop perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,new.recorded_at); end loop;
    end if;
    if fam in ('complaint.corrected','complaint.closed') then
      for item in select event_family,source_entity_kind,source_entity_id from public.notifications
        where contract_version=1 and deep_link_kind='complaintCase' and deep_link_entity_id=cc.id and resolved_at is null
          and event_family='complaint.appealed'
      loop perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,new.recorded_at); end loop;
    end if;
    title_text:=case fam when 'complaint.received' then '컴플레인 접수' when 'complaint.decided' then '컴플레인 판정'
      when 'complaint.corrected' then '컴플레인 판정 정정' when 'complaint.acknowledged' then '컴플레인 확인 완료'
      when 'complaint.appealed' then '컴플레인 이의 제기' else '컴플레인 종결' end;
    body_text:=case fam when 'complaint.received' then '승인된 청소에 컴플레인이 접수되었습니다.'
      when 'complaint.decided' then '컴플레인 판정이 등록되었습니다.' when 'complaint.corrected' then '컴플레인 판정이 정정되었습니다.'
      when 'complaint.acknowledged' then '담당 메이드가 판정을 확인했습니다.' when 'complaint.appealed' then '담당 메이드가 판정에 이의를 제기했습니다.'
      else '컴플레인 처리가 종결되었습니다.' end;
    perform private.emit_notification_v1(fam,new.actor_profile_id,deep_id,'complaint_case_event',ce.id::text,
      title_text,body_text,cc.room_id,cc.cleaning_target_id,cc.id,new.recorded_at);

  elsif new.event_type='complaint.rework_materialized' then
    select * into comp from public.complaint_compensation_decisions where id=new.entity_id;
    select * into cc from public.complaint_cases where id=comp.complaint_case_id;
    select * into t from public.cleaning_targets where complaint_compensation_decision_id=comp.id;
    select * into a from public.cleaning_assignments where cleaning_target_id=t.id and is_current;
    perform private.emit_notification_v1('complaint.rework_assigned',new.actor_profile_id,a.maid_profile_id,
      'complaint_compensation_decision',comp.id::text,'컴플레인 재작업 배정','승인 후 컴플레인 재작업이 배정되었습니다.',
      t.room_id,t.id,t.id,new.recorded_at);

  elsif new.event_type in ('payroll.adjustment_recorded','payroll.adjustment_reversed','payroll.late_earning_carried') then
    select * into adj from public.payroll_adjustments where id=new.entity_id;
    title_text:=case new.event_type when 'payroll.adjustment_recorded' then '주급 정정 반영'
      when 'payroll.adjustment_reversed' then '주급 원장 반전' else '늦은 수익 이월' end;
    body_text:=case new.event_type when 'payroll.adjustment_recorded' then '주급 정정 항목이 원장에 반영되었습니다.'
      when 'payroll.adjustment_reversed' then '주급 원장 항목이 전액 반전되었습니다.' else '늦게 확정된 수익이 다음 주차에 반영되었습니다.' end;
    perform private.emit_notification_v1(new.event_type,new.actor_profile_id,adj.maid_profile_id,'payroll_adjustment',adj.id::text,
      title_text,body_text,null,null,adj.maid_profile_id,new.recorded_at);

  elsif new.event_type='payroll.payment_started' then
    select * into cyc from public.payroll_cycles where id=new.entity_id;
    select * into pa from public.payroll_payment_attempts where payroll_cycle_id=cyc.id
      and attempt_number=(new.after_state->>'paymentAttemptNumber')::integer;
    perform private.emit_notification_v1('payroll.payment_started',new.actor_profile_id,cyc.maid_profile_id,
      'payroll_payment_attempt',pa.id::text,'주급 지급 처리 시작','종료된 주차의 주급 지급 처리가 시작되었습니다.',
      null,null,cyc.id,new.recorded_at);

  elsif new.event_type='payroll.offset_settled' then
    select * into os from public.payroll_offset_settlements where id=new.entity_id;
    select * into cyc from public.payroll_cycles where id=os.payroll_cycle_id;
    perform private.emit_notification_v1('payroll.offset_settled',new.actor_profile_id,cyc.maid_profile_id,
      'payroll_offset_settlement',os.id::text,'주급 상계 이월','0원 이하 주급이 다음 주차 상계로 이월되었습니다.',
      null,null,cyc.id,new.recorded_at);

  elsif new.event_type in ('payroll.payment_check_recorded','payroll.payment_paid','payroll.payment_reopened') then
    select * into pa from public.payroll_payment_attempts where id=new.entity_id;
    select * into cyc from public.payroll_cycles where id=pa.payroll_cycle_id;
    select * into pr from public.payroll_payment_results where payment_attempt_id=pa.id
      and result_type=case new.event_type when 'payroll.payment_check_recorded' then 'check'
        when 'payroll.payment_paid' then 'paid' else 'reopened' end
      and actor_profile_id=new.actor_profile_id and occurred_at=new.effective_at
      order by recorded_at desc,id desc limit 1;
    fam:=new.event_type;
    title_text:=case fam when 'payroll.payment_check_recorded' then '주급 지급 결과 확인 중'
      when 'payroll.payment_paid' then '주급 지급 완료' else '주급 지급 재확인' end;
    body_text:=case fam when 'payroll.payment_check_recorded' then '외부 송금 결과를 확인하고 있습니다.'
      when 'payroll.payment_paid' then '외부 송금 완료가 확인되었습니다.' else '외부 송금 없음이 확인되어 지급 처리가 다시 열렸습니다.' end;
    perform private.emit_notification_v1(fam,new.actor_profile_id,cyc.maid_profile_id,'payroll_payment_result',pr.id::text,
      title_text,body_text,null,null,cyc.id,new.recorded_at);
  end if;
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  perform set_config('app.notification_source_event_type',coalesce(previous_source_event_type,''),true);
  perform set_config('app.notification_source_reason_code',coalesce(previous_source_reason_code,''),true);
  return null;
exception when others then
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  perform set_config('app.notification_source_event_type',coalesce(previous_source_event_type,''),true);
  perform set_config('app.notification_source_reason_code',coalesce(previous_source_reason_code,''),true);
  raise;
end $$;
revoke all on function private.dispatch_notification_from_audit() from public,anon,authenticated,service_role;
create trigger audit_notification_catalog_dispatch after insert on public.audit_events
for each row execute function private.dispatch_notification_from_audit();

-- The offline-resolution ledger predates command_executions. Keep its native
-- idempotency contract, but wrap the only public entry point in the same typed
-- writer capability and coverage barrier used by current command writers.
create function private.resolve_offline_quarantine_with_notifications_at(
  p_actor_profile_id uuid,p_session_id uuid,p_quarantine_id uuid,p_resolution text,p_expected_execution_version bigint,
  p_reason_code text,p_idempotency_key text,p_request_hash text,p_command_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  result jsonb;
  previous_mode text:=current_setting('app.notification_writer_mode',true);
  previous_terminal_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_terminal_id text:=current_setting('app.notification_terminal_id',true);
  previous_source_event_type text:=current_setting('app.notification_source_event_type',true);
  previous_source_reason_code text:=current_setting('app.notification_source_reason_code',true);
  previous_suppressed text:=current_setting('app.notification_legacy_suppressed_count',true);
  previous_emitted text:=current_setting('app.notification_typed_emit_count',true);
begin
  perform set_config('app.notification_writer_mode','typed_v1',true);
  perform set_config('app.notification_terminal_kind','',true);
  perform set_config('app.notification_terminal_id','',true);
  perform set_config('app.notification_source_event_type','',true);
  perform set_config('app.notification_source_reason_code','',true);
  perform set_config('app.notification_legacy_suppressed_count','0',true);
  perform set_config('app.notification_typed_emit_count','0',true);
  result:=private.resolve_offline_quarantine_at(p_actor_profile_id,p_session_id,p_quarantine_id,p_resolution,
    p_expected_execution_version,p_reason_code,p_idempotency_key,p_request_hash,p_command_at);
  if coalesce(nullif(current_setting('app.notification_legacy_suppressed_count',true),''),'0')::integer>0
    and coalesce(nullif(current_setting('app.notification_typed_emit_count',true),''),'0')::integer
      <coalesce(nullif(current_setting('app.notification_legacy_suppressed_count',true),''),'0')::integer then
    raise exception using errcode='23514',message='NOTIFICATION_TYPED_WRITER_COVERAGE_GAP';
  end if;
  perform set_config('app.notification_writer_mode',coalesce(previous_mode,''),true);
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  perform set_config('app.notification_source_event_type',coalesce(previous_source_event_type,''),true);
  perform set_config('app.notification_source_reason_code',coalesce(previous_source_reason_code,''),true);
  perform set_config('app.notification_legacy_suppressed_count',coalesce(previous_suppressed,'0'),true);
  perform set_config('app.notification_typed_emit_count',coalesce(previous_emitted,'0'),true);
  return result;
exception when others then
  perform set_config('app.notification_writer_mode',coalesce(previous_mode,''),true);
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  perform set_config('app.notification_source_event_type',coalesce(previous_source_event_type,''),true);
  perform set_config('app.notification_source_reason_code',coalesce(previous_source_reason_code,''),true);
  perform set_config('app.notification_legacy_suppressed_count',coalesce(previous_suppressed,'0'),true);
  perform set_config('app.notification_typed_emit_count',coalesce(previous_emitted,'0'),true);
  raise;
end $$;
revoke all on function private.resolve_offline_quarantine_with_notifications_at(
  uuid,uuid,uuid,text,bigint,text,text,text,timestamptz
) from public,anon,authenticated,service_role;

create or replace function public.resolve_offline_event_quarantine(
  p_actor_profile_id uuid,p_session_id uuid,p_quarantine_id uuid,p_resolution text,p_expected_execution_version bigint,
  p_reason_code text,p_idempotency_key text,p_request_hash text
) returns jsonb language sql security definer set search_path='' as $$
  select private.resolve_offline_quarantine_with_notifications_at(p_actor_profile_id,p_session_id,p_quarantine_id,p_resolution,
    p_expected_execution_version,p_reason_code,p_idempotency_key,p_request_hash,null);
$$;
revoke all on function public.resolve_offline_event_quarantine(uuid,uuid,uuid,text,bigint,text,text,text)
from public,anon,authenticated;
grant execute on function public.resolve_offline_event_quarantine(uuid,uuid,uuid,text,bigint,text,text,text) to service_role;
