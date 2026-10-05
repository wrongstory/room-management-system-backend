-- #326: read-only target provenance/snapshot/cancellation guidance.
-- Existing ledgers, command guards, fingerprints and completed receipts remain
-- unchanged. The guidance is a snapshot, never authority to execute a command.
create function private.assignment_target_read_metadata(
  p_target_id uuid, p_assignment_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  target public.cleaning_targets;
  assignment public.cleaning_assignments;
  snapshot jsonb;
  cutoff bigint;
  rollover_count integer;
  rollover_reason text;
  cancel_reason text;
begin
  select * into target from public.cleaning_targets where id=p_target_id;
  if target.id is null or jsonb_typeof(target.room_type_snapshot)<>'object' then
    raise exception using errcode='23514',message='ASSIGNMENT_TARGET_READ_INVALID';
  end if;
  cutoff:=target.assignment_version;
  if p_assignment_id is not null then
    select * into assignment from public.cleaning_assignments
      where id=p_assignment_id and cleaning_target_id=target.id;
    if assignment.id is null then
      raise exception using errcode='23514',message='ASSIGNMENT_TARGET_READ_INVALID';
    end if;
    cutoff:=assignment.revision;
  end if;
  snapshot:=jsonb_build_object(
    'code',case when jsonb_typeof(target.room_type_snapshot->'code')='string'
      then nullif(target.room_type_snapshot->>'code','') end,
    'name',case when jsonb_typeof(target.room_type_snapshot->'name')='string'
      then nullif(target.room_type_snapshot->>'name','') end,
    'elevatorZone',case when jsonb_typeof(target.room_type_snapshot->'elevatorZone')='string'
      then nullif(target.room_type_snapshot->>'elevatorZone','') end
  );
  select least(target.carryover_count,count(*)::integer),
    (array_agg(schedule.reason_code order by schedule.revision desc))[1]
    into rollover_count,rollover_reason
  from public.cleaning_target_schedule_revisions schedule
  where schedule.cleaning_target_id=target.id and schedule.revision<=cutoff
    and schedule.reason_code in ('ROLLED_OVER_UNASSIGNED','ROLLED_OVER_NOT_STARTED');
  if rollover_count=0 then rollover_reason:=null; end if;

  -- Exactly the #348 domain predicate: stale draft/window, due date and PIN
  -- disclosure do not prevent cancellation. Historical attempts are not the
  -- current assignment's attempts. Do not use only the latest display attempt.
  if p_assignment_id is not null and not assignment.is_current then
    cancel_reason:='ASSIGNMENT_NOT_CURRENT';
  elsif target.source not in ('manual_room_request','stayover_request') then
    cancel_reason:='NOT_MANUAL_CLEANING_REQUEST';
  elsif target.status not in ('unassigned','draft_assigned','notified') or exists (
    select 1 from public.cleaning_attempts attempt
    join public.cleaning_assignments current_assignment
      on current_assignment.id=attempt.assignment_id
      and current_assignment.cleaning_target_id=target.id and current_assignment.is_current
    where attempt.cleaning_target_id=target.id and attempt.status<>'superseded'
      and (attempt.started_at is not null or attempt.status<>'scheduled')
  ) then
    cancel_reason:='CLEANING_REQUEST_CANCEL_CONFLICT';
  end if;
  return jsonb_build_object(
    'cleaningKind',target.cleaning_kind,'sourceKind',target.source,
    'roomTypeSnapshot',snapshot,'roomTypeCode',snapshot->'code',
    'roomTypeName',snapshot->'name','elevatorZone',snapshot->'elevatorZone',
    'feeSnapshot',target.fee_snapshot,'originalServiceDate',target.original_service_date,
    'effectiveServiceDate',target.effective_service_date,
    'rolloverCount',rollover_count,'rolloverReason',rollover_reason,
    'canCancel',cancel_reason is null,'cancelReasonCode',cancel_reason
  );
end $$;
revoke all on function private.assignment_target_read_metadata(uuid,uuid)
  from public,anon,authenticated,service_role;

create function private.assignment_target_read_rows(p_rows jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare row jsonb; result jsonb:='[]'::jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>1000 then
    raise exception using errcode='23514',message='ASSIGNMENT_TARGET_READ_INVALID';
  end if;
  for row in select value from jsonb_array_elements(p_rows) loop
    result:=result||jsonb_build_array(row||private.assignment_target_read_metadata(
      (row->>'cleaningTargetId')::uuid,nullif(row->>'assignmentId','')::uuid));
  end loop;
  return result;
end $$;
revoke all on function private.assignment_target_read_rows(jsonb)
  from public,anon,authenticated,service_role;

create function private.assignment_commit_read_metadata(p_impact jsonb)
returns jsonb language sql stable security definer set search_path='' as $$
  select p_impact||jsonb_build_object(
    'committableDrafts',private.assignment_target_read_rows(p_impact->'committableDrafts'),
    'blockedDrafts',private.assignment_target_read_rows(p_impact->'blockedDrafts'),
    'remainingUnassignedTargets',private.assignment_target_read_rows(p_impact->'remainingUnassignedTargets'))
$$;
revoke all on function private.assignment_commit_read_metadata(jsonb)
  from public,anon,authenticated,service_role;

-- Patch only known output construction sites. In particular, do not enrich a
-- completed legacy replay with today's state or alter its fingerprint/receipt.
do $patch$
declare change record; definition text; occurrences integer;
begin
  for change in select * from (values
    ('private.assignment_commit_impact_at(date,timestamptz)',
      $old$  return jsonb_build_object(
    'serviceDate', p_service_date,
    'impactFingerprint', v_fingerprint,
    'committableDrafts', v_committable,
    'blockedDrafts', v_blocked,
    'remainingUnassignedTargets', v_unassigned
  );$old$,
      $new$  return private.assignment_commit_read_metadata(jsonb_build_object(
    'serviceDate', p_service_date,
    'impactFingerprint', v_fingerprint,
    'committableDrafts', v_committable,
    'blockedDrafts', v_blocked,
    'remainingUnassignedTargets', v_unassigned
  ));$new$),
    ('private.commit_and_notify_assignments_at(uuid,date,text,jsonb,text,text,timestamptz)',
      $old$      'notifiedAt', p_command_at
    ));$old$,
      $new$      'notifiedAt', p_command_at
    ) || private.assignment_target_read_metadata(v_candidate.target_id,v_candidate.assignment_id));$new$),
    ('private.assignment_preview_snapshot_at(uuid,date,timestamptz)',
      $old$coalesce(t.room_type_snapshot->>'elevatorZone',r.elevator_zone,'unknown')$old$,
      $new$coalesce(t.room_type_snapshot->>'elevatorZone','unknown')$new$),
    ('private.assignment_preview_snapshot_at(uuid,date,timestamptz)',
      $old$  ) order by t.id),'[]'::jsonb) into v_targets$old$,
      $new$  ) || private.assignment_target_read_metadata(t.id) || jsonb_build_object(
    -- Existing preview routing classifications stay non-null for compatibility;
    -- canonical roomTypeSnapshot preserves missing data without catalog fill.
    'roomTypeCode',coalesce(case when jsonb_typeof(t.room_type_snapshot->'code')='string'
      then nullif(t.room_type_snapshot->>'code','') end,'unknown'),
    'elevatorZone',coalesce(case when jsonb_typeof(t.room_type_snapshot->'elevatorZone')='string'
      then nullif(t.room_type_snapshot->>'elevatorZone','') end,'unknown')
  ) order by t.id),'[]'::jsonb) into v_targets$new$)
  ) edits(signature,old_text,new_text) loop
    definition:=replace(pg_get_functiondef(change.signature::regprocedure),E'\r\n',E'\n');
    occurrences:=(length(definition)-length(replace(definition,change.old_text,'')))/length(change.old_text);
    if occurrences<>1 then
      raise exception 'ASSIGNMENT_TARGET_READ_SOURCE_DRIFT: %',change.signature;
    end if;
    execute replace(definition,change.old_text,change.new_text);
  end loop;
end $patch$;

comment on function private.assignment_target_read_metadata(uuid,uuid) is
  '#326 service-internal snapshot/provenance and advisory manual-target cancellation projection. Snapshot-only room type/fee, evidence-bound rollover, exact current attempt guard, no PIN/history-based prohibition. Public admin readers own authorization; legacy receipts are never hydrated.';
