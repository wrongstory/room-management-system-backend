-- #308 phase4B2: the requested planning day is not the immutable work date.
-- Old drafts may be committed on KST today using today's current availability.
-- No history, assignment snapshot, owner, sequence or schedule is rewritten.
create function private.assignment_planning_includes_date(
  p_original_date date,p_planning_date date,p_command_at timestamptz
) returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(isfinite(p_original_date) and isfinite(p_planning_date)
    and isfinite(p_command_at) and (
      p_original_date=p_planning_date
      or (p_planning_date=(p_command_at at time zone 'Asia/Seoul')::date
        and p_original_date<p_planning_date)
    ),false)
$$;
revoke all on function private.assignment_planning_includes_date(date,date,timestamptz)
from public,anon,authenticated,service_role;

-- Exact-date rows retain legacy preflight visibility (and existing invalid-day
-- reason codes); only the additional past-date inclusion requires KST today.
-- Patch only known clauses from89. Drift must abort the upgrade, not replace an
-- unexpected implementation or weaken unrelated source/role/CAS guards.
do $upgrade$
declare patch record; definition text; occurrences integer;
begin
  for patch in select * from (values
    ('private.assignment_commit_candidates_at_before_stay_segments(date,timestamptz)',
      '        or assignment.service_date <> p_service_date', '',1),
    ('private.assignment_commit_candidates_at_before_stay_segments(date,timestamptz)',
      '  where target.effective_service_date = p_service_date',
      '  where private.assignment_planning_includes_date(target.effective_service_date,p_service_date,p_command_at)',1),
    ('private.assignment_commit_candidates_at(date,timestamptz)',
      '      and candidate.assignment_service_date=p_service_date',
      '      and private.assignment_planning_includes_date(candidate.assignment_service_date,p_service_date,p_command_at)',1),
    ('private.commit_and_notify_assignments_at(uuid,date,text,jsonb,text,text,timestamptz)',
      '    where target.effective_service_date = p_service_date',
      '    where private.assignment_planning_includes_date(target.effective_service_date,p_service_date,p_command_at)',3),
    ('private.commit_and_notify_assignments_at(uuid,date,text,jsonb,text,text,timestamptz)',
      E'      ''maidDisplayName'', v_candidate.maid_display_name,\n      ''serviceDate'', p_service_date,',
      E'      ''maidDisplayName'', v_candidate.maid_display_name,\n      ''serviceDate'', v_candidate.assignment_service_date,',1),
    ('private.assignment_commit_impact_at(date,timestamptz)',
      E'    ''serviceDate'', p_service_date,\n    ''sequenceNumber'', candidate.sequence_number,',
      E'    ''serviceDate'', candidate.assignment_service_date,\n    ''sequenceNumber'', candidate.sequence_number,',1),
    ('private.assignment_commit_impact_at(date,timestamptz)',
      E'    ''serviceDate'', p_service_date,\n    ''status'', candidate.target_status,',
      E'    ''serviceDate'', (select target.effective_service_date from public.cleaning_targets target where target.id=candidate.target_id),\n    ''status'', candidate.target_status,',1),
    ('private.assignment_commit_impact_at(date,timestamptz)',
      E'  select\n    coalesce(jsonb_agg(jsonb_build_object(',
      E'  -- Fail closed before building any partial fingerprint or response. The\n  -- guard reads at most1001 target rows; candidate cardinality is one per target.\n  if exists (select 1 from public.cleaning_targets target\n    where private.assignment_planning_includes_date(target.effective_service_date,p_service_date,p_command_at)\n      and target.status in (''unassigned'',''draft_assigned'')\n    offset 1000 limit 1) then\n    raise exception using errcode=''54000'',message=''ASSIGNMENT_COMMIT_LIMIT_EXCEEDED'';\n  end if;\n\n  select\n    coalesce(jsonb_agg(jsonb_build_object(',1)
  ) as changes(signature,old_text,new_text,expected_occurrences)
  loop
    definition:=replace(pg_get_functiondef(patch.signature::regprocedure),E'\r\n',E'\n');
    occurrences:=(length(definition)-length(replace(definition,patch.old_text,'')))/length(patch.old_text);
    if occurrences<>patch.expected_occurrences then
      raise exception 'CLEANING_OVERDUE_COMMIT_SOURCE_DRIFT: %',patch.signature;
    end if;
    execute replace(definition,patch.old_text,patch.new_text);
  end loop;
end
$upgrade$;

-- Existing immutable assignment.notified audit already records the requested
-- commit planning serviceDate. It is exact per assignment revision, not inferred
-- from notification timestamps or backfilled from historical dates.
create index audit_assignment_notified_entity_idx on public.audit_events(entity_id)
where event_type='assignment.notified' and entity_type='cleaning_assignment';

create or replace function private.prevent_notified_assignment_unavailability()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not new.available and exists (
    select 1 from public.availability_versions version
    join public.cleaning_assignments assignment
      on assignment.maid_profile_id=version.maid_profile_id
      and assignment.is_current and assignment.notified_at is not null
    join public.cleaning_targets target
      on target.id=assignment.cleaning_target_id and target.status='notified'
    where version.id=new.availability_version_id
      and version.is_current and version.status='submitted'
      and (
        assignment.service_date=new.work_date
        or (assignment.service_date<new.work_date and exists (
          select 1 from public.audit_events audit
          where audit.event_type='assignment.notified'
            and audit.entity_type='cleaning_assignment' and audit.entity_id=assignment.id
            and audit.after_state->>'assignmentId'=assignment.id::text
            and audit.after_state->>'cleaningTargetId'=assignment.cleaning_target_id::text
            and audit.after_state->>'maidProfileId'=assignment.maid_profile_id::text
            and audit.after_state->>'revision'=assignment.revision::text
            and audit.after_state->>'serviceDate'=new.work_date::text
        ))
      )
  ) then
    raise exception using errcode='40001',message='ASSIGNMENT_AVAILABILITY_STALE';
  end if;
  return new;
end
$$;
revoke all on function private.prevent_notified_assignment_unavailability()
from public,anon,authenticated,service_role;
