-- #415: bounded display hydration only. Keep the adapter's final schedule/role/
-- session/ownership read AFTER all batches. This function grants no commands.
create function public.get_assignment_card_hydration(
  p_actor_profile_id uuid,p_session_id uuid,p_assignment_ids uuid[],p_expected_actor_role text
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare bindings jsonb; targets jsonb; profiles jsonb; attempts jsonb; submissions jsonb; schedules jsonb;
  target_ids uuid[]; maid_ids uuid[]; latest_attempt_ids uuid[];
begin
  -- Reuse the deployed exact-ID 1..100, live actor/session and notified ownership
  -- boundary. Never request current departure facts for intermediate hydration.
  perform public.get_assignment_schedule_read_for_plan(
    p_actor_profile_id,p_session_id,p_assignment_ids,false,p_expected_actor_role);
  select jsonb_agg(jsonb_build_object('id',a.id,'cleaning_target_id',a.cleaning_target_id,
      'maid_profile_id',a.maid_profile_id) order by a.id),
    array_agg(distinct a.cleaning_target_id),array_agg(distinct a.maid_profile_id)
    into bindings,target_ids,maid_ids
  from public.cleaning_assignments a where a.id=any(p_assignment_ids);
  select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) into targets from (
    select t.id,t.room_id,t.cleaning_kind,t.source,t.original_service_date,t.effective_service_date,
      t.carryover_count,t.status,t.assignment_version,t.room_type_snapshot,t.fee_snapshot,t.template_snapshot,
      jsonb_build_object('room_number',room.room_number) rooms
    from public.cleaning_targets t join public.rooms room on room.id=t.room_id
    where t.id=any(target_ids) order by t.id limit 1001
  ) r;
  select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) into profiles from (
    select p.id,p.display_name from public.profiles p where p.id=any(maid_ids) order by p.id limit 1001
  ) r;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.attempt_number desc,r.id),'[]'::jsonb) into attempts from (
    select a.id,a.assignment_id,a.attempt_number,a.status,a.started_at from public.cleaning_attempts a
    where a.assignment_id=any(p_assignment_ids) order by a.attempt_number desc,a.id limit 1001
  ) r;
  select array_agg(r.id) into latest_attempt_ids from (
    select distinct on(a.assignment_id) a.id from public.cleaning_attempts a
    where a.assignment_id=any(p_assignment_ids) order by a.assignment_id,a.attempt_number desc,a.id
  ) r;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.version desc,r.cleaning_attempt_id),'[]'::jsonb) into submissions from (
    select s.cleaning_attempt_id,s.version,s.status from public.cleaning_submissions s
    where s.cleaning_attempt_id=any(latest_attempt_ids) order by s.version desc,s.cleaning_attempt_id limit 1001
  ) r;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.revision desc,r.cleaning_target_id),'[]'::jsonb) into schedules from (
    select s.cleaning_target_id,s.revision,s.effective_service_date,s.reason_code
    from public.cleaning_target_schedule_revisions s where s.cleaning_target_id=any(target_ids)
    order by s.revision desc,s.cleaning_target_id limit 1001
  ) r;
  -- 1001 is a sentinel, never a successful truncated response. Every relation
  -- retains the old exact-count cap, including all attempts for cancellation.
  if jsonb_array_length(bindings)<>cardinality(p_assignment_ids)
    or jsonb_array_length(targets)<>cardinality(target_ids)
    or jsonb_array_length(profiles)<>cardinality(maid_ids)
    or greatest(jsonb_array_length(targets),jsonb_array_length(profiles),jsonb_array_length(attempts),
      jsonb_array_length(submissions),jsonb_array_length(schedules))>1000 then
    raise exception using errcode='22023',message='ASSIGNMENT_HYDRATION_INCOMPLETE';
  end if;
  return jsonb_build_object('assignments',bindings,
    'targets',jsonb_build_object('rows',targets,'count',jsonb_array_length(targets)),
    'profiles',jsonb_build_object('rows',profiles,'count',jsonb_array_length(profiles)),
    'attempts',jsonb_build_object('rows',attempts,'count',jsonb_array_length(attempts)),
    'submissions',jsonb_build_object('rows',submissions,'count',jsonb_array_length(submissions)),
    'schedules',jsonb_build_object('rows',schedules,'count',jsonb_array_length(schedules)));
end $$;
revoke all on function public.get_assignment_card_hydration(uuid,uuid,uuid[],text)
  from public,anon,authenticated,service_role;
grant execute on function public.get_assignment_card_hydration(uuid,uuid,uuid[],text) to service_role;
comment on function public.get_assignment_card_hydration(uuid,uuid,uuid[],text) is
  '#415 bounded display relations; no current departure or command authority. Adapter must revalidate authority after all batches.';
