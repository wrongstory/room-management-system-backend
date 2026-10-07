-- #327: bounded discovery only. Existing detail/decision proofs, RLS, writers,
-- notifications, receipts and immutable report identity are deliberately unchanged.
-- Existing room/status/report, target-open unique and assignment PK indexes cover
-- the scoped predicates/forward assignment join. This index adds the missing
-- global open-queue path; unrelated FK/index hardening is not part of this read.
create index checkout_presence_incidents_open_queue_idx
  on public.checkout_presence_incidents(reported_at desc,id desc)
  where status='open';

create function public.list_checkout_presence_incidents_page(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_id uuid,
  p_cleaning_target_id uuid,
  p_service_date date,
  p_after_reported_at timestamptz,
  p_after_incident_id uuid,
  p_limit integer
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  actor public.profiles;
  evaluated_at timestamptz:=statement_timestamp();
  result jsonb;
begin
  -- Authorization precedes even an empty/foreign filter result. Do not reuse the
  -- older existence-only Auth helper or a command helper with FOR SHARE locks.
  select * into actor from public.profiles where id=p_actor_profile_id;
  if not found or actor.role<>'admin' or actor.status<>'active' then
    raise exception using errcode='42501',message='ADMIN_REQUIRED';
  end if;
  if actor.must_change_password then
    raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED';
  end if;
  if p_session_id is null or not exists(
    select 1 from auth.sessions session
    where session.id=p_session_id and session.user_id=actor.auth_user_id
      and (session.not_after is null or session.not_after>evaluated_at)
  ) then
    raise exception using errcode='42501',message='SESSION_REVOKED';
  end if;

  if p_limit is null or p_limit<1 or p_limit>100
    or ((p_after_reported_at is null)<>(p_after_incident_id is null))
    or (p_after_reported_at is not null and (
      not isfinite(p_after_reported_at)
      or extract(year from p_after_reported_at at time zone 'UTC') not between 1 and 9999))
    or (p_service_date is not null and (
      not isfinite(p_service_date) or extract(year from p_service_date) not between 1 and 9999)) then
    raise exception using errcode='22023',message='INVALID_CHECKOUT_INCIDENT_LIST';
  end if;

  with page as (
    select incident.id,incident.status,incident.room_id,room.room_number,
      incident.cleaning_target_id,incident.assignment_id,incident.attempt_id,
      incident.reported_at,assignment.service_date
    from public.checkout_presence_incidents incident
    join public.cleaning_assignments assignment on assignment.id=incident.assignment_id
    join public.rooms room on room.id=incident.room_id
    where incident.status='open'
      and (p_room_id is null or incident.room_id=p_room_id)
      and (p_cleaning_target_id is null or incident.cleaning_target_id=p_cleaning_target_id)
      -- The report's immutable responsibility date is not the mutable current
      -- target date and is not the KST calendar date of the report instant.
      and (p_service_date is null or assignment.service_date=p_service_date)
      -- Anchor existence/status is irrelevant: resolution between pages must
      -- not make continuation fail or restart the queue.
      and (p_after_reported_at is null
        or (incident.reported_at,incident.id)<(p_after_reported_at,p_after_incident_id))
    order by incident.reported_at desc,incident.id desc
    limit p_limit+1
  )
  select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
    'incidentId',page.id,'status',page.status,'roomId',page.room_id,
    'roomNumber',page.room_number,'cleaningTargetId',page.cleaning_target_id,
    'assignmentId',page.assignment_id,'attemptId',page.attempt_id,
    -- Keep exact PostgreSQL microseconds for keyset continuation. Never round
    -- through a JS Date or depend on session TimeZone/DateStyle settings.
    'reportedAt',to_char(page.reported_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'serviceDate',to_char(page.service_date,'YYYY-MM-DD'),
    -- Advisory menu only. The existing detail's latest version/fingerprint and
    -- decision command still revalidate the entire current domain graph.
    'allowedDecisions',jsonb_build_array('EXTEND_CHECKOUT','CONFIRM_DEPARTED','FALSE_REPORT')
  ) order by page.reported_at desc,page.id desc),'[]'::jsonb)) into result from page;
  return result;
end $$;

revoke all on function public.list_checkout_presence_incidents_page(
  uuid,uuid,uuid,uuid,date,timestamptz,uuid,integer
) from public,anon,authenticated,service_role;
grant execute on function public.list_checkout_presence_incidents_page(
  uuid,uuid,uuid,uuid,date,timestamptz,uuid,integer
) to service_role;
