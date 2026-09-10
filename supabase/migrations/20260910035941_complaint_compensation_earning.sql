-- Issue #101: post-approval complaint rework and typed compensation earnings.
-- Existing original-cleaning earning identities remain unchanged.

alter table public.cleaning_targets
  drop constraint cleaning_targets_source_check,
  add constraint cleaning_targets_source_check check (source in (
    'scheduled_checkout','manual_checkout','stayover_request','manual_room_request',
    'inspection_reclean','post_approval_complaint_reclean'
  )),
  add column complaint_compensation_decision_id uuid;

create table public.complaint_compensation_decisions (
  id uuid primary key default gen_random_uuid(),
  complaint_case_id uuid not null unique
    references public.complaint_cases(id) on delete restrict,
  complaint_decision_id uuid not null unique
    references public.complaint_decisions(id) on delete restrict,
  original_cleaning_target_id uuid not null
    references public.cleaning_targets(id) on delete restrict,
  rework_cleaning_target_id uuid not null unique,
  original_maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  assignee_maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  original_base_fee_snapshot integer not null check (original_base_fee_snapshot >= 0),
  compensation_amount integer not null check (compensation_amount >= 0),
  currency text not null default 'KRW' check (currency='KRW'),
  source_case_version bigint not null check (source_case_version > 0),
  decision_version integer not null default 1 check (decision_version=1),
  decided_by uuid not null references public.profiles(id) on delete restrict,
  decided_at timestamptz not null,
  check (compensation_amount <= original_base_fee_snapshot),
  check (assignee_maid_profile_id<>original_maid_profile_id or compensation_amount=0),
  unique (id,complaint_case_id,complaint_decision_id,original_cleaning_target_id,
    rework_cleaning_target_id,assignee_maid_profile_id,compensation_amount,currency)
);

alter table public.cleaning_targets
  add constraint cleaning_targets_complaint_compensation_fk
  foreign key (complaint_compensation_decision_id)
  references public.complaint_compensation_decisions(id) on delete restrict
  deferrable initially deferred,
  add constraint cleaning_targets_complaint_rework_provenance_check check (
    (source='post_approval_complaint_reclean' and complaint_compensation_decision_id is not null
      and cleaning_kind='reclean' and reservation_id is null and checkout_obligation_id is null
      and reclean_of_attempt_id is null and reclean_maid_profile_id is null
      and reclean_of_submission_id is null and reclean_of_inspection_decision_id is null)
    or (source<>'post_approval_complaint_reclean' and complaint_compensation_decision_id is null)
  ),
  add constraint cleaning_targets_id_complaint_compensation_unique
    unique (id,complaint_compensation_decision_id);

alter table public.complaint_compensation_decisions
  add constraint complaint_compensation_rework_target_fk
  foreign key (rework_cleaning_target_id,id)
  references public.cleaning_targets(id,complaint_compensation_decision_id)
  on delete restrict deferrable initially deferred;

alter table public.complaint_cases
  add column current_compensation_decision_id uuid,
  add constraint complaint_cases_current_compensation_decision_fk
    foreign key (current_compensation_decision_id)
    references public.complaint_compensation_decisions(id) on delete restrict;

create table public.compensation_entitlements (
  id uuid primary key default gen_random_uuid(),
  compensation_decision_id uuid not null unique,
  complaint_case_id uuid not null references public.complaint_cases(id) on delete restrict,
  complaint_decision_id uuid not null references public.complaint_decisions(id) on delete restrict,
  original_cleaning_target_id uuid not null references public.cleaning_targets(id) on delete restrict,
  rework_cleaning_target_id uuid not null unique references public.cleaning_targets(id) on delete restrict,
  maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  cleaning_attempt_id uuid not null unique references public.cleaning_attempts(id) on delete restrict,
  submission_id uuid not null unique references public.cleaning_submissions(id) on delete restrict,
  inspection_decision_id uuid not null unique references public.inspection_decisions(id) on delete restrict,
  amount integer not null check (amount >= 0),
  currency text not null default 'KRW' check (currency='KRW'),
  entitled_at timestamptz not null,
  foreign key (compensation_decision_id,complaint_case_id,complaint_decision_id,
    original_cleaning_target_id,rework_cleaning_target_id,maid_profile_id,amount,currency)
  references public.complaint_compensation_decisions(id,complaint_case_id,complaint_decision_id,
    original_cleaning_target_id,rework_cleaning_target_id,assignee_maid_profile_id,compensation_amount,currency)
  on delete restrict,
  unique (id,submission_id,maid_profile_id,amount)
);

alter table public.earnings
  alter column earning_entitlement_id drop not null,
  add column compensation_entitlement_id uuid,
  add constraint earnings_compensation_entitlement_fk
    foreign key (compensation_entitlement_id,submission_id,maid_profile_id,base_amount)
    references public.compensation_entitlements(id,submission_id,maid_profile_id,amount)
    on delete restrict not valid,
  add constraint earnings_typed_entitlement_exactly_one_check check (
    ((earning_entitlement_id is not null)::integer
      +(compensation_entitlement_id is not null)::integer)=1
  ) not valid;

alter table public.earnings validate constraint earnings_compensation_entitlement_fk;
alter table public.earnings validate constraint earnings_typed_entitlement_exactly_one_check;
create unique index earnings_compensation_entitlement_unique
  on public.earnings(compensation_entitlement_id)
  where compensation_entitlement_id is not null;

create index complaint_compensation_decisions_case_idx
  on public.complaint_compensation_decisions(complaint_case_id,decided_at desc);
create index complaint_compensation_decisions_assignee_idx
  on public.complaint_compensation_decisions(assignee_maid_profile_id,decided_at desc);
create index compensation_entitlements_maid_date_idx
  on public.compensation_entitlements(maid_profile_id,entitled_at desc);
create index cleaning_targets_complaint_compensation_idx
  on public.cleaning_targets(complaint_compensation_decision_id)
  where complaint_compensation_decision_id is not null;

create function private.prevent_complaint_compensation_mutation()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception using errcode='55000',message='COMPLAINT_COMPENSATION_IMMUTABLE';
end $$;
revoke all on function private.prevent_complaint_compensation_mutation()
from public,anon,authenticated,service_role;
create trigger complaint_compensation_decisions_append_only
before update or delete on public.complaint_compensation_decisions
for each row execute function private.prevent_complaint_compensation_mutation();
create trigger compensation_entitlements_append_only
before update or delete on public.compensation_entitlements
for each row execute function private.prevent_complaint_compensation_mutation();

create function private.validate_complaint_compensation_link()
returns trigger language plpgsql set search_path='' as $$
declare v_decision public.complaint_compensation_decisions;
  v_target public.cleaning_targets; v_case public.complaint_cases; v_source public.complaint_decisions;
begin
  if tg_table_name='cleaning_targets' then
    if new.source<>'post_approval_complaint_reclean' then return null; end if;
    select * into v_decision from public.complaint_compensation_decisions
      where id=new.complaint_compensation_decision_id;
    v_target:=new;
  else
    v_decision:=new;
    select * into v_target from public.cleaning_targets where id=new.rework_cleaning_target_id;
  end if;
  select * into v_case from public.complaint_cases where id=v_decision.complaint_case_id;
  select * into v_source from public.complaint_decisions where id=v_decision.complaint_decision_id;
  if v_decision.id is null or v_target.id is null
    or v_target.source<>'post_approval_complaint_reclean'
    or v_target.complaint_compensation_decision_id is distinct from v_decision.id
    or v_decision.rework_cleaning_target_id is distinct from v_target.id
    or v_case.id is null or v_case.cleaning_target_id is distinct from v_decision.original_cleaning_target_id
    or v_source.id is null or v_source.complaint_case_id is distinct from v_case.id
    or v_source.finding<>'confirmed' or not v_source.rework_required
    or v_target.room_id is distinct from v_case.room_id
    or v_target.fee_snapshot<>0 then
    raise exception using errcode='23514',message='COMPLAINT_REWORK_PROVENANCE_MISMATCH';
  end if;
  return null;
end $$;
revoke all on function private.validate_complaint_compensation_link()
from public,anon,authenticated,service_role;
create constraint trigger complaint_compensation_target_validate
after insert or update of complaint_compensation_decision_id,room_id,source,fee_snapshot
on public.cleaning_targets deferrable initially deferred
for each row execute function private.validate_complaint_compensation_link();
create constraint trigger complaint_compensation_decision_validate
after insert or update on public.complaint_compensation_decisions deferrable initially deferred
for each row execute function private.validate_complaint_compensation_link();

create function private.validate_compensation_entitlement()
returns trigger language plpgsql set search_path='' as $$
declare v_comp public.complaint_compensation_decisions; v_target public.cleaning_targets;
  v_attempt public.cleaning_attempts; v_submission public.cleaning_submissions;
  v_inspection public.inspection_decisions;
begin
  select * into v_comp from public.complaint_compensation_decisions where id=new.compensation_decision_id;
  select * into v_target from public.cleaning_targets where id=new.rework_cleaning_target_id;
  select * into v_attempt from public.cleaning_attempts where id=new.cleaning_attempt_id;
  select * into v_submission from public.cleaning_submissions where id=new.submission_id;
  select * into v_inspection from public.inspection_decisions where id=new.inspection_decision_id;
  if v_comp.id is null or v_comp.assignee_maid_profile_id=v_comp.original_maid_profile_id
    or new.maid_profile_id is distinct from v_comp.assignee_maid_profile_id
    or new.amount is distinct from v_comp.compensation_amount or new.currency<>v_comp.currency
    or v_target.id is null or v_target.id is distinct from v_comp.rework_cleaning_target_id
    or v_target.source<>'post_approval_complaint_reclean' or v_target.status<>'approved'
    or v_attempt.id is null or v_attempt.cleaning_target_id is distinct from v_target.id
    or v_attempt.maid_profile_id is distinct from new.maid_profile_id
    or v_attempt.status<>'approved' or v_attempt.field_completed_at is null
    or v_submission.id is null or v_submission.cleaning_attempt_id is distinct from v_attempt.id
    or v_submission.submitted_by is distinct from new.maid_profile_id or v_submission.status<>'approved'
    or v_inspection.id is null or v_inspection.submission_id is distinct from v_submission.id
    or v_inspection.decision<>'approved' or new.entitled_at is distinct from v_inspection.decided_at then
    raise exception using errcode='23514',message='COMPENSATION_ENTITLEMENT_PROVENANCE_MISMATCH';
  end if;
  return new;
end $$;
revoke all on function private.validate_compensation_entitlement()
from public,anon,authenticated,service_role;
create trigger compensation_entitlement_validate before insert
on public.compensation_entitlements for each row
execute function private.validate_compensation_entitlement();

create or replace function private.validate_inspection_earning_source()
returns trigger language plpgsql set search_path='' as $$
declare bomb_decision private.bomb_room_decisions; v_entitlement public.compensation_entitlements;
  v_attempt public.cleaning_attempts;
begin
  if new.compensation_entitlement_id is not null then
    select * into v_entitlement from public.compensation_entitlements
      where id=new.compensation_entitlement_id;
    select * into v_attempt from public.cleaning_attempts where id=v_entitlement.cleaning_attempt_id;
    if new.earning_entitlement_id is not null or v_entitlement.id is null
      or new.submission_id is distinct from v_entitlement.submission_id
      or new.maid_profile_id is distinct from v_entitlement.maid_profile_id
      or new.base_amount is distinct from v_entitlement.amount
      or new.bomb_room_bonus<>0 or new.bomb_room_decision_id is not null
      or new.earned_on is distinct from (v_attempt.field_completed_at at time zone 'Asia/Seoul')::date then
      raise exception using errcode='23514',message='COMPENSATION_EARNING_PROVENANCE_MISMATCH';
    end if;
    return new;
  end if;
  if new.earning_entitlement_id is null then
    raise exception using errcode='23514',message='EARNING_ENTITLEMENT_SOURCE_REQUIRED';
  end if;
  if new.bomb_room_decision_id is null then
    if new.bomb_room_bonus<>0 then
      raise exception using errcode='23514',message='EARNING_BOMB_SOURCE_MISMATCH';
    end if;
    return new;
  end if;
  select * into bomb_decision from private.bomb_room_decisions where id=new.bomb_room_decision_id;
  if bomb_decision.id is null or bomb_decision.submission_id<>new.submission_id
    or bomb_decision.decision<>'approved' or new.bomb_room_bonus<>new.base_amount then
    raise exception using errcode='23514',message='EARNING_BOMB_SOURCE_MISMATCH';
  end if;
  return new;
end $$;

create or replace function private.enforce_cleaning_assignment_contract()
returns trigger language plpgsql set search_path='' as $$
declare v_target public.cleaning_targets; v_comp public.complaint_compensation_decisions;
begin
  if not exists(select 1 from public.profiles p where p.id=new.maid_profile_id
    and p.role='maid' and p.status='active') then
    raise exception using errcode='23514',message='ACTIVE_MAID_REQUIRED';
  end if;
  select * into v_target from public.cleaning_targets where id=new.cleaning_target_id;
  if v_target.source='inspection_reclean' and new.maid_profile_id is distinct from v_target.reclean_maid_profile_id then
    raise exception using errcode='23514',message='RECLEAN_MAID_IMMUTABLE';
  elsif v_target.source='post_approval_complaint_reclean' then
    select * into v_comp from public.complaint_compensation_decisions
      where id=v_target.complaint_compensation_decision_id;
    if v_comp.id is null or new.maid_profile_id is distinct from v_comp.assignee_maid_profile_id then
      raise exception using errcode='23514',message='COMPLAINT_REWORK_ASSIGNEE_IMMUTABLE';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.enforce_cleaning_assignment_contract()
from public,anon,authenticated,service_role;

create function private.guard_complaint_rework_attempt()
returns trigger language plpgsql set search_path='' as $$
declare v_target public.cleaning_targets; v_comp public.complaint_compensation_decisions;
  v_case public.complaint_cases; v_decision public.complaint_decisions;
begin
  select * into v_target from public.cleaning_targets where id=new.cleaning_target_id;
  if v_target.source<>'post_approval_complaint_reclean' then return new; end if;
  if tg_op='UPDATE' and not (old.status='scheduled' and new.status='in_progress') then return new; end if;
  select * into v_comp from public.complaint_compensation_decisions
    where id=v_target.complaint_compensation_decision_id;
  select * into v_case from public.complaint_cases where id=v_comp.complaint_case_id for share;
  select * into v_decision from public.complaint_decisions where id=v_case.current_decision_id;
  if v_comp.id is null or new.maid_profile_id is distinct from v_comp.assignee_maid_profile_id
    or v_case.current_compensation_decision_id is distinct from v_comp.id
    or v_comp.complaint_decision_id is null
    or v_decision.finding<>'confirmed' or not v_decision.rework_required then
    raise exception using errcode='40001',message='COMPLAINT_REWORK_DECISION_STALE';
  end if;
  return new;
end $$;
revoke all on function private.guard_complaint_rework_attempt()
from public,anon,authenticated,service_role;
create trigger complaint_rework_attempt_guard
before insert or update of status,cleaning_target_id,maid_profile_id
on public.cleaning_attempts for each row execute function private.guard_complaint_rework_attempt();

alter table public.complaint_case_events
  drop constraint complaint_case_events_event_type_check,
  drop constraint complaint_case_events_check,
  add column compensation_decision_id uuid
    references public.complaint_compensation_decisions(id) on delete restrict,
  add constraint complaint_case_events_event_type_check check (event_type in (
    'received','review_started','decided','acknowledged','appealed','closed','corrected','rework_materialized'
  )),
  add constraint complaint_case_events_source_check check (
    (event_type in ('decided','corrected') and decision_id is not null
      and maid_response_id is null and compensation_decision_id is null)
    or (event_type in ('acknowledged','appealed') and decision_id is not null
      and maid_response_id is not null and compensation_decision_id is null)
    or (event_type in ('received','review_started','closed') and maid_response_id is null
      and compensation_decision_id is null)
    or (event_type='rework_materialized' and decision_id is not null
      and maid_response_id is null and compensation_decision_id is not null)
  );

create or replace function private.guard_complaint_case_projection()
returns trigger language plpgsql set search_path='' as $$
declare v_response public.complaint_maid_responses;
  v_operational public.complaint_compensation_decisions;
  v_source public.complaint_decisions; v_next public.complaint_decisions;
begin
  if tg_op='DELETE' then raise exception using errcode='55000',message='COMPLAINT_CASE_DELETE_FORBIDDEN'; end if;
  if new.id<>old.id or new.room_id<>old.room_id or new.cleaning_target_id<>old.cleaning_target_id
    or new.cleaning_attempt_id<>old.cleaning_attempt_id or new.submission_id<>old.submission_id
    or new.inspection_decision_id<>old.inspection_decision_id or new.original_earning_id<>old.original_earning_id
    or new.maid_profile_id<>old.maid_profile_id or new.category<>old.category
    or new.received_by<>old.received_by or new.received_at<>old.received_at then
    raise exception using errcode='55000',message='COMPLAINT_CASE_SOURCE_IMMUTABLE';
  end if;
  if new.version<>old.version+1 or new.updated_at<old.updated_at then
    raise exception using errcode='40001',message='STALE_VERSION';
  end if;
  if old.current_compensation_decision_id is null and new.current_compensation_decision_id is not null
    and new.status=old.status and new.current_decision_id=old.current_decision_id then return new; end if;
  if new.current_compensation_decision_id is distinct from old.current_compensation_decision_id then
    raise exception using errcode='55000',message='COMPLAINT_REWORK_PROJECTION_IMMUTABLE'; end if;
  if old.status='received' and new.status='under_review' and new.current_decision_id is null then return new; end if;
  if old.status='under_review' and new.status='decided' and new.current_decision_id is not null and old.current_decision_id is null then return new; end if;
  if old.status='decided' and new.status in ('acknowledged','appealed') and new.current_decision_id=old.current_decision_id then return new; end if;
  if old.status='decided' and new.status='closed' and transaction_timestamp()>old.response_deadline and new.current_decision_id=old.current_decision_id then return new; end if;
  if old.status='acknowledged' and new.status='closed' and new.current_decision_id=old.current_decision_id then return new; end if;
  if old.status='appealed' and new.status='closed' then
    select * into v_response from public.complaint_maid_responses response where response.complaint_case_id=old.id;
    if v_response.id is not null and exists(select 1 from public.complaint_case_events correction_event
      join public.complaint_case_events response_event on response_event.maid_response_id=v_response.id
      where correction_event.complaint_case_id=old.id and correction_event.event_type='corrected'
        and correction_event.decision_id=old.current_decision_id and correction_event.id>response_event.id)
      and new.current_decision_id=old.current_decision_id then return new; end if;
  end if;
  if new.status=old.status and old.status in ('decided','acknowledged','appealed','closed')
    and new.current_decision_id<>old.current_decision_id and new.first_decided_at=old.first_decided_at
    and new.response_deadline=old.response_deadline then
    if old.current_compensation_decision_id is not null then
      select * into v_operational from public.complaint_compensation_decisions
        where id=old.current_compensation_decision_id;
      select * into v_source from public.complaint_decisions where id=v_operational.complaint_decision_id;
      select * into v_next from public.complaint_decisions where id=new.current_decision_id;
      if not exists(select 1 from public.cleaning_attempts attempt
          where attempt.cleaning_target_id=v_operational.rework_cleaning_target_id
            and attempt.started_at is not null)
        and (v_next.finding is distinct from v_source.finding
          or v_next.rework_required is distinct from v_source.rework_required) then
        raise exception using errcode='40001',message='COMPLAINT_REWORK_PRESTART_FROZEN';
      end if;
    end if;
    return new;
  end if;
  raise exception using errcode='55000',message='COMPLAINT_INVALID_TRANSITION';
end $$;

-- Complaint state writers take the shared domain lock before their case row.
-- The projection trigger validates only the row transition and never acquires
-- locks, preventing row -> advisory inversion against materialize/start/finalize.
create or replace function public.start_complaint_review(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases; v_replay jsonb;
  v_result jsonb; v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.review',p_idempotency_key,p_request_hash);
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_case.version is distinct from p_expected_version then
    raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if v_case.status<>'received' then
    raise exception using errcode='55000',message='COMPLAINT_INVALID_TRANSITION'; end if;
  update public.complaint_cases set status='under_review',version=version+1,updated_at=v_at
  where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,
    case_version,actor_profile_id,occurred_at)
  values(v_case.id,'review_started','received','under_review',v_case.version,v_actor.id,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,
    after_state,idempotency_key)
  values(v_actor.id,'complaint.review_started','complaint_case',v_case.id,v_at,
    jsonb_build_object('complaintId',v_case.id,'status',v_case.status,'version',v_case.version),
    private.audit_command_key(v_actor.id,'complaint.review',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.review',p_idempotency_key,p_request_hash,
    v_case.id,v_result);
  return v_result;
end $$;

create or replace function public.decide_complaint_case(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,p_finding text,
  p_penalty_score integer,p_rework_required boolean,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases; v_decision public.complaint_decisions;
  v_replay jsonb; v_result jsonb; v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.decide',p_idempotency_key,p_request_hash);
  if p_finding is null or p_finding not in ('confirmed','unverifiable','false') then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_FINDING'; end if;
  if p_penalty_score is null or p_penalty_score<0 or p_penalty_score>10 then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_PENALTY'; end if;
  if p_rework_required is null then
    raise exception using errcode='22023',message='INVALID_REWORK_DECISION'; end if;
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_case.version is distinct from p_expected_version then
    raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if v_case.status<>'under_review' or v_case.current_decision_id is not null then
    raise exception using errcode='55000',message='COMPLAINT_INVALID_TRANSITION'; end if;
  insert into public.complaint_decisions(complaint_case_id,decision_version,decision_kind,finding,
    penalty_score,rework_required,decided_by,decided_at)
  values(v_case.id,1,'initial',p_finding,p_penalty_score,p_rework_required,v_actor.id,v_at)
  returning * into v_decision;
  update public.complaint_cases set status='decided',version=version+1,
    current_decision_id=v_decision.id,first_decided_at=v_at,
    response_deadline=v_at+interval '7 days',updated_at=v_at
  where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,
    case_version,actor_profile_id,decision_id,occurred_at)
  values(v_case.id,'decided','under_review','decided',v_case.version,v_actor.id,v_decision.id,v_at);
  perform private.enqueue_complaint_notice(v_case.maid_profile_id,v_case,'decided',v_case.version,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,
    after_state,idempotency_key)
  values(v_actor.id,'complaint.decided','complaint_case',v_case.id,v_at,
    jsonb_build_object('complaintId',v_case.id,'decisionId',v_decision.id,'finding',p_finding,
      'penaltyScore',p_penalty_score,'reworkRequired',p_rework_required,'status',v_case.status,
      'version',v_case.version),
    private.audit_command_key(v_actor.id,'complaint.decide',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.decide',p_idempotency_key,p_request_hash,
    v_case.id,v_result);
  return v_result;
end $$;

create or replace function public.respond_to_complaint(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,p_response_type text,
  p_appeal_reason_code text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases;
  v_response public.complaint_maid_responses; v_decision public.complaint_decisions;
  v_replay jsonb; v_result jsonb; v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_reader(p_actor_profile_id);
  if v_actor.role<>'maid' then raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  v_replay:=private.replay_command(v_actor.id,'complaint.respond',p_idempotency_key,p_request_hash);
  if p_response_type not in ('acknowledged','appealed') then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_RESPONSE'; end if;
  if p_response_type='acknowledged' and p_appeal_reason_code is not null then
    raise exception using errcode='22023',message='COMPLAINT_APPEAL_REASON_FORBIDDEN'; end if;
  if p_response_type='appealed' and (p_appeal_reason_code is null or p_appeal_reason_code not in (
    'work_completed_as_required','evidence_misinterpreted','not_responsible','timeline_mismatch')) then
    raise exception using errcode='22023',message='COMPLAINT_APPEAL_REASON_REQUIRED'; end if;
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null or v_case.maid_profile_id<>v_actor.id then
    raise exception using errcode='42501',message='COMPLAINT_MAID_MISMATCH'; end if;
  if v_case.version is distinct from p_expected_version then
    raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if v_case.status<>'decided' or v_case.current_decision_id is null then
    raise exception using errcode='55000',message='COMPLAINT_INVALID_TRANSITION'; end if;
  if v_at>v_case.response_deadline then
    raise exception using errcode='22023',message='COMPLAINT_RESPONSE_WINDOW_CLOSED'; end if;
  if exists(select 1 from public.complaint_maid_responses r where r.complaint_case_id=v_case.id) then
    raise exception using errcode='23505',message='COMPLAINT_RESPONSE_ALREADY_RECORDED'; end if;
  select * into v_decision from public.complaint_decisions
  where complaint_case_id=v_case.id and decision_version=1;
  insert into public.complaint_maid_responses(complaint_case_id,decision_id,maid_profile_id,
    response_type,appeal_reason_code,responded_at)
  values(v_case.id,v_decision.id,v_actor.id,p_response_type,p_appeal_reason_code,v_at)
  returning * into v_response;
  update public.complaint_cases set status=p_response_type,version=version+1,updated_at=v_at
  where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,
    case_version,actor_profile_id,decision_id,maid_response_id,occurred_at)
  values(v_case.id,p_response_type,'decided',p_response_type,v_case.version,v_actor.id,
    v_decision.id,v_response.id,v_at);
  perform private.enqueue_complaint_notice(v_decision.decided_by,v_case,p_response_type,
    v_case.version,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,
    reason_code,after_state,idempotency_key)
  values(v_actor.id,'complaint.'||p_response_type,'complaint_case',v_case.id,v_at,
    p_appeal_reason_code,jsonb_strip_nulls(jsonb_build_object('complaintId',v_case.id,
      'decisionId',v_decision.id,'responseType',p_response_type,
      'appealReasonCode',p_appeal_reason_code,'status',v_case.status,'version',v_case.version)),
    private.audit_command_key(v_actor.id,'complaint.respond',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.respond',p_idempotency_key,p_request_hash,
    v_case.id,v_result);
  return v_result;
end $$;

create or replace function public.correct_complaint_decision(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,p_finding text,
  p_penalty_score integer,p_rework_required boolean,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases; v_prior public.complaint_decisions;
  v_decision public.complaint_decisions; v_replay jsonb; v_result jsonb;
  v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.correct',p_idempotency_key,p_request_hash);
  if p_finding is null or p_finding not in ('confirmed','unverifiable','false') then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_FINDING'; end if;
  if p_penalty_score is null or p_penalty_score<0 or p_penalty_score>10 then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_PENALTY'; end if;
  if p_rework_required is null then
    raise exception using errcode='22023',message='INVALID_REWORK_DECISION'; end if;
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_case.version is distinct from p_expected_version then
    raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if v_case.status not in ('decided','acknowledged','appealed','closed')
    or v_case.current_decision_id is null then
    raise exception using errcode='55000',message='COMPLAINT_DECISION_REQUIRED'; end if;
  select * into v_prior from public.complaint_decisions where id=v_case.current_decision_id for share;
  insert into public.complaint_decisions(complaint_case_id,decision_version,decision_kind,
    prior_decision_id,finding,penalty_score,rework_required,decided_by,decided_at)
  values(v_case.id,v_prior.decision_version+1,'correction',v_prior.id,p_finding,p_penalty_score,
    p_rework_required,v_actor.id,v_at) returning * into v_decision;
  update public.complaint_cases set current_decision_id=v_decision.id,version=version+1,updated_at=v_at
  where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,
    case_version,actor_profile_id,decision_id,occurred_at)
  values(v_case.id,'corrected',v_case.status,v_case.status,v_case.version,v_actor.id,v_decision.id,v_at);
  perform private.enqueue_complaint_notice(v_case.maid_profile_id,v_case,'corrected',v_case.version,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,
    after_state,idempotency_key)
  values(v_actor.id,'complaint.corrected','complaint_case',v_case.id,v_at,
    jsonb_build_object('complaintId',v_case.id,'decisionId',v_decision.id,
      'priorDecisionId',v_prior.id,'finding',p_finding,'penaltyScore',p_penalty_score,
      'reworkRequired',p_rework_required,'status',v_case.status,'version',v_case.version),
    private.audit_command_key(v_actor.id,'complaint.correct',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.correct',p_idempotency_key,p_request_hash,
    v_case.id,v_result);
  return v_result;
end $$;

create or replace function public.close_complaint_case(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases;
  v_response public.complaint_maid_responses; v_appeal_resolved boolean;
  v_replay jsonb; v_result jsonb; v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.close',p_idempotency_key,p_request_hash);
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_case.version is distinct from p_expected_version then
    raise exception using errcode='40001',message='STALE_VERSION'; end if;
  select * into v_response from public.complaint_maid_responses
  where complaint_case_id=v_case.id;
  select exists(
    select 1 from public.complaint_case_events correction_event
    join public.complaint_case_events response_event
      on response_event.maid_response_id=v_response.id
    where correction_event.complaint_case_id=v_case.id
      and correction_event.event_type='corrected'
      and correction_event.decision_id=v_case.current_decision_id
      and correction_event.id>response_event.id
  ) into v_appeal_resolved;
  if v_case.status='decided' and v_at<=v_case.response_deadline then
    raise exception using errcode='55000',message='COMPLAINT_RESPONSE_WINDOW_OPEN';
  elsif v_case.status='appealed' and (v_response.id is null or not v_appeal_resolved) then
    raise exception using errcode='55000',message='COMPLAINT_APPEAL_UNRESOLVED';
  elsif v_case.status not in ('decided','acknowledged','appealed') then
    raise exception using errcode='55000',message='COMPLAINT_INVALID_TRANSITION';
  end if;
  update public.complaint_cases set status='closed',version=version+1,updated_at=v_at
  where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,
    case_version,actor_profile_id,decision_id,occurred_at)
  values(v_case.id,'closed',case when v_response.response_type is null then 'decided'
    else v_response.response_type end,'closed',v_case.version,v_actor.id,
    v_case.current_decision_id,v_at);
  perform private.enqueue_complaint_notice(v_case.maid_profile_id,v_case,'closed',v_case.version,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,
    after_state,idempotency_key)
  values(v_actor.id,'complaint.closed','complaint_case',v_case.id,v_at,
    jsonb_build_object('complaintId',v_case.id,'status','closed','version',v_case.version),
    private.audit_command_key(v_actor.id,'complaint.close',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.close',p_idempotency_key,p_request_hash,
    v_case.id,v_result);
  return v_result;
end $$;

create function private.complaint_compensation_projection(
  p_comp public.complaint_compensation_decisions,p_current_complaint_decision_id uuid
) returns jsonb language sql stable set search_path='' as $$
  select case when p_comp.id is null then null else jsonb_build_object(
    'id',p_comp.id,'complaintId',p_comp.complaint_case_id,
    'sourceComplaintDecisionId',p_comp.complaint_decision_id,
    'currentComplaintDecisionId',p_current_complaint_decision_id,
    'sourceDecisionIsCurrent',p_comp.complaint_decision_id=p_current_complaint_decision_id,
    'originalCleaningTargetId',p_comp.original_cleaning_target_id,
    'reworkCleaningTargetId',p_comp.rework_cleaning_target_id,
    'originalMaidProfileId',p_comp.original_maid_profile_id,
    'assigneeMaidProfileId',p_comp.assignee_maid_profile_id,
    'sameMaid',p_comp.original_maid_profile_id=p_comp.assignee_maid_profile_id,
    'originalBaseFeeSnapshot',p_comp.original_base_fee_snapshot,
    'compensationAmount',p_comp.compensation_amount,'currency',p_comp.currency,
    'sourceCaseVersion',p_comp.source_case_version,'decisionVersion',p_comp.decision_version,
    'decidedAt',p_comp.decided_at) end
$$;
revoke all on function private.complaint_compensation_projection(
  public.complaint_compensation_decisions,uuid
) from public,anon,authenticated,service_role;

create or replace function private.get_complaint_projection(p_case_id uuid)
returns jsonb language plpgsql stable set search_path='' as $$
declare v_case public.complaint_cases; v_decision public.complaint_decisions;
  v_response public.complaint_maid_responses; v_comp public.complaint_compensation_decisions;
begin
  select * into v_case from public.complaint_cases where id=p_case_id;
  if v_case.id is null then return null; end if;
  select * into v_decision from public.complaint_decisions where id=v_case.current_decision_id;
  select * into v_response from public.complaint_maid_responses where complaint_case_id=v_case.id;
  select * into v_comp from public.complaint_compensation_decisions
    where id=v_case.current_compensation_decision_id;
  return private.complaint_projection(v_case)||jsonb_build_object(
    'currentDecision',private.complaint_decision_projection(v_decision),
    'maidResponse',private.complaint_response_projection(v_response),
    'reworkDecision',private.complaint_compensation_projection(v_comp,v_case.current_decision_id));
end $$;

alter table public.complaint_compensation_decisions enable row level security;
alter table public.compensation_entitlements enable row level security;
create policy complaint_compensation_decisions_read
on public.complaint_compensation_decisions for select to authenticated
using ((select private.complaint_rls_session_is_active()) and exists(
  select 1 from public.profiles actor where actor.id=(select private.current_profile_id())
    and actor.status='active' and not actor.must_change_password
    and actor.role='admin'));
create policy compensation_entitlements_read
on public.compensation_entitlements for select to authenticated
using ((select private.complaint_rls_session_is_active()) and exists(
  select 1 from public.profiles actor where actor.id=(select private.current_profile_id())
    and actor.status='active' and not actor.must_change_password
    and (actor.role='admin' or (actor.role='maid' and actor.id=maid_profile_id))));
revoke all on table public.complaint_compensation_decisions,public.compensation_entitlements
from public,anon,authenticated,service_role;
grant select on table public.complaint_compensation_decisions,public.compensation_entitlements
to authenticated,service_role;

create function public.materialize_complaint_rework(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,
  p_complaint_decision_id uuid,p_assignee_maid_profile_id uuid,p_compensation_amount integer,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases; v_source public.complaint_decisions;
  v_original_target public.cleaning_targets; v_assignee public.profiles;
  v_template public.cleaning_template_versions; v_template_count integer;
  v_comp public.complaint_compensation_decisions; v_target public.cleaning_targets;
  v_assignment public.cleaning_assignments; v_replay jsonb; v_result jsonb;
  v_notice uuid; v_at timestamptz:=transaction_timestamp(); v_today date;
  v_tomorrow timestamptz; v_due timestamptz; v_duration interval; v_sequence integer;
  v_week date;
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.materialize_rework',p_idempotency_key,p_request_hash);
  if p_expected_version is null or p_expected_version<1 or p_complaint_decision_id is null
    or p_assignee_maid_profile_id is null or p_compensation_amount is null or p_compensation_amount<0 then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_REWORK';
  end if;
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  v_replay:=private.replay_command(v_actor.id,'complaint.materialize_rework',p_idempotency_key,p_request_hash);
  if v_replay is not null then return v_replay; end if;
  select * into v_actor from public.profiles where id=p_actor_profile_id and role='admin'
    and status='active' and not must_change_password for no key update;
  if v_actor.id is null then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_case.version is distinct from p_expected_version
    or v_case.current_decision_id is distinct from p_complaint_decision_id then
    raise exception using errcode='40001',message='COMPLAINT_REWORK_DECISION_STALE'; end if;
  if v_case.current_compensation_decision_id is not null then
    raise exception using errcode='23505',message='COMPLAINT_REWORK_ALREADY_MATERIALIZED'; end if;
  if v_case.status not in ('decided','acknowledged','appealed','closed') then
    raise exception using errcode='55000',message='COMPLAINT_DECISION_REQUIRED'; end if;
  select * into v_source from public.complaint_decisions
    where id=v_case.current_decision_id and complaint_case_id=v_case.id for share;
  if v_source.id is null or v_source.finding<>'confirmed' or not v_source.rework_required then
    raise exception using errcode='55000',message='COMPLAINT_REWORK_NOT_CONFIRMED'; end if;
  select * into v_original_target from public.cleaning_targets
    where id=v_case.cleaning_target_id for update;
  if v_original_target.id is null or v_original_target.source not in (
      'scheduled_checkout','manual_checkout','stayover_request','manual_room_request')
    or v_original_target.status<>'approved' then
    raise exception using errcode='55000',message='COMPLAINT_SOURCE_NOT_APPROVED'; end if;
  select * into v_assignee from public.profiles where id=p_assignee_maid_profile_id
    and role='maid' and status='active' for share;
  if v_assignee.id is null then
    raise exception using errcode='23514',message='COMPLAINT_REWORK_MAID_UNAVAILABLE'; end if;
  if p_assignee_maid_profile_id=v_case.maid_profile_id and p_compensation_amount<>0
    or p_assignee_maid_profile_id<>v_case.maid_profile_id
      and p_compensation_amount>v_original_target.fee_snapshot then
    raise exception using errcode='22023',message='COMPLAINT_COMPENSATION_AMOUNT_INVALID'; end if;
  v_today:=(v_at at time zone 'Asia/Seoul')::date;
  v_tomorrow:=(v_today+1)::timestamp at time zone 'Asia/Seoul';
  select count(*) into v_template_count
  from public.cleaning_template_versions template
  join public.room_types room_type on room_type.id=template.room_type_id
  where room_type.code=v_original_target.room_type_snapshot->>'code'
    and template.cleaning_kind='reclean' and template.status='published';
  if v_template_count<>1 then
    raise exception using errcode='23514',message='RECLEAN_TEMPLATE_NOT_CONFIGURED'; end if;
  select template.* into v_template from public.cleaning_template_versions template
  join public.room_types room_type on room_type.id=template.room_type_id
  where room_type.code=v_original_target.room_type_snapshot->>'code'
    and template.cleaning_kind='reclean' and template.status='published';
  v_duration:=make_interval(mins=>v_template.duration_minutes);
  select least(v_tomorrow,coalesce(min(reservation.check_in_at-interval '30 minutes'),v_tomorrow))
  into v_due from public.reservations reservation
  where reservation.room_id=v_case.room_id and reservation.status='active'
    and reservation.check_in_at>v_at;
  v_due:=coalesce(v_due,v_tomorrow);
  if v_at+v_duration>v_due
    or exists(select 1 from public.reservations reservation
      where reservation.room_id=v_case.room_id and reservation.status='active'
        and tstzrange(coalesce(reservation.actual_check_in_at,reservation.check_in_at),
          case when reservation.actual_check_in_at is not null and reservation.actual_checkout_at is null
            then 'infinity'::timestamptz else coalesce(reservation.actual_checkout_at,reservation.check_out_at) end,'[)')
          && tstzrange(v_at,v_at+v_duration,'[)'))
    or exists(select 1 from public.cleaning_targets target where target.room_id=v_case.room_id
      and target.status not in ('approved','cancelled')) then
    raise exception using errcode='55000',message='COMPLAINT_REWORK_WINDOW_UNAVAILABLE'; end if;
  v_week:=v_today-(extract(isodow from v_today)::integer-1);
  if not exists(select 1 from public.availability_versions version
    join public.availability_days day on day.availability_version_id=version.id
    where version.maid_profile_id=v_assignee.id and version.week_start=v_week
      and version.is_current and version.status='submitted' and day.work_date=v_today and day.available) then
    raise exception using errcode='23514',message='COMPLAINT_REWORK_MAID_UNAVAILABLE'; end if;
  select coalesce(max(assignment.sequence_number),0)+1 into v_sequence
  from public.cleaning_assignments assignment
  where assignment.maid_profile_id=v_assignee.id and assignment.service_date=v_today and assignment.is_current;
  v_comp.id:=gen_random_uuid(); v_target.id:=gen_random_uuid(); v_assignment.id:=gen_random_uuid();
  insert into public.complaint_compensation_decisions(id,complaint_case_id,complaint_decision_id,
    original_cleaning_target_id,rework_cleaning_target_id,original_maid_profile_id,assignee_maid_profile_id,
    original_base_fee_snapshot,compensation_amount,source_case_version,decided_by,decided_at)
  values(v_comp.id,v_case.id,v_source.id,v_original_target.id,v_target.id,v_case.maid_profile_id,v_assignee.id,
    v_original_target.fee_snapshot,p_compensation_amount,v_case.version,v_actor.id,v_at)
  returning * into v_comp;
  insert into public.cleaning_targets(id,room_id,reservation_id,cleaning_kind,source,source_key,
    original_service_date,effective_service_date,carryover_count,available_from,due_at,status,
    assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by,
    complaint_compensation_decision_id)
  values(v_target.id,v_case.room_id,null,'reclean','post_approval_complaint_reclean',
    'complaint-rework:'||v_comp.id::text,v_today,v_today,0,v_at,v_due,'notified',1,
    v_original_target.room_type_snapshot,0,jsonb_build_object('id',v_template.id,'version',v_template.version,
      'durationMinutes',v_template.duration_minutes,'photoSlots',v_template.photo_slots),v_actor.id,v_comp.id)
  returning * into v_target;
  insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,
    available_from,due_at,reason_code,changed_by,recorded_at)
  values(v_target.id,1,v_today,v_at,v_due,'COMPLAINT_REWORK_CONFIRMED',v_actor.id,v_at);
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,
    is_current,notified_at,changed_by,created_at)
  values(v_assignment.id,v_target.id,v_assignee.id,v_sequence,1,true,v_at,v_actor.id,v_at)
  returning * into v_assignment;
  update public.complaint_cases set current_compensation_decision_id=v_comp.id,
    version=version+1,updated_at=v_at where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,
    actor_profile_id,decision_id,compensation_decision_id,occurred_at)
  values(v_case.id,'rework_materialized',v_case.status,v_case.status,v_case.version,
    v_actor.id,v_source.id,v_comp.id,v_at);
  insert into public.notifications(recipient_profile_id,category,title,body,room_id,cleaning_target_id,
    dedupe_key,requires_action,occurred_at)
  values(v_assignee.id,'complaint_rework_assigned','컴플레인 재작업 배정',
    '승인 후 컴플레인 재작업이 배정되었습니다.',v_case.room_id,v_target.id,
    'complaint-rework:'||v_comp.id::text,true,v_at) returning id into v_notice;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
  values(v_notice,'web_push','pending',v_at,v_at);
  v_result:=jsonb_build_object('complaint',private.get_complaint_projection(v_case.id,v_actor.id),
    'reworkDecision',private.complaint_compensation_projection(v_comp,v_case.current_decision_id),
    'assignment',jsonb_build_object('id',v_assignment.id,'cleaningTargetId',v_target.id,
      'maidProfileId',v_assignment.maid_profile_id,'sequenceNumber',v_assignment.sequence_number,
      'revision',v_assignment.revision,'serviceDate',v_assignment.service_date,
      'availableFrom',v_assignment.available_from_snapshot,'dueAt',v_assignment.due_at_snapshot));
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
    effective_at,after_state,request_hash,idempotency_key)
  values(v_actor.id,v_actor.display_name,'complaint.rework_materialized','complaint_compensation_decision',v_comp.id,
    v_at,jsonb_build_object('complaintId',v_case.id,'sourceComplaintDecisionId',v_source.id,
      'reworkCleaningTargetId',v_target.id,'assigneeMaidProfileId',v_assignee.id,
      'compensationAmount',v_comp.compensation_amount,'currency','KRW','caseVersion',v_case.version),
    p_request_hash,private.audit_command_key(v_actor.id,'complaint.materialize_rework',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.materialize_rework',p_idempotency_key,p_request_hash,v_comp.id,v_result);
  return v_result;
end $$;
revoke all on function public.materialize_complaint_rework(uuid,uuid,bigint,uuid,uuid,integer,text,text)
from public,anon,authenticated,service_role;
grant execute on function public.materialize_complaint_rework(uuid,uuid,bigint,uuid,uuid,integer,text,text)
to service_role;

create function private.create_compensation_entitlement_earning(
  p_compensation_decision_id uuid,p_attempt_id uuid,p_submission_id uuid,
  p_inspection_decision_id uuid,p_entitled_at timestamptz
) returns uuid language plpgsql set search_path='' as $$
declare v_comp public.complaint_compensation_decisions; v_attempt public.cleaning_attempts;
  v_entitlement public.compensation_entitlements; v_earning public.earnings;
begin
  select * into v_comp from public.complaint_compensation_decisions
    where id=p_compensation_decision_id;
  select * into v_attempt from public.cleaning_attempts where id=p_attempt_id;
  if v_comp.id is null then
    raise exception using errcode='23514',message='COMPLAINT_REWORK_PROVENANCE_MISMATCH'; end if;
  if v_comp.assignee_maid_profile_id=v_comp.original_maid_profile_id then return null; end if;
  insert into public.compensation_entitlements(compensation_decision_id,complaint_case_id,
    complaint_decision_id,original_cleaning_target_id,rework_cleaning_target_id,maid_profile_id,
    cleaning_attempt_id,submission_id,inspection_decision_id,amount,currency,entitled_at)
  values(v_comp.id,v_comp.complaint_case_id,v_comp.complaint_decision_id,v_comp.original_cleaning_target_id,
    v_comp.rework_cleaning_target_id,v_comp.assignee_maid_profile_id,v_attempt.id,p_submission_id,
    p_inspection_decision_id,v_comp.compensation_amount,v_comp.currency,p_entitled_at)
  returning * into v_entitlement;
  insert into public.earnings(earning_entitlement_id,compensation_entitlement_id,submission_id,
    maid_profile_id,earned_on,base_amount,bomb_room_bonus,bomb_room_decision_id)
  values(null,v_entitlement.id,p_submission_id,v_attempt.maid_profile_id,
    (v_attempt.field_completed_at at time zone 'Asia/Seoul')::date,v_entitlement.amount,0,null)
  returning * into v_earning;
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,after_state)
  values((select decided_by from public.inspection_decisions where id=p_inspection_decision_id),
    'compensation.earned','compensation_entitlement',v_entitlement.id,p_entitled_at,
    jsonb_build_object('complaintId',v_comp.complaint_case_id,
      'compensationDecisionId',v_comp.id,'reworkCleaningTargetId',v_comp.rework_cleaning_target_id,
      'attemptId',v_attempt.id,'submissionId',p_submission_id,'inspectionDecisionId',p_inspection_decision_id,
      'maidProfileId',v_attempt.maid_profile_id,'amount',v_entitlement.amount,'currency',v_entitlement.currency,
      'earningId',v_earning.id));
  return v_earning.id;
end $$;
revoke all on function private.create_compensation_entitlement_earning(uuid,uuid,uuid,uuid,timestamptz)
from public,anon,authenticated,service_role;

create or replace function private.finalize_submission_inspection(
  p_actor_profile_id uuid,p_submission_id uuid,p_decision text,p_reason_code text,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.profiles; s public.cleaning_submissions; a public.cleaning_attempts; t public.cleaning_targets;
  bseal private.bomb_room_report_seals; bdecision private.bomb_room_decisions; replay jsonb; result jsonb;
  reclean_template public.cleaning_template_versions; reclean_template_count integer; reclean_due_at timestamptz;
  reclean_sequence integer; checkout_obligation_id uuid; decision_id uuid; reclean_id uuid;
  reclean_assignment_id uuid; earning_id uuid; notice_id uuid; at_time timestamptz:=clock_timestamp();
begin
  replay:=private.replay_command(p_actor_profile_id,'inspection.'||p_decision,p_idempotency_key,p_request_hash);
  p:=private.assert_submission_admin(p_actor_profile_id);
  if replay is not null then return replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  s:=private.assert_current_submission(p_submission_id);
  select * into a from public.cleaning_attempts where id=s.cleaning_attempt_id for update;
  select * into t from public.cleaning_targets where id=a.cleaning_target_id for update;
  if not private.inspection_reason_valid(p_decision,p_reason_code)
    or a.status<>'submitted' or t.status<>'inspection_pending' then
    raise exception using errcode='55000',message='INSPECTION_INVALID_TRANSITION'; end if;
  select * into bseal from private.bomb_room_report_seals where submission_id=s.id;
  if bseal.report_id is not null then
    select * into bdecision from private.bomb_room_decisions where submission_id=s.id;
    if bdecision.id is null then raise exception using errcode='55000',message='BOMB_DECISION_REQUIRED'; end if;
  end if;
  if t.source='post_approval_complaint_reclean' and bseal.report_id is not null then
    raise exception using errcode='55000',message='BOMB_REPORT_NOT_ALLOWED'; end if;
  if p_decision='rejected' and t.source<>'post_approval_complaint_reclean' then
    if not exists(select 1 from public.profiles maid where maid.id=a.maid_profile_id
      and maid.role='maid' and maid.status='active') then
      raise exception using errcode='55000',message='RECLEAN_ORIGINAL_MAID_UNAVAILABLE';
    end if;
    select count(*) into reclean_template_count from public.cleaning_template_versions template
      join public.room_types room_type on room_type.id=template.room_type_id
      where room_type.code=t.room_type_snapshot->>'code' and template.cleaning_kind='reclean'
        and template.status='published';
    if reclean_template_count<>1 then
      raise exception using errcode='23514',message='RECLEAN_TEMPLATE_NOT_CONFIGURED'; end if;
    select template.* into reclean_template from public.cleaning_template_versions template
      join public.room_types room_type on room_type.id=template.room_type_id
      where room_type.code=t.room_type_snapshot->>'code' and template.cleaning_kind='reclean'
        and template.status='published';
    select min(reservation.check_in_at-interval '30 minutes') into reclean_due_at
      from public.reservations reservation where reservation.room_id=t.room_id
        and reservation.status='active' and reservation.check_in_at>at_time;
    if reclean_due_at is not null and reclean_due_at<=at_time then
      raise exception using errcode='55000',message='RECLEAN_WINDOW_NOT_AVAILABLE'; end if;
    select coalesce(max(assignment.sequence_number),0)+1 into reclean_sequence
      from public.cleaning_assignments assignment
      join public.cleaning_targets target on target.id=assignment.cleaning_target_id
      where assignment.maid_profile_id=a.maid_profile_id and assignment.is_current
        and target.effective_service_date=(at_time at time zone 'Asia/Seoul')::date;
  end if;
  insert into public.inspection_decisions(submission_id,decision,reason_code,reason_detail,
    bomb_room_decision,decided_by,decided_at)
  values(s.id,p_decision,p_reason_code,null,bdecision.decision,p.id,at_time)
  returning id into decision_id;
  update public.cleaning_submissions set status=p_decision::public.submission_status where id=s.id;
  update public.cleaning_attempts set status=p_decision::public.attempt_status where id=a.id;
  update public.cleaning_targets set status=p_decision::public.cleaning_target_status where id=t.id;
  if p_decision='approved' then
    with recursive ancestry(target_id,depth) as (
      select t.id,0 union all
      select origin_attempt.cleaning_target_id,ancestry.depth+1 from ancestry
        join public.cleaning_targets child on child.id=ancestry.target_id and child.source='inspection_reclean'
        join public.cleaning_attempts origin_attempt on origin_attempt.id=child.reclean_of_attempt_id
      where ancestry.depth<32
    ) select target.checkout_obligation_id into checkout_obligation_id from ancestry
      join public.cleaning_targets target on target.id=ancestry.target_id
      where target.checkout_obligation_id is not null order by ancestry.depth desc limit 1;
    if checkout_obligation_id is not null then
      update public.checkout_cleaning_obligations set status='completed',completion_submission_id=s.id,
        version=version+1 where id=checkout_obligation_id;
    end if;
    update public.preparation_obligations obligation set status='approved',current_attempt_id=a.id,
      approved_submission_id=s.id,invalidated_reason_code=null,version=version+1
    where obligation.id=(select candidate.id from public.preparation_obligations candidate
      join public.reservations r on r.id=candidate.reservation_id
      where candidate.room_id=t.room_id and candidate.status in ('pending','invalidated') and r.status='active'
        and r.check_in_at>=at_time and t.available_from is not null
        and t.available_from>=coalesce((select max(coalesce(previous.actual_checkout_at,previous.check_out_at))
          from public.reservations previous where previous.room_id=r.room_id and previous.id<>r.id
            and previous.status<>'cancelled' and previous.check_in_at<r.check_in_at),candidate.created_at)
        and a.started_at is not null and a.field_completed_at is not null and a.ended_at is not null
        and a.started_at>=t.available_from and a.field_completed_at>=a.started_at
        and a.ended_at>=a.field_completed_at and s.submitted_at>=a.ended_at
        and at_time>=s.submitted_at and at_time<=r.check_in_at order by r.check_in_at limit 1);
    if t.source not in ('inspection_reclean','post_approval_complaint_reclean') then
      insert into public.earnings(earning_entitlement_id,compensation_entitlement_id,submission_id,
        maid_profile_id,earned_on,base_amount,bomb_room_bonus,bomb_room_decision_id)
      values(s.id,null,s.id,a.maid_profile_id,(a.field_completed_at at time zone 'Asia/Seoul')::date,
        t.fee_snapshot,case when bdecision.decision='approved' then t.fee_snapshot else 0 end,
        case when bdecision.decision='approved' then bdecision.id end) returning id into earning_id;
    elsif t.source='post_approval_complaint_reclean' then
      earning_id:=private.create_compensation_entitlement_earning(
        t.complaint_compensation_decision_id,a.id,s.id,decision_id,at_time);
    end if;
  elsif t.source<>'post_approval_complaint_reclean' then
    reclean_id:=gen_random_uuid();
    insert into public.cleaning_targets(id,room_id,reservation_id,cleaning_kind,source,source_key,
      original_service_date,effective_service_date,carryover_count,available_from,due_at,status,
      assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by,
      reclean_of_attempt_id,reclean_maid_profile_id,reclean_of_submission_id,
      reclean_of_inspection_decision_id)
    values(reclean_id,t.room_id,null,'reclean','inspection_reclean','inspection-reclean:'||decision_id::text,
      (at_time at time zone 'Asia/Seoul')::date,(at_time at time zone 'Asia/Seoul')::date,0,at_time,
      reclean_due_at,'notified',1,t.room_type_snapshot,0,
      jsonb_build_object('id',reclean_template.id,'version',reclean_template.version,
        'durationMinutes',reclean_template.duration_minutes,'photoSlots',reclean_template.photo_slots),
      p.id,a.id,a.maid_profile_id,s.id,decision_id);
    insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,
      available_from,due_at,reason_code,changed_by)
    values(reclean_id,1,(at_time at time zone 'Asia/Seoul')::date,at_time,reclean_due_at,
      'INSPECTION_REJECTED',p.id);
    reclean_assignment_id:=gen_random_uuid();
    insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,
      is_current,notified_at,changed_by)
    values(reclean_assignment_id,reclean_id,a.maid_profile_id,reclean_sequence,1,true,at_time,p.id);
  end if;
  insert into public.notifications(recipient_profile_id,category,title,body,room_id,cleaning_target_id,
    dedupe_key,requires_action,occurred_at)
  values(a.maid_profile_id,'cleaning_inspection_'||p_decision,
    case when p_decision='approved' then '청소 검수 승인' else '청소 검수 반려' end,
    case when p_decision='approved' then '제출한 청소가 승인되었습니다.'
      when t.source='post_approval_complaint_reclean' then '컴플레인 재작업 제출이 반려되었습니다.'
      else '제출한 청소가 반려되어 재청소가 필요합니다.' end,
    t.room_id,case when p_decision='approved' or t.source='post_approval_complaint_reclean'
      then t.id else reclean_id end,'inspection:'||decision_id::text,
    p_decision='rejected' and t.source<>'post_approval_complaint_reclean',at_time)
  returning id into notice_id;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
  values(notice_id,'web_push','pending',at_time,at_time);
  result:=jsonb_build_object('submissionId',s.id,'decisionId',decision_id,'decision',p_decision,
    'reasonCode',p_reason_code,'decidedAt',at_time,'earningId',earning_id,
    'recleanTargetId',reclean_id,'recleanAssignmentId',reclean_assignment_id);
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,
    actor_display_name_snapshot,effective_at,reason_code,after_state,idempotency_key)
  values('inspection.'||p_decision,'inspection_decision',decision_id,p.id,p.display_name,at_time,p_reason_code,
    jsonb_build_object('submissionId',s.id,'attemptId',a.id,'cleaningTargetId',t.id,
      'maidProfileId',a.maid_profile_id,'decision',p_decision,'earningId',earning_id,
      'recleanTargetId',reclean_id,'earningProvenance',case when earning_id is null then null
        when t.source='post_approval_complaint_reclean' then 'compensation' else 'original' end),
    private.audit_command_key(p.id,'inspection.'||p_decision,p_idempotency_key));
  perform private.complete_command(p.id,'inspection.'||p_decision,p_idempotency_key,
    p_request_hash,decision_id,result);
  return result;
end $$;

create or replace function private.assignment_preview_source_reason(
  p_target public.cleaning_targets,p_duration_minutes integer,p_command_at timestamptz
) returns text language plpgsql stable security definer set search_path='' as $$
declare v_comp public.complaint_compensation_decisions; v_case public.complaint_cases;
  v_decision public.complaint_decisions;
begin
  if p_target.available_from is null or not isfinite(p_target.available_from)
    or p_target.due_at is not null and (not isfinite(p_target.due_at) or p_target.due_at<=p_target.available_from)
    or (p_target.available_from at time zone 'Asia/Seoul')::date<>p_target.effective_service_date then
    return 'ASSIGNMENT_PREVIEW_INVALID_SCHEDULE'; end if;
  if p_target.due_at is not null and p_target.due_at<=p_command_at then return 'ASSIGNMENT_WINDOW_EXPIRED'; end if;
  if p_target.cleaning_kind='checkout' and p_target.source in ('scheduled_checkout','manual_checkout') then
    if not exists(select 1 from public.reservations r join public.checkout_cleaning_obligations o
      on o.reservation_id=r.id and o.room_id=r.room_id where o.id=p_target.checkout_obligation_id
        and r.id=p_target.reservation_id and r.room_id=p_target.room_id
        and o.planned_cleaning_target_id=p_target.id and o.effective_service_date=p_target.effective_service_date
        and o.available_from is not distinct from p_target.available_from and o.due_at is not distinct from p_target.due_at
        and ((r.status='checked_out' and r.actual_checkout_at is not null and o.status='materialized'
            and o.current_cleaning_target_id=p_target.id)
          or (p_target.source='scheduled_checkout' and r.status='active' and r.actual_checkout_at is null
            and r.check_out_at=p_target.available_from and o.status='private' and o.current_cleaning_target_id is null)))
    then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
  elsif p_target.source='stayover_request' and p_target.cleaning_kind='stayover' then
    if not exists(select 1 from public.reservations r where r.id=p_target.reservation_id
      and r.room_id=p_target.room_id and r.status='active' and r.actual_check_in_at is not null
      and r.actual_checkout_at is null and p_target.available_from>=r.actual_check_in_at
      and p_target.due_at is not null and p_target.due_at<=r.check_out_at)
    then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
  elsif p_target.source='manual_room_request' and p_target.cleaning_kind='additional' then
    if p_target.due_at is null and p_duration_minutes is null then
      return 'ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED'; end if;
    if exists(select 1 from public.reservations r where r.room_id=p_target.room_id and r.status='active'
      and tstzrange(coalesce(r.actual_check_in_at,r.check_in_at),case when r.actual_check_in_at is not null
        and r.actual_checkout_at is null then 'infinity'::timestamptz
        else coalesce(r.actual_checkout_at,r.check_out_at) end,'[)')
      && tstzrange(p_target.available_from,coalesce(p_target.due_at,
        p_target.available_from+make_interval(mins=>p_duration_minutes)),'[)'))
    then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
  elsif p_target.source='inspection_reclean' and p_target.cleaning_kind='reclean' then
    if p_target.fee_snapshot<>0 or p_target.reclean_maid_profile_id is null or not exists(
      select 1 from public.cleaning_attempts a where a.id=p_target.reclean_of_attempt_id
        and a.maid_profile_id=p_target.reclean_maid_profile_id and a.status='rejected')
    then return 'RECLEAN_MAID_IMMUTABLE'; end if;
  elsif p_target.source='post_approval_complaint_reclean' and p_target.cleaning_kind='reclean' then
    select * into v_comp from public.complaint_compensation_decisions
      where id=p_target.complaint_compensation_decision_id;
    select * into v_case from public.complaint_cases where id=v_comp.complaint_case_id;
    select * into v_decision from public.complaint_decisions where id=v_case.current_decision_id;
    if v_comp.id is null or v_case.current_compensation_decision_id is distinct from v_comp.id
      or v_decision.finding<>'confirmed' or not v_decision.rework_required or p_target.fee_snapshot<>0 then
      return 'COMPLAINT_REWORK_DECISION_STALE'; end if;
  else return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
  return null;
end $$;

create or replace function private.activation_reason_at(
  p_target public.cleaning_targets,p_assignment public.cleaning_assignments,p_command_at timestamptz
) returns text language plpgsql stable security definer set search_path='' as $$
declare v_today date:=(p_command_at at time zone 'Asia/Seoul')::date;
  v_comp public.complaint_compensation_decisions; v_case public.complaint_cases;
  v_decision public.complaint_decisions;
begin
  if p_target.status<>'notified' then return 'ASSIGNMENT_NOT_NOTIFIED'; end if;
  if p_assignment.id is null or not p_assignment.is_current or p_assignment.notified_at is null then
    return 'ASSIGNMENT_NOT_NOTIFIED'; end if;
  if p_assignment.cleaning_target_id is distinct from p_target.id
    or p_assignment.revision is distinct from p_target.assignment_version
    or p_assignment.service_date is distinct from p_target.effective_service_date
    or p_assignment.available_from_snapshot is distinct from p_target.available_from
    or p_assignment.due_at_snapshot is distinct from p_target.due_at then
    return 'ASSIGNMENT_VERSION_CONFLICT'; end if;
  if p_target.effective_service_date>v_today then return 'CLEANING_SERVICE_DATE_NOT_DUE'; end if;
  if p_target.effective_service_date<v_today then return 'CLEANING_SERVICE_DATE_EXPIRED'; end if;
  if p_target.available_from is null or p_target.available_from>p_command_at then return 'CLEANING_WINDOW_NOT_OPEN'; end if;
  if p_target.due_at is not null and p_target.due_at<=p_command_at then return 'CLEANING_WINDOW_EXPIRED'; end if;
  if not exists(select 1 from public.profiles profile where profile.id=p_assignment.maid_profile_id
      and profile.role='maid' and profile.status='active') then return 'ASSIGNMENT_MAID_UNAVAILABLE'; end if;
  if p_target.cleaning_kind='checkout' then
    if p_target.source not in ('scheduled_checkout','manual_checkout') or not exists(
      select 1 from public.checkout_cleaning_obligations obligation join public.reservations reservation
        on reservation.id=obligation.reservation_id and reservation.room_id=obligation.room_id
      where obligation.id=p_target.checkout_obligation_id and obligation.planned_cleaning_target_id=p_target.id
        and obligation.current_cleaning_target_id=p_target.id and obligation.status in ('materialized','completed')
        and reservation.id=p_target.reservation_id and reservation.room_id=p_target.room_id
        and reservation.status='checked_out' and reservation.actual_checkout_at is not null
        and reservation.actual_checkout_at<=p_command_at and p_target.available_from<=p_command_at)
    then return 'CHECKOUT_NOT_MATERIALIZED'; end if;
  elsif p_target.source='stayover_request' and p_target.cleaning_kind='stayover' then
    if not exists(select 1 from public.reservations reservation where reservation.id=p_target.reservation_id
      and reservation.room_id=p_target.room_id and reservation.status='active'
      and reservation.actual_check_in_at is not null and reservation.actual_checkout_at is null
      and p_target.available_from>=reservation.actual_check_in_at and p_target.due_at is not null
      and p_target.due_at<=reservation.check_out_at and p_target.available_from<p_target.due_at)
    then return 'ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
  elsif p_target.source='manual_room_request' and p_target.cleaning_kind='additional' then
    if exists(select 1 from public.reservations reservation where reservation.room_id=p_target.room_id
      and reservation.status='active' and tstzrange(coalesce(reservation.actual_check_in_at,reservation.check_in_at),
        case when reservation.actual_check_in_at is not null and reservation.actual_checkout_at is null
          then 'infinity'::timestamptz else coalesce(reservation.actual_checkout_at,reservation.check_out_at) end,'[)')
        && tstzrange(p_target.available_from,coalesce(p_target.due_at,p_target.available_from+make_interval(
          mins=>coalesce(nullif(p_target.template_snapshot->>'durationMinutes','')::integer,1))),'[)'))
    then return 'ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
  elsif p_target.source='inspection_reclean' and p_target.cleaning_kind='reclean' then
    if p_target.fee_snapshot<>0 or p_target.reclean_of_attempt_id is null
      or p_target.reclean_maid_profile_id is distinct from p_assignment.maid_profile_id or not exists(
        select 1 from public.cleaning_attempts original_attempt where original_attempt.id=p_target.reclean_of_attempt_id
          and original_attempt.maid_profile_id=p_target.reclean_maid_profile_id and original_attempt.status='rejected')
    then return 'RECLEAN_MAID_IMMUTABLE'; end if;
  elsif p_target.source='post_approval_complaint_reclean' and p_target.cleaning_kind='reclean' then
    select * into v_comp from public.complaint_compensation_decisions
      where id=p_target.complaint_compensation_decision_id;
    select * into v_case from public.complaint_cases where id=v_comp.complaint_case_id;
    select * into v_decision from public.complaint_decisions where id=v_case.current_decision_id;
    if v_comp.id is null or v_case.current_compensation_decision_id is distinct from v_comp.id
      or v_comp.assignee_maid_profile_id is distinct from p_assignment.maid_profile_id
      or v_decision.finding<>'confirmed' or not v_decision.rework_required or p_target.fee_snapshot<>0 then
      return 'COMPLAINT_REWORK_DECISION_STALE'; end if;
  else return 'ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
  if exists(select 1 from public.cleaning_attempts previous_attempt
    join public.cleaning_targets previous_target on previous_target.id=previous_attempt.cleaning_target_id
    where previous_target.room_id=p_target.room_id and previous_target.id<>p_target.id
      and previous_attempt.status in ('scheduled','in_progress','field_completed','upload_pending','submitted')
      and (coalesce(previous_target.available_from,'-infinity'::timestamptz),previous_target.created_at,previous_target.id)
        < (coalesce(p_target.available_from,'infinity'::timestamptz),p_target.created_at,p_target.id)) then
    return 'PREVIOUS_ROOM_WORKFLOW_ACTIVE'; end if;
  return null;
end $$;

create function private.forbid_complaint_rework_bomb_report()
returns trigger language plpgsql set search_path='' as $$
begin
  if exists(select 1 from public.cleaning_attempts attempt
    join public.cleaning_targets target on target.id=attempt.cleaning_target_id
    where attempt.id=new.cleaning_attempt_id
      and target.source='post_approval_complaint_reclean') then
    raise exception using errcode='55000',message='BOMB_REPORT_NOT_ALLOWED';
  end if;
  return new;
end $$;
revoke all on function private.forbid_complaint_rework_bomb_report()
from public,anon,authenticated,service_role;
create trigger complaint_rework_bomb_report_forbidden
before insert on private.bomb_room_reports for each row
execute function private.forbid_complaint_rework_bomb_report();

comment on table public.complaint_compensation_decisions is
'#101 immutable admin decision that materializes one approved-complaint reclean target. It records the operational source complaint decision even if a later correction changes the current pointer.';
comment on table public.compensation_entitlements is
'#101 immutable approved other-maid work proof. Zero-KRW entitlement is retained and creates one zero-KRW earning; same-maid rework creates neither.';

-- Raw compensation rows are admin-only. Maid-facing payloads are deliberately
-- shaped by trusted RPCs so one maid never learns another maid's profile id or pay.
create function private.complaint_compensation_projection_for_actor(
  p_comp public.complaint_compensation_decisions,
  p_current_complaint_decision_id uuid,
  p_actor_profile_id uuid
) returns jsonb language plpgsql stable set search_path='' as $$
declare v_actor public.profiles;
begin
  if p_comp.id is null then return null; end if;
  select * into v_actor from public.profiles where id=p_actor_profile_id;
  if v_actor.role='admin' then
    return private.complaint_compensation_projection(p_comp,p_current_complaint_decision_id)
      ||jsonb_build_object('view','admin');
  elsif v_actor.role='maid' and v_actor.id=p_comp.original_maid_profile_id then
    return jsonb_build_object('view','originalMaid','sameMaid',
      p_comp.original_maid_profile_id=p_comp.assignee_maid_profile_id,
      'sourceDecisionIsCurrent',p_comp.complaint_decision_id=p_current_complaint_decision_id);
  elsif v_actor.role='maid' and v_actor.id=p_comp.assignee_maid_profile_id then
    return jsonb_build_object('view','assigneeMaid','id',p_comp.id,
      'reworkCleaningTargetId',p_comp.rework_cleaning_target_id,
      'compensationAmount',p_comp.compensation_amount,'currency',p_comp.currency,
      'sourceDecisionIsCurrent',p_comp.complaint_decision_id=p_current_complaint_decision_id);
  end if;
  return null;
end $$;
revoke all on function private.complaint_compensation_projection_for_actor(
  public.complaint_compensation_decisions,uuid,uuid
) from public,anon,authenticated,service_role;

create function private.get_complaint_projection(p_case_id uuid,p_actor_profile_id uuid)
returns jsonb language plpgsql stable set search_path='' as $$
declare v_case public.complaint_cases; v_decision public.complaint_decisions;
  v_response public.complaint_maid_responses; v_comp public.complaint_compensation_decisions;
begin
  select * into v_case from public.complaint_cases where id=p_case_id;
  if v_case.id is null then return null; end if;
  select * into v_decision from public.complaint_decisions where id=v_case.current_decision_id;
  select * into v_response from public.complaint_maid_responses where complaint_case_id=v_case.id;
  select * into v_comp from public.complaint_compensation_decisions where id=v_case.current_compensation_decision_id;
  return private.complaint_projection(v_case)||jsonb_build_object(
    'currentDecision',private.complaint_decision_projection(v_decision),
    'maidResponse',private.complaint_response_projection(v_response),
    'reworkDecision',private.complaint_compensation_projection_for_actor(
      v_comp,v_case.current_decision_id,p_actor_profile_id));
end $$;
revoke all on function private.get_complaint_projection(uuid,uuid)
from public,anon,authenticated,service_role;

-- Existing command functions call the one-argument overload. Keep those replies
-- safe for the original maid; admin can retrieve the full actor-aware projection.
create or replace function private.get_complaint_projection(p_case_id uuid)
returns jsonb language plpgsql stable set search_path='' as $$
declare v_case public.complaint_cases; v_decision public.complaint_decisions;
  v_response public.complaint_maid_responses; v_comp public.complaint_compensation_decisions;
begin
  select * into v_case from public.complaint_cases where id=p_case_id;
  if v_case.id is null then return null; end if;
  select * into v_decision from public.complaint_decisions where id=v_case.current_decision_id;
  select * into v_response from public.complaint_maid_responses where complaint_case_id=v_case.id;
  select * into v_comp from public.complaint_compensation_decisions where id=v_case.current_compensation_decision_id;
  return private.complaint_projection(v_case)||jsonb_build_object(
    'currentDecision',private.complaint_decision_projection(v_decision),
    'maidResponse',private.complaint_response_projection(v_response),
    'reworkDecision',case when v_comp.id is null then null else jsonb_build_object(
      'view','originalMaid','sameMaid',v_comp.original_maid_profile_id=v_comp.assignee_maid_profile_id,
      'sourceDecisionIsCurrent',v_comp.complaint_decision_id=v_case.current_decision_id) end);
end $$;

create or replace function public.list_complaint_cases_page(
  p_actor_profile_id uuid,p_from timestamptz,p_to timestamptz,p_after_received_at timestamptz default null,
  p_after_id uuid default null,p_limit integer default 50
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_actor public.profiles; v_rows jsonb; v_has_more boolean; v_last_at timestamptz; v_last_id uuid;
begin
  v_actor:=private.assert_complaint_reader(p_actor_profile_id);
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_to<=p_from or p_to-p_from>interval '31 days' then
    raise exception using errcode='22023',message='COMPLAINT_PERIOD_INVALID'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 then
    raise exception using errcode='22023',message='COMPLAINT_PAGE_LIMIT_INVALID'; end if;
  if (p_after_received_at is null)<>(p_after_id is null) then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_CURSOR'; end if;
  with page as (
    select c.* from public.complaint_cases c
    where c.received_at>=p_from and c.received_at<p_to
      and (v_actor.role='admin' or c.maid_profile_id=v_actor.id)
      and (p_after_received_at is null or (c.received_at,c.id)<(p_after_received_at,p_after_id))
    order by c.received_at desc,c.id desc limit p_limit+1
  ), kept as (select * from page order by received_at desc,id desc limit p_limit)
  select coalesce(jsonb_agg(private.get_complaint_projection(k.id,v_actor.id)
      order by k.received_at desc,k.id desc),'[]'::jsonb),
    (select count(*)>p_limit from page),
    (select received_at from kept order by received_at,id limit 1),
    (select id from kept order by received_at,id limit 1)
  into v_rows,v_has_more,v_last_at,v_last_id from kept k;
  return jsonb_build_object('complaints',v_rows,'hasMore',coalesce(v_has_more,false),
    'lastReceivedAt',case when v_has_more then v_last_at else null end,
    'lastId',case when v_has_more then v_last_id else null end);
end $$;

create or replace function public.get_complaint_case(p_actor_profile_id uuid,p_complaint_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases;
begin
  v_actor:=private.assert_complaint_reader(p_actor_profile_id);
  select * into v_case from public.complaint_cases c where c.id=p_complaint_id;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_actor.role='maid' and v_case.maid_profile_id<>v_actor.id then
    raise exception using errcode='42501',message='COMPLAINT_MAID_MISMATCH'; end if;
  return private.get_complaint_projection(v_case.id,v_actor.id);
end $$;

create or replace function public.list_complaint_history_page(
  p_actor_profile_id uuid,p_complaint_id uuid,p_after_event_id bigint default null,p_limit integer default 50
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases; v_rows jsonb; v_more boolean; v_last bigint;
begin
  v_actor:=private.assert_complaint_reader(p_actor_profile_id);
  select * into v_case from public.complaint_cases where id=p_complaint_id;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_actor.role='maid' and v_case.maid_profile_id<>v_actor.id then
    raise exception using errcode='42501',message='COMPLAINT_MAID_MISMATCH'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 or p_after_event_id is not null and p_after_event_id<1 then
    raise exception using errcode='22023',message='COMPLAINT_PAGE_LIMIT_INVALID'; end if;
  with page as (
    select e.*,d.id as joined_decision_id,d.complaint_case_id as d_case,d.decision_version,d.decision_kind,
      d.prior_decision_id,d.finding,d.penalty_score,d.rework_required,d.decided_at,
      r.id as joined_response_id,r.decision_id as r_decision_id,r.maid_profile_id as r_maid,
      r.response_type,r.appeal_reason_code,r.responded_at
    from public.complaint_case_events e
    left join public.complaint_decisions d on d.id=e.decision_id
    left join public.complaint_maid_responses r on r.id=e.maid_response_id
    where e.complaint_case_id=v_case.id and (p_after_event_id is null or e.id<p_after_event_id)
    order by e.id desc limit p_limit+1
  ), kept as (select * from page order by id desc limit p_limit)
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'eventId',k.id,'eventType',k.event_type,'fromStatus',k.from_status,'toStatus',k.to_status,
      'caseVersion',k.case_version,'occurredAt',k.occurred_at,
      'compensationDecisionId',case when v_actor.role='admin' then k.compensation_decision_id else null end,
      'decision',case when k.joined_decision_id is null then null else jsonb_build_object(
        'id',k.joined_decision_id,'complaintId',k.d_case,'decisionVersion',k.decision_version,
        'decisionKind',k.decision_kind,'priorDecisionId',k.prior_decision_id,'finding',k.finding,
        'penaltyScore',k.penalty_score,'reworkRequired',k.rework_required,'decidedAt',k.decided_at) end,
      'maidResponse',case when k.joined_response_id is null then null else jsonb_strip_nulls(jsonb_build_object(
        'id',k.joined_response_id,'complaintId',v_case.id,'decisionId',k.r_decision_id,
        'maidProfileId',k.r_maid,'responseType',k.response_type,
        'appealReasonCode',k.appeal_reason_code,'respondedAt',k.responded_at)) end
    )) order by k.id desc),'[]'::jsonb),
    (select count(*)>p_limit from page),(select id from kept order by id limit 1)
  into v_rows,v_more,v_last from kept k;
  return jsonb_build_object('events',v_rows,'hasMore',coalesce(v_more,false),
    'lastEventId',case when v_more then v_last else null end);
end $$;

comment on function public.materialize_complaint_rework(uuid,uuid,bigint,uuid,uuid,integer,text,text) is
'#101 admin CAS command. It proves a current safe room-access window and atomically freezes the complaint decision, published reclean template, target version, notified assignment revision, assignee, and amount.';

-- Extend the developer audit allowlist with only the two Issue #101 events. Older
-- event projections remain delegated to the previously reviewed wrapper and raw
-- after_state, request hashes and idempotency keys are never returned.
alter function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) rename to list_developer_audit_events_before_compensation;
revoke all on function private.list_developer_audit_events_before_compensation(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public,anon,authenticated,service_role;

create function public.list_developer_audit_events(
  p_actor_profile_id uuid,p_event_types text[] default null,
  p_filter_actor_profile_id uuid default null,p_from timestamptz default null,
  p_to timestamptz default null,p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,p_limit integer default 50
) returns table(id uuid,event_type text,entity_type text,entity_id uuid,
  actor_profile_id uuid,actor_display_name text,effective_at timestamptz,
  recorded_at timestamptz,reason_code text,summary jsonb)
language plpgsql security definer set search_path='' as $$
declare v_previous_types text[];
  v_from timestamptz:=coalesce(p_from,clock_timestamp()-interval '7 days');
  v_to timestamptz:=coalesce(p_to,clock_timestamp());
begin
  if p_event_types is not null and coalesce(cardinality(p_event_types),0)=0 then
    raise exception using errcode='22023',message='INVALID_AUDIT_QUERY'; end if;
  if p_event_types is null then v_previous_types:=null;
  else
    select coalesce(array_agg(requested),array[]::text[]) into v_previous_types
    from unnest(p_event_types) requested
    where requested not in ('complaint.rework_materialized','compensation.earned');
    if cardinality(v_previous_types)=0 then v_previous_types:=array['account.created']; end if;
  end if;
  return query select merged.* from (
    select previous.* from private.list_developer_audit_events_before_compensation(
      p_actor_profile_id,v_previous_types,p_filter_actor_profile_id,p_from,p_to,
      p_before_recorded_at,p_before_id,p_limit) previous
    where p_event_types is null or previous.event_type=any(p_event_types)
    union all
    select audit.id,audit.event_type,audit.entity_type,audit.entity_id,
      audit.actor_profile_id,audit.actor_display_name_snapshot,audit.effective_at,
      audit.recorded_at,audit.reason_code,
      case audit.event_type
        when 'complaint.rework_materialized' then jsonb_strip_nulls(jsonb_build_object(
          'complaintId',comp.complaint_case_id,
          'sourceComplaintDecisionId',comp.complaint_decision_id,
          'reworkCleaningTargetId',comp.rework_cleaning_target_id,
          'sameMaid',comp.original_maid_profile_id=comp.assignee_maid_profile_id,
          'compensationAmount',comp.compensation_amount,'currency',comp.currency,
          'caseVersion',audit.after_state->'caseVersion'))
        else jsonb_strip_nulls(jsonb_build_object(
          'complaintId',entitlement.complaint_case_id,
          'compensationDecisionId',entitlement.compensation_decision_id,
          'reworkCleaningTargetId',entitlement.rework_cleaning_target_id,
          'attemptId',entitlement.cleaning_attempt_id,
          'submissionId',entitlement.submission_id,
          'inspectionDecisionId',entitlement.inspection_decision_id,
          'amount',entitlement.amount,'currency',entitlement.currency,
          'earningId',earning.id)) end
    from public.audit_events audit
    left join public.complaint_compensation_decisions comp
      on audit.event_type='complaint.rework_materialized' and comp.id=audit.entity_id
    left join public.compensation_entitlements entitlement
      on audit.event_type='compensation.earned' and entitlement.id=audit.entity_id
    left join public.earnings earning on earning.compensation_entitlement_id=entitlement.id
    where audit.event_type in ('complaint.rework_materialized','compensation.earned')
      and (p_event_types is null or audit.event_type=any(p_event_types))
      and audit.recorded_at>=v_from and audit.recorded_at<=v_to
      and (p_filter_actor_profile_id is null or audit.actor_profile_id=p_filter_actor_profile_id)
      and (p_before_recorded_at is null or
        (audit.recorded_at,audit.id)<(p_before_recorded_at,p_before_id))
    order by recorded_at desc,id desc limit p_limit
  ) merged order by merged.recorded_at desc,merged.id desc limit p_limit;
end $$;
revoke all on function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) from public,anon,authenticated,service_role;
grant execute on function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) to service_role;
