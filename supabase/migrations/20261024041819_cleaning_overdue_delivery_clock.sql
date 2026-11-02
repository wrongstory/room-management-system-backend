-- #345: keep event/inbox occurrence history; a newly eligible recipient gets
-- its own delivery opportunity. No historical rows or expired jobs are rewritten.
create function private.guard_cleaning_overdue_enrollment_clock() returns trigger
language plpgsql security definer set search_path='' as $$
declare event private.cleaning_overdue_events; target public.cleaning_targets;
begin
 select * into event from private.cleaning_overdue_events where id=new.event_id;
 select * into target from public.cleaning_targets where id=event.cleaning_target_id;
 if event.id is null or target.id is null or new.enrolled_at<event.occurred_at
   or not private.cleaning_target_is_overdue(target,new.enrolled_at) then
  raise exception using errcode='23514',message='CLEANING_OVERDUE_RECIPIENT_INVALID';
 end if;
 return new;
end $$;
create trigger cleaning_overdue_enrollment_clock before insert on private.cleaning_overdue_recipients
 for each row execute function private.guard_cleaning_overdue_enrollment_clock();

create function private.set_cleaning_overdue_delivery_clock() returns trigger
language plpgsql security definer set search_path='' as $$
declare notice public.notifications; event private.cleaning_overdue_events;
 enrollment private.cleaning_overdue_recipients;
begin
 if new.event_family is distinct from 'cleaning.overdue_admin' then return new; end if;
 select * into notice from public.notifications where id=new.notification_id;
 begin
  select * into event from private.cleaning_overdue_events where id=notice.source_entity_id::uuid;
 exception when invalid_text_representation then
  raise exception using errcode='23514',message='CLEANING_OVERDUE_DELIVERY_NOT_ATOMIC';
 end;
 select * into enrollment from private.cleaning_overdue_recipients
   where event_id=event.id and recipient_profile_id=notice.recipient_profile_id;
 if notice.contract_version is distinct from 1 or notice.event_family is distinct from new.event_family
   or notice.source_entity_kind is distinct from 'cleaning_overdue_event'
   or event.id is null or enrollment.event_id is null or not enrollment.push_expected
   or notice.actor_profile_id is distinct from enrollment.actor_profile_id
   or new.enqueued_at is distinct from event.occurred_at then
  raise exception using errcode='23514',message='CLEANING_OVERDUE_DELIVERY_NOT_ATOMIC';
 end if;
 new.enqueued_at:=enrollment.enrolled_at;
 return new;
end $$;
create trigger cleaning_overdue_delivery_clock before insert on private.notification_delivery_outbox
 for each row execute function private.set_cleaning_overdue_delivery_clock();

-- Preserve all existing bidirectional atomicity checks and their grants. Fail
-- closed if the source changed instead of replacing an unknown implementation.
do $upgrade$
declare definition text;
 needle text:='o.enqueued_at<>event.occurred_at';
begin
 definition:=replace(pg_get_functiondef('private.check_cleaning_overdue_delivery()'::regprocedure),E'\r\n',E'\n');
 if strpos(definition,needle)=0
   or strpos(substr(definition,strpos(definition,needle)+length(needle)),needle)>0 then
  raise exception 'CLEANING_OVERDUE_DELIVERY_CLOCK_SOURCE_DRIFT';
 end if;
 execute replace(definition,needle,'o.enqueued_at<>enrollment.enrolled_at');
end $upgrade$;
revoke all on function private.guard_cleaning_overdue_enrollment_clock(),
 private.set_cleaning_overdue_delivery_clock() from public,anon,authenticated,service_role;
