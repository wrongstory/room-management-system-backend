-- #348 / #326: explicit 2026-10-02 policy B. PIN disclosure is not a manual
-- request cancellation predicate. Started/terminal and automatic checkout
-- boundaries remain unchanged. No historical data or receipts are rewritten.
do $patch$
declare
  definition text;
  replacement record;
begin
  definition := replace(pg_get_functiondef(
    'public.cancel_manual_cleaning_request(uuid,uuid,bigint,text,text,text)'::regprocedure), E'\r\n', E'\n');
  for replacement in select * from (values
    ($old$  v_target public.cleaning_targets%rowtype;
$old$, $new$  v_target public.cleaning_targets%rowtype;
  v_cancelled_assignment_id uuid;
$new$),
    ($old$  if v_target.status not in ('unassigned', 'draft_assigned', 'notified')
$old$, $new$  -- Bind notification evidence to the assignment cancelled by this command,
  -- never the newest notified row from an earlier reassignment/unassign.
  select a.id into v_cancelled_assignment_id
  from public.cleaning_assignments a
  where a.cleaning_target_id = v_target.id and a.is_current
  for update;

  if v_target.status not in ('unassigned', 'draft_assigned', 'notified')
$new$),
    ($old$
    or exists (
      select 1 from public.room_pin_access_leases l
      where l.cleaning_target_id = v_target.id
        and l.revealed_at is not null
        and l.revoked_at is null
    ) then
$old$, $new$ then
$new$),
    ($old$    v_response,
    p_request_hash,
$old$, $new$    v_response || jsonb_build_object('cancelledAssignmentId', v_cancelled_assignment_id),
    p_request_hash,
$new$)
  ) as edits(old_text, new_text)
  loop
    if (length(definition) - length(replace(definition, replacement.old_text, '')))
      / length(replacement.old_text) <> 1 then
      raise exception 'MANUAL_CLEANING_CANCEL_DEFINITION_DRIFT';
    end if;
    definition := replace(definition, replacement.old_text, replacement.new_text);
  end loop;
  execute definition;

  definition := replace(pg_get_functiondef(
    'private.dispatch_notification_from_audit()'::regprocedure), E'\r\n', E'\n');
  for replacement in select * from (values
    ($old$    select * into old_a from public.cleaning_assignments where cleaning_target_id=t.id
      and change_reason_code='REQUEST_CANCELLED' and xmin=xact order by ended_at desc limit 1;
    if old_a.id is null then select * into old_a from public.cleaning_assignments where cleaning_target_id=t.id
      and not is_current and notified_at is not null order by ended_at desc limit 1; end if;
$old$, $new$    select * into old_a from public.cleaning_assignments
      where id=nullif(new.after_state->>'cancelledAssignmentId','')::uuid
        and cleaning_target_id=t.id and not is_current
        and ended_at=new.effective_at and change_reason_code=new.reason_code
        and t.status='cancelled' and t.cancelled_by=new.actor_profile_id
        and t.cancelled_at=new.effective_at and t.cancellation_reason_code=new.reason_code
        and new.after_state->>'status'='cancelled'
        and t.assignment_version=(new.after_state->>'version')::bigint
        and t.assignment_version=(new.before_state->>'version')::bigint+1;
    -- xmin is a row-version subtransaction XID, not necessarily the top-level
    -- XID. Bind exact business evidence instead; never search historical rows.
$new$)
  ) as edits(old_text, new_text)
  loop
    if (length(definition) - length(replace(definition, replacement.old_text, '')))
      / length(replacement.old_text) <> 1 then
      raise exception 'MANUAL_CLEANING_CANCEL_DISPATCH_DRIFT';
    end if;
    definition := replace(definition, replacement.old_text, replacement.new_text);
  end loop;
  execute definition;
end $patch$;

-- The old service entry had no DB session/password recheck. Keep its existing
-- receipt namespace and response internally, but expose only the session-bound
-- app command. Global lock -> actor -> session matches account reset ordering.
create function public.cancel_manual_cleaning_request_with_session(
  p_actor_profile_id uuid, p_session_id uuid, p_target_id uuid,
  p_expected_version bigint, p_reason_code text, p_idempotency_key text, p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor public.profiles;
  actor_session auth.sessions;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));
  select * into actor from public.profiles where id=p_actor_profile_id for share;
  if actor.id is null or actor.status<>'active' then
    raise exception using errcode='42501', message='ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if actor.role<>'admin' then
    raise exception using errcode='42501', message='ADMIN_REQUIRED';
  end if;
  if actor.must_change_password then
    raise exception using errcode='42501', message='PASSWORD_CHANGE_REQUIRED';
  end if;
  select * into actor_session from auth.sessions
    where id=p_session_id and user_id=actor.auth_user_id for share;
  if actor_session.id is null or (
    actor_session.not_after is not null and actor_session.not_after<=clock_timestamp()
  ) then
    raise exception using errcode='42501', message='SESSION_REVOKED';
  end if;
  -- Live authorization, including lock-wait expiry, precedes even receipt replay.
  -- No session identifier is persisted in audit, receipt, or public response.
  if p_expected_version is null or p_expected_version<1 or p_reason_code is null
    or p_reason_code !~ '^[A-Z0-9_]{2,80}$' then
    raise exception using errcode='22023', message='VALIDATION_ERROR';
  end if;
  return public.cancel_manual_cleaning_request(p_actor_profile_id, p_target_id,
    p_expected_version, p_reason_code, p_idempotency_key, p_request_hash);
end $$;

revoke all on function public.cancel_manual_cleaning_request(uuid,uuid,bigint,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.cancel_manual_cleaning_request_with_session(uuid,uuid,uuid,bigint,text,text,text)
  from public, anon, authenticated;
grant execute on function public.cancel_manual_cleaning_request_with_session(uuid,uuid,uuid,bigint,text,text,text)
  to service_role;
revoke all on function private.dispatch_notification_from_audit() from public, anon, authenticated, service_role;

comment on function public.cancel_manual_cleaning_request(uuid,uuid,bigint,text,text,text) is
  'Active admin manual additional/stayover soft cancellation before start, including draft/notified/scheduled work regardless of PIN disclosure. Target CAS/idempotency and exact current notified recipient are preserved; assignment/entitlement termination closes subsequent PIN access, not historical disclosure.';

comment on function public.cancel_manual_cleaning_request_with_session(uuid,uuid,uuid,bigint,text,text,text) is
  'Service-only manual request cancel with locked active/password-complete admin and exact live session checked before legacy CAS/idempotent replay. Session identity is runtime-only. PIN disclosure does not restrict unstarted cancellation.';
