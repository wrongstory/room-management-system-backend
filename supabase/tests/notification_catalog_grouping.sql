begin;

select plan(64);

select is((select count(*) from private.notification_event_catalog),48::bigint,
  'source-controlled catalog contains every approved event family');
select is((select count(distinct category) from private.notification_event_catalog),32::bigint,
  'event families map to exactly 32 public categories');
select ok(bool_and(deep_link_kind in ('cleaningTarget','assignmentRequest','submission','complaintCase','payrollCycle','payrollProfile')),
  'catalog deep links use only the six approved kinds') from private.notification_event_catalog;
select ok((select bool_and(push_eligible and not requires_action)
  from private.notification_event_catalog where event_family in (
    'reservation.extension_revoked','reservation.cancelled_revoked',
    'cleaning_request.cancelled_revoked','assignment.prestart_old_revoked',
    'assignment.prestart_unassigned','attempt.handover_previous_revoked',
    'assignment.cancellation_approved','assignment.cancellation_rejected',
    'assignment.scheduled_rolled_over','cleaning.field_completed_admin')),
  'approved informational events are push eligible without becoming actionable');

insert into auth.users(id) values
  ('10900000-0000-4000-8000-000000000001'),
  ('10900000-0000-4000-8000-000000000002'),
  ('10900000-0000-4000-8000-000000000003'),
  ('10900000-0000-4000-8000-000000000004');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values
  ('20900000-0000-4000-8000-000000000001','10900000-0000-4000-8000-000000000001','카탈로그 관리자','카탈로그 관리자','catalog-admin','catalog-admin',0,'admin','active',false),
  ('20900000-0000-4000-8000-000000000002','10900000-0000-4000-8000-000000000002','카탈로그 메이드','카탈로그 메이드','catalog-maid','catalog-maid',0,'maid','active',false),
  ('20900000-0000-4000-8000-000000000003','10900000-0000-4000-8000-000000000003','비활성 메이드','비활성 메이드','catalog-inactive','catalog-inactive',0,'maid','active',false),
  ('20900000-0000-4000-8000-000000000004','10900000-0000-4000-8000-000000000004','임시 메이드','임시 메이드','catalog-temp','catalog-temp',0,'maid','active',false);

insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,status,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
values('30900000-0000-4000-8000-000000000001',(select id from public.rooms order by room_number limit 1),
  'additional','manual_room_request','notification-catalog-fixture','2028-01-01','2028-01-01',
  '2028-01-01 00:00:00+00','2028-01-01 12:00:00+00','notified','{}',10000,'{"durationMinutes":60}',
  '20900000-0000-4000-8000-000000000001');
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,notified_at,ended_at,change_reason_code,changed_by)
values
  ('40900000-0000-4000-8000-000000000001','30900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000002',1,1,false,'2028-01-01 00:00:00+00','2028-01-01 04:00:00+00','DRAFT_REVISED','20900000-0000-4000-8000-000000000001'),
  ('40900000-0000-4000-8000-000000000002','30900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000002',2,2,false,'2028-01-01 00:00:00+00','2028-01-01 04:00:00+00','DRAFT_REVISED','20900000-0000-4000-8000-000000000001'),
  ('40900000-0000-4000-8000-000000000003','30900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000002',3,3,false,'2028-01-01 00:00:00+00','2028-01-01 04:00:00+00','DRAFT_REVISED','20900000-0000-4000-8000-000000000001'),
  ('40900000-0000-4000-8000-000000000004','30900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000002',4,4,false,'2028-01-01 00:00:00+00','2028-01-01 04:00:00+00','DRAFT_REVISED','20900000-0000-4000-8000-000000000002'),
  ('40900000-0000-4000-8000-000000000005','30900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000003',5,5,false,'2028-01-01 00:00:00+00','2028-01-01 04:00:00+00','DRAFT_REVISED','20900000-0000-4000-8000-000000000001'),
  ('40900000-0000-4000-8000-000000000006','30900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000004',6,6,false,'2028-01-01 00:00:00+00','2028-01-01 04:00:00+00','DRAFT_REVISED','20900000-0000-4000-8000-000000000001'),
  ('40900000-0000-4000-8000-000000000007','30900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000002',7,7,false,'2028-01-01 00:00:00+00','2028-01-01 04:00:00+00','DRAFT_REVISED','20900000-0000-4000-8000-000000000001');

update public.profiles set status='inactive' where id='20900000-0000-4000-8000-000000000003';
update public.profiles set must_change_password=true where id='20900000-0000-4000-8000-000000000004';

select lives_ok($$select private.emit_notification_v1('assignment.commit_notified',
  '20900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000002','cleaning_assignment',
  '40900000-0000-4000-8000-000000000001','첫 알림','첫 본문',(select room_id from public.cleaning_targets where id='30900000-0000-4000-8000-000000000001'),
  '30900000-0000-4000-8000-000000000001','30900000-0000-4000-8000-000000000001','2028-01-01 00:00:00+00')$$,
  'valid exact source and recipient relation emits typed notification');
select lives_ok($$select private.emit_notification_v1('assignment.commit_notified',
  '20900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000002','cleaning_assignment',
  '40900000-0000-4000-8000-000000000001','첫 알림','첫 본문',(select room_id from public.cleaning_targets where id='30900000-0000-4000-8000-000000000001'),
  '30900000-0000-4000-8000-000000000001','30900000-0000-4000-8000-000000000001','2028-01-01 00:00:00+00')$$,
  'same logical event retry is idempotent');
select ok(
  (select count(*)=1 from public.notifications where source_entity_id='40900000-0000-4000-8000-000000000001')
  and (select count(*)=1 from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
       where n.source_entity_id='40900000-0000-4000-8000-000000000001'),
  'same event retry preserves exactly one inbox and one delivery row');
select lives_ok($$select private.emit_notification_v1('assignment.commit_notified',
  '20900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000002','cleaning_assignment',
  '40900000-0000-4000-8000-000000000002','둘째 알림','둘째 본문',(select room_id from public.cleaning_targets where id='30900000-0000-4000-8000-000000000001'),
  '30900000-0000-4000-8000-000000000001','30900000-0000-4000-8000-000000000001','2028-01-01 00:09:59+00')$$,
  'event inside fixed window emits');
select ok((select count(*)=2
    and count(distinct dedupe_key)=2
    and count(distinct notification_group_id)=1
  from public.notifications
  where source_entity_id in ('40900000-0000-4000-8000-000000000001','40900000-0000-4000-8000-000000000002')),
  'different logical events share one fixed group without deduplicating each other');
select lives_ok($$select private.emit_notification_v1('assignment.commit_notified',
  '20900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000002','cleaning_assignment',
  '40900000-0000-4000-8000-000000000003','경계 알림','경계 본문',(select room_id from public.cleaning_targets where id='30900000-0000-4000-8000-000000000001'),
  '30900000-0000-4000-8000-000000000001','30900000-0000-4000-8000-000000000001','2028-01-01 00:10:00+00')$$,
  'event on exclusive boundary emits into a new group');
select is((select count(distinct notification_group_id) from public.notifications where contract_version=1),2::bigint,
  'fixed ten-minute window groups first two and starts a new boundary group');
select is((select min(ends_at-started_at) from private.notification_groups),interval '10 minutes',
  'group duration is exactly ten minutes');

select lives_ok($$select private.emit_notification_v1('assignment.commit_notified',
  '20900000-0000-4000-8000-000000000002','20900000-0000-4000-8000-000000000002','cleaning_assignment',
  '40900000-0000-4000-8000-000000000004','자기 알림','자기 본문',(select room_id from public.cleaning_targets where id='30900000-0000-4000-8000-000000000001'),
  '30900000-0000-4000-8000-000000000001','30900000-0000-4000-8000-000000000001','2028-01-01 01:00:00+00')$$,
  'actor equal recipient keeps inbox history');
select ok((select count(*)=1 from public.notifications where source_entity_id='40900000-0000-4000-8000-000000000004')
  and (select count(*)=0 from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
    where n.source_entity_id='40900000-0000-4000-8000-000000000004'),
  'self action produces one inbox row and no push row');
select is((select count(*) from private.notification_delivery_outbox),3::bigint,
  'actor-self event is excluded from push outbox');

select lives_ok($$select private.emit_notification_v1('assignment.commit_notified',
  '20900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000003','cleaning_assignment',
  '40900000-0000-4000-8000-000000000005','비활성 알림','비활성 본문',(select room_id from public.cleaning_targets where id='30900000-0000-4000-8000-000000000001'),
  '30900000-0000-4000-8000-000000000001','30900000-0000-4000-8000-000000000001','2028-01-01 02:00:00+00')$$,
  'inactive recipient still receives inbox history');
select lives_ok($$select private.emit_notification_v1('assignment.commit_notified',
  '20900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000004','cleaning_assignment',
  '40900000-0000-4000-8000-000000000006','임시 알림','임시 본문',(select room_id from public.cleaning_targets where id='30900000-0000-4000-8000-000000000001'),
  '30900000-0000-4000-8000-000000000001','30900000-0000-4000-8000-000000000001','2028-01-01 02:01:00+00')$$,
  'temporary-password recipient still receives inbox history');
select is((select count(*) from private.notification_delivery_outbox),3::bigint,
  'inactive and temporary-password recipients are fail-closed for push only');
select isnt(
  (select notification_group_id from public.notifications where source_entity_id='40900000-0000-4000-8000-000000000005'),
  (select notification_group_id from public.notifications where source_entity_id='40900000-0000-4000-8000-000000000006'),
  'same-room notifications for different maids never share recipient group identity');
select throws_ok($$select private.emit_notification_v1('assignment.commit_notified',
  '20900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000001','cleaning_assignment',
  '40900000-0000-4000-8000-000000000007','잘못된 알림','잘못된 본문',(select room_id from public.cleaning_targets where id='30900000-0000-4000-8000-000000000001'),
  '30900000-0000-4000-8000-000000000001','30900000-0000-4000-8000-000000000001','2028-01-01 03:00:00+00')$$,
  '23514','NOTIFICATION_PROVENANCE_INVALID','source-recipient mismatch fails closed');

select is(coalesce(current_setting('app.notification_writer_mode',true),''),'',
  'fresh transaction has no typed writer capability');
select lives_ok($$insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,
  actor_display_name_snapshot,effective_at,recorded_at,after_state)
  values('assignment.notified','cleaning_assignment','40900000-0000-4000-8000-000000000007',
    '20900000-0000-4000-8000-000000000001','카탈로그 관리자','2028-01-01 02:30:00+00',
    '2028-01-01 02:30:00+00','{}')$$,
  'matching audit append without typed writer capability remains inert');
select ok(
  (select count(*)=0 from public.notifications where contract_version=1
    and source_entity_id='40900000-0000-4000-8000-000000000007')
  and (select count(*)=0 from private.notification_delivery_outbox o join public.notifications n
    on n.id=o.notification_id where n.source_entity_id='40900000-0000-4000-8000-000000000007'),
  'fresh-session audit trigger emits neither typed inbox nor delivery row');

insert into public.notifications(recipient_profile_id,category,title,body,dedupe_key,requires_action)
values('20900000-0000-4000-8000-000000000002','legacy_collision','legacy','legacy',
  'notification:v1:assignment.commit_notified:cleaning_assignment:40900000-0000-4000-8000-000000000007',false);
select throws_ok($$select private.emit_notification_v1('assignment.commit_notified',
  '20900000-0000-4000-8000-000000000001','20900000-0000-4000-8000-000000000002','cleaning_assignment',
  '40900000-0000-4000-8000-000000000007','충돌 알림','충돌 본문',(select room_id from public.cleaning_targets where id='30900000-0000-4000-8000-000000000001'),
  '30900000-0000-4000-8000-000000000001','30900000-0000-4000-8000-000000000001','2028-01-01 03:00:00+00')$$,
  '23505','NOTIFICATION_DEDUPE_CONFLICT','legacy dedupe collision is never accepted as typed success');

select ok(not has_table_privilege(role_name,'private.notification_delivery_outbox','SELECT'),role_name||' cannot read typed outbox')
from unnest(array['anon','authenticated','service_role']) role_name;
select ok(not has_table_privilege(role_name,'private.notification_outbox','SELECT'),role_name||' cannot read legacy outbox')
from unnest(array['anon','authenticated','service_role']) role_name;
select ok(not has_table_privilege('service_role','private.notification_outbox','INSERT'),
  'service role cannot append legacy outbox rows');
select ok(not has_table_privilege(role_name,'private.notification_event_catalog','UPDATE'),role_name||' cannot mutate catalog')
from unnest(array['anon','authenticated','service_role']) role_name;
select ok(not has_function_privilege('service_role',
  'private.emit_notification_v1(text,uuid,uuid,text,text,text,text,uuid,uuid,uuid,timestamptz)','EXECUTE'),
  'service role cannot invoke the private typed emitter after setting arbitrary GUCs');
select ok(not has_function_privilege('authenticated',
  'private.emit_notification_v1(text,uuid,uuid,text,text,text,text,uuid,uuid,uuid,timestamptz)','EXECUTE'),
  'authenticated cannot invoke the private typed emitter');
select ok(not has_function_privilege('service_role',
  'private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)','EXECUTE'),
  'service role cannot invoke the private provenance validator');
select ok(not has_function_privilege('authenticated',
  'private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)','EXECUTE'),
  'authenticated cannot invoke the private provenance validator');
select throws_ok($$update private.notification_event_catalog set category=category where event_family='assignment.commit_notified'$$,
  '55000','NOTIFICATION_CATALOG_LEDGER_IMMUTABLE','catalog rows are immutable');
select throws_ok($$delete from private.notification_groups$$,'55000','NOTIFICATION_CATALOG_LEDGER_IMMUTABLE',
  'notification groups are immutable');
select ok((select obj_description('private.notification_outbox'::regclass) like 'LEGACY_DO_NOT_DELIVER:%'),
  'legacy outbox is explicitly excluded from future workers');
select is((select count(*) from public.notifications where contract_version=1),6::bigint,
  'all valid events remain in inbox history');
select is((private.notification_public_projection((select n from public.notifications n where contract_version=1 order by occurred_at limit 1))->'deepLink'->>'kind'),
  'cleaningTarget','public projection exposes only the approved deep-link kind');
select ok((private.notification_public_projection((select n from public.notifications n where contract_version=1 order by occurred_at limit 1)) ? 'groupId')
  and not (private.notification_public_projection((select n from public.notifications n where contract_version=1 order by occurred_at limit 1))
    ?| array['eventFamily','sourceEntityId','actorProfileId','recipientProfileId','dedupeKey','groupKey']),
  'public projection exposes groupId without internal provenance or dedupe fields');

select set_config('app.notification_writer_mode','typed_v1',true);
select set_config('app.notification_source_event_type','sentinel.event',true);
select set_config('app.notification_source_reason_code','SENTINEL_REASON',true);
select throws_ok($$insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,
  actor_display_name_snapshot,effective_at,recorded_at,after_state)
  values('assignment.notified','cleaning_assignment','40900000-0000-4000-8000-000000000007',
    '20900000-0000-4000-8000-000000000001','카탈로그 관리자','2028-01-01 03:00:00+00',
    '2028-01-01 03:00:00+00','{}')$$,'23505','NOTIFICATION_DEDUPE_CONFLICT',
  'dispatch failure remains fail-closed on a colliding legacy row');
select ok(current_setting('app.notification_source_event_type',true)='sentinel.event'
  and current_setting('app.notification_source_reason_code',true)='SENTINEL_REASON',
  'dispatch exception restores the caller transaction provenance values');
select lives_ok($$insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,
  actor_display_name_snapshot,effective_at,recorded_at,after_state)
  values('assignment.notified','cleaning_assignment','40900000-0000-4000-8000-000000000002',
    '20900000-0000-4000-8000-000000000001','카탈로그 관리자','2028-01-01 00:09:59+00',
    '2028-01-01 00:09:59+00','{}')$$,
  'a later dispatch succeeds without inheriting the failed event provenance');
select ok(current_setting('app.notification_source_event_type',true)='sentinel.event'
  and current_setting('app.notification_source_reason_code',true)='SENTINEL_REASON',
  'successive dispatch restores provenance and cannot leak stale event or reason');
select set_config('app.notification_writer_mode','',true);
select set_config('app.notification_source_event_type','',true);
select set_config('app.notification_source_reason_code','',true);

select is(private.replay_command('20900000-0000-4000-8000-000000000001','assignment.commit_notify',
  'catalog-mode-new-0001',repeat('a',64)),null::jsonb,'new typed writer has no replay response');
select is(current_setting('app.notification_writer_mode',true),'typed_v1','approved writer enables typed cutover mode');
select lives_ok($$select private.complete_command('20900000-0000-4000-8000-000000000001','assignment.commit_notify',
  'catalog-mode-new-0001',repeat('a',64),'40900000-0000-4000-8000-000000000001','{"ok":true}')$$,
  'typed command completion records receipt');
select ok(array[
    coalesce(current_setting('app.notification_writer_mode',true),''),
    coalesce(current_setting('app.notification_terminal_kind',true),''),
    coalesce(current_setting('app.notification_terminal_id',true),''),
    coalesce(current_setting('app.notification_source_event_type',true),''),
    coalesce(current_setting('app.notification_source_reason_code',true),''),
    coalesce(current_setting('app.notification_legacy_suppressed_count',true),''),
    coalesce(current_setting('app.notification_typed_emit_count',true),'')
  ]=array['','','','','','',''],
  'successful command completion clears every notification writer GUC');
select is(private.replay_command('20900000-0000-4000-8000-000000000001','assignment.commit_notify',
  'catalog-mode-new-0001',repeat('a',64)),'{"ok": true}'::jsonb,'exact replay returns the stored response');
select ok(array[
    coalesce(current_setting('app.notification_writer_mode',true),''),
    coalesce(current_setting('app.notification_terminal_kind',true),''),
    coalesce(current_setting('app.notification_terminal_id',true),''),
    coalesce(current_setting('app.notification_source_event_type',true),''),
    coalesce(current_setting('app.notification_source_reason_code',true),''),
    coalesce(current_setting('app.notification_legacy_suppressed_count',true),''),
    coalesce(current_setting('app.notification_typed_emit_count',true),'')
  ]=array['','','','','','',''],
  'replay exit clears every notification writer GUC');
select throws_ok($$select private.replay_command(
  '20900000-0000-4000-8000-000000000001','assignment.commit_notify','short',repeat('a',64))$$,
  '22023','INVALID_IDEMPOTENCY_KEY','typed command setup rejects invalid input');
select ok(array[
    coalesce(current_setting('app.notification_writer_mode',true),''),
    coalesce(current_setting('app.notification_terminal_kind',true),''),
    coalesce(current_setting('app.notification_terminal_id',true),''),
    coalesce(current_setting('app.notification_source_event_type',true),''),
    coalesce(current_setting('app.notification_source_reason_code',true),''),
    coalesce(current_setting('app.notification_legacy_suppressed_count',true),''),
    coalesce(current_setting('app.notification_typed_emit_count',true),'')
  ]=array['','','','','','',''],
  'exception exit leaves every notification writer GUC clear');
select is(private.replay_command('20900000-0000-4000-8000-000000000001','room.change_master_data',
  'catalog-mode-other-0001',repeat('b',64)),null::jsonb,'unmapped command remains a normal new command');
select is(current_setting('app.notification_writer_mode',true),'','unmapped writer never suppresses legacy notification paths');
select lives_ok($$select private.complete_command('20900000-0000-4000-8000-000000000001','room.change_master_data',
  'catalog-mode-other-0001',repeat('b',64),'40900000-0000-4000-8000-000000000001','{}')$$,
  'unmapped command receipt completes with clean mode');
select lives_ok($$select private.replay_command('20900000-0000-4000-8000-000000000001','assignment.commit_notify',
  'catalog-mode-gap-0001',repeat('c',64))$$,'coverage guard fixture enables typed mode');
insert into public.notifications(recipient_profile_id,category,title,body,dedupe_key,requires_action)
values('20900000-0000-4000-8000-000000000002','legacy_gap','legacy gap','legacy gap',
  'legacy-gap-should-not-persist',false);
select throws_ok($$select private.complete_command('20900000-0000-4000-8000-000000000001','assignment.commit_notify',
  'catalog-mode-gap-0001',repeat('c',64),'40900000-0000-4000-8000-000000000001','{}')$$,
  '23514','NOTIFICATION_TYPED_WRITER_COVERAGE_GAP',
  'typed cutover cannot silently suppress a legacy notice without a typed replacement');
do $$begin
  perform set_config('app.notification_writer_mode','',true);
  perform set_config('app.notification_legacy_suppressed_count','0',true);
  perform set_config('app.notification_typed_emit_count','0',true);
end$$;
select ok((select count(*)=0 from public.notifications where dedupe_key='legacy-gap-should-not-persist')
  and (select count(*)=0 from private.command_executions where idempotency_key='catalog-mode-gap-0001'),
  'coverage failure records neither legacy notice nor command receipt');
select ok(not private.notification_resolution_is_valid('assignment.commit_notified','cleaning_assignment',
  '40900000-0000-4000-8000-000000000001','audit_event','50900000-0000-4000-8000-000000000001'),
  'resolver rejects a terminal event without exact source linkage');
select throws_ok($$select private.resolve_notifications_v1('assignment.commit_notified','cleaning_assignment',
  '40900000-0000-4000-8000-000000000001',clock_timestamp())$$,'23514','NOTIFICATION_RESOLVER_CONTRACT_VIOLATION',
  'typed resolver cannot run without catalog-approved terminal evidence');

rollback;
