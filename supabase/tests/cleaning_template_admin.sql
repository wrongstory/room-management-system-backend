begin;
select no_plan();

create function pg_temp.tid(n integer) returns uuid language sql immutable as $$
  select ('e1560000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.room_for(p_code text, p_offset integer default 0)
returns uuid language sql stable as $$
  select room.id from public.rooms room
  join public.room_types room_type on room_type.id = room.room_type_id
  where room_type.code = p_code order by room.room_number offset p_offset limit 1
$$;
create function pg_temp.checkout_slots(p_count integer) returns jsonb
language sql immutable as $$
  select jsonb_agg(jsonb_build_object(
    'slotKey', case when display_order = 0 then 'tv-on'
      when display_order = 1 then 'entry-storage'
      when display_order = p_count - 1 then 'extra-proof'
      else 'slot-' || display_order end,
    'displayOrder', display_order,
    'required', display_order < p_count - 1,
    'label', '사진 ' || (display_order + 1),
    'maxPhotos', case when display_order = p_count - 1 then 10 else 1 end
  ) order by display_order)
  from generate_series(0, p_count - 1) display_order
$$;

insert into auth.users(id) select pg_temp.tid(n) from generate_series(101, 106) n;
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized, login_id,
  login_id_normalized, login_sequence, role, status, must_change_password
) values
  (pg_temp.tid(6),pg_temp.tid(106),'템플릿 개발자','템플릿 개발자','admin','admin',0,'developer','active',false),
  (pg_temp.tid(1),pg_temp.tid(101),'템플릿 관리자','템플릿 관리자','template-admin','template-admin',0,'admin','active',false),
  (pg_temp.tid(2),pg_temp.tid(102),'보조 관리자','보조 관리자','template-admin-2','template-admin-2',0,'admin','active',false),
  (pg_temp.tid(3),pg_temp.tid(103),'템플릿 메이드','템플릿 메이드','template-maid','template-maid',0,'maid','active',false),
  (pg_temp.tid(4),pg_temp.tid(104),'비활성 관리자','비활성 관리자','template-inactive','template-inactive',0,'admin','inactive',false),
  (pg_temp.tid(5),pg_temp.tid(105),'임시 비밀번호 관리자','임시 비밀번호 관리자','template-password','template-password',0,'admin','active',true);
insert into auth.sessions(id,user_id) select pg_temp.tid(n + 100), pg_temp.tid(n) from generate_series(101,106) n;

select is(
  (public.list_checkout_cleaning_templates(pg_temp.tid(1),pg_temp.tid(201))->>'cleaningKind'),
  'checkout',
  'active admin lists only the confirmed checkout cleaning kind'
);
select is(
  jsonb_array_length(public.list_checkout_cleaning_templates(pg_temp.tid(1),pg_temp.tid(201))->'roomTypes'),
  4,
  'catalog lists all four stable room type identities'
);
select ok(
  not exists (
    select 1 from jsonb_array_elements(
      public.list_checkout_cleaning_templates(pg_temp.tid(1),pg_temp.tid(201))->'roomTypes'
    ) room_type where (room_type->>'configured')::boolean
  ),
  'fresh catalog explicitly remains unconfigured without a source seed'
);

select throws_ok(
  format(
    $sql$select public.create_reservation(%L,%L,%L,'2042-01-01 16:00+09','2042-01-02 11:00+09',2,null,%s,%L,%L)$sql$,
    pg_temp.tid(1),pg_temp.tid(301),pg_temp.room_for('standard'),
    (select state_version from public.rooms where id=pg_temp.room_for('standard')),
    'template-reservation-before',repeat('1',64)
  ),
  '23514','CLEANING_TEMPLATE_NOT_CONFIGURED',
  'reservation creation stays fail-closed before publication'
);

select throws_ok(
  $$select public.publish_checkout_cleaning_template(
    pg_temp.tid(1),pg_temp.tid(201),'standard',0,60,'1'::jsonb,
    'template-malformed-scalar',repeat('2',64))$$,
  '22023','INVALID_CLEANING_TEMPLATE_SLOTS',
  'scalar slots are rejected with a stable validation error'
);
select throws_ok(
  $$select public.publish_checkout_cleaning_template(
    pg_temp.tid(1),pg_temp.tid(201),'standard',0,60,pg_temp.checkout_slots(8),
    'template-missing-slot',repeat('3',64))$$,
  '23514','INVALID_CLEANING_TEMPLATE_SLOTS',
  'missing required room-type slots are rejected by the v8 evidence contract'
);
select throws_ok(
  $$select public.publish_checkout_cleaning_template(
    pg_temp.tid(1),pg_temp.tid(201),'standard',0,60,pg_temp.checkout_slots(10),
    'template-former-v7-count',repeat('3',64))$$,
  '23514','INVALID_CLEANING_TEMPLATE_SLOTS',
  'new publication rejects the former v7 standard count'
);
select throws_ok(
  $$select public.publish_checkout_cleaning_template(
    pg_temp.tid(1),pg_temp.tid(201),'standard',0,60,
    (select jsonb_agg(value - 'maxPhotos' order by (value->>'displayOrder')::integer)
       from jsonb_array_elements(pg_temp.checkout_slots(10))),
    'template-fresh-legacy-shape',repeat('3',64))$$,
  '23514','INVALID_CLEANING_TEMPLATE_SLOTS',
  'fresh publication cannot use a maxPhotos-less pre-A shape'
);
select throws_ok(
  $$select public.publish_checkout_cleaning_template(
    pg_temp.tid(1),pg_temp.tid(201),'standard',0,60,
    pg_temp.checkout_slots(9) #- '{0,maxPhotos}',
    'template-missing-max-photos',repeat('3',64))$$,
  '23514','INVALID_CLEANING_TEMPLATE_SLOTS',
  'v8 publication requires explicit maxPhotos metadata'
);
select throws_ok(
  $$select public.publish_checkout_cleaning_template(
    pg_temp.tid(1),pg_temp.tid(201),'standard',0,60,
    jsonb_set(pg_temp.checkout_slots(9),'{1,slotKey}','"tv-on"'),
    'template-duplicate-slot',repeat('4',64))$$,
  '22023','INVALID_CLEANING_TEMPLATE_SLOTS',
  'duplicate slot keys are rejected before publication'
);
select throws_ok(
  $$select public.publish_checkout_cleaning_template(
    pg_temp.tid(1),pg_temp.tid(201),'standard',0,10081,pg_temp.checkout_slots(9),
    'template-duration-overflow',repeat('5',64))$$,
  '22023','INVALID_CLEANING_TEMPLATE',
  'duration technical upper bound is enforced in the database'
);

create temp table first_publication(response jsonb);
insert into first_publication select public.publish_checkout_cleaning_template(
  pg_temp.tid(1),pg_temp.tid(201),'standard',0,60,pg_temp.checkout_slots(9),
  'template-publish-standard-v8',repeat('a',64)
);
select is((select (response->>'version')::integer from first_publication),8,
  'first checkout publication starts at confirmed A-contract version 8');
select is((select response->>'status' from first_publication),'published',
  'new version is published');
select is((select count(*) from public.cleaning_template_versions where status='published' and cleaning_kind='checkout'),1::bigint,
  'exactly one published version exists for the configured room type');
select is((select count(*) from private.photo_template_slots),9::bigint,
  'normalized slot rows exactly match the immutable published JSON snapshot');
select is(
  public.publish_checkout_cleaning_template(
    pg_temp.tid(1),pg_temp.tid(201),'standard',0,60,pg_temp.checkout_slots(9),
    'template-publish-standard-v8',repeat('a',64)
  ),
  (select response from first_publication),
  'same scoped key and request hash replay the identical response'
);
select is((select count(*) from public.audit_events where event_type='cleaning_template.published'),1::bigint,
  'replay does not append a duplicate audit event');
select throws_ok(
  $$select public.publish_checkout_cleaning_template(
    pg_temp.tid(1),pg_temp.tid(201),'standard',0,60,pg_temp.checkout_slots(9),
    'template-publish-standard-v8',repeat('b',64))$$,
  '23505','IDEMPOTENCY_KEY_REUSED',
  'same scoped key with a different request hash is rejected'
);
select throws_ok(
  $$select public.publish_checkout_cleaning_template(
    pg_temp.tid(1),pg_temp.tid(201),'standard',0,60,pg_temp.checkout_slots(9),
    'template-stale-standard',repeat('c',64))$$,
  '40001','CLEANING_TEMPLATE_VERSION_CONFLICT',
  'stale expected version is rejected after publication'
);

select lives_ok(
  format(
    $sql$select public.create_reservation(%L,%L,%L,'2042-02-01 16:00+09','2042-02-02 11:00+09',2,null,%s,%L,%L)$sql$,
    pg_temp.tid(1),pg_temp.tid(302),pg_temp.room_for('standard'),
    (select state_version from public.rooms where id=pg_temp.room_for('standard')),
    'template-reservation-after',repeat('d',64)
  ),
  'reservation succeeds after an explicit publication'
);
select is((select count(*) from public.cleaning_targets where reservation_id=pg_temp.tid(302)),1::bigint,
  'post-publication reservation creates exactly one planned checkout target');
create temp table original_target_snapshot as
select id,template_snapshot from public.cleaning_targets where reservation_id=pg_temp.tid(302);

create temp table second_publication(response jsonb);
insert into second_publication select public.publish_checkout_cleaning_template(
  pg_temp.tid(1),pg_temp.tid(201),'standard',8,75,pg_temp.checkout_slots(9),
  'template-publish-standard-v9',repeat('e',64)
);
select is((select (response->>'version')::integer from second_publication),9,
  'next publication allocates a new immutable version');
select is((select count(*) from public.cleaning_template_versions where status='published' and cleaning_kind='checkout'),1::bigint,
  'republish preserves exactly one published version');
select is((select count(*) from public.cleaning_template_versions where status='retired' and cleaning_kind='checkout'),1::bigint,
  'previous published version is retained as retired history');
select is(
  (select target.template_snapshot from public.cleaning_targets target join original_target_snapshot original using(id)),
  (select template_snapshot from original_target_snapshot),
  'a prior planned target keeps its original template and slot snapshot'
);
select lives_ok(
  format(
    $sql$select public.create_reservation(%L,%L,%L,'2043-02-01 16:00+09','2043-02-02 11:00+09',2,null,%s,%L,%L)$sql$,
    pg_temp.tid(1),pg_temp.tid(303),pg_temp.room_for('standard',1),
    (select state_version from public.rooms where id=pg_temp.room_for('standard',1)),
    'template-reservation-v9',repeat('f',64)
  ),
  'new reservation uses the newly published version'
);
select is((select (template_snapshot->>'version')::integer from public.cleaning_targets where reservation_id=pg_temp.tid(303)),9,
  'new target freezes the current v9 snapshot');

select throws_ok(
  $$select public.list_checkout_cleaning_templates(pg_temp.tid(3),pg_temp.tid(203))$$,
  '42501','ADMIN_REQUIRED','maid cannot list template configuration');
select throws_ok(
  $$select public.list_checkout_cleaning_templates(pg_temp.tid(4),pg_temp.tid(204))$$,
  '42501','ADMIN_REQUIRED','inactive admin cannot list template configuration');
select throws_ok(
  $$select public.list_checkout_cleaning_templates(pg_temp.tid(5),pg_temp.tid(205))$$,
  '42501','PASSWORD_CHANGE_REQUIRED','temporary-password admin cannot list template configuration');
delete from auth.sessions where id=pg_temp.tid(202);
select throws_ok(
  $$select public.list_checkout_cleaning_templates(pg_temp.tid(2),pg_temp.tid(202))$$,
  '42501','SESSION_REVOKED','revoked live session cannot list template configuration');

select ok(
  not has_table_privilege('authenticated','public.cleaning_template_versions','SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('service_role','public.cleaning_template_versions','SELECT,INSERT,UPDATE,DELETE'),
  'raw template table access is denied to Data API roles including service role'
);
select ok(
  has_function_privilege('service_role','public.list_checkout_cleaning_templates(uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.publish_checkout_cleaning_template(uuid,uuid,text,integer,integer,jsonb,text,text)','EXECUTE')
  and not has_function_privilege('authenticated','public.list_checkout_cleaning_templates(uuid,uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.publish_checkout_cleaning_template(uuid,uuid,text,integer,integer,jsonb,text,text)','EXECUTE'),
  'only service-role adapters can invoke the actor/session revalidating RPCs'
);
select ok(
  not exists(select 1 from pg_policies where schemaname='public' and tablename='cleaning_template_versions'),
  'RLS has no direct template policy after moving the catalog to RPC-only access'
);

select is(
  (select count(*)::integer from jsonb_object_keys((
    select after_state from public.audit_events where event_type='cleaning_template.published'
    order by recorded_at desc limit 1
  ))),5,
  'publication audit stores only the safe five-field operational summary'
);
select is(
  (select count(*)::integer from jsonb_object_keys((
    select summary from public.list_developer_audit_events(
      pg_temp.tid(6),array['cleaning_template.published'],null,null,null,null,null,100
    ) order by recorded_at desc limit 1
  ))),5,
  'developer projection exposes only the safe publication summary'
);
select ok(not exists(
  select 1 from public.list_developer_audit_events(
    pg_temp.tid(6),array['cleaning_template.published'],null,null,null,null,null,100
  ) where summary ?| array['slots','label','description','requestHash','before_state','after_state']
), 'developer audit never exposes slots, text payloads, request hashes, or raw states');
select throws_ok(
  $$select * from public.list_developer_audit_events(
    pg_temp.tid(6),array['cleaning_template.published'],null,clock_timestamp()-interval '32 days',clock_timestamp(),null,null,10)$$,
  '22023','INVALID_AUDIT_QUERY','new-event-only audit filter preserves the 31-day bound');
select throws_ok(
  $$select * from public.list_developer_audit_events(
    pg_temp.tid(6),array['cleaning_template.published'],null,null,null,null,null,101)$$,
  '22023','INVALID_AUDIT_QUERY','new-event-only audit filter preserves the limit bound');
select throws_ok(
  $$select * from public.list_developer_audit_events(
    pg_temp.tid(6),array['cleaning_template.published'],null,null,null,clock_timestamp(),null,10)$$,
  '22023','INVALID_AUDIT_QUERY','new-event-only audit filter preserves cursor pair validation');
select throws_ok(
  $$select * from public.list_developer_audit_events(
    pg_temp.tid(1),array['cleaning_template.published'],null,null,null,null,null,10)$$,
  '42501','DEVELOPER_REQUIRED','new-event-only audit filter preserves developer-role validation');
select is((select count(*) from public.notifications),0::bigint,
  'template publication emits no user action notification');
select is((select count(*) from private.notification_outbox),0::bigint,
  'template publication emits no delivery outbox because no recipient action is required');

select * from finish();
rollback;
