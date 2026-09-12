begin;
select no_plan();

create function pg_temp.did(n integer) returns uuid language sql immutable as $$
  select ('11100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.sha(value text) returns text language sql immutable as $$
  select encode(digest(value,'sha256'),'hex')
$$;
create function pg_temp.register(profile_n integer,user_n integer,session_n integer,subscription_n integer,seed text,expires timestamptz default null)
returns jsonb language sql as $$
  select public.register_web_push_subscription(
    pg_temp.did(profile_n),pg_temp.did(session_n),pg_temp.did(subscription_n),null,null,
    pg_temp.sha('endpoint-'||seed),pg_temp.sha('session-'||seed),pg_temp.sha('material-'||seed),
    expires,'v1',encode(convert_to('sealed-'||seed,'utf8'),'base64'),
    encode(repeat('n',12)::bytea,'base64'),encode(repeat('t',16)::bytea,'base64'),
    'delivery-register-'||seed,pg_temp.sha('request-'||seed),'vapid-v1'
  )
$$;
create function pg_temp.notice(profile_n integer,notice_n integer,outbox_n integer,at_time timestamptz default clock_timestamp())
returns void language plpgsql as $$
begin
  perform set_config('app.notification_writer_mode','typed_v1',true);
  insert into private.notification_groups(id,recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at,created_at)
  values(pg_temp.did(notice_n),pg_temp.did(profile_n),'cleaning_assignment_notified','room',pg_temp.did(notice_n),
    at_time,at_time+interval '10 minutes',at_time);
  insert into public.notifications(id,recipient_profile_id,category,title,body,dedupe_key,contract_version,
    actor_profile_id,event_family,source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,
    notification_group_id,requires_action,occurred_at,created_at)
  values(pg_temp.did(notice_n),pg_temp.did(profile_n),'cleaning_assignment_notified','청소 배정','새 청소 배정이 등록되었습니다.',
    'delivery-'||notice_n,1,pg_temp.did(1),'assignment.commit_notified','cleaning_assignment',pg_temp.did(notice_n)::text,
    'cleaningTarget',pg_temp.did(notice_n),pg_temp.did(notice_n),true,at_time,at_time);
  insert into private.notification_delivery_outbox(id,notification_id,event_family,enqueued_at)
  values(pg_temp.did(outbox_n),pg_temp.did(notice_n),'assignment.commit_notified',at_time);
  perform set_config('app.notification_writer_mode','',true);
end $$;

insert into auth.users(id) values(pg_temp.did(101)),(pg_temp.did(102)),(pg_temp.did(103)),(pg_temp.did(104)),
  (pg_temp.did(105)),(pg_temp.did(106)),(pg_temp.did(107));
insert into auth.sessions(id,user_id) values
  (pg_temp.did(901),pg_temp.did(101)),(pg_temp.did(902),pg_temp.did(102)),
  (pg_temp.did(903),pg_temp.did(103)),(pg_temp.did(904),pg_temp.did(104)),
  (pg_temp.did(905),pg_temp.did(105)),(pg_temp.did(906),pg_temp.did(105)),
  (pg_temp.did(907),pg_temp.did(105)),(pg_temp.did(908),pg_temp.did(105)),
  (pg_temp.did(909),pg_temp.did(105)),(pg_temp.did(911),pg_temp.did(107));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values(pg_temp.did(6),pg_temp.did(106),'delivery developer','delivery developer','admin','admin',0,'developer','active',false);
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values
  (pg_temp.did(1),pg_temp.did(101),'delivery admin','delivery admin','delivery-admin','delivery-admin',0,'admin','active',false),
  (pg_temp.did(2),pg_temp.did(102),'delivery maid','delivery maid','delivery-maid','delivery-maid',0,'maid','active',false),
  (pg_temp.did(3),pg_temp.did(103),'delivery none','delivery none','delivery-none','delivery-none',0,'maid','active',false),
  (pg_temp.did(4),pg_temp.did(104),'delivery expired','delivery expired','delivery-expired','delivery-expired',0,'maid','active',false),
  (pg_temp.did(5),pg_temp.did(105),'delivery batch','delivery batch','delivery-batch','delivery-batch',0,'maid','active',false),
  (pg_temp.did(7),pg_temp.did(107),'delivery dead','delivery dead','delivery-dead','delivery-dead',0,'maid','active',false);

select ok(has_function_privilege('service_role','public.claim_notification_deliveries(text,integer)','EXECUTE'),'service role may claim only through RPC');
select ok(not has_function_privilege('authenticated','public.claim_notification_deliveries(text,integer)','EXECUTE'),'authenticated cannot claim');
select ok(not has_function_privilege('anon','public.permit_notification_delivery(uuid,integer,text,uuid)','EXECUTE'),'anon cannot authorize send');
select ok(not has_table_privilege('service_role','private.notification_delivery_targets','SELECT'),'service role raw target SELECT denied');
select ok(not has_table_privilege('service_role','private.notification_delivery_targets','UPDATE'),'service role raw target UPDATE denied');
select ok(not has_table_privilege('service_role','private.notification_delivery_attempts','DELETE'),'service role raw history DELETE denied');
select ok((select relrowsecurity from pg_class where oid='private.notification_delivery_targets'::regclass),'target RLS enabled');

select pg_temp.register(2,102,902,1001,'maid');
select pg_temp.notice(2,2001,3001);
select is((select count(*) from private.notification_delivery_jobs where outbox_id=pg_temp.did(3001)),1::bigint,'typed outbox atomically enqueues one delivery job');
select is((select count(*) from private.notification_outbox),0::bigint,'legacy outbox is never used by delivery worker');

create temporary table delivery_claim(value jsonb);
insert into delivery_claim values(public.claim_notification_deliveries(repeat('a',64),10));
select is(jsonb_array_length((select value->'items' from delivery_claim)),1,'first fanout claims one current subscription target');
select is((select count(*) from private.notification_delivery_targets where outbox_id=pg_temp.did(3001)),1::bigint,'first fanout materializes one target exactly once');
select ok((select t.subscription_revision_id=s.current_revision_id and t.subscription_version=s.version
  from private.notification_delivery_targets t join private.web_push_subscriptions s on s.id=t.subscription_id
  where t.outbox_id=pg_temp.did(3001)),'target binds exact current subscription version and revision');

create temporary table delivery_ids as
select (value->'items'->0->>'targetId')::uuid target_id,(value->'items'->0->>'leaseVersion')::integer lease_version
from delivery_claim;
create temporary table envelope(value jsonb);
insert into envelope select public.get_notification_delivery_envelope(target_id,lease_version,repeat('a',64)) from delivery_ids;
select ok((select (value->>'sendAllowed')::boolean from envelope),'fenced context returns current encrypted envelope');
select ok(not ((select value from envelope) ?| array['endpoint','p256dh','auth','sessionId']),'context exposes no decrypted endpoint/key/session');
select lives_ok($$select public.permit_notification_delivery((select target_id from delivery_ids),1,repeat('a',64),pg_temp.did(902))$$,
  'live exact session obtains send permit');
select is((select count(*) from private.notification_delivery_permits),1::bigint,'permit linearization is append-only evidence');
select is((public.permit_notification_delivery((select target_id from delivery_ids),1,repeat('a',64),pg_temp.did(902))->>'permittedAt'),
  (select to_jsonb(permitted_at)#>>'{}' from private.notification_delivery_permits),
  'permit replay returns the immutable first linearization timestamp');
select lives_ok($$select public.settle_notification_delivery((select target_id from delivery_ids),1,repeat('a',64),'accepted',null,null)$$,
  'accepted provider-neutral result settles');
select lives_ok($$select public.settle_notification_delivery((select target_id from delivery_ids),1,repeat('a',64),'accepted',null,null)$$,
  'same settle replay is idempotent');
select is((select status from private.notification_delivery_targets where id=(select target_id from delivery_ids)),'delivered','target is terminal delivered');
select is((select status from private.notification_delivery_jobs where outbox_id=pg_temp.did(3001)),'completed','job completes after every target is terminal');
select is((select count(*) from private.notification_delivery_attempts),1::bigint,'claim replay and settle replay do not duplicate attempt');
select is((select count(*) from private.notification_delivery_attempt_results),1::bigint,'settle replay does not duplicate result');

-- p_limit bounds returned/terminal target workload, not the number of jobs
-- whose exact-current fanout is materialized. Fifteen targets drain as 10+5.
select pg_temp.register(5,105,905,1101,'batch-1');
select pg_temp.register(5,105,906,1102,'batch-2');
select pg_temp.register(5,105,907,1103,'batch-3');
select pg_temp.register(5,105,908,1104,'batch-4');
select pg_temp.register(5,105,909,1105,'batch-5');
select pg_temp.notice(5,2101,3101);
select pg_temp.notice(5,2102,3102);
select pg_temp.notice(5,2103,3103);
create temporary table bounded_claim_one(value jsonb);
insert into bounded_claim_one values(public.claim_notification_deliveries(repeat('1',64),10));
select is(jsonb_array_length((select value->'items' from bounded_claim_one)),10,'first claim returns at most ten fanout targets');
select is((select count(*) from private.notification_delivery_targets where outbox_id in (pg_temp.did(3101),pg_temp.did(3102),pg_temp.did(3103))),15::bigint,
  'three five-device jobs snapshot all exact-current targets once');
select is((select count(*) from private.notification_delivery_attempts a join private.notification_delivery_targets t on t.id=a.target_id
  where t.outbox_id in (pg_temp.did(3101),pg_temp.did(3102),pg_temp.did(3103))),10::bigint,'only returned targets consume first-run claim attempts');
create temporary table bounded_claim_two(value jsonb);
insert into bounded_claim_two values(public.claim_notification_deliveries(repeat('2',64),10));
select is(jsonb_array_length((select value->'items' from bounded_claim_two)),5,'remaining fanout targets are claimed on the following run');
select is((select count(*) from private.notification_delivery_attempts a join private.notification_delivery_targets t on t.id=a.target_id
  where t.outbox_id in (pg_temp.did(3101),pg_temp.did(3102),pg_temp.did(3103))),15::bigint,'bounded follow-up creates no duplicate attempt');

-- One configuration failure blocks the whole parent job. Expired sibling
-- leases remain unclaimable until the service-only resume moves every
-- non-terminal sibling together.
select pg_temp.notice(5,2104,3104);
create temporary table blocked_claim(value jsonb);
insert into blocked_claim values(public.claim_notification_deliveries(repeat('3',64),10));
select is(jsonb_array_length((select value->'items' from blocked_claim)),5,'multi-device job initially claims five targets');
create temporary table blocked_id as
select (value->'items'->0->>'targetId')::uuid id from blocked_claim;
select public.get_notification_delivery_envelope((select id from blocked_id),1,repeat('3',64));
select public.permit_notification_delivery((select id from blocked_id),1,repeat('3',64),pg_temp.did(905));
select public.settle_notification_delivery((select id from blocked_id),1,repeat('3',64),'provider_configuration_error','PROVIDER_CONFIGURATION_ERROR',null);
select is((select status from private.notification_delivery_jobs where outbox_id=pg_temp.did(3104)),'operator_blocked','first configuration failure blocks the parent job');
select set_config('app.notification_delivery_writer_mode','typed_v1',true);
update private.notification_delivery_targets set lease_expires_at=clock_timestamp()-interval '1 second'
where outbox_id=pg_temp.did(3104) and status='claimed';
select set_config('app.notification_delivery_writer_mode','',true);
create temporary table blocked_before_resume(value jsonb);
insert into blocked_before_resume values(public.claim_notification_deliveries(repeat('4',64),10));
select is((select count(*) from jsonb_array_elements((select value->'items' from blocked_before_resume)) item
  where item->>'notificationId'=pg_temp.did(2104)::text),0::bigint,'blocked parent excludes every expired sibling from reclaim');
select is((select count(*) from private.notification_delivery_attempts a join private.notification_delivery_targets t on t.id=a.target_id
  where t.outbox_id=pg_temp.did(3104)),5::bigint,'blocked sibling claim creates no new provider attempt');
select is(public.resume_blocked_notification_deliveries(10),5,'resume moves every non-terminal sibling in one bounded job operation');
select is((select status from private.notification_delivery_jobs where outbox_id=pg_temp.did(3104)),'materialized','resume reopens the parent job only after all siblings move');
select is((select count(*) from private.notification_delivery_targets where outbox_id=pg_temp.did(3104) and status='retry'),5::bigint,'resume clears all sibling leases into retry');
create temporary table blocked_after_resume(value jsonb);
insert into blocked_after_resume values(public.claim_notification_deliveries(repeat('5',64),10));
select is((select count(*) from jsonb_array_elements((select value->'items' from blocked_after_resume)) item
  where item->>'notificationId'=pg_temp.did(2104)::text),5::bigint,'only explicit resume makes all siblings claimable again');

select pg_temp.notice(2,2006,3006);
create temporary table retry_claim(value jsonb);
insert into retry_claim values(public.claim_notification_deliveries(repeat('6',64),10));
create temporary table retry_id as select (value->'items'->0->>'targetId')::uuid id from retry_claim;
select public.get_notification_delivery_envelope((select id from retry_id),1,repeat('6',64));
select public.permit_notification_delivery((select id from retry_id),1,repeat('6',64),pg_temp.did(902));
select lives_ok($$select public.settle_notification_delivery((select id from retry_id),1,repeat('6',64),'retryable','NETWORK_ERROR',null)$$,
  'retryable result is recorded without worker sleep');
select lives_ok($$select public.settle_notification_delivery((select id from retry_id),1,repeat('6',64),'retryable','NETWORK_ERROR',null)$$,
  'same retryable settlement input replays idempotently');
select throws_ok($$select public.settle_notification_delivery((select id from retry_id),1,repeat('6',64),'retryable','NETWORK_ERROR',60)$$,
  '23505','NOTIFICATION_DELIVERY_SETTLE_CONFLICT','different retry-after cannot reuse an attempt settlement');
select ok((select next_attempt_at between updated_at+interval '30 seconds' and updated_at+interval '45 seconds'
  from private.notification_delivery_targets where id=(select id from retry_id)),'first retry uses 30 seconds plus deterministic 0..15 second jitter');
select set_config('app.notification_delivery_writer_mode','typed_v1',true);
update private.notification_delivery_targets set next_attempt_at=clock_timestamp()-interval '1 second' where id=(select id from retry_id);
select set_config('app.notification_delivery_writer_mode','',true);
select public.claim_notification_deliveries(repeat('7',64),10);
select public.get_notification_delivery_envelope((select id from retry_id),2,repeat('7',64));
select public.permit_notification_delivery((select id from retry_id),2,repeat('7',64),pg_temp.did(902));
select lives_ok($$select public.settle_notification_delivery((select id from retry_id),2,repeat('7',64),'provider_configuration_error','PROVIDER_CONFIGURATION_ERROR',null)$$,
  'provider configuration failure is operator-blocked rather than endpoint retirement');
select lives_ok($$select public.settle_notification_delivery((select id from retry_id),2,repeat('7',64),'provider_configuration_error','PROVIDER_CONFIGURATION_ERROR',null)$$,
  'same provider-configuration settlement replays while operator-blocked');
select is((select status from private.notification_delivery_targets where id=(select id from retry_id)),'operator_blocked','configuration failure blocks target');
select is((select status from private.web_push_subscriptions where id=pg_temp.did(1001)),'active','401/403-class configuration failure never retires endpoint');
select is(public.resume_blocked_notification_deliveries(10),1,'service-only bounded resume releases one blocked target');
select is((select status from private.notification_delivery_targets where id=(select id from retry_id)),'retry','resume preserves bounded attempt count and returns target to retry');

select pg_temp.notice(2,2007,3007);
select public.claim_notification_deliveries(repeat('8',64),10);
select lives_ok($$select public.register_web_push_subscription(pg_temp.did(2),pg_temp.did(902),pg_temp.did(1001),pg_temp.did(1001),1,
  pg_temp.sha('endpoint-maid-rotated'),pg_temp.sha('session-maid'),pg_temp.sha('material-maid-rotated'),null,'v1',
  encode(convert_to('sealed-maid-rotated','utf8'),'base64'),encode(repeat('o',12)::bytea,'base64'),encode(repeat('u',16)::bytea,'base64'),
  'delivery-rotate-maid',pg_temp.sha('request-maid-rotated'),'vapid-v1')$$,'subscription rotates after target snapshot');
select is((public.get_notification_delivery_envelope((select id from private.notification_delivery_targets where outbox_id=pg_temp.did(3007)),1,repeat('8',64))->>'reasonCode'),
  'REVISION_SUPERSEDED','permit-before rotation barrier refuses superseded target without retargeting');
select is((select count(*) from private.notification_delivery_targets where outbox_id=pg_temp.did(3007)),1::bigint,'rotation never expands or replaces first fanout target');

select pg_temp.notice(2,2008,3008);
select public.claim_notification_deliveries(repeat('9',64),10);
select public.get_notification_delivery_envelope((select id from private.notification_delivery_targets where outbox_id=pg_temp.did(3008)),1,repeat('9',64));
select lives_ok($$select public.retire_web_push_subscription(pg_temp.did(2),pg_temp.did(902),pg_temp.did(1001),2,
  'delivery-retire-maid',pg_temp.sha('delivery-retire-maid'))$$,'subscription retires after envelope but before permit');
select is((public.permit_notification_delivery((select id from private.notification_delivery_targets where outbox_id=pg_temp.did(3008)),1,repeat('9',64),pg_temp.did(902))->>'reasonCode'),
  'SUBSCRIPTION_RETIRED','permit is the exact-current linearization barrier before external send');

select pg_temp.notice(3,2002,3002);
select public.claim_notification_deliveries(repeat('b',64),10);
select is((select status from private.notification_delivery_jobs where outbox_id=pg_temp.did(3002)),'suppressed','no active subscription is terminal immediately');
select is((select terminal_reason from private.notification_delivery_jobs where outbox_id=pg_temp.did(3002)),'NO_ACTIVE_SUBSCRIPTION','no-subscription reason is stable');
select pg_temp.register(3,103,903,1002,'late');
select public.claim_notification_deliveries(repeat('c',64),10);
select is((select count(*) from private.notification_delivery_targets where outbox_id=pg_temp.did(3002)),0::bigint,'later registration never replays historical no-subscription push');

select pg_temp.notice(3,2003,3003,clock_timestamp()-interval '24 hours 1 second');
select public.claim_notification_deliveries(repeat('d',64),10);
select is((select terminal_reason from private.notification_delivery_jobs where outbox_id=pg_temp.did(3003)),'STALE_NOTIFICATION','24-hour TTL terminalizes stale push but keeps inbox');
select is((select count(*) from public.notifications where id=pg_temp.did(2003)),1::bigint,'stale push leaves inbox notification intact');

select pg_temp.register(4,104,904,1003,'expired',clock_timestamp()+interval '1 day');
select pg_temp.notice(4,2004,3004);
select set_config('app.web_push_writer_mode','typed_v1',true);
update private.web_push_subscriptions set expiration_at=clock_timestamp()-interval '1 second' where id=pg_temp.did(1003);
select set_config('app.web_push_writer_mode','',true);
create temporary table expired_claim(value jsonb);
insert into expired_claim values(public.claim_notification_deliveries(repeat('e',64),10));
create temporary table expired_id as select (value->'items'->0->>'targetId')::uuid id from expired_claim;
select is((public.get_notification_delivery_envelope((select id from expired_id),1,repeat('e',64))->>'reasonCode'),'SUBSCRIPTION_EXPIRED','expired exact-current target is not sent');
select is((select status from private.web_push_subscriptions where id=pg_temp.did(1003)),'retired','expired current subscription is retired');
select is((select count(*) from private.web_push_subscription_secrets s join private.web_push_subscription_revisions r on r.id=s.revision_id where r.subscription_id=pg_temp.did(1003)),0::bigint,'expired retirement crypto-shreds current secret');
select is((select reason_code from private.web_push_subscription_events where subscription_id=pg_temp.did(1003) order by occurred_at desc limit 1),'expired','expired immutable lifecycle reason is recorded');

select pg_temp.notice(3,2005,3005);
create temporary table revoked_claim(value jsonb);
insert into revoked_claim values(public.claim_notification_deliveries(repeat('f',64),10));
create temporary table revoked_id as select (value->'items'->0->>'targetId')::uuid id from revoked_claim;
select lives_ok($$select public.get_notification_delivery_envelope((select id from revoked_id),1,repeat('f',64))$$,'session-revocation fixture obtains envelope before revoke');
delete from auth.sessions where id=pg_temp.did(903);
select is((public.permit_notification_delivery((select id from revoked_id),1,repeat('f',64),pg_temp.did(903))->>'reasonCode'),'SESSION_REVOKED','missing live session fails at exact permit');
select is((select status from private.web_push_subscriptions where id=pg_temp.did(1002)),'retired','session-revoked exact-current subscription retires');
select is((select count(*) from private.web_push_subscription_secrets s join private.web_push_subscription_revisions r on r.id=s.revision_id where r.subscription_id=pg_temp.did(1002)),0::bigint,'session-revoked retirement crypto-shreds secret');

-- Developer health distinguishes target dead letters from jobs that failed
-- contract validation before any target existed.
select pg_temp.register(7,107,911,1201,'dead-target');
select pg_temp.notice(7,2201,3201);
select public.claim_notification_deliveries(repeat('0',64),10);
create temporary table dead_target as select id,lease_version,claim_digest
from private.notification_delivery_targets where outbox_id=pg_temp.did(3201);
select public.get_notification_delivery_envelope((select id from dead_target),(select lease_version from dead_target),(select claim_digest from dead_target));
select public.permit_notification_delivery((select id from dead_target),(select lease_version from dead_target),(select claim_digest from dead_target),pg_temp.did(911));
select public.settle_notification_delivery((select id from dead_target),(select lease_version from dead_target),(select claim_digest from dead_target),'payload_rejected','PAYLOAD_REJECTED',null);
select is((select status from private.notification_delivery_jobs where outbox_id=pg_temp.did(3201)),'dead_letter','target terminal dead letter also terminalizes its job');

-- Simulate an immutable revision created before migration 45. No current-key
-- guess is allowed: it terminalizes without a provider permit or HTTP attempt.
alter table private.web_push_subscription_revisions disable trigger user;
update private.web_push_subscription_revisions set vapid_key_version=null
where id=(select current_revision_id from private.web_push_subscriptions where id=pg_temp.did(1201));
alter table private.web_push_subscription_revisions enable trigger user;
select pg_temp.notice(7,2203,3203);
select public.claim_notification_deliveries(pg_temp.sha('legacy-unbound-claim'),10);
create temporary table unbound_target as select id,lease_version,claim_digest
from private.notification_delivery_targets where outbox_id=pg_temp.did(3203);
select is((public.get_notification_delivery_envelope((select id from unbound_target),(select lease_version from unbound_target),pg_temp.sha('legacy-unbound-claim'))->>'reasonCode'),'VAPID_KEY_UNBOUND','legacy unbound revision is never guessed from current VAPID config');
select is((select status from private.notification_delivery_targets where outbox_id=pg_temp.did(3203)),'dead_letter','legacy unbound target is terminal rather than retried forever');
select is((select count(*) from private.notification_delivery_permits p join private.notification_delivery_attempts a on a.id=p.attempt_id join private.notification_delivery_targets t on t.id=a.target_id where t.outbox_id=pg_temp.did(3203)),0::bigint,'legacy unbound target obtains no send permit');

select set_config('app.notification_writer_mode','typed_v1',true);
insert into private.notification_groups(id,recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at)
values(pg_temp.did(2202),pg_temp.did(7),'cleaning_assignment_notified','room',pg_temp.did(2202),clock_timestamp(),clock_timestamp()+interval '10 minutes');
insert into public.notifications(id,recipient_profile_id,category,title,body,dedupe_key,contract_version,
  actor_profile_id,event_family,source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,
  notification_group_id,requires_action,occurred_at)
values(pg_temp.did(2202),pg_temp.did(7),'cleaning_assignment_notified','청소 배정','새 청소 배정이 등록되었습니다.',
  'delivery-invalid-2202',1,pg_temp.did(1),'assignment.commit_notified','cleaning_assignment',pg_temp.did(2202)::text,
  'cleaningTarget',pg_temp.did(2202),pg_temp.did(2202),true,clock_timestamp());
insert into private.notification_delivery_outbox(id,notification_id,event_family)
values(pg_temp.did(3202),pg_temp.did(2202),'assignment.prestart_unassigned');
select set_config('app.notification_writer_mode','',true);
select public.claim_notification_deliveries(repeat('0',64),10);
select is((select status from private.notification_delivery_jobs where outbox_id=pg_temp.did(3202)),'dead_letter','invalid delivery contract dead-letters before fanout');
select is((select count(*) from private.notification_delivery_targets where outbox_id=pg_temp.did(3202)),0::bigint,'contract-invalid job has no target');
select public.record_notification_delivery_heartbeat('succeeded',0,0,0,0,0,0,0,null);
create temporary table delivery_health(value jsonb);
insert into delivery_health values(public.get_developer_notification_delivery_status(pg_temp.did(6)));
select is(((select value from delivery_health)#>>'{backlog,jobOnlyDeadLetter}')::integer,1,'job-only dead letter has a separate bounded health count');
select is(((select value from delivery_health)#>>'{backlog,deadLetter}')::integer,
  (select least(count(*),1000)::integer from private.notification_delivery_targets where status='dead_letter'),
  'target dead letters are counted once and never include job-only failures');
select is((select value->>'status' from delivery_health),'degraded','empty successful heartbeat cannot hide unresolved job-only dead letter');
select is((select value#>>'{activation,expectedCronName}' from delivery_health),'notification-delivery','developer health exposes only the expected scheduler name');
select is((select (value#>>'{activation,cronConfigured}')::boolean from delivery_health),false,'source-only migration does not create the production notification Cron');
select is((select (value#>>'{activation,cronActive}')::boolean from delivery_health),false,'missing notification Cron prevents false-green health');

select is(coalesce(current_setting('app.notification_delivery_writer_mode',true),''),'','delivery writer capability clears after success paths');
select is(coalesce(current_setting('app.web_push_writer_mode',true),''),'','web-push writer capability clears after automatic retirement');
set local role service_role;
select throws_ok($$update private.notification_delivery_targets set status='delivered'$$,'42501',null,'service role raw UPDATE remains denied even if GUC can be set');
select throws_ok($$select * from private.notification_delivery_attempts$$,'42501',null,'service role raw SELECT remains denied');
reset role;
select throws_ok($$select public.claim_notification_deliveries('bad',11)$$,'22023','NOTIFICATION_DELIVERY_CLAIM_INVALID','claim validates digest and batch bound');
select throws_ok($$select public.claim_notification_deliveries(repeat('a',64),null)$$,'22023','NOTIFICATION_DELIVERY_CLAIM_INVALID','null claim limit cannot become unbounded');
select throws_ok($$select public.resume_blocked_notification_deliveries(11)$$,'22023','NOTIFICATION_DELIVERY_RESUME_INVALID','resume is bounded');
select throws_ok($$select public.resume_blocked_notification_deliveries(null)$$,'22023','NOTIFICATION_DELIVERY_RESUME_INVALID','null resume limit cannot become unbounded');
select throws_ok($$select public.purge_notification_delivery_history(101)$$,'22023','NOTIFICATION_DELIVERY_PURGE_INVALID','retention purge is bounded');
select throws_ok($$select public.purge_notification_delivery_history(null)$$,'22023','NOTIFICATION_DELIVERY_PURGE_INVALID','null purge limit cannot become unbounded');

select * from finish();
rollback;
