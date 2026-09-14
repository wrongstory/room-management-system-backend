-- Issue #31: immutable submission, inspection, bomb-room and reclean lifecycle.
-- This migration is append-only; previously applied migrations remain untouched.

create table private.bomb_room_reports (
  id uuid primary key default gen_random_uuid(),
  cleaning_attempt_id uuid not null unique references public.cleaning_attempts(id) on delete restrict,
  reported_by uuid not null references public.profiles(id) on delete restrict,
  memo text not null check (char_length(memo) between 1 and 500),
  reported_at timestamptz not null default clock_timestamp()
);

create table private.bomb_room_report_evidence (
  report_id uuid not null references private.bomb_room_reports(id) on delete restrict,
  photo_version_id uuid not null references private.attempt_photo_versions(id) on delete restrict,
  primary key (report_id, photo_version_id)
);

create table private.bomb_room_report_seals (
  report_id uuid primary key references private.bomb_room_reports(id) on delete restrict,
  submission_id uuid not null unique references public.cleaning_submissions(id) on delete restrict,
  sealed_at timestamptz not null default clock_timestamp(),
  unique (report_id, submission_id)
);

create table private.bomb_room_decisions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null unique references private.bomb_room_reports(id) on delete restrict,
  submission_id uuid not null unique references public.cleaning_submissions(id) on delete restrict,
  decision text not null check (decision in ('approved','rejected')),
  reason_code text not null check (reason_code ~ '^[A-Z0-9_]{2,80}$'),
  decided_by uuid not null references public.profiles(id) on delete restrict,
  decided_at timestamptz not null default clock_timestamp(),
  foreign key (report_id, submission_id)
    references private.bomb_room_report_seals(report_id, submission_id) on delete restrict
);

alter table public.cleaning_targets
  add column reclean_of_submission_id uuid references public.cleaning_submissions(id) on delete restrict,
  add column reclean_of_inspection_decision_id uuid unique references public.inspection_decisions(id) on delete restrict,
  add constraint cleaning_targets_inspection_reclean_provenance_check check (
    (source='inspection_reclean' and reclean_of_submission_id is not null and reclean_of_inspection_decision_id is not null)
    or (source<>'inspection_reclean' and reclean_of_submission_id is null and reclean_of_inspection_decision_id is null)
  );

alter table public.earnings
  add column bomb_room_decision_id uuid unique
    references private.bomb_room_decisions(id) on delete restrict,
  add constraint earnings_bomb_bonus_source_check check (
    (bomb_room_decision_id is null and bomb_room_bonus=0)
    or (bomb_room_decision_id is not null and bomb_room_bonus=base_amount)
  );

alter table public.checkout_cleaning_obligations
  add column completion_submission_id uuid unique
    references public.cleaning_submissions(id) on delete restrict;

create index bomb_room_reports_actor_idx on private.bomb_room_reports(reported_by, reported_at desc);
create index bomb_room_report_evidence_photo_idx on private.bomb_room_report_evidence(photo_version_id);
create index bomb_room_decisions_actor_idx on private.bomb_room_decisions(decided_by, decided_at desc);
create index cleaning_targets_reclean_submission_idx on public.cleaning_targets(reclean_of_submission_id)
  where reclean_of_submission_id is not null;
create unique index cleaning_targets_reclean_submission_unique on public.cleaning_targets(reclean_of_submission_id)
  where reclean_of_submission_id is not null;

do $$ declare n text; begin
  foreach n in array array['bomb_room_reports','bomb_room_report_evidence','bomb_room_report_seals','bomb_room_decisions'] loop
    execute format('alter table private.%I enable row level security', n);
    execute format('revoke all on table private.%I from public,anon,authenticated,service_role', n);
  end loop;
end $$;

-- #31 adds two source-controlled denial codes. Keep denial logging bounded and
-- callable only from the service-owned Edge/Fastify boundary; otherwise an
-- intended 403 could be replaced by ACTIVITY_RECORD_FAILED.
alter table private.actor_authorization_denial_aggregates
  drop constraint actor_authorization_denial_aggregates_reason_code_check,
  add constraint actor_authorization_denial_aggregates_reason_code_check check (
    reason_code in (
      'ACCOUNT_MANAGER_REQUIRED',
      'ADMIN_REQUIRED',
      'ASSIGNMENT_ACCESS_REQUIRED',
      'ATTEMPT_ACCESS_REQUIRED',
      'CAPABILITY_ACCESS_REQUIRED',
      'PHOTO_ACCESS_REQUIRED',
      'AVAILABILITY_ACCESS_REQUIRED',
      'DEVELOPER_REQUIRED',
      'MAID_REQUIRED',
      'BOMB_REPORT_ACCESS_REQUIRED',
      'SUBMISSION_ACCESS_REQUIRED',
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
      'edge.authorization.photos',
      'edge.authorization.reservations',
      'edge.authorization.rooms'
    )
    or p_reason_code not in (
      'ACCOUNT_MANAGER_REQUIRED',
      'ADMIN_REQUIRED',
      'ASSIGNMENT_ACCESS_REQUIRED',
      'ATTEMPT_ACCESS_REQUIRED',
      'CAPABILITY_ACCESS_REQUIRED',
      'PHOTO_ACCESS_REQUIRED',
      'AVAILABILITY_ACCESS_REQUIRED',
      'DEVELOPER_REQUIRED',
      'MAID_REQUIRED',
      'BOMB_REPORT_ACCESS_REQUIRED',
      'SUBMISSION_ACCESS_REQUIRED',
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
            and p_reason_code in ('CAPABILITY_ACCESS_REQUIRED', 'SUBMISSION_ACCESS_REQUIRED')
          )
          or (
            p_source = 'edge.authorization.photos'
            and p_reason_code in ('PHOTO_ACCESS_REQUIRED', 'CAPABILITY_ACCESS_REQUIRED')
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

revoke all on function public.record_authorization_denial(uuid, text, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.record_authorization_denial(uuid, text, text, timestamptz)
to service_role;

create function private.guard_submission_inspection_append_only()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception using errcode='55000',message='SUBMISSION_INSPECTION_IMMUTABLE';
end $$;
revoke all on function private.guard_submission_inspection_append_only() from public,anon,authenticated,service_role;

do $$ declare n text; begin
  foreach n in array array['bomb_room_reports','bomb_room_report_evidence','bomb_room_report_seals','bomb_room_decisions'] loop
    execute format('create trigger submission_inspection_append_only before update or delete on private.%I for each row execute function private.guard_submission_inspection_append_only()', n);
  end loop;
end $$;

create trigger earnings_append_only before update or delete on public.earnings
for each row execute function private.prevent_append_only_mutation();

create function private.validate_inspection_earning_source()
returns trigger language plpgsql set search_path='' as $$
declare bomb_decision private.bomb_room_decisions;
begin
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
revoke all on function private.validate_inspection_earning_source() from public,anon,authenticated,service_role;
create trigger inspection_earning_source_validate before insert on public.earnings
for each row execute function private.validate_inspection_earning_source();

create or replace function private.enforce_reclean_origin_room()
returns trigger language plpgsql set search_path='' as $$
declare origin_attempt public.cleaning_attempts; origin_target public.cleaning_targets;
  source_submission public.cleaning_submissions; source_decision public.inspection_decisions;
begin
  if tg_op='UPDATE' and (
    new.source is distinct from old.source
    or new.reclean_of_attempt_id is distinct from old.reclean_of_attempt_id
    or new.reclean_maid_profile_id is distinct from old.reclean_maid_profile_id
    or new.reclean_of_submission_id is distinct from old.reclean_of_submission_id
    or new.reclean_of_inspection_decision_id is distinct from old.reclean_of_inspection_decision_id
  ) then
    raise exception using errcode='55000',message='CLEANING_TARGET_ORIGIN_IMMUTABLE';
  end if;
  if new.source<>'inspection_reclean' then return new; end if;
  select * into origin_attempt from public.cleaning_attempts where id=new.reclean_of_attempt_id;
  select * into origin_target from public.cleaning_targets where id=origin_attempt.cleaning_target_id;
  select * into source_submission from public.cleaning_submissions where id=new.reclean_of_submission_id;
  select * into source_decision from public.inspection_decisions where id=new.reclean_of_inspection_decision_id;
  if origin_attempt.id is null or origin_attempt.maid_profile_id<>new.reclean_maid_profile_id
    or origin_target.id is null or origin_target.room_id<>new.room_id
    or source_submission.id is null or source_submission.cleaning_attempt_id<>origin_attempt.id
    or source_decision.id is null or source_decision.submission_id<>source_submission.id
    or source_decision.decision<>'rejected' then
    raise exception using errcode='23514',message='RECLEAN_PROVENANCE_MISMATCH';
  end if;
  return new;
end $$;
revoke all on function private.enforce_reclean_origin_room() from public,anon,authenticated,service_role;
drop trigger cleaning_targets_enforce_reclean_origin on public.cleaning_targets;
create trigger cleaning_targets_enforce_reclean_origin
before insert or update of room_id,source,reclean_of_attempt_id,reclean_maid_profile_id,
  reclean_of_submission_id,reclean_of_inspection_decision_id
on public.cleaning_targets for each row execute function private.enforce_reclean_origin_room();

create function private.approved_submission_work_proof(
  p_submission uuid,p_attempt uuid,p_room uuid,p_not_before timestamptz,p_not_after timestamptz
) returns boolean language sql stable set search_path='' as $$
  select exists(select 1 from public.cleaning_submissions submission
    join public.inspection_decisions decision on decision.submission_id=submission.id
    join public.cleaning_attempts attempt on attempt.id=submission.cleaning_attempt_id
    join public.cleaning_targets target on target.id=attempt.cleaning_target_id
    where submission.id=p_submission and attempt.id=p_attempt and target.room_id=p_room
      and submission.status='approved' and decision.decision='approved'
      and attempt.status='approved' and target.status='approved'
      and target.available_from is not null and target.available_from>=p_not_before
      and attempt.started_at is not null and attempt.field_completed_at is not null and attempt.ended_at is not null
      and attempt.started_at>=target.available_from and attempt.field_completed_at>=attempt.started_at
      and attempt.ended_at>=attempt.field_completed_at and submission.submitted_at>=attempt.ended_at
      and decision.decided_at>=submission.submitted_at and decision.decided_at<=p_not_after)
$$;
revoke all on function private.approved_submission_work_proof(uuid,uuid,uuid,timestamptz,timestamptz)
  from public,anon,authenticated,service_role;

create function private.checkout_submission_proves_completion(p_obligation uuid,p_submission uuid)
returns boolean language sql stable set search_path='' as $$
  with recursive lineage(target_id,depth) as (
    select obligation.current_cleaning_target_id,0 from public.checkout_cleaning_obligations obligation
      where obligation.id=p_obligation and obligation.current_cleaning_target_id is not null
    union all
    select child.id,lineage.depth+1 from lineage
      join public.cleaning_attempts origin_attempt on origin_attempt.cleaning_target_id=lineage.target_id
      join public.cleaning_submissions origin_submission on origin_submission.cleaning_attempt_id=origin_attempt.id
      join public.inspection_decisions rejection on rejection.submission_id=origin_submission.id and rejection.decision='rejected'
      join public.cleaning_targets child on child.source='inspection_reclean'
        and child.reclean_of_attempt_id=origin_attempt.id and child.reclean_of_submission_id=origin_submission.id
        and child.reclean_of_inspection_decision_id=rejection.id
      where lineage.depth<32
  ), candidate as (
    select submission.cleaning_attempt_id,attempt.cleaning_target_id,target.room_id,root.available_from
    from public.cleaning_submissions submission
      join public.cleaning_attempts attempt on attempt.id=submission.cleaning_attempt_id
      join public.cleaning_targets target on target.id=attempt.cleaning_target_id
      join lineage on lineage.target_id=target.id
      join public.checkout_cleaning_obligations obligation on obligation.id=p_obligation
      join public.cleaning_targets root on root.id=obligation.current_cleaning_target_id
    where submission.id=p_submission
  )
  select coalesce((select private.approved_submission_work_proof(
    p_submission,candidate.cleaning_attempt_id,candidate.room_id,candidate.available_from,'infinity'::timestamptz) from candidate),false)
$$;
revoke all on function private.checkout_submission_proves_completion(uuid,uuid)
  from public,anon,authenticated,service_role;

create or replace function private.enforce_checkout_obligation_target_state()
returns trigger language plpgsql security definer set search_path='' as $$
declare target public.cleaning_targets;
begin
  if new.current_cleaning_target_id is null then
    if new.completion_submission_id is not null then raise exception using errcode='23514',message='CHECKOUT_COMPLETION_PROOF_REQUIRED'; end if;
    return new;
  end if;
  select * into target from public.cleaning_targets where id=new.current_cleaning_target_id;
  if target.id is null or target.checkout_obligation_id<>new.id or target.reservation_id<>new.reservation_id
    or target.room_id<>new.room_id or target.cleaning_kind<>'checkout' then
    raise exception using errcode='23514',message='CHECKOUT_TARGET_CONTRACT_MISMATCH';
  end if;
  if new.status='completed' then
    if new.completion_submission_id is null
      or not private.checkout_submission_proves_completion(new.id,new.completion_submission_id) then
      raise exception using errcode='23514',message='CHECKOUT_COMPLETION_PROOF_REQUIRED';
    end if;
  elsif new.completion_submission_id is not null then
    raise exception using errcode='23514',message='CHECKOUT_COMPLETION_PROOF_REQUIRED';
  elsif new.status='cancelled' and target.status<>'cancelled' then
    raise exception using errcode='23514',message='CHECKOUT_CANCELLATION_TARGET_MISMATCH';
  elsif new.status='materialized' and target.status in ('approved','cancelled') then
    raise exception using errcode='23514',message='CHECKOUT_TERMINAL_TARGET_STATUS_MISMATCH';
  end if;
  return new;
end $$;
revoke all on function private.enforce_checkout_obligation_target_state() from public,anon,authenticated,service_role;
drop trigger checkout_obligations_enforce_target_state on public.checkout_cleaning_obligations;
create trigger checkout_obligations_enforce_target_state
before insert or update of status,current_cleaning_target_id,reservation_id,room_id,completion_submission_id
on public.checkout_cleaning_obligations for each row execute function private.enforce_checkout_obligation_target_state();

create or replace function private.validate_checkout_obligation_target_at_commit()
returns trigger language plpgsql security definer set search_path='' as $$
declare obligation_id uuid;
begin
  if tg_table_name='checkout_cleaning_obligations' then obligation_id:=new.id;
  else select o.id into obligation_id from public.checkout_cleaning_obligations o where o.current_cleaning_target_id=new.id;
    if not found then return null; end if;
  end if;
  if exists(select 1 from public.checkout_cleaning_obligations obligation
    left join public.cleaning_targets target on target.id=obligation.current_cleaning_target_id
    where obligation.id=obligation_id and (
      (obligation.status='materialized' and target.status in ('approved','cancelled'))
      or (obligation.status='completed' and (
        obligation.completion_submission_id is null
        or not private.checkout_submission_proves_completion(obligation.id,obligation.completion_submission_id)))
      or (obligation.status='cancelled' and obligation.current_cleaning_target_id is not null and target.status is distinct from 'cancelled')
    )) then raise exception using errcode='23514',message='CHECKOUT_TERMINAL_CONTRACT_NOT_ATOMIC'; end if;
  return null;
end $$;
revoke all on function private.validate_checkout_obligation_target_at_commit() from public,anon,authenticated,service_role;

create or replace function private.enforce_preparation_proof_contract()
returns trigger language plpgsql security definer set search_path='' as $$
declare attempt_room uuid; check_in timestamptz; required_after timestamptz;
begin
  select reservation.check_in_at into check_in from public.reservations reservation
    where reservation.id=new.reservation_id and reservation.room_id=new.room_id;
  if not found then raise exception using errcode='23514',message='PREPARATION_RESERVATION_ROOM_MISMATCH'; end if;
  select coalesce(max(coalesce(reservation.actual_checkout_at,reservation.check_out_at)),new.created_at) into required_after
    from public.reservations reservation where reservation.room_id=new.room_id and reservation.id<>new.reservation_id
      and reservation.status<>'cancelled' and reservation.check_in_at<check_in;
  if new.current_attempt_id is not null then
    select target.room_id into attempt_room from public.cleaning_attempts attempt
      join public.cleaning_targets target on target.id=attempt.cleaning_target_id where attempt.id=new.current_attempt_id;
    if not found or attempt_room<>new.room_id then raise exception using errcode='23514',message='PREPARATION_ATTEMPT_ROOM_MISMATCH'; end if;
  end if;
  if new.status='approved' and not private.approved_submission_work_proof(
    new.approved_submission_id,new.current_attempt_id,new.room_id,required_after,check_in) then
    raise exception using errcode='23514',message='PREPARATION_APPROVAL_PROOF_REQUIRED';
  end if;
  return new;
end $$;
revoke all on function private.enforce_preparation_proof_contract() from public,anon,authenticated,service_role;

-- All lifecycle writes go through the service-owned commands below.  The Edge
-- and rollback HTTP runtimes must not gain raw table mutation authority.
revoke insert, update, delete, truncate, references, trigger
on public.inspection_decisions, public.earnings
from service_role;

create function private.guard_submission_lifecycle()
returns trigger language plpgsql set search_path='' as $$
begin
  if old.status<>'submitted' or new.status not in ('superseded','approved','rejected')
    or (new.status='superseded')<>(new.superseded_at is not null)
    or (new.status<>'superseded' and new.superseded_at is not null) then
    raise exception using errcode='55000',message='SUBMISSION_INVALID_TRANSITION';
  end if;
  return new;
end $$;
revoke all on function private.guard_submission_lifecycle() from public,anon,authenticated,service_role;
create trigger submission_lifecycle_guard before update of status,superseded_at on public.cleaning_submissions
for each row execute function private.guard_submission_lifecycle();

-- Pending inspection remains an evidence/submission phase. The current owner may
-- replace a photo by CAS and create a newer immutable submission version, but no
-- other attempt transition or actor gains access.
create or replace function private.assert_photo_model_actor(p_actor uuid,p_attempt uuid,p_action text)
returns public.cleaning_attempts language plpgsql set search_path='' as $$
declare a public.cleaning_attempts; p public.profiles; at_time timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into p from public.profiles where id=p_actor for no key update;
  select * into a from public.cleaning_attempts where id=p_attempt for update;
  at_time:=clock_timestamp();
  if p.id is null or p.role<>'maid' or p.must_change_password or a.id is null or a.maid_profile_id<>p.id then
    raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  if p.status='active'
    and (a.status in ('in_progress','field_completed','upload_pending')
      or (a.status='scheduled' and p_action in ('upload_evidence','validate_evidence'))
      or (a.status='submitted' and p_action in ('upload_evidence','validate_evidence','submit')))
    and exists(select 1 from public.cleaning_assignments s join public.cleaning_targets t on t.id=s.cleaning_target_id
      where s.id=a.assignment_id and s.is_current and s.notified_at is not null and s.ended_at is null
      and s.maid_profile_id=p.id and s.revision=a.assignment_revision and t.assignment_version=s.revision and t.status<>'cancelled') then
    if p_action='submit' and a.field_completed_at is null then
      raise exception using errcode='55000',message='FIELD_COMPLETION_REQUIRED'; end if;
    return a;
  end if;
  if (private.live_attempt_capability(p_actor,p_attempt,a.assignment_revision,p_action,at_time)).id is null then
    raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  return a;
end $$;
revoke all on function private.assert_photo_model_actor(uuid,uuid,text) from public,anon,authenticated,service_role;

-- Scheduled evidence is accepted only for a pre-submission bomb report. Full
-- submission proof must have been uploaded after the attempt actually started.
create or replace function private.photo_attempt_complete(p_attempt uuid,p_as_of timestamptz)
returns boolean language sql stable set search_path='' as $$
 select coalesce(isfinite(p_as_of) and exists(select 1 from public.cleaning_attempts a
   join private.target_photo_snapshot_contracts contract on contract.cleaning_target_id=a.cleaning_target_id
   where a.id=p_attempt and a.started_at is not null and contract.ready
     and (select count(*) from private.target_photo_slot_snapshots s where s.cleaning_target_id=a.cleaning_target_id)=jsonb_array_length(contract.frozen_snapshot->'slots')
     and exists(select 1 from private.target_photo_slot_snapshots s where s.cleaning_target_id=a.cleaning_target_id and s.required)
     and not exists((select value from jsonb_array_elements(contract.frozen_snapshot->'slots'))
       except(select slot_snapshot from private.target_photo_slot_snapshots s where s.cleaning_target_id=a.cleaning_target_id))
     and a.template_snapshot=(select template_snapshot from public.cleaning_targets where id=a.cleaning_target_id)
     and not exists(select 1 from private.target_photo_slot_snapshots s where s.cleaning_target_id=a.cleaning_target_id and s.required
       and not exists(select 1 from private.attempt_photo_current c join private.attempt_photo_versions p on p.id=c.photo_version_id
         where c.cleaning_attempt_id=a.id and c.target_photo_slot_id=s.id and p.validation_status='verified'
           and p.uploaded_at>=a.started_at and p.uploaded_at<=p_as_of and p.purge_after>p_as_of
           and not exists(select 1 from private.attempt_photo_purge_states x where x.photo_version_id=p.id)))
     and not exists(select 1 from private.attempt_photo_current c join private.attempt_photo_versions p on p.id=c.photo_version_id
       where c.cleaning_attempt_id=a.id and (p.validation_status<>'verified' or p.uploaded_at<a.started_at
         or p.uploaded_at>p_as_of or p.purge_after<=p_as_of
         or exists(select 1 from private.attempt_photo_purge_states x where x.photo_version_id=p.id)))
 ),false)
$$;
revoke all on function private.photo_attempt_complete(uuid,timestamptz) from public,anon,authenticated,service_role;

create function private.bomb_report_actor(p_actor uuid,p_attempt uuid)
returns public.cleaning_attempts language plpgsql set search_path='' as $$
declare a public.cleaning_attempts; p public.profiles; t public.cleaning_targets;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into p from public.profiles where id=p_actor for no key update;
  select * into a from public.cleaning_attempts where id=p_attempt for update;
  select * into t from public.cleaning_targets where id=a.cleaning_target_id for update;
  if p.id is null or p.role<>'maid' or p.status<>'active' or p.must_change_password
    or a.id is null or a.maid_profile_id<>p.id or a.status not in ('scheduled','in_progress','field_completed','upload_pending')
    or t.source='inspection_reclean'
    or not exists(select 1 from public.cleaning_assignments s where s.id=a.assignment_id and s.is_current
      and s.notified_at is not null and s.ended_at is null and s.maid_profile_id=p.id
      and s.revision=a.assignment_revision and t.assignment_version=s.revision and t.status<>'cancelled') then
    raise exception using errcode='42501',message='BOMB_REPORT_ACCESS_REQUIRED';
  end if;
  return a;
end $$;
revoke all on function private.bomb_report_actor(uuid,uuid) from public,anon,authenticated,service_role;

create function private.submission_actor(p_actor uuid,p_attempt uuid)
returns public.cleaning_attempts language plpgsql set search_path='' as $$
declare a public.cleaning_attempts; p public.profiles; at_time timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into p from public.profiles where id=p_actor for no key update;
  select * into a from public.cleaning_attempts where id=p_attempt for update;
  if p.id is null or p.role<>'maid' or p.must_change_password or a.id is null or a.maid_profile_id<>p.id
    or a.field_completed_at is null or a.status not in ('field_completed','upload_pending','submitted') then
    raise exception using errcode='42501',message='SUBMISSION_ACCESS_REQUIRED';
  end if;
  if p.status='active' and exists(select 1 from public.cleaning_assignments s join public.cleaning_targets t on t.id=s.cleaning_target_id
    where s.id=a.assignment_id and s.is_current and s.notified_at is not null and s.ended_at is null
      and s.maid_profile_id=p.id and s.revision=a.assignment_revision and t.assignment_version=s.revision and t.status<>'cancelled') then
    return a;
  end if;
  if (private.live_attempt_capability(p_actor,p_attempt,a.assignment_revision,'submit',at_time)).id is null then
    raise exception using errcode='42501',message='SUBMISSION_ACCESS_REQUIRED';
  end if;
  return a;
end $$;
revoke all on function private.submission_actor(uuid,uuid) from public,anon,authenticated,service_role;

-- Receipt replay survives later attempt/inspection transitions, but only the
-- authenticated maid who owns the immutable attempt can read it.
create function private.submission_receipt_actor(p_actor uuid,p_attempt uuid)
returns public.cleaning_attempts language plpgsql set search_path='' as $$
declare a public.cleaning_attempts; p public.profiles;
begin
  select * into p from public.profiles where id=p_actor;
  select * into a from public.cleaning_attempts where id=p_attempt;
  if p.id is null or p.role<>'maid' or p.status not in ('active','upload_only') or p.must_change_password
    or a.id is null or a.maid_profile_id<>p.id then
    raise exception using errcode='42501',message='SUBMISSION_ACCESS_REQUIRED';
  end if;
  return a;
end $$;
revoke all on function private.submission_receipt_actor(uuid,uuid) from public,anon,authenticated,service_role;

create function private.submission_projection(p_submission uuid)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id',s.id,'attemptId',s.cleaning_attempt_id,'version',s.version,'status',s.status,
    'submittedBy',s.submitted_by,'submittedAt',s.submitted_at,
    'currentRevision',pointer.revision,'current',pointer.submission_id=s.id,
    'photoCount',seal.photo_count,'candleCount',s.candle_count,
    'bombReportId',report_seal.report_id,'bombDecision',bomb_decision.decision,
    'inspectionDecision',inspection.decision,'inspectionReasonCode',inspection.reason_code,
    'decidedAt',inspection.decided_at
  ) from public.cleaning_submissions s
    join private.submission_photo_binding_sets seal on seal.submission_id=s.id
    left join private.submission_current_pointers pointer on pointer.cleaning_attempt_id=s.cleaning_attempt_id
    left join private.bomb_room_report_seals report_seal on report_seal.submission_id=s.id
    left join private.bomb_room_decisions bomb_decision on bomb_decision.submission_id=s.id
    left join public.inspection_decisions inspection on inspection.submission_id=s.id
  where s.id=p_submission
$$;
revoke all on function private.submission_projection(uuid) from public,anon,authenticated,service_role;

create function private.submission_review_context(p_submission uuid)
returns jsonb language plpgsql stable set search_path='' as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'cleaningTargetId',target.id,
    'cleaningKind',target.cleaning_kind,
    'roomNumber',assignment.notified_room_number_snapshot,
    'serviceDate',assignment.service_date,
    'maidProfileId',attempt.maid_profile_id
  ) into result
  from public.cleaning_submissions submission
  join public.cleaning_attempts attempt on attempt.id=submission.cleaning_attempt_id
  join public.cleaning_targets target on target.id=attempt.cleaning_target_id
  join public.cleaning_assignments assignment on assignment.id=attempt.assignment_id
  where submission.id=p_submission
    and assignment.cleaning_target_id=target.id
    and assignment.maid_profile_id=attempt.maid_profile_id
    and assignment.revision=attempt.assignment_revision
    and assignment.notified_at is not null
    and assignment.notified_room_id_snapshot=target.room_id
    and nullif(assignment.notified_room_number_snapshot,'') is not null;
  if result is null then
    raise exception using errcode='23514',message='REVIEW_CONTEXT_INVALID';
  end if;
  return result;
end
$$;
revoke all on function private.submission_review_context(uuid) from public,anon,authenticated,service_role;

create function public.report_bomb_room(
  p_actor_profile_id uuid,p_attempt_id uuid,p_evidence_photo_ids uuid[],p_memo text,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.cleaning_attempts; t public.cleaning_targets; p public.profiles; replay jsonb; result jsonb; rid uuid; report_time timestamptz;
begin
  replay:=private.replay_command(p_actor_profile_id,'submission.report_bomb_room',p_idempotency_key,p_request_hash);
  a:=private.submission_receipt_actor(p_actor_profile_id,p_attempt_id);
  if replay is not null then return replay; end if;
  a:=private.bomb_report_actor(p_actor_profile_id,p_attempt_id);
  select * into t from public.cleaning_targets where id=a.cleaning_target_id for update;
  select * into p from public.profiles where id=p_actor_profile_id;
  if t.source='inspection_reclean' then raise exception using errcode='55000',message='BOMB_REPORT_NOT_ALLOWED'; end if;
  if exists(select 1 from private.bomb_room_reports existing where existing.cleaning_attempt_id=a.id)
    or exists(select 1 from private.submission_current_pointers where cleaning_attempt_id=a.id)
    or p_evidence_photo_ids is null or cardinality(p_evidence_photo_ids) not between 1 and 20
    or cardinality(p_evidence_photo_ids)<>(select count(distinct x) from unnest(p_evidence_photo_ids) x)
    or nullif(btrim(p_memo),'') is null or char_length(p_memo)>500 then
    raise exception using errcode='22023',message='INVALID_BOMB_REPORT';
  end if;
  if exists(select 1 from unnest(p_evidence_photo_ids) x where not exists(
    select 1 from private.attempt_photo_current c join private.attempt_photo_versions v on v.id=c.photo_version_id
    where c.cleaning_attempt_id=a.id and c.photo_version_id=x and v.validation_status='verified'
      and v.purge_after>clock_timestamp() and not exists(select 1 from private.attempt_photo_purge_states ps where ps.photo_version_id=v.id))) then
    raise exception using errcode='23514',message='BOMB_EVIDENCE_INVALID';
  end if;
  insert into private.bomb_room_reports(cleaning_attempt_id,reported_by,memo) values(a.id,p_actor_profile_id,p_memo) returning id,reported_at into rid,report_time;
  insert into private.bomb_room_report_evidence(report_id,photo_version_id) select rid,x from unnest(p_evidence_photo_ids) x;
  result:=jsonb_build_object('id',rid,'attemptId',a.id,'evidenceCount',cardinality(p_evidence_photo_ids),'reportedAt',report_time);
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,after_state,idempotency_key)
    values('submission.bomb_reported','bomb_room_report',rid,p.id,p.display_name,report_time,
      jsonb_build_object('attemptId',a.id,'evidenceCount',cardinality(p_evidence_photo_ids)),
      private.audit_command_key(p_actor_profile_id,'submission.report_bomb_room',p_idempotency_key));
  perform private.complete_command(p_actor_profile_id,'submission.report_bomb_room',p_idempotency_key,p_request_hash,rid,result);
  return result;
end $$;

create function public.create_cleaning_submission(
  p_actor_profile_id uuid,p_attempt_id uuid,p_client_submission_id uuid,p_expected_revision bigint,
  p_candle_count integer,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.cleaning_attempts; p public.profiles; pointer private.submission_current_pointers; old_s public.cleaning_submissions;
  replay jsonb; result jsonb; sid uuid; next_version integer; v_report_id uuid; at_time timestamptz:=clock_timestamp();
begin
  replay:=private.replay_command(p_actor_profile_id,'submission.create',p_idempotency_key,p_request_hash);
  a:=private.submission_receipt_actor(p_actor_profile_id,p_attempt_id);
  if replay is not null then return replay; end if;
  a:=private.submission_actor(p_actor_profile_id,p_attempt_id);
  select * into p from public.profiles where id=p_actor_profile_id;
  select * into pointer from private.submission_current_pointers where cleaning_attempt_id=a.id for update;
  if p_client_submission_id is null or p_expected_revision is null or p_expected_revision<0
    or coalesce(pointer.revision,0)<>p_expected_revision or p_candle_count is null or p_candle_count<0 then
    raise exception using errcode='40001',message='SUBMISSION_VERSION_CONFLICT';
  end if;
  if not private.photo_attempt_complete(a.id,at_time) then
    raise exception using errcode='55000',message='PHOTO_EVIDENCE_INCOMPLETE';
  end if;
  if pointer.submission_id is not null then
    select * into old_s from public.cleaning_submissions where id=pointer.submission_id for update;
    if old_s.status<>'submitted' or exists(select 1 from public.inspection_decisions where submission_id=old_s.id) then
      raise exception using errcode='40001',message='STALE_VERSION';
    end if;
    -- A bomb report/evidence set is sealed to exactly one immutable submission.
    -- It must not silently disappear from the current version through resubmit.
    if exists(select 1 from private.bomb_room_report_seals seal where seal.submission_id=old_s.id) then
      raise exception using errcode='55000',message='BOMB_REPORT_SEALED';
    end if;
    update public.cleaning_submissions set status='superseded',superseded_at=at_time where id=old_s.id;
  end if;
  select coalesce(max(version),0)+1 into next_version from public.cleaning_submissions where cleaning_attempt_id=a.id;
  select report.id into v_report_id from private.bomb_room_reports report where report.cleaning_attempt_id=a.id;
  insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,status,photo_manifest,
    issue_snapshot,candle_count,bomb_room_snapshot,submitted_by,submitted_at)
  values(gen_random_uuid(),a.id,p_client_submission_id,next_version,'submitted',jsonb_build_object('source','verified_photo_bindings'),
    '[]'::jsonb,p_candle_count,case when v_report_id is null then null else jsonb_build_object('reportId',v_report_id) end,
    p_actor_profile_id,at_time) returning id into sid;
  perform private.bind_submission_photo_model(p_actor_profile_id,sid,p_expected_revision);
  if v_report_id is not null and not exists(select 1 from private.bomb_room_report_seals seal where seal.report_id=v_report_id) then
    insert into private.bomb_room_report_seals(report_id,submission_id,sealed_at) values(v_report_id,sid,at_time);
  end if;
  update public.cleaning_attempts set status='submitted' where id=a.id;
  update public.cleaning_targets set status='inspection_pending' where id=a.cleaning_target_id;
  result:=private.submission_projection(sid);
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,after_state,idempotency_key)
    values('submission.created','cleaning_submission',sid,p.id,p.display_name,at_time,
      jsonb_build_object('attemptId',a.id,'version',next_version,'currentRevision',p_expected_revision+1,'photoCount',result->'photoCount','bombReportId',v_report_id),
      private.audit_command_key(p_actor_profile_id,'submission.create',p_idempotency_key));
  perform private.complete_command(p_actor_profile_id,'submission.create',p_idempotency_key,p_request_hash,sid,result);
  return result;
end $$;

create function private.assert_submission_admin(p_actor uuid)
returns public.profiles language plpgsql set search_path='' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id=p_actor and role='admin' and status='active' for no key update;
  if p.id is null or p.must_change_password then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  return p;
end $$;
revoke all on function private.assert_submission_admin(uuid) from public,anon,authenticated,service_role;

create function private.assert_current_submission(p_submission uuid)
returns public.cleaning_submissions language plpgsql set search_path='' as $$
declare s public.cleaning_submissions;
begin
  select * into s from public.cleaning_submissions where id=p_submission for update;
  if s.id is null then raise exception using errcode='P0002',message='SUBMISSION_NOT_FOUND'; end if;
  if s.status<>'submitted' or not exists(select 1 from private.submission_current_pointers p where p.submission_id=s.id and p.cleaning_attempt_id=s.cleaning_attempt_id)
    or exists(select 1 from public.inspection_decisions d where d.submission_id=s.id) then
    raise exception using errcode='40001',message='STALE_VERSION';
  end if;
  return s;
end $$;
revoke all on function private.assert_current_submission(uuid) from public,anon,authenticated,service_role;

create function private.bomb_decision_reason_valid(p_decision text,p_reason text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(case p_decision when 'approved' then p_reason='BOMB_CONFIRMED'
    when 'rejected' then p_reason in ('BOMB_NOT_CONFIRMED','BOMB_EVIDENCE_INSUFFICIENT') else false end,false)
$$;
create function private.inspection_reason_valid(p_decision text,p_reason text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(case p_decision when 'approved' then p_reason='QUALITY_OK'
    when 'rejected' then p_reason in ('QUALITY_REWORK','EVIDENCE_INCOMPLETE','CLEANING_INCOMPLETE') else false end,false)
$$;
revoke all on function private.bomb_decision_reason_valid(text,text),private.inspection_reason_valid(text,text)
  from public,anon,authenticated,service_role;

create function public.decide_bomb_room(
  p_actor_profile_id uuid,p_submission_id uuid,p_decision text,p_reason_code text,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.profiles; s public.cleaning_submissions; seal private.bomb_room_report_seals; replay jsonb; result jsonb; did uuid; at_time timestamptz:=clock_timestamp();
begin
  replay:=private.replay_command(p_actor_profile_id,'inspection.decide_bomb_room',p_idempotency_key,p_request_hash);
  p:=private.assert_submission_admin(p_actor_profile_id);
  if replay is not null then return replay; end if;
  s:=private.assert_current_submission(p_submission_id);
  if exists(select 1 from private.bomb_room_decisions decision where decision.submission_id=s.id) then
    raise exception using errcode='40001',message='BOMB_DECISION_ALREADY_RECORDED';
  end if;
  if not private.bomb_decision_reason_valid(p_decision,p_reason_code) then
    raise exception using errcode='22023',message='INVALID_BOMB_DECISION'; end if;
  select * into seal from private.bomb_room_report_seals where submission_id=s.id;
  if seal.report_id is null then raise exception using errcode='55000',message='BOMB_REPORT_NOT_FOUND'; end if;
  insert into private.bomb_room_decisions(report_id,submission_id,decision,reason_code,decided_by,decided_at)
    values(seal.report_id,s.id,p_decision,p_reason_code,p.id,at_time) returning id into did;
  result:=jsonb_build_object('id',did,'submissionId',s.id,'decision',p_decision,'reasonCode',p_reason_code,'decidedAt',at_time);
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,reason_code,after_state,idempotency_key)
    values('inspection.bomb_decided','bomb_room_decision',did,p.id,p.display_name,at_time,p_reason_code,
      jsonb_build_object('submissionId',s.id,'decision',p_decision),private.audit_command_key(p.id,'inspection.decide_bomb_room',p_idempotency_key));
  perform private.complete_command(p.id,'inspection.decide_bomb_room',p_idempotency_key,p_request_hash,did,result);
  return result;
end $$;

create function private.finalize_submission_inspection(
  p_actor_profile_id uuid,p_submission_id uuid,p_decision text,p_reason_code text,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.profiles; s public.cleaning_submissions; a public.cleaning_attempts; t public.cleaning_targets;
  bseal private.bomb_room_report_seals; bdecision private.bomb_room_decisions; replay jsonb; result jsonb;
  reclean_template public.cleaning_template_versions; reclean_template_count integer; reclean_due_at timestamptz;
  reclean_sequence integer; checkout_obligation_id uuid; decision_id uuid; reclean_id uuid; reclean_assignment_id uuid; earning_id uuid; notice_id uuid;
  at_time timestamptz:=clock_timestamp();
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
    raise exception using errcode='55000',message='INSPECTION_INVALID_TRANSITION';
  end if;
  select * into bseal from private.bomb_room_report_seals where submission_id=s.id;
  if bseal.report_id is not null then
    select * into bdecision from private.bomb_room_decisions where submission_id=s.id;
    if bdecision.id is null then raise exception using errcode='55000',message='BOMB_DECISION_REQUIRED'; end if;
  end if;
  if p_decision='rejected' then
    if not exists(select 1 from public.profiles maid where maid.id=a.maid_profile_id
      and maid.role='maid' and maid.status='active' and not maid.must_change_password) then
      raise exception using errcode='55000',message='RECLEAN_ORIGINAL_MAID_UNAVAILABLE';
    end if;
    select count(*) into reclean_template_count from public.cleaning_template_versions template
      join public.room_types room_type on room_type.id=template.room_type_id
      where room_type.code=t.room_type_snapshot->>'code' and template.cleaning_kind='reclean' and template.status='published';
    if reclean_template_count<>1 then
      raise exception using errcode='23514',message='RECLEAN_TEMPLATE_NOT_CONFIGURED';
    end if;
    select template.* into reclean_template from public.cleaning_template_versions template
      join public.room_types room_type on room_type.id=template.room_type_id
      where room_type.code=t.room_type_snapshot->>'code' and template.cleaning_kind='reclean' and template.status='published';
    select min(reservation.check_in_at-interval '30 minutes') into reclean_due_at
      from public.reservations reservation where reservation.room_id=t.room_id
        and reservation.status='active' and reservation.check_in_at>at_time;
    if reclean_due_at is not null and reclean_due_at<=at_time then
      raise exception using errcode='55000',message='RECLEAN_WINDOW_NOT_AVAILABLE';
    end if;
    select coalesce(max(assignment.sequence_number),0)+1 into reclean_sequence
      from public.cleaning_assignments assignment join public.cleaning_targets target on target.id=assignment.cleaning_target_id
      where assignment.maid_profile_id=a.maid_profile_id and assignment.is_current
        and target.effective_service_date=(at_time at time zone 'Asia/Seoul')::date;
  end if;
  insert into public.inspection_decisions(submission_id,decision,reason_code,reason_detail,bomb_room_decision,decided_by,decided_at)
    values(s.id,p_decision,p_reason_code,null,bdecision.decision,p.id,at_time) returning id into decision_id;
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
      update public.checkout_cleaning_obligations set status='completed',completion_submission_id=s.id,version=version+1
        where id=checkout_obligation_id;
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
        and a.started_at>=t.available_from and a.field_completed_at>=a.started_at and a.ended_at>=a.field_completed_at
        and s.submitted_at>=a.ended_at and at_time>=s.submitted_at and at_time<=r.check_in_at
      order by r.check_in_at limit 1);
    if t.source<>'inspection_reclean' then
      insert into public.earnings(earning_entitlement_id,submission_id,maid_profile_id,earned_on,base_amount,bomb_room_bonus,bomb_room_decision_id)
      values(s.id,s.id,a.maid_profile_id,(a.field_completed_at at time zone 'Asia/Seoul')::date,t.fee_snapshot,
        case when bdecision.decision='approved' then t.fee_snapshot else 0 end,
        case when bdecision.decision='approved' then bdecision.id end) returning id into earning_id;
    end if;
  else
    reclean_id:=gen_random_uuid();
    insert into public.cleaning_targets(id,room_id,reservation_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
      carryover_count,available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,
      created_by,reclean_of_attempt_id,reclean_maid_profile_id,reclean_of_submission_id,reclean_of_inspection_decision_id)
    values(reclean_id,t.room_id,null,'reclean','inspection_reclean','inspection-reclean:'||decision_id::text,
      (at_time at time zone 'Asia/Seoul')::date,(at_time at time zone 'Asia/Seoul')::date,0,at_time,reclean_due_at,'notified',1,
      t.room_type_snapshot,0,jsonb_build_object('id',reclean_template.id,'version',reclean_template.version,
        'durationMinutes',reclean_template.duration_minutes,'photoSlots',reclean_template.photo_slots),
      p.id,a.id,a.maid_profile_id,s.id,decision_id);
    insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,available_from,due_at,reason_code,changed_by)
      values(reclean_id,1,(at_time at time zone 'Asia/Seoul')::date,at_time,reclean_due_at,'INSPECTION_REJECTED',p.id);
    reclean_assignment_id:=gen_random_uuid();
    insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,notified_at,changed_by)
      values(reclean_assignment_id,reclean_id,a.maid_profile_id,reclean_sequence,1,true,at_time,p.id);
  end if;
  insert into public.notifications(recipient_profile_id,category,title,body,room_id,cleaning_target_id,dedupe_key,requires_action,occurred_at)
    values(a.maid_profile_id,'cleaning_inspection_'||p_decision,case when p_decision='approved' then '청소 검수 승인' else '청소 검수 반려' end,
      case when p_decision='approved' then '제출한 청소가 승인되었습니다.' else '제출한 청소가 반려되어 재청소가 필요합니다.' end,
      t.room_id,case when p_decision='approved' then t.id else reclean_id end,'inspection:'||decision_id::text,p_decision='rejected',at_time) returning id into notice_id;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
    values(notice_id,'web_push','pending',at_time,at_time);
  result:=jsonb_build_object('submissionId',s.id,'decisionId',decision_id,'decision',p_decision,'reasonCode',p_reason_code,
    'decidedAt',at_time,'earningId',earning_id,'recleanTargetId',reclean_id,'recleanAssignmentId',reclean_assignment_id);
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,reason_code,after_state,idempotency_key)
    values('inspection.'||p_decision,'inspection_decision',decision_id,p.id,p.display_name,at_time,p_reason_code,
      jsonb_build_object('submissionId',s.id,'attemptId',a.id,'cleaningTargetId',t.id,'maidProfileId',a.maid_profile_id,
        'decision',p_decision,'earningId',earning_id,'recleanTargetId',reclean_id),
      private.audit_command_key(p.id,'inspection.'||p_decision,p_idempotency_key));
  perform private.complete_command(p.id,'inspection.'||p_decision,p_idempotency_key,p_request_hash,decision_id,result);
  return result;
end $$;
revoke all on function private.finalize_submission_inspection(uuid,uuid,text,text,text,text)
from public,anon,authenticated,service_role;

create function public.approve_cleaning_submission(p_actor_profile_id uuid,p_submission_id uuid,p_reason_code text,p_idempotency_key text,p_request_hash text)
returns jsonb language sql security definer set search_path='' as $$ select private.finalize_submission_inspection(p_actor_profile_id,p_submission_id,'approved',p_reason_code,p_idempotency_key,p_request_hash) $$;
create function public.reject_cleaning_submission(p_actor_profile_id uuid,p_submission_id uuid,p_reason_code text,p_idempotency_key text,p_request_hash text)
returns jsonb language sql security definer set search_path='' as $$ select private.finalize_submission_inspection(p_actor_profile_id,p_submission_id,'rejected',p_reason_code,p_idempotency_key,p_request_hash) $$;

create function public.list_cleaning_submissions(p_actor_profile_id uuid,p_attempt_id uuid default null,p_pending_only boolean default false)
returns setof jsonb language plpgsql stable security definer set search_path='' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id=p_actor_profile_id and status='active';
  if p.id is null or p.must_change_password or p.role not in ('admin','maid') then raise exception using errcode='42501',message='SUBMISSION_ACCESS_REQUIRED'; end if;
  if p.role='maid' and (p_attempt_id is null or not exists(select 1 from public.cleaning_attempts a where a.id=p_attempt_id and a.maid_profile_id=p.id)) then
    raise exception using errcode='42501',message='SUBMISSION_ACCESS_REQUIRED'; end if;
  return query select private.submission_projection(s.id)
      || case when p.role='admin' then jsonb_build_object('reviewContext',private.submission_review_context(s.id)) else '{}'::jsonb end
    from public.cleaning_submissions s
    join public.cleaning_attempts a on a.id=s.cleaning_attempt_id
    where (p_attempt_id is null or s.cleaning_attempt_id=p_attempt_id) and (p.role='admin' or a.maid_profile_id=p.id)
      and (not p_pending_only or s.status='submitted') order by s.submitted_at asc,s.id asc limit 100;
end $$;

create function public.get_cleaning_submission(p_actor_profile_id uuid,p_submission_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p public.profiles; s public.cleaning_submissions; report private.bomb_room_reports; evidence_count integer;
  evidence_ids uuid[]; photos jsonb; result jsonb;
begin
  select * into p from public.profiles where id=p_actor_profile_id and status='active';
  select * into s from public.cleaning_submissions where id=p_submission_id;
  if p.id is null or p.must_change_password or s.id is null or p.role<>'admin' then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  result:=private.submission_projection(s.id)
    || jsonb_build_object('reviewContext',private.submission_review_context(s.id));
  select coalesce(jsonb_agg(jsonb_build_object(
    'photoId',binding.photo_version_id,
    'targetPhotoSlotId',binding.target_photo_slot_id,
    'slotKey',slot.slot_key,
    'label',slot.slot_snapshot->>'label',
    'displayOrder',slot.display_order,
    'required',slot.required,
    'photoVersion',binding.photo_version
  ) order by slot.display_order,binding.target_photo_slot_id),'[]'::jsonb)
    into photos
  from private.submission_photo_bindings binding
  join private.target_photo_slot_snapshots slot on slot.id=binding.target_photo_slot_id
  where binding.submission_id=s.id;
  result:=result||jsonb_build_object('photos',photos);
  select r.* into report from private.bomb_room_report_seals seal
    join private.bomb_room_reports r on r.id=seal.report_id where seal.submission_id=s.id;
  if report.id is not null then
    select count(*),array_agg(e.photo_version_id order by e.photo_version_id)
      into evidence_count,evidence_ids
    from private.bomb_room_report_evidence e where e.report_id=report.id;
  end if;
  if report.id is not null then result:=result||jsonb_build_object('bombReport',jsonb_build_object(
    'id',report.id,'attemptId',report.cleaning_attempt_id,'memo',report.memo,
    'evidenceCount',evidence_count,'evidencePhotoIds',to_jsonb(evidence_ids),'reportedAt',report.reported_at)); end if;
  return result;
end $$;

revoke all on function public.report_bomb_room(uuid,uuid,uuid[],text,text,text),
  public.create_cleaning_submission(uuid,uuid,uuid,bigint,integer,text,text),
  public.decide_bomb_room(uuid,uuid,text,text,text,text),
  public.approve_cleaning_submission(uuid,uuid,text,text,text),
  public.reject_cleaning_submission(uuid,uuid,text,text,text),
  public.list_cleaning_submissions(uuid,uuid,boolean),public.get_cleaning_submission(uuid,uuid)
from public,anon,authenticated;
grant execute on function public.report_bomb_room(uuid,uuid,uuid[],text,text,text),
  public.create_cleaning_submission(uuid,uuid,uuid,bigint,integer,text,text),
  public.decide_bomb_room(uuid,uuid,text,text,text,text),
  public.approve_cleaning_submission(uuid,uuid,text,text,text),
  public.reject_cleaning_submission(uuid,uuid,text,text,text),
  public.list_cleaning_submissions(uuid,uuid,boolean),public.get_cleaning_submission(uuid,uuid)
to service_role;

-- Keep the previous audited projection intact and wrap it with the new approved
-- submission events. Raw before/after state and command request hashes never
-- cross this projection.
alter function public.list_developer_audit_events(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
  set schema private;
alter function private.list_developer_audit_events(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
  rename to list_developer_audit_events_before_submission;
revoke all on function private.list_developer_audit_events_before_submission(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
  from public,anon,authenticated,service_role;

create function public.list_developer_audit_events(
  p_actor_profile_id uuid,p_event_types text[] default null,p_filter_actor_profile_id uuid default null,
  p_from timestamptz default null,p_to timestamptz default null,p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,p_limit integer default 50
) returns table(id uuid,event_type text,entity_type text,entity_id uuid,actor_profile_id uuid,
  actor_display_name text,effective_at timestamptz,recorded_at timestamptz,reason_code text,summary jsonb)
language plpgsql security definer set search_path='' as $$
declare
  old_allowed constant text[]:=array[
    'account.bootstrap_developer_created','account.bootstrap_admin_created','account.created','account.role_changed',
    'account.status_changed','account.unlocked','account.password_reset_requested','account.password_changed',
    'availability.submitted','availability.change_requested','availability.change_decided','assignment.draft_saved',
    'assignment.notified','assignment.prestart_changed','assignment.prestart_unassigned','assignment.cancellation_requested',
    'assignment.cancellation_decided','assignment.attempt_activated','assignment.rolled_over','assignment.duration_policy_confirmed',
    'cleaning.attempt_started','cleaning.field_completed','cleaning.finish_current_allowed','cleaning.upload_only_allowed',
    'cleaning.interrupted_handover','cleaning.scheduled_expired','cleaning.offline_event_resolved','photo.upload_accepted',
    'reservation.created','reservation.changed','reservation.cancelled','reservation.manual_checkout',
    'reservation.scheduled_check_in','reservation.scheduled_checkout','reservation.guest_name_retention_purged',
    'cleaning.manual_request.created','cleaning.manual_request.cancelled','room.master_data_changed','room.create_block',
    'room.release_block','room.set_candle_count','room.report_issue','room.resolve_issue','room.record_pin_sync'];
  new_allowed constant text[]:=array['submission.bomb_reported','submission.created','inspection.bomb_decided','inspection.approved','inspection.rejected'];
  allowed text[]:=old_allowed||new_allowed; selected text[]:=coalesce(p_event_types,allowed); old_selected text[];
  from_at timestamptz:=coalesce(p_from,clock_timestamp()-interval '7 days'); to_at timestamptz:=coalesce(p_to,clock_timestamp());
begin
  perform private.assert_active_developer(p_actor_profile_id);
  if p_limit not between 1 and 100 or from_at>to_at or to_at-from_at>interval '31 days'
    or (p_before_recorded_at is null)<>(p_before_id is null)
    or coalesce(cardinality(selected),0) not between 1 and cardinality(allowed)
    or exists(select 1 from unnest(selected) requested where not requested=any(allowed)) then
    raise exception using errcode='22023',message='INVALID_AUDIT_QUERY';
  end if;
  select coalesce(array_agg(value),array[]::text[]) into old_selected from unnest(selected) value where value=any(old_allowed);
  return query select merged.* from (
    select previous.* from private.list_developer_audit_events_before_submission(
      p_actor_profile_id,case when cardinality(old_selected)>0 then old_selected else array['account.created'] end,
      p_filter_actor_profile_id,from_at,to_at,p_before_recorded_at,p_before_id,p_limit) previous
      where previous.event_type=any(selected)
    union all
    select audit.id,audit.event_type,audit.entity_type,audit.entity_id,audit.actor_profile_id,
      audit.actor_display_name_snapshot,audit.effective_at,audit.recorded_at,audit.reason_code,
      case
        when audit.event_type='submission.bomb_reported' then jsonb_strip_nulls(jsonb_build_object(
          'attemptId',audit.after_state->>'attemptId','evidenceCount',audit.after_state->'evidenceCount'))
        when audit.event_type='submission.created' then jsonb_strip_nulls(jsonb_build_object(
          'attemptId',audit.after_state->>'attemptId','version',audit.after_state->'version',
          'currentRevision',audit.after_state->'currentRevision','photoCount',audit.after_state->'photoCount',
          'bombReportId',audit.after_state->>'bombReportId'))
        when audit.event_type='inspection.bomb_decided' then jsonb_strip_nulls(jsonb_build_object(
          'submissionId',audit.after_state->>'submissionId','decision',audit.after_state->>'decision'))
        else jsonb_strip_nulls(jsonb_build_object(
          'submissionId',audit.after_state->>'submissionId','attemptId',audit.after_state->>'attemptId',
          'cleaningTargetId',audit.after_state->>'cleaningTargetId','maidProfileId',audit.after_state->>'maidProfileId',
          'decision',audit.after_state->>'decision','earningId',audit.after_state->>'earningId',
          'recleanTargetId',audit.after_state->>'recleanTargetId')) end
    from public.audit_events audit where audit.event_type=any(new_allowed) and audit.event_type=any(selected)
      and audit.recorded_at>=from_at and audit.recorded_at<=to_at
      and (p_filter_actor_profile_id is null or audit.actor_profile_id=p_filter_actor_profile_id)
      and (p_before_recorded_at is null or (audit.recorded_at,audit.id)<(p_before_recorded_at,p_before_id))
    order by recorded_at desc,id desc limit p_limit
  ) merged order by merged.recorded_at desc,merged.id desc limit p_limit;
end $$;
revoke all on function public.list_developer_audit_events(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
  from public,anon,authenticated;
grant execute on function public.list_developer_audit_events(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
  to service_role;
