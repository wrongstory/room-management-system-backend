-- #27: 시작 전 배정 변경. 실행/외부 push는 만들지 않는다.
create table public.assignment_change_requests (
  id uuid primary key default gen_random_uuid(),
  cleaning_target_id uuid not null references public.cleaning_targets(id),
  assignment_id uuid not null,
  maid_profile_id uuid not null references public.profiles(id),
  request_type text not null default 'cancel_assignment' check (request_type = 'cancel_assignment'),
  reason_code text not null check (reason_code in ('PERSONAL_REASON','HEALTH_REASON','MAID_UNAVAILABLE','OPERATIONAL_CHANGE')),
  reason_detail text check (char_length(reason_detail) between 1 and 200
    and reason_detail !~ '[0-9@:/]'),
  status text not null default 'pending' check (status in ('pending','approved','rejected','superseded')),
  source_assignment_revision bigint not null check (source_assignment_revision > 0),
  source_target_assignment_version bigint not null check (source_target_assignment_version > 0),
  requested_at timestamptz not null default clock_timestamp(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_reason_code text,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (assignment_id,cleaning_target_id,maid_profile_id,source_assignment_revision)
    references public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,revision),
  check ((status in ('pending','superseded') and decided_by is null and decided_at is null and decision_reason_code is null)
    or (status in ('approved','rejected') and decided_by is not null and decided_at is not null
      and decision_reason_code is not null and decision_reason_code in ('APPROVED','REJECTED','OPERATIONAL_CHANGE','MAID_UNAVAILABLE')))
);
create unique index assignment_change_requests_one_pending on public.assignment_change_requests(assignment_id) where status='pending';
create index assignment_change_requests_assignment_idx on public.assignment_change_requests(assignment_id);
create index assignment_change_requests_target_idx on public.assignment_change_requests(cleaning_target_id);
create index assignment_change_requests_actor_page_idx on public.assignment_change_requests(maid_profile_id,requested_at desc,id desc);
create index assignment_change_requests_page_idx on public.assignment_change_requests(requested_at desc,id desc);
create index assignment_change_requests_decider_idx on public.assignment_change_requests(decided_by);
alter table public.assignment_change_requests enable row level security;
revoke all on public.assignment_change_requests from public,anon,authenticated;
grant select on public.assignment_change_requests to authenticated;
grant select,insert,update on public.assignment_change_requests to service_role;
create policy assignment_change_requests_read on public.assignment_change_requests for select to authenticated
using ((select private.current_role())='admin' or
  ((select private.current_role())='maid' and maid_profile_id=(select private.current_profile_id())));

create function private.guard_assignment_change_request()
returns trigger language plpgsql set search_path=''
as $$
begin
  if tg_op='DELETE' then raise exception using errcode='23514',message='ASSIGNMENT_CHANGE_REQUEST_IMMUTABLE'; end if;
  if old.status <> 'pending' or new.status not in ('approved','rejected','superseded')
    or (to_jsonb(new)-array['status','decided_by','decided_at','decision_reason_code'])
      is distinct from (to_jsonb(old)-array['status','decided_by','decided_at','decision_reason_code']) then
    raise exception using errcode='23514',message='ASSIGNMENT_CHANGE_REQUEST_IMMUTABLE';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_assignment_change_request() from public,anon,authenticated;
create trigger assignment_change_requests_immutable before update or delete on public.assignment_change_requests
for each row execute function private.guard_assignment_change_request();

-- 이전 domain command(예약 취소/조기 checkout/draft 재저장)도 ghost pending을 남기지 않는다.
create function private.supersede_assignment_requests()
returns trigger language plpgsql security definer set search_path=''
as $$
declare req record;
begin
  if old.is_current and not new.is_current then
    for req in update public.assignment_change_requests set status='superseded'
      where assignment_id=old.id and status='pending' returning id
    loop
      update public.notifications set resolved_at=coalesce(resolved_at,clock_timestamp())
      where dedupe_key='assignment-request:'||req.id::text and requires_action;
    end loop;
  end if;
  return null;
end;
$$;
revoke all on function private.supersede_assignment_requests() from public,anon,authenticated;
create trigger assignment_requests_supersede after update of is_current on public.cleaning_assignments
for each row execute function private.supersede_assignment_requests();

-- #28이 사용할 INSERT 경계만 보호한다. attempt를 생성/활성화하는 기능은 아니다.
-- 고정 순서: reservation-command -> target -> assignment. stale assignment로 시작할 수 없다.
create function private.guard_prestart_attempt_identity()
returns trigger language plpgsql security definer set search_path=''
as $$
declare t public.cleaning_targets%rowtype; a public.cleaning_assignments%rowtype;
begin
  if new.status='superseded' then return new; end if;
  if tg_op='UPDATE' and old.status <> 'superseded'
    and (new.cleaning_target_id,new.assignment_id,new.maid_profile_id,new.assignment_revision)
      is not distinct from (old.cleaning_target_id,old.assignment_id,old.maid_profile_id,old.assignment_revision) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into t from public.cleaning_targets where id=new.cleaning_target_id for update;
  select * into a from public.cleaning_assignments where id=new.assignment_id for update;
  -- 복합 FK의 기존 23503 계약은 유지한다. 유효한 identity의 stale/current 경계만 추가 검증한다.
  if a.id is null or a.cleaning_target_id is distinct from t.id
    or a.maid_profile_id is distinct from new.maid_profile_id or a.revision is distinct from new.assignment_revision then
    return new;
  end if;
  if not a.is_current or t.assignment_version is distinct from a.revision then
    raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_prestart_attempt_identity() from public,anon,authenticated;
create trigger ab_prestart_attempt_identity before insert or update on public.cleaning_attempts
for each row execute function private.guard_prestart_attempt_identity();

create function private.prestart_assignment_projection(p_id uuid)
returns jsonb language sql stable set search_path=''
as $$
  select jsonb_build_object('assignmentId',a.id,'cleaningTargetId',t.id,'roomId',t.room_id,
    'roomNumber',r.room_number,'maidProfileId',a.maid_profile_id,'maidDisplayName',p.display_name,
    'serviceDate',a.service_date,'sequenceNumber',a.sequence_number,'revision',a.revision,
    'isCurrent',a.is_current,'targetAssignmentVersion',t.assignment_version,
    'availableFrom',a.available_from_snapshot,'dueAt',a.due_at_snapshot,'notifiedAt',a.notified_at,
    'endedAt',a.ended_at,'createdAt',a.created_at)
  from public.cleaning_assignments a join public.cleaning_targets t on t.id=a.cleaning_target_id
  join public.rooms r on r.id=t.room_id join public.profiles p on p.id=a.maid_profile_id where a.id=p_id;
$$;
create function private.assignment_request_projection(p_row public.assignment_change_requests)
returns jsonb language sql immutable set search_path=''
as $$ select jsonb_build_object('requestId',p_row.id,'cleaningTargetId',p_row.cleaning_target_id,
  'assignmentId',p_row.assignment_id,'maidProfileId',p_row.maid_profile_id,'requestType',p_row.request_type,
  'reasonCode',p_row.reason_code,'reasonDetail',p_row.reason_detail,'status',p_row.status,
  'sourceAssignmentRevision',p_row.source_assignment_revision,'sourceTargetAssignmentVersion',p_row.source_target_assignment_version,
  'requestedAt',p_row.requested_at,'decision',case when p_row.status in ('approved','rejected') then p_row.status end,
  'decisionReasonCode',p_row.decision_reason_code,'decidedAt',p_row.decided_at); $$;
revoke all on function private.prestart_assignment_projection(uuid),private.assignment_request_projection(public.assignment_change_requests)
from public,anon,authenticated;

create function private.prestart_notice(p_recipient uuid,p_target public.cleaning_targets,p_category text,p_key text,p_action boolean)
returns void language plpgsql set search_path=''
as $$
declare n uuid;
begin
  insert into public.notifications(recipient_profile_id,category,title,body,room_id,cleaning_target_id,dedupe_key,requires_action)
  values(p_recipient,p_category,'청소 배정 변경 안내',p_target.effective_service_date::text||' 청소 배정 내역을 확인해 주세요.',
    p_target.room_id,p_target.id,p_key,p_action) returning id into n;
  insert into private.notification_outbox(notification_id,channel,delivery_status) values(n,'web_push','pending');
end;
$$;
revoke all on function private.prestart_notice(uuid,public.cleaning_targets,text,text,boolean) from public,anon,authenticated;

create function public.list_assignment_change_requests(p_actor_profile_id uuid,p_maid_profile_id uuid default null,
  p_status text default null,p_from timestamptz default null,p_to timestamptz default null,
  p_before_at timestamptz default null,p_before_id uuid default null,p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor public.profiles%rowtype; v_from timestamptz:=coalesce(p_from,clock_timestamp()-interval '7 days');
  v_to timestamptz:=coalesce(p_to,clock_timestamp()); rows jsonb;
begin
  select * into actor from public.profiles where id=p_actor_profile_id and status='active';
  if actor.id is null or actor.role not in ('admin','maid') then
    raise exception using errcode='42501',message='ASSIGNMENT_ACCESS_REQUIRED'; end if;
  if actor.role='maid' then
    if p_maid_profile_id is not null and p_maid_profile_id<>actor.id then
      raise exception using errcode='42501',message='ASSIGNMENT_CHANGE_REQUEST_ACCESS_REQUIRED'; end if;
    p_maid_profile_id:=actor.id;
  end if;
  if p_limit is null or p_limit not between 1 and 100 or v_from>v_to or v_to-v_from>interval '31 days'
    or (p_before_at is null)<>(p_before_id is null)
    or (p_status is not null and p_status not in ('pending','approved','rejected','superseded')) then
    raise exception using errcode='22023',message='ASSIGNMENT_QUERY_INVALID'; end if;
  select coalesce(jsonb_agg(private.assignment_request_projection(page) order by page.requested_at desc,page.id desc),'[]'::jsonb) into rows
  from (select q.* from public.assignment_change_requests q where q.requested_at>=v_from and q.requested_at<=v_to
    and (p_maid_profile_id is null or q.maid_profile_id=p_maid_profile_id) and (p_status is null or q.status=p_status)
    and (p_before_at is null or (q.requested_at,q.id)<(p_before_at,p_before_id))
    order by q.requested_at desc,q.id desc limit p_limit) page;
  return rows;
end;
$$;
revoke all on function public.list_assignment_change_requests(uuid,uuid,text,timestamptz,timestamptz,timestamptz,uuid,integer) from public,anon,authenticated;
grant execute on function public.list_assignment_change_requests(uuid,uuid,text,timestamptz,timestamptz,timestamptz,uuid,integer) to service_role;

-- 단일 transaction 구현을 좁은 네 개의 public RPC가 호출한다. private helper는 외부 실행 불가.
create function private.assignment_prestart_command(
  p_actor uuid,p_action text,p_target uuid,p_assignment uuid,p_version bigint,
  p_maid uuid,p_sequence integer,p_available timestamptz,p_due timestamptz,
  p_request uuid,p_decision text,p_reason text,p_detail text,p_key text,p_hash text
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  t public.cleaning_targets%rowtype; a public.cleaning_assignments%rowtype; next_a public.cleaning_assignments%rowtype;
  q public.assignment_change_requests%rowtype; r public.reservations%rowtype;
  cmd text; event_name text; response jsonb; summary jsonb; entity uuid;
  wk date; admin_row record; was_notified boolean; changed_schedule boolean;
  access_at timestamptz; deadline timestamptz; v_now timestamptz:=clock_timestamp();
begin
  if p_action='request' then
    if private.assert_active_actor(p_actor)<>'maid' then
      raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  else perform private.assert_room_admin(p_actor); end if;
  cmd:=case p_action when 'change' then 'assignment.prestart_change' when 'unassign' then 'assignment.prestart_unassign'
    when 'request' then 'assignment.cancellation_request' when 'decision' then 'assignment.cancellation_decision' end;
  if cmd is null or p_version is null or p_version<1 or p_assignment is null then
    raise exception using errcode='22023',message='ASSIGNMENT_INPUT_INVALID'; end if;
  if p_reason is null or not (p_reason=any(case p_action when 'request' then
    array['PERSONAL_REASON','HEALTH_REASON','MAID_UNAVAILABLE','OPERATIONAL_CHANGE']
    when 'decision' then array['APPROVED','REJECTED','OPERATIONAL_CHANGE','MAID_UNAVAILABLE']
    else array['MAID_UNAVAILABLE','SCHEDULE_CHANGED','SEQUENCE_CHANGED','OPERATIONAL_CHANGE'] end)) then
    raise exception using errcode='22023',message='ASSIGNMENT_REASON_INVALID'; end if;
  if p_detail is not null and (char_length(p_detail) not between 1 and 200 or p_detail ~ '[0-9@:/]') then
    raise exception using errcode='22023',message='ASSIGNMENT_REASON_INVALID'; end if;
  response:=private.replay_command(p_actor,cmd,p_key,p_hash);
  if response is not null then return response; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  if p_action='decision' then
    if p_decision is null or p_decision not in ('approved','rejected') then
      raise exception using errcode='22023',message='ASSIGNMENT_INPUT_INVALID'; end if;
    select * into q from public.assignment_change_requests where id=p_request;
    if not found then raise exception using errcode='P0002',message='ASSIGNMENT_CHANGE_REQUEST_NOT_FOUND'; end if;
    p_target:=q.cleaning_target_id;
  end if;
  select * into t from public.cleaning_targets where id=p_target for update;
  select * into a from public.cleaning_assignments where cleaning_target_id=t.id and is_current for update;
  if p_action='decision' then
    select * into q from public.assignment_change_requests where id=p_request for update;
    if q.status='superseded' then raise exception using errcode='40001',message='ASSIGNMENT_CHANGE_REQUEST_STALE'; end if;
    if q.status<>'pending' then raise exception using errcode='23514',message='ASSIGNMENT_CHANGE_REQUEST_ALREADY_DECIDED'; end if;
    if q.assignment_id is distinct from a.id or q.source_target_assignment_version is distinct from t.assignment_version
      or q.assignment_id is distinct from p_assignment or q.source_target_assignment_version is distinct from p_version then
      raise exception using errcode='40001',message='ASSIGNMENT_CHANGE_REQUEST_STALE'; end if;
  end if;
  if t.id is null or a.id is null then raise exception using errcode='P0002',message='ASSIGNMENT_NOT_FOUND'; end if;
  if p_action='request' and a.maid_profile_id<>p_actor then
    raise exception using errcode='42501',message='ASSIGNMENT_CHANGE_REQUEST_ACCESS_REQUIRED'; end if;
  if exists(select 1 from public.cleaning_attempts where cleaning_target_id=t.id and status<>'superseded') then
    raise exception using errcode='23514',message='ASSIGNMENT_ALREADY_STARTED'; end if;
  if t.status not in ('draft_assigned','notified') or (p_action in ('request','decision') and t.status<>'notified') then
    raise exception using errcode='23514',message='ASSIGNMENT_PRESTART_REQUIRED'; end if;
  if t.assignment_version<>p_version or a.id<>p_assignment then
    raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT'; end if;
  was_notified:=t.status='notified';
  if p_action='change' then
    if p_sequence is null or p_sequence<1 or p_maid is null then
      raise exception using errcode='22023',message='ASSIGNMENT_INPUT_INVALID'; end if;
    perform 1 from public.profiles where id=p_maid and role='maid' and status='active' for share;
    if not found then raise exception using errcode='23514',message='ASSIGNMENT_MAID_UNAVAILABLE'; end if;
    if t.source='inspection_reclean' and p_maid is distinct from t.reclean_maid_profile_id then
      raise exception using errcode='23514',message='RECLEAN_MAID_IMMUTABLE'; end if;
    wk:=t.effective_service_date-(extract(isodow from t.effective_service_date)::integer-1);
    perform pg_advisory_xact_lock(hashtextextended('availability:'||p_maid::text||':'||wk::text,0));
    if not exists(select 1 from public.availability_versions v join public.availability_days d on d.availability_version_id=v.id
      where v.maid_profile_id=p_maid and v.week_start=wk and v.is_current and d.work_date=t.effective_service_date and d.available) then
      raise exception using errcode='23514',message='ASSIGNMENT_MAID_UNAVAILABLE'; end if;
    if exists(select 1 from public.cleaning_assignments where is_current and id<>a.id and maid_profile_id=p_maid
      and service_date=t.effective_service_date and sequence_number=p_sequence) then
      raise exception using errcode='23514',message='ASSIGNMENT_SEQUENCE_CONFLICT'; end if;
    access_at:=coalesce(p_available,t.available_from); deadline:=coalesce(p_due,t.due_at);
    changed_schedule:=access_at is distinct from t.available_from or deadline is distinct from t.due_at;
    if changed_schedule then
      -- 예약/checkout 원장의 시간을 #27로 우회해 변경하지 않는다. 수동 요청만 같은 날짜의 기존 창을 좁힐 수 있다.
      if t.source<>'manual_room_request' or t.cleaning_kind not in ('additional','stayover')
        or access_at is null or deadline is null or access_at>=deadline
        or t.available_from is null or t.due_at is null
        or access_at<t.available_from or deadline>t.due_at
        or (access_at at time zone 'Asia/Seoul')::date<>t.effective_service_date then
        raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID'; end if;
      if t.cleaning_kind='stayover' then
        select * into r from public.reservations where id=t.reservation_id;
        if r.status<>'active' or r.actual_checkout_at is not null or access_at<r.check_in_at or deadline>r.check_out_at then
          raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID'; end if;
      end if;
    end if;
    update public.cleaning_assignments set is_current=false,ended_at=v_now,change_reason_code=p_reason where id=a.id;
    update public.cleaning_targets set assignment_version=assignment_version+1,available_from=access_at,due_at=deadline
      where id=t.id returning * into t;
    if changed_schedule then
      insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,available_from,due_at,reason_code,changed_by)
      values(t.id,t.assignment_version,t.effective_service_date,t.available_from,t.due_at,p_reason,p_actor);
    end if;
    insert into public.cleaning_assignments(cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at)
    values(t.id,p_maid,p_sequence,t.assignment_version,p_actor,case when was_notified then v_now end) returning * into next_a;
    if was_notified then
      update public.notifications set resolved_at=coalesce(resolved_at,v_now) where cleaning_target_id=t.id
        and recipient_profile_id=a.maid_profile_id and requires_action
        and category in ('cleaning_assignment_notified','cleaning_assignment_changed','cleaning_schedule_changed');
      if a.maid_profile_id<>p_maid then
        perform private.prestart_notice(a.maid_profile_id,t,'cleaning_assignment_revoked','prestart-revoke:'||a.id::text,false);
      end if;
      perform private.prestart_notice(p_maid,t,case when a.maid_profile_id=p_maid then 'cleaning_assignment_changed' else 'cleaning_assignment_notified' end,
        'prestart-notify:'||next_a.id::text,true);
    end if;
    event_name:='assignment.prestart_changed'; entity:=next_a.id;
    response:=private.prestart_assignment_projection(next_a.id);
  elsif p_action='request' then
    if exists(select 1 from public.assignment_change_requests where assignment_id=a.id and status='pending') then
      raise exception using errcode='23514',message='ASSIGNMENT_CHANGE_REQUEST_EXISTS'; end if;
    insert into public.assignment_change_requests(cleaning_target_id,assignment_id,maid_profile_id,reason_code,reason_detail,
      source_assignment_revision,source_target_assignment_version)
    values(t.id,a.id,p_actor,p_reason,p_detail,a.revision,t.assignment_version) returning * into q;
    for admin_row in select id from public.profiles where role='admin' and status='active' order by id loop
      perform private.prestart_notice(admin_row.id,t,'assignment_cancellation_requested','assignment-request:'||q.id::text,true);
    end loop;
    event_name:='assignment.cancellation_requested'; entity:=q.id;
    response:=private.assignment_request_projection(q);
  else
    if p_action='decision' then
      -- 요청을 먼저 terminal로 만들어 source 종료 trigger가 승인 이력을 superseded로 덮지 않게 한다.
      update public.assignment_change_requests set status=p_decision,decided_by=p_actor,decided_at=v_now,decision_reason_code=p_reason
      where id=q.id returning * into q;
      update public.notifications set resolved_at=coalesce(resolved_at,v_now) where dedupe_key='assignment-request:'||q.id::text and requires_action;
    end if;
    if p_action='unassign' or p_decision='approved' then
      update public.cleaning_assignments set is_current=false,ended_at=v_now,change_reason_code=p_reason where id=a.id;
      update public.cleaning_targets set status='unassigned',assignment_version=assignment_version+1 where id=t.id returning * into t;
      if was_notified then
        update public.notifications set resolved_at=coalesce(resolved_at,v_now) where cleaning_target_id=t.id
          and recipient_profile_id=a.maid_profile_id and requires_action
          and category in ('cleaning_assignment_notified','cleaning_assignment_changed','cleaning_schedule_changed');
      end if;
    end if;
    if was_notified then
      perform private.prestart_notice(a.maid_profile_id,t,
        case when p_action='unassign' then 'cleaning_assignment_revoked'
          when p_decision='approved' then 'assignment_cancellation_approved' else 'assignment_cancellation_rejected' end,
        case when p_action='unassign' then 'prestart-revoke:'||a.id::text else 'assignment-decision:'||q.id::text end,false);
    end if;
    if p_action='unassign' then event_name:='assignment.prestart_unassigned';entity:=a.id;
      response:=private.prestart_assignment_projection(a.id);
    else event_name:='assignment.cancellation_decided';entity:=q.id;response:=private.assignment_request_projection(q);end if;
  end if;
  summary:=jsonb_strip_nulls(jsonb_build_object('cleaningTargetId',t.id,'assignmentId',coalesce(next_a.id,a.id),
    'previousAssignmentId',case when next_a.id is not null then a.id end,'maidProfileId',coalesce(next_a.maid_profile_id,a.maid_profile_id),
    'previousMaidProfileId',case when next_a.id is not null then a.maid_profile_id end,'serviceDate',t.effective_service_date,
    'sequenceNumber',coalesce(next_a.sequence_number,a.sequence_number),'revision',coalesce(next_a.revision,a.revision),
    'targetAssignmentVersion',t.assignment_version,'requestId',q.id,'decision',p_decision,'reasonCode',p_reason));
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,effective_at,reason_code,after_state,request_hash,idempotency_key)
  select p_actor,display_name,event_name,case when q.id is null then 'cleaning_assignment' else 'assignment_change_request' end,
    entity,v_now,p_reason,summary,p_hash,private.audit_command_key(p_actor,cmd,p_key) from public.profiles where id=p_actor;
  perform private.complete_command(p_actor,cmd,p_key,p_hash,entity,response);
  return response;
end;
$$;
revoke all on function private.assignment_prestart_command(uuid,text,uuid,uuid,bigint,uuid,integer,timestamptz,timestamptz,uuid,text,text,text,text,text)
from public,anon,authenticated;

create function public.change_cleaning_assignment_prestart(p_actor_profile_id uuid,p_cleaning_target_id uuid,
  p_expected_current_assignment_id uuid,p_expected_assignment_version bigint,p_maid_profile_id uuid,p_sequence_number integer,
  p_reason_code text,p_idempotency_key text,p_request_hash text,p_available_from timestamptz default null,p_due_at timestamptz default null)
returns jsonb language sql security definer set search_path='' as $$
  select private.assignment_prestart_command(p_actor_profile_id,'change',p_cleaning_target_id,p_expected_current_assignment_id,
    p_expected_assignment_version,p_maid_profile_id,p_sequence_number,p_available_from,p_due_at,null,null,p_reason_code,null,p_idempotency_key,p_request_hash); $$;
create function public.unassign_cleaning_assignment_prestart(p_actor_profile_id uuid,p_cleaning_target_id uuid,
  p_expected_current_assignment_id uuid,p_expected_assignment_version bigint,p_reason_code text,p_idempotency_key text,p_request_hash text)
returns jsonb language sql security definer set search_path='' as $$
  select private.assignment_prestart_command(p_actor_profile_id,'unassign',p_cleaning_target_id,p_expected_current_assignment_id,
    p_expected_assignment_version,null,null,null,null,null,null,p_reason_code,null,p_idempotency_key,p_request_hash); $$;
create function public.request_assignment_cancellation(p_actor_profile_id uuid,p_cleaning_target_id uuid,
  p_expected_current_assignment_id uuid,p_expected_assignment_version bigint,p_reason_code text,p_idempotency_key text,p_request_hash text,p_reason_detail text default null)
returns jsonb language sql security definer set search_path='' as $$
  select private.assignment_prestart_command(p_actor_profile_id,'request',p_cleaning_target_id,p_expected_current_assignment_id,
    p_expected_assignment_version,null,null,null,null,null,null,p_reason_code,p_reason_detail,p_idempotency_key,p_request_hash); $$;
create function public.decide_assignment_cancellation_request(p_actor_profile_id uuid,p_request_id uuid,
  p_expected_current_assignment_id uuid,p_expected_assignment_version bigint,p_decision text,p_reason_code text,p_idempotency_key text,p_request_hash text)
returns jsonb language sql security definer set search_path='' as $$
  select private.assignment_prestart_command(p_actor_profile_id,'decision',null,p_expected_current_assignment_id,
    p_expected_assignment_version,null,null,null,null,p_request_id,p_decision,p_reason_code,null,p_idempotency_key,p_request_hash); $$;
revoke all on function public.change_cleaning_assignment_prestart(uuid,uuid,uuid,bigint,uuid,integer,text,text,text,timestamptz,timestamptz),
  public.unassign_cleaning_assignment_prestart(uuid,uuid,uuid,bigint,text,text,text),
  public.request_assignment_cancellation(uuid,uuid,uuid,bigint,text,text,text,text),
  public.decide_assignment_cancellation_request(uuid,uuid,uuid,bigint,text,text,text,text) from public,anon,authenticated;
grant execute on function public.change_cleaning_assignment_prestart(uuid,uuid,uuid,bigint,uuid,integer,text,text,text,timestamptz,timestamptz),
  public.unassign_cleaning_assignment_prestart(uuid,uuid,uuid,bigint,text,text,text),
  public.request_assignment_cancellation(uuid,uuid,uuid,bigint,text,text,text,text),
  public.decide_assignment_cancellation_request(uuid,uuid,uuid,bigint,text,text,text,text) to service_role;

create or replace function public.list_developer_audit_events(
  p_actor_profile_id uuid,
  p_event_types text[] default null,
  p_filter_actor_profile_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  event_type text,
  entity_type text,
  entity_id uuid,
  actor_profile_id uuid,
  actor_display_name text,
  effective_at timestamptz,
  recorded_at timestamptz,
  reason_code text,
  summary jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed constant text[] := array[
    'account.bootstrap_developer_created',
    'account.bootstrap_admin_created',
    'account.created',
    'account.role_changed',
    'account.status_changed',
    'account.unlocked',
    'account.password_reset_requested',
    'account.password_changed',
    'availability.submitted',
    'availability.change_requested',
    'availability.change_decided',
    'assignment.draft_saved',
    'assignment.notified',
    'assignment.prestart_changed',
    'assignment.prestart_unassigned',
    'assignment.cancellation_requested',
    'assignment.cancellation_decided',
    'reservation.created',
    'reservation.changed',
    'reservation.cancelled',
    'reservation.manual_checkout',
    'reservation.scheduled_check_in',
    'reservation.scheduled_checkout',
    'reservation.guest_name_retention_purged',
    'cleaning.manual_request.created',
    'cleaning.manual_request.cancelled',
    'room.master_data_changed',
    'room.create_block',
    'room.release_block',
    'room.set_candle_count',
    'room.report_issue',
    'room.resolve_issue',
    'room.record_pin_sync'
  ];
  v_selected text[] := coalesce(p_event_types, v_allowed);
  v_from timestamptz := coalesce(p_from, clock_timestamp() - interval '7 days');
  v_to timestamptz := coalesce(p_to, clock_timestamp());
begin
  perform private.assert_active_developer(p_actor_profile_id);

  if p_limit not between 1 and 100
    or v_from > v_to
    or v_to - v_from > interval '31 days'
    or (p_before_recorded_at is null) <> (p_before_id is null)
    or coalesce(cardinality(v_selected), 0) not between 1 and cardinality(v_allowed)
    or exists (
      select 1 from unnest(v_selected) requested
      where not requested = any (v_allowed)
    ) then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_QUERY';
  end if;

  return query
  select
    audit.id,
    audit.event_type,
    audit.entity_type,
    audit.entity_id,
    audit.actor_profile_id,
    audit.actor_display_name_snapshot,
    audit.effective_at,
    audit.recorded_at,
    audit.reason_code,
    case
      when audit.event_type like 'account.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'displayName', audit.after_state ->> 'displayName',
          'loginId', audit.after_state ->> 'loginId',
          'role', audit.after_state ->> 'role',
          'status', audit.after_state ->> 'status',
          'mustChangePassword', audit.after_state -> 'mustChangePassword'
        ))
      when audit.event_type like 'availability.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'maidProfileId', audit.after_state ->> 'maidProfileId',
          'weekStart', audit.after_state ->> 'weekStart',
          'version', audit.after_state -> 'version',
          'sourceVersion', audit.after_state -> 'sourceVersion',
          'status', audit.after_state ->> 'status',
          'approvedVersionId', audit.after_state ->> 'approvedVersionId'
        ))
      when audit.event_type = 'assignment.draft_saved' then
        jsonb_strip_nulls(jsonb_build_object(
          'cleaningTargetId', audit.after_state ->> 'cleaningTargetId',
          'maidProfileId', audit.after_state ->> 'maidProfileId',
          'serviceDate', audit.after_state ->> 'serviceDate',
          'sequenceNumber', audit.after_state -> 'sequenceNumber',
          'revision', audit.after_state -> 'revision',
          'targetAssignmentVersion', audit.after_state -> 'targetAssignmentVersion'
        ))
      when audit.event_type in ('assignment.notified','assignment.prestart_changed','assignment.prestart_unassigned','assignment.cancellation_requested','assignment.cancellation_decided') then
        jsonb_strip_nulls(jsonb_build_object(
          'cleaningTargetId', audit.after_state ->> 'cleaningTargetId',
          'assignmentId', audit.after_state ->> 'assignmentId',
          'previousAssignmentId', audit.after_state ->> 'previousAssignmentId',
          'previousMaidProfileId', audit.after_state ->> 'previousMaidProfileId',
          'targetAssignmentVersion', audit.after_state -> 'targetAssignmentVersion',
          'requestId', audit.after_state ->> 'requestId',
          'decision', audit.after_state ->> 'decision',
          'reasonCode', audit.after_state ->> 'reasonCode',
          'maidProfileId', audit.after_state ->> 'maidProfileId',
          'serviceDate', audit.after_state ->> 'serviceDate',
          'sequenceNumber', audit.after_state -> 'sequenceNumber',
          'revision', audit.after_state -> 'revision'
        ))
      when audit.event_type like 'reservation.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'roomId', audit.after_state ->> 'room_id',
          'status', audit.after_state ->> 'status',
          'version', audit.after_state -> 'version',
          'checkInAt', audit.after_state ->> 'check_in_at',
          'checkOutAt', audit.after_state ->> 'check_out_at',
          'purgedCount', audit.after_state -> 'purged_count'
        ))
      when audit.event_type like 'cleaning.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'roomId', audit.after_state ->> 'room_id',
          'reservationId', audit.after_state ->> 'reservation_id',
          'cleaningKind', audit.after_state ->> 'cleaning_kind',
          'status', audit.after_state ->> 'status',
          'serviceDate', audit.after_state ->> 'service_date',
          'availableFrom', audit.after_state ->> 'available_from',
          'dueAt', audit.after_state ->> 'due_at',
          'version', audit.after_state -> 'version'
        ))
      when audit.event_type like 'room.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'roomTypeId', audit.after_state ->> 'roomTypeId',
          'elevatorZone', audit.after_state ->> 'elevatorZone',
          'dataStatus', audit.after_state ->> 'dataStatus',
          'stateVersion', audit.after_state -> 'stateVersion',
          'blockId', audit.after_state ->> 'blockId',
          'active', audit.after_state -> 'active',
          'count', audit.after_state -> 'count',
          'issueId', audit.after_state ->> 'issueId',
          'category', audit.after_state ->> 'category',
          'severity', audit.after_state ->> 'severity',
          'blocksGuestAssignment', audit.after_state -> 'blocksGuestAssignment',
          'status', audit.after_state ->> 'status',
          'pinSyncEventId', audit.after_state ->> 'pinSyncEventId',
          'syncStatus', audit.after_state ->> 'syncStatus',
          'pinVersion', audit.after_state -> 'pinVersion'
        ))
      else '{}'::jsonb
    end
  from public.audit_events audit
  where audit.event_type = any (v_selected)
    and audit.recorded_at >= v_from
    and audit.recorded_at <= v_to
    and (p_filter_actor_profile_id is null
      or audit.actor_profile_id = p_filter_actor_profile_id)
    and (
      p_before_recorded_at is null
      or (audit.recorded_at, audit.id) < (p_before_recorded_at, p_before_id)
    )
  order by audit.recorded_at desc, audit.id desc
  limit p_limit;
end;
$$;

revoke all on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) to service_role;
