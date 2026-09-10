-- Issue #100: approved-cleaning complaint, appeal and correction lifecycle.
-- Complaint facts are typed, decisions/responses/events are append-only, and
-- the mutable case row is only the current CAS projection.

alter table private.actor_authorization_denial_aggregates
  drop constraint actor_authorization_denial_aggregates_source_check,
  add constraint actor_authorization_denial_aggregates_source_check check (
    source in (
      'edge.authorization.accounts',
      'edge.authorization.developer',
      'edge.authorization.availability',
      'edge.authorization.assignments',
      'edge.authorization.attempts',
      'edge.authorization.complaints',
      'edge.authorization.photos',
      'edge.authorization.payroll',
      'edge.authorization.reservations',
      'edge.authorization.rooms'
    )
  ),
  drop constraint actor_authorization_denial_aggregates_reason_code_check,
  add constraint actor_authorization_denial_aggregates_reason_code_check check (
    reason_code in (
      'ACCOUNT_MANAGER_REQUIRED',
      'ADMIN_REQUIRED',
      'ASSIGNMENT_ACCESS_REQUIRED',
      'ATTEMPT_ACCESS_REQUIRED',
      'CAPABILITY_ACCESS_REQUIRED',
      'COMPLAINT_ACCESS_REQUIRED',
      'PHOTO_ACCESS_REQUIRED',
      'AVAILABILITY_ACCESS_REQUIRED',
      'DEVELOPER_REQUIRED',
      'MAID_REQUIRED',
      'BOMB_REPORT_ACCESS_REQUIRED',
      'SUBMISSION_ACCESS_REQUIRED',
      'PAYROLL_ACCESS_REQUIRED',
      'PASSWORD_CHANGE_REQUIRED'
    )
  );

create or replace function public.record_authorization_denial(
  p_actor_profile_id uuid,
  p_source text,
  p_reason_code text,
  p_occurred_at timestamptz default clock_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_bucket timestamptz;
begin
  if p_occurred_at is null
    or abs(extract(epoch from (clock_timestamp() - p_occurred_at))) > 300
    or p_source not in (
      'edge.authorization.accounts',
      'edge.authorization.developer',
      'edge.authorization.availability',
      'edge.authorization.assignments',
      'edge.authorization.attempts',
      'edge.authorization.complaints',
      'edge.authorization.photos',
      'edge.authorization.payroll',
      'edge.authorization.reservations',
      'edge.authorization.rooms'
    )
    or p_reason_code not in (
      'ACCOUNT_MANAGER_REQUIRED',
      'ADMIN_REQUIRED',
      'ASSIGNMENT_ACCESS_REQUIRED',
      'ATTEMPT_ACCESS_REQUIRED',
      'CAPABILITY_ACCESS_REQUIRED',
      'COMPLAINT_ACCESS_REQUIRED',
      'PHOTO_ACCESS_REQUIRED',
      'AVAILABILITY_ACCESS_REQUIRED',
      'DEVELOPER_REQUIRED',
      'MAID_REQUIRED',
      'BOMB_REPORT_ACCESS_REQUIRED',
      'SUBMISSION_ACCESS_REQUIRED',
      'PAYROLL_ACCESS_REQUIRED',
      'PASSWORD_CHANGE_REQUIRED'
    ) then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_EVENT';
  end if;

  select * into v_profile
  from public.profiles profile
  where profile.id = p_actor_profile_id
    and (
      profile.status = 'active'
      or (
        profile.role = 'maid'
        and profile.status in ('deactivation_pending', 'upload_only')
        and (
          (
            p_source = 'edge.authorization.attempts'
            and p_reason_code in (
              'CAPABILITY_ACCESS_REQUIRED', 'SUBMISSION_ACCESS_REQUIRED'
            )
          )
          or (
            p_source = 'edge.authorization.photos'
            and p_reason_code in (
              'PHOTO_ACCESS_REQUIRED', 'CAPABILITY_ACCESS_REQUIRED'
            )
          )
        )
      )
    );

  if not found then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_ACTOR';
  end if;

  v_bucket := date_trunc('minute', p_occurred_at);

  insert into private.actor_authorization_denial_aggregates (
    actor_profile_id,
    actor_role_snapshot,
    category,
    event_type,
    outcome,
    source,
    reason_code,
    bucket_started_at,
    occurrence_count,
    first_occurred_at,
    last_occurred_at
  ) values (
    v_profile.id,
    v_profile.role,
    'authorization',
    'authorization.denied',
    'denied',
    p_source,
    p_reason_code,
    v_bucket,
    1,
    p_occurred_at,
    p_occurred_at
  )
  on conflict (actor_profile_id, source, reason_code, bucket_started_at)
  do update set
    occurrence_count = least(
      private.actor_authorization_denial_aggregates.occurrence_count + 1,
      600
    ),
    last_occurred_at = greatest(
      private.actor_authorization_denial_aggregates.last_occurred_at,
      excluded.last_occurred_at
    );

  delete from private.actor_authorization_denial_aggregates aggregate
  where aggregate.id in (
    select expired.id
    from private.actor_authorization_denial_aggregates expired
    where expired.bucket_started_at < v_bucket - interval '31 days'
    order by expired.bucket_started_at
    limit 64
  );
end;
$$;

create table public.complaint_cases (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  cleaning_target_id uuid not null references public.cleaning_targets(id) on delete restrict,
  cleaning_attempt_id uuid not null references public.cleaning_attempts(id) on delete restrict,
  submission_id uuid not null references public.cleaning_submissions(id) on delete restrict,
  inspection_decision_id uuid not null references public.inspection_decisions(id) on delete restrict,
  original_earning_id uuid not null references public.earnings(id) on delete restrict,
  maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  category text not null check (category in (
    'cleanliness_general','bathroom_cleanliness','bedding_quality','trash_not_removed',
    'amenity_missing','damage_or_loss','odor_or_smoke','access_or_handover'
  )),
  status text not null check (status in (
    'received','under_review','decided','acknowledged','appealed','closed'
  )),
  version bigint not null default 1 check (version > 0),
  current_decision_id uuid,
  first_decided_at timestamptz,
  response_deadline timestamptz,
  received_by uuid not null references public.profiles(id) on delete restrict,
  received_at timestamptz not null,
  updated_at timestamptz not null,
  check (
    (current_decision_id is null and first_decided_at is null and response_deadline is null
      and status in ('received','under_review'))
    or (current_decision_id is not null and first_decided_at is not null
      and response_deadline = first_decided_at + interval '7 days'
      and status in ('decided','acknowledged','appealed','closed'))
  )
);

create table public.complaint_decisions (
  id uuid primary key default gen_random_uuid(),
  complaint_case_id uuid not null references public.complaint_cases(id) on delete restrict,
  decision_version integer not null check (decision_version > 0),
  decision_kind text not null check (decision_kind in ('initial','correction')),
  prior_decision_id uuid references public.complaint_decisions(id) on delete restrict,
  finding text not null check (finding in ('confirmed','unverifiable','false')),
  penalty_score integer not null check (penalty_score between 0 and 10),
  rework_required boolean not null,
  decided_by uuid not null references public.profiles(id) on delete restrict,
  decided_at timestamptz not null,
  unique (complaint_case_id, decision_version),
  unique (prior_decision_id),
  check (
    (decision_kind='initial' and decision_version=1 and prior_decision_id is null)
    or (decision_kind='correction' and decision_version>1 and prior_decision_id is not null)
  )
);

alter table public.complaint_cases
  add constraint complaint_cases_current_decision_fk
  foreign key (current_decision_id) references public.complaint_decisions(id) on delete restrict;

create table public.complaint_maid_responses (
  id uuid primary key default gen_random_uuid(),
  complaint_case_id uuid not null unique references public.complaint_cases(id) on delete restrict,
  decision_id uuid not null references public.complaint_decisions(id) on delete restrict,
  maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  response_type text not null check (response_type in ('acknowledged','appealed')),
  appeal_reason_code text,
  responded_at timestamptz not null,
  check (
    (response_type='acknowledged' and appeal_reason_code is null)
    or (response_type='appealed' and appeal_reason_code in (
      'work_completed_as_required','evidence_misinterpreted','not_responsible','timeline_mismatch'
    ))
  )
);

create table public.complaint_case_events (
  id bigint generated always as identity primary key,
  complaint_case_id uuid not null references public.complaint_cases(id) on delete restrict,
  event_type text not null check (event_type in (
    'received','review_started','decided','acknowledged','appealed','closed','corrected'
  )),
  from_status text,
  to_status text not null check (to_status in (
    'received','under_review','decided','acknowledged','appealed','closed'
  )),
  case_version bigint not null check (case_version > 0),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  decision_id uuid references public.complaint_decisions(id) on delete restrict,
  maid_response_id uuid references public.complaint_maid_responses(id) on delete restrict,
  occurred_at timestamptz not null,
  check (from_status is null or from_status in (
    'received','under_review','decided','acknowledged','appealed','closed'
  )),
  check (
    (event_type in ('decided','corrected') and decision_id is not null and maid_response_id is null)
    or (event_type in ('acknowledged','appealed') and decision_id is not null and maid_response_id is not null)
    or (event_type in ('received','review_started','closed') and maid_response_id is null)
  ),
  unique (complaint_case_id, case_version)
);

create index complaint_cases_admin_page_idx
on public.complaint_cases (received_at desc, id desc);
create index complaint_cases_maid_page_idx
on public.complaint_cases (maid_profile_id, received_at desc, id desc);
create index complaint_cases_room_idx on public.complaint_cases (room_id, received_at desc);
create index complaint_cases_target_idx on public.complaint_cases (cleaning_target_id);
create index complaint_cases_attempt_idx on public.complaint_cases (cleaning_attempt_id);
create index complaint_cases_submission_idx on public.complaint_cases (submission_id);
create index complaint_cases_inspection_idx on public.complaint_cases (inspection_decision_id);
create index complaint_cases_earning_idx on public.complaint_cases (original_earning_id);
create index complaint_decisions_case_idx
on public.complaint_decisions (complaint_case_id, decision_version desc);
create index complaint_responses_maid_idx
on public.complaint_maid_responses (maid_profile_id, responded_at desc);
create index complaint_events_case_page_idx
on public.complaint_case_events (complaint_case_id, id desc);

create function private.prevent_complaint_history_mutation()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception using errcode='55000',message='COMPLAINT_HISTORY_IMMUTABLE';
end $$;

revoke all on function private.prevent_complaint_history_mutation()
from public,anon,authenticated,service_role;

create trigger complaint_decisions_append_only before update or delete on public.complaint_decisions
for each row execute function private.prevent_complaint_history_mutation();
create trigger complaint_responses_append_only before update or delete on public.complaint_maid_responses
for each row execute function private.prevent_complaint_history_mutation();
create trigger complaint_events_append_only before update or delete on public.complaint_case_events
for each row execute function private.prevent_complaint_history_mutation();

create function private.guard_complaint_case_projection()
returns trigger language plpgsql set search_path='' as $$
declare v_response public.complaint_maid_responses;
begin
  if tg_op='DELETE' then
    raise exception using errcode='55000',message='COMPLAINT_CASE_DELETE_FORBIDDEN';
  end if;
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
  if old.status='received' and new.status='under_review' and new.current_decision_id is null then return new; end if;
  if old.status='under_review' and new.status='decided' and new.current_decision_id is not null
    and old.current_decision_id is null then return new; end if;
  if old.status='decided' and new.status in ('acknowledged','appealed')
    and new.current_decision_id=old.current_decision_id then return new; end if;
  if old.status='decided' and new.status='closed' and transaction_timestamp()>old.response_deadline
    and new.current_decision_id=old.current_decision_id then return new; end if;
  if old.status='acknowledged' and new.status='closed'
    and new.current_decision_id=old.current_decision_id then return new; end if;
  if old.status='appealed' and new.status='closed' then
    select * into v_response from public.complaint_maid_responses response
    where response.complaint_case_id=old.id;
    if v_response.id is not null and exists(
      select 1 from public.complaint_case_events correction_event
      join public.complaint_case_events response_event
        on response_event.maid_response_id=v_response.id
      where correction_event.complaint_case_id=old.id
        and correction_event.event_type='corrected'
        and correction_event.decision_id=old.current_decision_id
        and correction_event.id>response_event.id
    )
      and new.current_decision_id=old.current_decision_id then return new; end if;
  end if;
  if new.status=old.status and old.status in ('decided','acknowledged','appealed','closed')
    and new.current_decision_id<>old.current_decision_id
    and new.first_decided_at=old.first_decided_at and new.response_deadline=old.response_deadline then
    return new;
  end if;
  raise exception using errcode='55000',message='COMPLAINT_INVALID_TRANSITION';
end $$;

revoke all on function private.guard_complaint_case_projection()
from public,anon,authenticated,service_role;
create trigger complaint_case_projection_guard before update or delete on public.complaint_cases
for each row execute function private.guard_complaint_case_projection();

create function private.validate_complaint_decision_lineage()
returns trigger language plpgsql set search_path='' as $$
declare v_prior public.complaint_decisions;
begin
  if new.prior_decision_id is null then return new; end if;
  select * into v_prior from public.complaint_decisions where id=new.prior_decision_id;
  if v_prior.id is null or v_prior.complaint_case_id<>new.complaint_case_id
    or v_prior.decision_version+1<>new.decision_version then
    raise exception using errcode='23514',message='COMPLAINT_DECISION_LINEAGE_INVALID';
  end if;
  return new;
end $$;

revoke all on function private.validate_complaint_decision_lineage()
from public,anon,authenticated,service_role;
create trigger complaint_decision_lineage before insert on public.complaint_decisions
for each row execute function private.validate_complaint_decision_lineage();

alter table public.complaint_cases enable row level security;
alter table public.complaint_decisions enable row level security;
alter table public.complaint_maid_responses enable row level security;
alter table public.complaint_case_events enable row level security;

create policy complaint_cases_read on public.complaint_cases for select to authenticated
using (exists(select 1 from public.profiles actor
  where actor.id=(select private.current_profile_id()) and actor.status='active'
    and not actor.must_change_password
    and (actor.role='admin' or (actor.role='maid' and actor.id=maid_profile_id))));
create policy complaint_decisions_read on public.complaint_decisions for select to authenticated
using (exists(select 1 from public.complaint_cases c where c.id=complaint_case_id
  and exists(select 1 from public.profiles actor
    where actor.id=(select private.current_profile_id()) and actor.status='active'
      and not actor.must_change_password
      and (actor.role='admin' or (actor.role='maid' and actor.id=c.maid_profile_id)))));
create policy complaint_responses_read on public.complaint_maid_responses for select to authenticated
using (exists(select 1 from public.complaint_cases c where c.id=complaint_case_id
  and exists(select 1 from public.profiles actor
    where actor.id=(select private.current_profile_id()) and actor.status='active'
      and not actor.must_change_password
      and (actor.role='admin' or (actor.role='maid' and actor.id=c.maid_profile_id)))));
create policy complaint_events_read on public.complaint_case_events for select to authenticated
using (exists(select 1 from public.complaint_cases c where c.id=complaint_case_id
  and exists(select 1 from public.profiles actor
    where actor.id=(select private.current_profile_id()) and actor.status='active'
      and not actor.must_change_password
      and (actor.role='admin' or (actor.role='maid' and actor.id=c.maid_profile_id)))));

revoke all on table public.complaint_cases,public.complaint_decisions,
  public.complaint_maid_responses,public.complaint_case_events
from public,anon,authenticated,service_role;
grant select on table public.complaint_cases,public.complaint_decisions,
  public.complaint_maid_responses,public.complaint_case_events to authenticated,service_role;

create function private.assert_complaint_admin(p_actor uuid)
returns public.profiles language plpgsql stable security definer set search_path='' as $$
declare v_actor public.profiles;
begin
  select * into v_actor from public.profiles p where p.id=p_actor and p.role='admin'
    and p.status='active' and not p.must_change_password;
  if v_actor.id is null then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  return v_actor;
end $$;

create function private.assert_complaint_reader(p_actor uuid)
returns public.profiles language plpgsql stable security definer set search_path='' as $$
declare v_actor public.profiles;
begin
  select * into v_actor from public.profiles p where p.id=p_actor and p.role in ('admin','maid')
    and p.status='active' and not p.must_change_password;
  if v_actor.id is null then raise exception using errcode='42501',message='COMPLAINT_ACCESS_REQUIRED'; end if;
  return v_actor;
end $$;

create function private.complaint_projection(p_case public.complaint_cases)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id',p_case.id,'roomId',p_case.room_id,'cleaningTargetId',p_case.cleaning_target_id,
    'cleaningAttemptId',p_case.cleaning_attempt_id,'submissionId',p_case.submission_id,
    'inspectionDecisionId',p_case.inspection_decision_id,'originalEarningId',p_case.original_earning_id,
    'maidProfileId',p_case.maid_profile_id,'category',p_case.category,'status',p_case.status,
    'version',p_case.version,'currentDecisionId',p_case.current_decision_id,
    'firstDecidedAt',p_case.first_decided_at,'responseDeadline',p_case.response_deadline,
    'receivedAt',p_case.received_at,'updatedAt',p_case.updated_at)
$$;

create function private.complaint_decision_projection(p_decision public.complaint_decisions)
returns jsonb language sql stable set search_path='' as $$
  select case when p_decision.id is null then null else jsonb_build_object(
    'id',p_decision.id,'complaintId',p_decision.complaint_case_id,
    'decisionVersion',p_decision.decision_version,'decisionKind',p_decision.decision_kind,
    'priorDecisionId',p_decision.prior_decision_id,'finding',p_decision.finding,
    'penaltyScore',p_decision.penalty_score,'reworkRequired',p_decision.rework_required,
    'decidedAt',p_decision.decided_at) end
$$;

create function private.complaint_response_projection(p_response public.complaint_maid_responses)
returns jsonb language sql stable set search_path='' as $$
  select case when p_response.id is null then null else jsonb_build_object(
    'id',p_response.id,'complaintId',p_response.complaint_case_id,'decisionId',p_response.decision_id,
    'maidProfileId',p_response.maid_profile_id,'responseType',p_response.response_type,
    'appealReasonCode',p_response.appeal_reason_code,'respondedAt',p_response.responded_at) end
$$;

create function private.get_complaint_projection(p_case_id uuid)
returns jsonb language plpgsql stable set search_path='' as $$
declare v_case public.complaint_cases; v_decision public.complaint_decisions; v_response public.complaint_maid_responses;
begin
  select * into v_case from public.complaint_cases where id=p_case_id;
  if v_case.id is null then return null; end if;
  select * into v_decision from public.complaint_decisions where id=v_case.current_decision_id;
  select * into v_response from public.complaint_maid_responses where complaint_case_id=v_case.id;
  return private.complaint_projection(v_case)||jsonb_build_object(
    'currentDecision',private.complaint_decision_projection(v_decision),
    'maidResponse',private.complaint_response_projection(v_response));
end $$;

create function private.enqueue_complaint_notice(
  p_recipient uuid,p_case public.complaint_cases,p_kind text,p_version bigint,p_at timestamptz
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  if p_kind not in ('received','decided','corrected','acknowledged','appealed','closed') then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_NOTICE';
  end if;
  insert into public.notifications(recipient_profile_id,category,title,body,room_id,cleaning_target_id,
    dedupe_key,requires_action,occurred_at)
  values(p_recipient,'complaint_'||p_kind,
    case p_kind when 'received' then '컴플레인 접수' when 'decided' then '컴플레인 판정'
      when 'corrected' then '컴플레인 판정 정정' when 'acknowledged' then '컴플레인 확인 완료'
      when 'appealed' then '컴플레인 이의 제기' else '컴플레인 종결' end,
    case p_kind when 'received' then '승인된 청소에 컴플레인이 접수되었습니다.'
      when 'decided' then '컴플레인 판정이 등록되었습니다.' when 'corrected' then '컴플레인 판정이 정정되었습니다.'
      when 'acknowledged' then '담당 메이드가 판정을 확인했습니다.' when 'appealed' then '담당 메이드가 판정에 이의를 제기했습니다.'
      else '컴플레인 처리가 종결되었습니다.' end,
    p_case.room_id,p_case.cleaning_target_id,
    'complaint:'||p_case.id::text||':'||p_kind||':'||p_version::text,
    p_kind in ('decided','corrected','appealed'),p_at) returning id into v_id;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
  values(v_id,'web_push','pending',p_at,p_at);
  return v_id;
end $$;

revoke all on function private.assert_complaint_admin(uuid),private.assert_complaint_reader(uuid),
  private.complaint_projection(public.complaint_cases),
  private.complaint_decision_projection(public.complaint_decisions),
  private.complaint_response_projection(public.complaint_maid_responses),
  private.get_complaint_projection(uuid),
  private.enqueue_complaint_notice(uuid,public.complaint_cases,text,bigint,timestamptz)
from public,anon,authenticated,service_role;

create function public.create_complaint_case(
  p_actor_profile_id uuid,p_original_earning_id uuid,p_category text,p_expected_version bigint,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_earning public.earnings; v_submission public.cleaning_submissions;
  v_attempt public.cleaning_attempts; v_target public.cleaning_targets; v_inspection public.inspection_decisions;
  v_case public.complaint_cases; v_replay jsonb; v_result jsonb; v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.create',p_idempotency_key,p_request_hash);
  if p_expected_version is distinct from 0 then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if p_category is null or p_category not in ('cleanliness_general','bathroom_cleanliness','bedding_quality',
    'trash_not_removed','amenity_missing','damage_or_loss','odor_or_smoke','access_or_handover') then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_CATEGORY'; end if;
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_earning from public.earnings where id=p_original_earning_id;
  select * into v_submission from public.cleaning_submissions where id=v_earning.submission_id;
  select * into v_attempt from public.cleaning_attempts where id=v_submission.cleaning_attempt_id;
  select * into v_target from public.cleaning_targets where id=v_attempt.cleaning_target_id;
  select * into v_inspection from public.inspection_decisions where submission_id=v_submission.id;
  if v_earning.id is null or v_submission.id is null or v_attempt.id is null or v_target.id is null
    or v_inspection.id is null or v_inspection.decision<>'approved' or v_submission.status<>'approved'
    or v_attempt.status<>'approved' or v_target.status<>'approved' or v_target.source='inspection_reclean'
    or v_earning.earning_entitlement_id<>v_submission.id or v_earning.maid_profile_id<>v_attempt.maid_profile_id
    or v_submission.submitted_by<>v_attempt.maid_profile_id then
    raise exception using errcode='55000',message='COMPLAINT_SOURCE_NOT_APPROVED';
  end if;
  if v_inspection.decided_at>v_at or v_at>v_inspection.decided_at+interval '30 days' then
    raise exception using errcode='22023',message='COMPLAINT_INTAKE_WINDOW_CLOSED';
  end if;
  insert into public.complaint_cases(room_id,cleaning_target_id,cleaning_attempt_id,submission_id,
    inspection_decision_id,original_earning_id,maid_profile_id,category,status,version,received_by,received_at,updated_at)
  values(v_target.room_id,v_target.id,v_attempt.id,v_submission.id,v_inspection.id,v_earning.id,
    v_attempt.maid_profile_id,p_category,'received',1,v_actor.id,v_at,v_at) returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,actor_profile_id,occurred_at)
  values(v_case.id,'received',null,'received',1,v_actor.id,v_at);
  perform private.enqueue_complaint_notice(v_case.maid_profile_id,v_case,'received',1,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,reason_code,after_state,idempotency_key)
  values(v_actor.id,'complaint.received','complaint_case',v_case.id,v_at,p_category,
    jsonb_build_object('complaintId',v_case.id,'originalEarningId',v_case.original_earning_id,'status','received','version',1),
    private.audit_command_key(v_actor.id,'complaint.create',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.create',p_idempotency_key,p_request_hash,v_case.id,v_result);
  return v_result;
end $$;

create function public.start_complaint_review(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases; v_replay jsonb; v_result jsonb; v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.review',p_idempotency_key,p_request_hash);
  if v_replay is not null then return v_replay; end if;
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_case.version is distinct from p_expected_version then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if v_case.status<>'received' then raise exception using errcode='55000',message='COMPLAINT_INVALID_TRANSITION'; end if;
  update public.complaint_cases set status='under_review',version=version+1,updated_at=v_at where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,actor_profile_id,occurred_at)
  values(v_case.id,'review_started','received','under_review',v_case.version,v_actor.id,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,after_state,idempotency_key)
  values(v_actor.id,'complaint.review_started','complaint_case',v_case.id,v_at,
    jsonb_build_object('complaintId',v_case.id,'status',v_case.status,'version',v_case.version),
    private.audit_command_key(v_actor.id,'complaint.review',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.review',p_idempotency_key,p_request_hash,v_case.id,v_result);
  return v_result;
end $$;

create function public.decide_complaint_case(
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
  if p_rework_required is null then raise exception using errcode='22023',message='INVALID_REWORK_DECISION'; end if;
  if v_replay is not null then return v_replay; end if;
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_case.version is distinct from p_expected_version then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if v_case.status<>'under_review' or v_case.current_decision_id is not null then
    raise exception using errcode='55000',message='COMPLAINT_INVALID_TRANSITION'; end if;
  insert into public.complaint_decisions(complaint_case_id,decision_version,decision_kind,finding,penalty_score,rework_required,decided_by,decided_at)
  values(v_case.id,1,'initial',p_finding,p_penalty_score,p_rework_required,v_actor.id,v_at) returning * into v_decision;
  update public.complaint_cases set status='decided',version=version+1,current_decision_id=v_decision.id,
    first_decided_at=v_at,response_deadline=v_at+interval '7 days',updated_at=v_at
  where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,actor_profile_id,decision_id,occurred_at)
  values(v_case.id,'decided','under_review','decided',v_case.version,v_actor.id,v_decision.id,v_at);
  perform private.enqueue_complaint_notice(v_case.maid_profile_id,v_case,'decided',v_case.version,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,after_state,idempotency_key)
  values(v_actor.id,'complaint.decided','complaint_case',v_case.id,v_at,
    jsonb_build_object('complaintId',v_case.id,'decisionId',v_decision.id,'finding',p_finding,
      'penaltyScore',p_penalty_score,'reworkRequired',p_rework_required,'status',v_case.status,'version',v_case.version),
    private.audit_command_key(v_actor.id,'complaint.decide',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.decide',p_idempotency_key,p_request_hash,v_case.id,v_result);
  return v_result;
end $$;

create function public.respond_to_complaint(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,p_response_type text,
  p_appeal_reason_code text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases; v_response public.complaint_maid_responses;
  v_decision public.complaint_decisions; v_replay jsonb; v_result jsonb; v_at timestamptz:=transaction_timestamp();
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
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null or v_case.maid_profile_id<>v_actor.id then
    raise exception using errcode='42501',message='COMPLAINT_MAID_MISMATCH'; end if;
  if v_case.version is distinct from p_expected_version then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if v_case.status<>'decided' or v_case.current_decision_id is null then
    raise exception using errcode='55000',message='COMPLAINT_INVALID_TRANSITION'; end if;
  if v_at>v_case.response_deadline then
    raise exception using errcode='22023',message='COMPLAINT_RESPONSE_WINDOW_CLOSED'; end if;
  if exists(select 1 from public.complaint_maid_responses r where r.complaint_case_id=v_case.id) then
    raise exception using errcode='23505',message='COMPLAINT_RESPONSE_ALREADY_RECORDED'; end if;
  select * into v_decision from public.complaint_decisions
  where complaint_case_id=v_case.id and decision_version=1;
  insert into public.complaint_maid_responses(complaint_case_id,decision_id,maid_profile_id,response_type,appeal_reason_code,responded_at)
  values(v_case.id,v_decision.id,v_actor.id,p_response_type,p_appeal_reason_code,v_at) returning * into v_response;
  update public.complaint_cases set status=p_response_type,version=version+1,updated_at=v_at
  where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,
    actor_profile_id,decision_id,maid_response_id,occurred_at)
  values(v_case.id,p_response_type,'decided',p_response_type,v_case.version,v_actor.id,v_decision.id,v_response.id,v_at);
  perform private.enqueue_complaint_notice(v_decision.decided_by,v_case,p_response_type,v_case.version,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,reason_code,after_state,idempotency_key)
  values(v_actor.id,'complaint.'||p_response_type,'complaint_case',v_case.id,v_at,p_appeal_reason_code,
    jsonb_strip_nulls(jsonb_build_object('complaintId',v_case.id,'decisionId',v_decision.id,
      'responseType',p_response_type,'appealReasonCode',p_appeal_reason_code,'status',v_case.status,'version',v_case.version)),
    private.audit_command_key(v_actor.id,'complaint.respond',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.respond',p_idempotency_key,p_request_hash,v_case.id,v_result);
  return v_result;
end $$;

create function public.correct_complaint_decision(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,p_finding text,
  p_penalty_score integer,p_rework_required boolean,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases; v_prior public.complaint_decisions;
  v_decision public.complaint_decisions; v_replay jsonb; v_result jsonb; v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.correct',p_idempotency_key,p_request_hash);
  if p_finding is null or p_finding not in ('confirmed','unverifiable','false') then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_FINDING'; end if;
  if p_penalty_score is null or p_penalty_score<0 or p_penalty_score>10 then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_PENALTY'; end if;
  if p_rework_required is null then raise exception using errcode='22023',message='INVALID_REWORK_DECISION'; end if;
  if v_replay is not null then return v_replay; end if;
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_case.version is distinct from p_expected_version then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if v_case.status not in ('decided','acknowledged','appealed','closed') or v_case.current_decision_id is null then
    raise exception using errcode='55000',message='COMPLAINT_DECISION_REQUIRED'; end if;
  select * into v_prior from public.complaint_decisions where id=v_case.current_decision_id for share;
  insert into public.complaint_decisions(complaint_case_id,decision_version,decision_kind,prior_decision_id,
    finding,penalty_score,rework_required,decided_by,decided_at)
  values(v_case.id,v_prior.decision_version+1,'correction',v_prior.id,p_finding,p_penalty_score,p_rework_required,v_actor.id,v_at)
  returning * into v_decision;
  update public.complaint_cases set current_decision_id=v_decision.id,version=version+1,updated_at=v_at
  where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,actor_profile_id,decision_id,occurred_at)
  values(v_case.id,'corrected',v_case.status,v_case.status,v_case.version,v_actor.id,v_decision.id,v_at);
  perform private.enqueue_complaint_notice(v_case.maid_profile_id,v_case,'corrected',v_case.version,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,after_state,idempotency_key)
  values(v_actor.id,'complaint.corrected','complaint_case',v_case.id,v_at,
    jsonb_build_object('complaintId',v_case.id,'decisionId',v_decision.id,'priorDecisionId',v_prior.id,
      'finding',p_finding,'penaltyScore',p_penalty_score,'reworkRequired',p_rework_required,
      'status',v_case.status,'version',v_case.version),
    private.audit_command_key(v_actor.id,'complaint.correct',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.correct',p_idempotency_key,p_request_hash,v_case.id,v_result);
  return v_result;
end $$;

create function public.close_complaint_case(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases; v_response public.complaint_maid_responses;
  v_appeal_resolved boolean;
  v_replay jsonb; v_result jsonb; v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.close',p_idempotency_key,p_request_hash);
  if v_replay is not null then return v_replay; end if;
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_case.version is distinct from p_expected_version then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  select * into v_response from public.complaint_maid_responses where complaint_case_id=v_case.id;
  select exists(
    select 1 from public.complaint_case_events correction_event
    join public.complaint_case_events response_event on response_event.maid_response_id=v_response.id
    where correction_event.complaint_case_id=v_case.id and correction_event.event_type='corrected'
      and correction_event.decision_id=v_case.current_decision_id and correction_event.id>response_event.id
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
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,actor_profile_id,decision_id,occurred_at)
  values(v_case.id,'closed',case when v_response.response_type is null then 'decided' else v_response.response_type end,
    'closed',v_case.version,v_actor.id,v_case.current_decision_id,v_at);
  perform private.enqueue_complaint_notice(v_case.maid_profile_id,v_case,'closed',v_case.version,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,after_state,idempotency_key)
  values(v_actor.id,'complaint.closed','complaint_case',v_case.id,v_at,
    jsonb_build_object('complaintId',v_case.id,'status','closed','version',v_case.version),
    private.audit_command_key(v_actor.id,'complaint.close',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.close',p_idempotency_key,p_request_hash,v_case.id,v_result);
  return v_result;
end $$;

create function public.list_complaint_cases_page(
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
    raise exception using errcode='22023',message='COMPLAINT_CURSOR_INVALID'; end if;
  with page as (
    select c.* from public.complaint_cases c
    where c.received_at>=p_from and c.received_at<p_to
      and (v_actor.role='admin' or c.maid_profile_id=v_actor.id)
      and (p_after_received_at is null or (c.received_at,c.id)<(p_after_received_at,p_after_id))
    order by c.received_at desc,c.id desc limit p_limit+1
  ), kept as (select * from page order by received_at desc,id desc limit p_limit)
  select coalesce(jsonb_agg(private.get_complaint_projection(k.id) order by k.received_at desc,k.id desc),'[]'::jsonb),
    (select count(*)>p_limit from page),
    (select received_at from kept order by received_at,id limit 1),
    (select id from kept order by received_at,id limit 1)
  into v_rows,v_has_more,v_last_at,v_last_id from kept k;
  return jsonb_build_object('complaints',v_rows,'hasMore',coalesce(v_has_more,false),
    'lastReceivedAt',case when v_has_more then v_last_at else null end,
    'lastId',case when v_has_more then v_last_id else null end);
end $$;

create function public.get_complaint_case(p_actor_profile_id uuid,p_complaint_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases;
begin
  v_actor:=private.assert_complaint_reader(p_actor_profile_id);
  select * into v_case from public.complaint_cases c where c.id=p_complaint_id;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_actor.role='maid' and v_case.maid_profile_id<>v_actor.id then
    raise exception using errcode='42501',message='COMPLAINT_MAID_MISMATCH'; end if;
  return private.get_complaint_projection(v_case.id);
end $$;

create function public.list_complaint_history_page(
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
      d.prior_decision_id,d.finding,d.penalty_score,d.rework_required,d.decided_by,d.decided_at,
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

revoke all on function public.create_complaint_case(uuid,uuid,text,bigint,text,text),
  public.start_complaint_review(uuid,uuid,bigint,text,text),
  public.decide_complaint_case(uuid,uuid,bigint,text,integer,boolean,text,text),
  public.respond_to_complaint(uuid,uuid,bigint,text,text,text,text),
  public.correct_complaint_decision(uuid,uuid,bigint,text,integer,boolean,text,text),
  public.close_complaint_case(uuid,uuid,bigint,text,text),
  public.list_complaint_cases_page(uuid,timestamptz,timestamptz,timestamptz,uuid,integer),
  public.get_complaint_case(uuid,uuid),public.list_complaint_history_page(uuid,uuid,bigint,integer)
from public,anon,authenticated,service_role;

grant execute on function public.create_complaint_case(uuid,uuid,text,bigint,text,text),
  public.start_complaint_review(uuid,uuid,bigint,text,text),
  public.decide_complaint_case(uuid,uuid,bigint,text,integer,boolean,text,text),
  public.respond_to_complaint(uuid,uuid,bigint,text,text,text,text),
  public.correct_complaint_decision(uuid,uuid,bigint,text,integer,boolean,text,text),
  public.close_complaint_case(uuid,uuid,bigint,text,text),
  public.list_complaint_cases_page(uuid,timestamptz,timestamptz,timestamptz,uuid,integer),
  public.get_complaint_case(uuid,uuid),public.list_complaint_history_page(uuid,uuid,bigint,integer)
to service_role;

comment on table public.complaint_cases is
'#100 current complaint projection. Source identity is immutable; all changes use CAS RPCs.';
comment on table public.complaint_decisions is
'#100 immutable initial/correction decision versions. penalty_score is evaluation-only.';
comment on table public.complaint_maid_responses is
'#100 one immutable acknowledgement or appeal for the original decision.';
comment on table public.complaint_case_events is
'#100 append-only complaint lifecycle history.';
