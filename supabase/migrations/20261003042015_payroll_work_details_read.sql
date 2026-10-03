-- #324: bounded, read-only actual earning / unearned workflow detail streams.
-- Existing earning/attempt/submission FK and maid indexes cover the joins.
-- No money, receipt, paid snapshot, current pointer or catalog is rewritten.
create function public.list_payroll_work_details_page(
  p_actor_profile_id uuid, p_session_id uuid, p_expected_actor_role text,
  p_week_start date, p_maid_profile_id uuid, p_kind text,
  p_after_entry_date date default null, p_after_entry_id uuid default null,
  p_limit integer default 25
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  actor public.profiles;
  cycle public.payroll_cycles;
  evaluated_at timestamptz:=statement_timestamp();
  aggregate jsonb;
  summary jsonb;
  rows jsonb;
  candidate_count integer;
  last_date date;
  last_id uuid;
begin
  select * into actor from public.profiles where id=p_actor_profile_id;
  if not found or actor.role not in ('admin','maid') or actor.status<>'active'
    or p_expected_actor_role is null
    or actor.role::text is distinct from p_expected_actor_role then
    raise exception using errcode='42501',message='PAYROLL_ACCESS_REQUIRED';
  end if;
  if actor.must_change_password then
    raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED';
  end if;
  if p_session_id is null or not exists (
    select 1 from auth.sessions session where session.id=p_session_id
      and session.user_id=actor.auth_user_id
      and (session.not_after is null or session.not_after>evaluated_at)
  ) then
    raise exception using errcode='42501',message='SESSION_REVOKED';
  end if;
  if actor.role='maid' and p_maid_profile_id is distinct from actor.id then
    raise exception using errcode='42501',message='PAYROLL_ACCESS_REQUIRED';
  end if;
  -- Administrators may read former maids' immutable historical earnings.
  if not exists(select 1 from public.profiles maid
    where maid.id=p_maid_profile_id and maid.role='maid') then
    raise exception using errcode='P0002',message='PAYROLL_MAID_NOT_FOUND';
  end if;
  if p_week_start is null or not isfinite(p_week_start)
    or extract(year from p_week_start) not between 1 and 9999 then
    raise exception using errcode='22023',message='PAYROLL_WEEK_MUST_START_MONDAY';
  end if;
  perform private.assert_readable_payroll_week(p_week_start);
  if p_kind is null or p_kind not in ('earnings','workflow') then
    raise exception using errcode='22023',message='PAYROLL_PAGE_KIND_INVALID';
  end if;
  if p_limit is null or p_limit<1 or p_limit>50 then
    raise exception using errcode='22023',message='PAYROLL_PAGE_LIMIT_INVALID';
  end if;
  if (p_after_entry_date is null)<>(p_after_entry_id is null)
    or (p_after_entry_date is not null and (not isfinite(p_after_entry_date)
      or p_after_entry_date<p_week_start or p_after_entry_date>=p_week_start+7)) then
    raise exception using errcode='22023',message='PAYROLL_CURSOR_INVALID';
  end if;

  select * into cycle from public.payroll_cycles
    where maid_profile_id=p_maid_profile_id and week_start=p_week_start;
  aggregate:=private.project_payroll_cycle_bounded(p_week_start,p_maid_profile_id,1);
  -- Whitelist the existing aggregate; never leak nested legacy previews or
  -- private continuation positions, and never add accrual twice to payable.
  summary:=jsonb_build_object('cycleId',aggregate->'cycleId',
    'cycleStatus',aggregate->'status','cycleVersion',aggregate->'version',
    'offsetSettled',aggregate->'offsetSettled','lockedAmount',aggregate->'lockedAmount',
    'accrualAmount',aggregate->'accrualAmount','expectedAmount',aggregate->'expectedAmount',
    'pendingAmount',aggregate->'pendingAmount','pendingCount',aggregate->'pendingCount',
    'totalAmount',aggregate->'totalAmount','lateEarningAmount',aggregate->'lateEarningAmount',
    'adjustmentAmount',aggregate->'adjustmentAmount','carryInAmount',aggregate->'carryInAmount',
    'carryOutAmount',aggregate->'carryOutAmount','payableAmount',aggregate->'payableAmount');

  with selected as (
    -- The earning's immutable submission is authoritative, not today's pointer.
    select e.id entry_id,e.earned_on entry_date,a.id attempt_id,e.id earning_id,s.id submission_id
    from public.earnings e join public.cleaning_submissions s on s.id=e.submission_id
    join public.cleaning_attempts a on a.id=s.cleaning_attempt_id
    where p_kind='earnings' and e.maid_profile_id=p_maid_profile_id
      and e.earned_on>=p_week_start and e.earned_on<p_week_start+7
    union all
    select a.id,coalesce((a.field_completed_at at time zone 'Asia/Seoul')::date,t.effective_service_date),
      a.id,null::uuid,pointer.submission_id
    from public.cleaning_attempts a join public.cleaning_targets t on t.id=a.cleaning_target_id
    join public.cleaning_assignments assignment on assignment.id=a.assignment_id
    left join private.submission_current_pointers pointer on pointer.cleaning_attempt_id=a.id
    where p_kind='workflow' and a.maid_profile_id=p_maid_profile_id
      and assignment.notified_at is not null
      and coalesce((a.field_completed_at at time zone 'Asia/Seoul')::date,t.effective_service_date)>=p_week_start
      and coalesce((a.field_completed_at at time zone 'Asia/Seoul')::date,t.effective_service_date)<p_week_start+7
      and not exists(select 1 from public.cleaning_submissions prior
        join public.earnings earned on earned.submission_id=prior.id where prior.cleaning_attempt_id=a.id)
  ), candidates as materialized (
    select * from selected where p_after_entry_date is null
      or (entry_date,entry_id)>(p_after_entry_date,p_after_entry_id)
    order by entry_date,entry_id limit p_limit+1
  ), page as materialized (
    select * from candidates order by entry_date,entry_id limit p_limit
  ), facts as (
    select page.*,a.cleaning_target_id,a.assignment_id,a.room_snapshot,a.field_completed_at,
      a.status attempt_status,t.room_type_snapshot,t.cleaning_kind,t.source,t.fee_snapshot,
      s.status submission_status,decision.id inspection_id,decision.decision,
      e.earned_on,e.earning_entitlement_id,e.base_amount,e.bomb_room_bonus,e.total_amount,
      item.payroll_cycle_id,item.locked_amount,
      exists(select 1 from public.payroll_adjustments adjustment
        where adjustment.late_carried_earning_id=e.id) late_carried,
      -- Exactly the existing workflow aggregate predicate, separate from which
      -- historical actual attempts may be displayed with zero contributions.
      (t.status<>'cancelled' and t.source<>'inspection_reclean' and assignment.is_current
        and assignment.notified_at is not null
        and a.status in ('scheduled','in_progress','field_completed','upload_pending','submitted')) eligible,
      exists(select 1 from private.bomb_room_report_seals seal
        join private.bomb_room_decisions bomb on bomb.submission_id=seal.submission_id
        join public.cleaning_submissions sealed on sealed.id=seal.submission_id
        where sealed.cleaning_attempt_id=a.id and bomb.decision='approved') expected_bomb
    from page join public.cleaning_attempts a on a.id=page.attempt_id
    join public.cleaning_targets t on t.id=a.cleaning_target_id
    join public.cleaning_assignments assignment on assignment.id=a.assignment_id
    left join public.cleaning_submissions s on s.id=page.submission_id
    left join public.inspection_decisions decision on decision.submission_id=s.id
    left join public.earnings e on e.id=page.earning_id
    left join public.payroll_items item on item.earning_id=e.id
  ), normalized as (
    select facts.*,
      case when room_snapshot ? 'roomType' then case
          when jsonb_typeof(room_snapshot->'roomType')<>'object' then null::jsonb
          when (room_snapshot->'roomType') ? 'code' then room_snapshot#>'{roomType,code}'
          else room_type_snapshot->'code' end
        when room_snapshot ? 'code' then room_snapshot->'code'
        else room_type_snapshot->'code' end type_code,
      case when room_snapshot ? 'roomType' then case
          when jsonb_typeof(room_snapshot->'roomType')<>'object' then null::jsonb
          when (room_snapshot->'roomType') ? 'name' then room_snapshot#>'{roomType,name}'
          else room_type_snapshot->'name' end
        when room_snapshot ? 'name' then room_snapshot->'name'
        else room_type_snapshot->'name' end type_name,
      case when eligible then fee_snapshot::bigint else 0 end expected_base,
      case when eligible and expected_bomb then fee_snapshot::bigint else 0 end expected_bonus
    from facts
  ), projected as (
    select entry_date,entry_id,jsonb_build_object(
      'entryId',entry_id,'entryDate',entry_date,'cleaningTargetId',cleaning_target_id,
      'assignmentId',assignment_id,'attemptId',attempt_id,'submissionId',submission_id,
      'inspectionDecisionId',inspection_id,
      'roomNumber',case when jsonb_typeof(room_snapshot->'roomNumber')='string'
        and btrim(room_snapshot->>'roomNumber')<>'' then room_snapshot->>'roomNumber' end,
      'roomTypeCode',case when jsonb_typeof(type_code)='string' and btrim(type_code#>>'{}')<>''
        then type_code#>>'{}' end,
      'roomTypeName',case when jsonb_typeof(type_name)='string' and btrim(type_name#>>'{}')<>''
        then type_name#>>'{}' end,
      'cleaningKind',cleaning_kind,'sourceKind',source,'fieldCompletedAt',field_completed_at,
      'feeSnapshot',fee_snapshot,'attemptStatus',attempt_status,
      'submissionStatus',submission_status,'inspectionDecision',decision
    ) || case when p_kind='earnings' then jsonb_build_object(
      'earningId',earning_id,'earnedOn',earned_on,
      'earningSource',case when earning_entitlement_id is not null then 'cleaning' else 'compensation' end,
      'baseAmount',base_amount,'bombRoomBonus',bomb_room_bonus,'totalAmount',total_amount,
      'itemContributionAmount',case when payroll_cycle_id=cycle.id then locked_amount::bigint
        when payroll_cycle_id is null and not late_carried and total_amount>0
          and coalesce(cycle.status='open' and cycle.offset_settled_at is null,true)
          then total_amount::bigint else 0 end,
      'lateContributionAmount',case when payroll_cycle_id is null and not late_carried
        and total_amount>0 and cycle.id is not null
        and (cycle.status<>'open' or cycle.offset_settled_at is not null)
        then total_amount::bigint else 0 end,
      'alreadyClaimed',payroll_cycle_id is not null,'lateCarried',late_carried
    ) else jsonb_build_object('earningId',null,'baseAmount',null,'bombRoomBonus',null,'totalAmount',null,
      'expectedBaseContributionAmount',expected_base,'expectedBombContributionAmount',expected_bonus,
      'expectedContributionAmount',expected_base+expected_bonus,
      'pendingContributionAmount',case when eligible and attempt_status='submitted'
        then expected_base+expected_bonus else 0 end,
      'includedInPendingCount',eligible and attempt_status='submitted') end payload
    from normalized
  )
  select coalesce(jsonb_agg(payload order by entry_date,entry_id),'[]'::jsonb),
    (select count(*) from candidates),
    (select entry_date from page order by entry_date desc,entry_id desc limit 1),
    (select entry_id from page order by entry_date desc,entry_id desc limit 1)
  into rows,candidate_count,last_date,last_id from projected;
  return jsonb_build_object('weekStart',p_week_start,'maidProfileId',p_maid_profile_id,
    'kind',p_kind,'summary',summary,'entries',rows,'hasMore',candidate_count>p_limit,
    'lastEntryDate',last_date,'lastEntryId',last_id);
end $$;

revoke all on function public.list_payroll_work_details_page(uuid,uuid,text,date,uuid,text,date,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.list_payroll_work_details_page(uuid,uuid,text,date,uuid,text,date,uuid,integer)
  to service_role;
