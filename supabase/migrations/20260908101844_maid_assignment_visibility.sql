-- #4 승인 A안: 통보 사실은 revision별 권한 경계이며 current target 권한이 아니다.
-- 기존 업무/통보/시도 이력을 보존하고 조회 정책·향후 통보 객실 snapshot을 보강한다.
-- 이전 통보의 객실은 현재 target에서 추정하지 않는다. Legacy NULL은 정보 없음이며,
-- 이후 통보만 그 시점의 객실을 저장한다. API는 현재 target으로 fallback하지 않는다.
alter table public.cleaning_assignments
  add column notified_room_id_snapshot uuid references public.rooms(id) on delete restrict,
  add column notified_room_number_snapshot text,
  add constraint cleaning_assignments_notified_room_pair check (
    (notified_room_id_snapshot is null) = (notified_room_number_snapshot is null)
    and (notified_room_number_snapshot is null or char_length(notified_room_number_snapshot)>0)
  );
create index cleaning_assignments_notified_room_idx
on public.cleaning_assignments(notified_room_id_snapshot)
where notified_room_id_snapshot is not null;

create function private.capture_assignment_notification_room()
returns trigger language plpgsql set search_path=''
as $$
begin
  if tg_op='UPDATE' then
    if old.notified_at is not null then
      if new.notified_room_id_snapshot is distinct from old.notified_room_id_snapshot
        or new.notified_room_number_snapshot is distinct from old.notified_room_number_snapshot then
        raise exception using errcode='23514',message='ASSIGNMENT_NOTIFICATION_ROOM_IMMUTABLE';
      end if;
      return new;
    end if;
  end if;
  if new.notified_at is null then
    -- caller의 draft metadata는 통보 사실/노출 근거로 저장하지 않는다.
    new.notified_room_id_snapshot:=null;
    new.notified_room_number_snapshot:=null;
  else
    -- 최초 통보의 caller-supplied snapshot은 신뢰하지 않고 DB source로 덮어쓴다.
    select target.room_id,room.room_number
      into new.notified_room_id_snapshot,new.notified_room_number_snapshot
    from public.cleaning_targets target join public.rooms room on room.id=target.room_id
    where target.id=new.cleaning_target_id;
    if not found then
      raise exception using errcode='P0002',message='CLEANING_TARGET_NOT_FOUND';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.capture_assignment_notification_room()
from public,anon,authenticated;
create trigger cleaning_assignments_capture_notification_room
before insert or update on public.cleaning_assignments
for each row execute function private.capture_assignment_notification_room();

create index cleaning_assignments_notified_maid_history_idx
on public.cleaning_assignments (maid_profile_id, cleaning_target_id, revision)
where notified_at is not null;

drop policy assignments_read_scoped on public.cleaning_assignments;
create policy assignments_read_scoped on public.cleaning_assignments
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or (
    (select private.current_role()) = 'maid'
    and maid_profile_id = (select private.current_profile_id())
    and notified_at is not null
  )
);

-- 과거 통보 revision 소유는 현재 target의 새 담당·계획을 조회할 권한이 아니다.
-- 과거 이력 화면은 assignment의 immutable schedule/revision projection을 사용한다.
drop policy targets_read_scoped on public.cleaning_targets;
create policy targets_read_scoped on public.cleaning_targets
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or (
    (select private.current_role()) = 'maid'
    and exists (
      select 1 from public.cleaning_assignments assignment
      where assignment.cleaning_target_id = cleaning_targets.id
        and assignment.maid_profile_id = (select private.current_profile_id())
        and assignment.notified_at is not null
        and assignment.is_current
        and assignment.notified_room_id_snapshot = cleaning_targets.room_id
        and assignment.revision = cleaning_targets.assignment_version
        and assignment.service_date = cleaning_targets.effective_service_date
        and assignment.available_from_snapshot is not distinct from cleaning_targets.available_from
        and assignment.due_at_snapshot is not distinct from cleaning_targets.due_at
    )
  )
);

-- target를 한 번 배정받았다는 이유로 이전 draft/타인 schedule revision을 펼치지 않는다.
drop policy cleaning_target_schedule_revisions_scoped_read
on public.cleaning_target_schedule_revisions;
create policy cleaning_target_schedule_revisions_scoped_read
on public.cleaning_target_schedule_revisions for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or (
    (select private.current_role()) = 'maid'
    and exists (
      select 1 from public.cleaning_assignments assignment
      where assignment.cleaning_target_id = cleaning_target_schedule_revisions.cleaning_target_id
        and assignment.maid_profile_id = (select private.current_profile_id())
        and assignment.notified_at is not null
        and assignment.revision = cleaning_target_schedule_revisions.revision
        and assignment.service_date = cleaning_target_schedule_revisions.effective_service_date
        and assignment.available_from_snapshot is not distinct from cleaning_target_schedule_revisions.available_from
        and assignment.due_at_snapshot is not distinct from cleaning_target_schedule_revisions.due_at
    )
  )
);

drop policy attempts_read_scoped on public.cleaning_attempts;
create policy attempts_read_scoped on public.cleaning_attempts
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or (
    (select private.current_role()) = 'maid'
    and maid_profile_id = (select private.current_profile_id())
    and exists (
      select 1 from public.cleaning_assignments assignment
      where assignment.id = cleaning_attempts.assignment_id
        and assignment.maid_profile_id = (select private.current_profile_id())
        and assignment.notified_at is not null
    )
  )
);

drop policy assignment_change_requests_read on public.assignment_change_requests;
create policy assignment_change_requests_read on public.assignment_change_requests
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or (
    (select private.current_role()) = 'maid'
    and maid_profile_id = (select private.current_profile_id())
    and exists (
      select 1 from public.cleaning_assignments assignment
      where assignment.id = assignment_change_requests.assignment_id
        and assignment.maid_profile_id = (select private.current_profile_id())
        and assignment.notified_at is not null
    )
  )
);

drop policy room_pin_access_leases_scoped_read on public.room_pin_access_leases;
create policy room_pin_access_leases_scoped_read on public.room_pin_access_leases
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or (
    (select private.current_role()) = 'maid'
    and issued_to = (select private.current_profile_id())
    and exists (
      select 1 from public.cleaning_assignments assignment
      where assignment.id = room_pin_access_leases.assignment_id
        and assignment.maid_profile_id = (select private.current_profile_id())
        and assignment.notified_at is not null
    )
  )
);

-- 사진/검수 파생 정책은 submission 조회를 사용하므로 동일한 통보 경계를 상속한다.
drop policy submissions_read_scoped on public.cleaning_submissions;
create policy submissions_read_scoped on public.cleaning_submissions
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or (
    (select private.current_role()) = 'maid'
    and submitted_by = (select private.current_profile_id())
    and exists (
      select 1 from public.cleaning_attempts attempt
      where attempt.id = cleaning_submissions.cleaning_attempt_id
        and attempt.maid_profile_id = (select private.current_profile_id())
    )
  )
);

-- 통보된 revision이 종료되어도 통보 시각을 지워 과거 통보 이력을 잃게 하지 않는다.
-- 미통보 과거 draft를 사후에 통보된 revision으로 승격시키는 UPDATE도 거부한다.
create function private.preserve_assignment_notification_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.notified_at is not null
    and new.notified_at is distinct from old.notified_at then
    raise exception using errcode = '23514', message = 'ASSIGNMENT_NOTIFICATION_IMMUTABLE';
  end if;
  if old.notified_at is null and new.notified_at is not null and not old.is_current then
    raise exception using errcode = '23514', message = 'ASSIGNMENT_NOTIFICATION_REQUIRES_CURRENT';
  end if;
  return new;
end;
$$;
revoke all on function private.preserve_assignment_notification_history()
from public, anon, authenticated;
create trigger cleaning_assignments_preserve_notification_history
before update of notified_at on public.cleaning_assignments
for each row execute function private.preserve_assignment_notification_history();

-- Service-role projection도 동일한 통보 경계를 적용한다. RLS만 좁히면
-- SECURITY DEFINER 조회가 미통보 source request를 우회 반환할 수 있다.
create or replace function public.list_assignment_change_requests(
  p_actor_profile_id uuid,p_maid_profile_id uuid default null,
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
    and (actor.role='admin' or exists (
      select 1 from public.cleaning_assignments assignment
      where assignment.id=q.assignment_id and assignment.maid_profile_id=actor.id
        and assignment.notified_at is not null
    ))
    and (p_before_at is null or (q.requested_at,q.id)<(p_before_at,p_before_id))
    order by q.requested_at desc,q.id desc limit p_limit) page;
  return rows;
end;
$$;
revoke all on function public.list_assignment_change_requests(uuid,uuid,text,timestamptz,timestamptz,timestamptz,uuid,integer)
from public,anon,authenticated;
grant execute on function public.list_assignment_change_requests(uuid,uuid,text,timestamptz,timestamptz,timestamptz,uuid,integer)
to service_role;
