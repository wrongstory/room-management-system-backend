begin;
select plan(22);
insert into auth.users(id) select ('13600000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,5) n;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select ('23600000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('13600000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '가능일 알림 데모 '||n,'가능일 알림 데모 '||n,'availability-notice-'||n,'availability-notice-'||n,0,
 (case when n<=2 then 'admin' when n<=4 then 'maid' else 'developer' end)::public.app_role,
 'active',false from generate_series(1,5) n;
-- The business inbox is retained for inactive admins, but no push target is enqueued for them.
update public.profiles set status='inactive' where id='23600000-0000-4000-8000-000000000002';

create temporary table request_one as select r.* from private.request_availability_change_at(
 '23600000-0000-4000-8000-000000000003','2026-11-02',array['2026-11-04'::date,'2026-11-06'::date],
 'WORK_SCHEDULE',0,'availability-notice-request-1','2026-11-04 10:00+09') r;
select is((select count(*) from public.notifications where source_entity_id=(select id::text from request_one)),
 (select count(*) from public.profiles where role='admin'),'request reaches every administrator inbox only');
select ok((select bool_and(event_family='availability.change_requested' and requires_action and resolved_at is null
 and deep_link_kind='availabilityRequest' and deep_link_entity_id=(select id from request_one)
 and room_id is null and cleaning_target_id is null) from public.notifications where source_entity_id=(select id::text from request_one)),
 'pending notice is actionable and links to the exact request without room placeholders');
select is((select count(*) from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
 where n.source_entity_id=(select id::text from request_one)),
 (select count(*) from public.profiles where role='admin' and status='active' and not must_change_password),'push is queued only for eligible administrators');
select is((select count(*) from public.notifications where source_entity_id=(select id::text from request_one)
 and recipient_profile_id in ('23600000-0000-4000-8000-000000000003','23600000-0000-4000-8000-000000000004','23600000-0000-4000-8000-000000000005')),0::bigint,'no request echo to maid, peer or developer');
select is((select count(*) from public.availability_versions where maid_profile_id='23600000-0000-4000-8000-000000000003'),0::bigint,'notification does not approve the initial request');
select is((private.request_availability_change_at('23600000-0000-4000-8000-000000000003','2026-11-02',array['2026-11-04'::date,'2026-11-06'::date],
 'WORK_SCHEDULE',0,'availability-notice-request-1','2026-11-04 10:01+09')).id,(select id from request_one),'request retry returns the same request');
select is((select count(*) from public.notifications where source_entity_id=(select id::text from request_one)),
 (select count(*) from public.profiles where role='admin'),'request retry creates no duplicate inbox rows');
select ok(not private.notification_source_is_valid('availability.change_requested','23600000-0000-4000-8000-000000000003',
 '23600000-0000-4000-8000-000000000001',(select id::text from request_one),null,null,(select id from request_one)),
 'source validation rejects an absent audit context');
select set_config('app.notification_terminal_kind','audit_event',true);
select set_config('app.notification_terminal_id',(select id::text from public.audit_events where entity_id=(select id from request_one) and event_type='availability.change_requested'),true);
select ok(not private.notification_source_is_valid('availability.change_requested','23600000-0000-4000-8000-000000000003',
 '23600000-0000-4000-8000-000000000004',(select id::text from request_one),null,null,(select id from request_one)),
 'typed writer rejects a non-administrator request recipient');
select ok(not private.notification_resolution_is_valid('availability.change_requested','availability_change_request',
 (select id::text from request_one),'audit_event',current_setting('app.notification_terminal_id')),'request evidence cannot resolve its own action');
select set_config('app.notification_terminal_kind','',true);
select set_config('app.notification_terminal_id','',true);

select lives_ok($$select private.decide_availability_change_at('23600000-0000-4000-8000-000000000001',(select id from request_one),
 'approved','ADMIN_APPROVED',0,'availability-notice-approve-1','2026-11-04 10:02+09')$$,'approval commits notification and approved availability together');
select is((select count(*) from public.notifications where source_entity_id=(select id::text from request_one) and event_family='availability.change_approved'
 and recipient_profile_id='23600000-0000-4000-8000-000000000003' and not requires_action),1::bigint,'approval reaches only the requesting maid as information');
select ok((select bool_and(resolved_at is not null) from public.notifications where source_entity_id=(select id::text from request_one)
 and event_family='availability.change_requested'),'approval resolves administrator actions');
select lives_ok($$select private.decide_availability_change_at('23600000-0000-4000-8000-000000000001',(select id from request_one),
 'approved','ADMIN_APPROVED',0,'availability-notice-approve-1','2026-11-04 10:03+09')$$,'decision retry is idempotent');
select is((select count(*) from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
 where n.source_entity_id=(select id::text from request_one) and n.event_family='availability.change_approved'),1::bigint,'approval retry queues exactly one maid push');

create temporary table request_two as select r.* from private.request_availability_change_at(
 '23600000-0000-4000-8000-000000000003','2026-11-02',array['2026-11-04'::date],
 'WORK_SCHEDULE',1,'availability-notice-request-2','2026-11-04 11:00+09') r;
select lives_ok($$select private.decide_availability_change_at('23600000-0000-4000-8000-000000000001',(select id from request_two),
 'rejected','ADMIN_REJECTED',1,'availability-notice-reject-2','2026-11-04 11:01+09')$$,'rejection commits its notice');
select is((select count(*) from public.notifications where source_entity_id=(select id::text from request_two) and event_family='availability.change_rejected'
 and recipient_profile_id='23600000-0000-4000-8000-000000000003' and not requires_action),1::bigint,'rejection informs the owner only');
select is((select count(*) from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
 where n.source_entity_id=(select id::text from request_two) and n.event_family='availability.change_rejected'),1::bigint,'informational rejection also queues push');
select ok((select bool_and(resolved_at is not null) from public.notifications where source_entity_id=(select id::text from request_two)
 and event_family='availability.change_requested'),'rejection resolves administrator actions');
select is((select max(version) from public.availability_versions where maid_profile_id='23600000-0000-4000-8000-000000000003'),1,'rejection preserves the approved version');
select throws_ok($$select private.request_availability_change_at('23600000-0000-4000-8000-000000000003','2026-11-02',array['2026-11-05'::date],
 'WORK_SCHEDULE',0,'availability-notice-stale','2026-11-04 11:02+09')$$,'40001','STALE_VERSION','stale request fails before any notification');
select is((select count(*) from public.notifications where recipient_profile_id='23600000-0000-4000-8000-000000000003'
 and event_family like 'availability.%'),2::bigint,'failed command emits nothing and unrelated maid receives nothing');
select * from finish();
rollback;
