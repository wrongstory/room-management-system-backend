-- Issue #111: provider-neutral notification delivery ledger and bounded worker RPCs.
-- Actual Web Push HTTP, VAPID, Cron, secrets and production activation remain #112.

alter table private.web_push_subscription_events
  drop constraint web_push_subscription_events_reason_code_check;
alter table private.web_push_subscription_events
  add constraint web_push_subscription_events_reason_code_check
  check (reason_code in (
    'registered','material_rotated','session_rotated','endpoint_rotated','user_requested',
    'expired','session_revoked','endpoint_gone'
  ));
alter table private.web_push_subscriptions
  add constraint web_push_subscriptions_id_profile_unique unique(id,profile_id);
alter table private.web_push_subscription_revisions
  add constraint web_push_subscription_revisions_delivery_identity_unique
  unique(id,subscription_id,revision_no,profile_id);

create table private.notification_delivery_jobs (
  outbox_id uuid primary key references private.notification_delivery_outbox(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending','materialized','completed','suppressed','dead_letter','operator_blocked')),
  snapshot_at timestamptz,
  terminal_at timestamptz,
  terminal_reason text check (terminal_reason is null or terminal_reason in (
    'STALE_NOTIFICATION','NO_ACTIVE_SUBSCRIPTION','RECIPIENT_NOT_ELIGIBLE',
    'NOTIFICATION_RESOLVED','DELIVERY_CONTRACT_INVALID','DELIVERY_DEAD_LETTER',
    'PROVIDER_CONFIGURATION_ERROR'
  )),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (
    (status in ('completed','suppressed','dead_letter') and terminal_at is not null)
    or (status not in ('completed','suppressed','dead_letter') and terminal_at is null)
  )
);

create table private.notification_delivery_targets (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references private.notification_delivery_jobs(outbox_id) on delete restrict,
  notification_id uuid not null references public.notifications(id) on delete restrict,
  recipient_profile_id uuid not null references public.profiles(id) on delete restrict,
  subscription_id uuid not null references private.web_push_subscriptions(id) on delete restrict,
  subscription_version integer not null check (subscription_version >= 1),
  subscription_revision_id uuid not null references private.web_push_subscription_revisions(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending','claimed','retry','delivered','suppressed','dead_letter','operator_blocked')),
  lease_version integer not null default 0 check (lease_version between 0 and 8),
  claim_digest text check (claim_digest is null or claim_digest ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  terminal_at timestamptz,
  reason_code text check (reason_code is null or reason_code in (
    'STALE_NOTIFICATION','RECIPIENT_NOT_ELIGIBLE','NOTIFICATION_RESOLVED',
    'SUBSCRIPTION_EXPIRED','SUBSCRIPTION_RETIRED','REVISION_SUPERSEDED',
    'SESSION_REVOKED','ENVELOPE_UNAVAILABLE','PAYLOAD_TOO_LARGE','ENDPOINT_GONE',
    'RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR','TIMEOUT','PAYLOAD_REJECTED',
    'PROVIDER_CONFIGURATION_ERROR','RETRY_EXHAUSTED'
  )),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (outbox_id, subscription_id),
  check (
    (status in ('delivered','suppressed','dead_letter') and terminal_at is not null)
    or (status not in ('delivered','suppressed','dead_letter') and terminal_at is null)
  ),
  check ((status = 'claimed') = (claim_digest is not null and lease_expires_at is not null))
);
create index notification_delivery_targets_due_idx
  on private.notification_delivery_targets(next_attempt_at,id)
  where status in ('pending','retry','claimed');
create index notification_delivery_targets_job_idx
  on private.notification_delivery_targets(outbox_id,status,id);
create index notification_delivery_targets_revision_idx
  on private.notification_delivery_targets(subscription_revision_id,id);
alter table private.notification_delivery_targets
  add constraint notification_delivery_targets_subscription_profile_fk
  foreign key(subscription_id,recipient_profile_id)
  references private.web_push_subscriptions(id,profile_id) on delete restrict;
alter table private.notification_delivery_targets
  add constraint notification_delivery_targets_exact_revision_fk
  foreign key(subscription_revision_id,subscription_id,subscription_version,recipient_profile_id)
  references private.web_push_subscription_revisions(id,subscription_id,revision_no,profile_id) on delete restrict;

create table private.notification_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references private.notification_delivery_targets(id) on delete restrict,
  attempt_no integer not null check (attempt_no between 1 and 8),
  lease_version integer not null check (lease_version between 1 and 8),
  claim_digest text not null check (claim_digest ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null default clock_timestamp(),
  unique (target_id, attempt_no),
  unique (target_id, lease_version)
);

create table private.notification_delivery_permits (
  attempt_id uuid primary key references private.notification_delivery_attempts(id) on delete restrict,
  subscription_revision_id uuid not null references private.web_push_subscription_revisions(id) on delete restrict,
  permitted_at timestamptz not null default clock_timestamp()
);

create table private.notification_delivery_attempt_results (
  attempt_id uuid primary key references private.notification_delivery_attempts(id) on delete restrict,
  outcome text not null check (outcome in (
    'accepted','suppressed','retryable','endpoint_gone','payload_rejected','provider_configuration_error'
  )),
  reason_code text check (reason_code is null or reason_code in (
    'STALE_NOTIFICATION','RECIPIENT_NOT_ELIGIBLE','NOTIFICATION_RESOLVED',
    'SUBSCRIPTION_EXPIRED','SUBSCRIPTION_RETIRED','REVISION_SUPERSEDED',
    'SESSION_REVOKED','ENVELOPE_UNAVAILABLE','PAYLOAD_TOO_LARGE','ENDPOINT_GONE',
    'RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR','TIMEOUT','PAYLOAD_REJECTED',
    'PROVIDER_CONFIGURATION_ERROR','RETRY_EXHAUSTED'
  )),
  request_reason_code text check (request_reason_code is null or request_reason_code in (
    'RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR','TIMEOUT','PAYLOAD_REJECTED',
    'PROVIDER_CONFIGURATION_ERROR'
  )),
  requested_retry_after_seconds integer
    check (requested_retry_after_seconds is null or requested_retry_after_seconds between 1 and 3600),
  retry_at timestamptz,
  completed_at timestamptz not null default clock_timestamp()
);
create index notification_delivery_attempt_results_retention_idx
  on private.notification_delivery_attempt_results(completed_at,attempt_id);

create table private.notification_delivery_events (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references private.notification_delivery_jobs(outbox_id) on delete restrict,
  target_id uuid references private.notification_delivery_targets(id) on delete restrict,
  state text not null check (state in (
    'pending','materialized','claimed','retry','delivered','suppressed','completed',
    'dead_letter','operator_blocked','resumed'
  )),
  reason_code text,
  occurred_at timestamptz not null default clock_timestamp(),
  check (reason_code is null or reason_code ~ '^[A-Z0-9_]{2,80}$')
);
create index notification_delivery_events_retention_idx
  on private.notification_delivery_events(occurred_at,id);

create table private.notification_delivery_heartbeat (
  singleton boolean primary key default true check (singleton),
  status text not null check (status in ('succeeded','degraded','failed')),
  claimed integer not null check (claimed between 0 and 10),
  delivered integer not null check (delivered between 0 and 10),
  retrying integer not null check (retrying between 0 and 10),
  suppressed integer not null check (suppressed between 0 and 10),
  dead_letter integer not null check (dead_letter between 0 and 10),
  blocked integer not null check (blocked between 0 and 10),
  deferred integer not null check (deferred between 0 and 10),
  error_code text check (error_code is null or error_code in (
    'NOTIFICATION_DELIVERY_FAILED','PROVIDER_CONFIGURATION_ERROR'
  )),
  recorded_at timestamptz not null default clock_timestamp()
);

do $$ declare t text; begin
  foreach t in array array[
    'notification_delivery_jobs','notification_delivery_targets',
    'notification_delivery_attempts','notification_delivery_permits',
    'notification_delivery_attempt_results','notification_delivery_events',
    'notification_delivery_heartbeat'
  ] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on table private.%I from public,anon,authenticated,service_role',t);
  end loop;
end $$;

create function private.guard_notification_delivery_mutable()
returns trigger language plpgsql set search_path='' as $$
begin
  if coalesce(current_setting('app.notification_delivery_writer_mode',true),'') <> 'typed_v1'
    or tg_op='DELETE' then
    raise exception using errcode='55000',message='NOTIFICATION_DELIVERY_LEDGER_IMMUTABLE';
  end if;
  if tg_op='UPDATE' and tg_table_name='notification_delivery_jobs' then
    if old.outbox_id is distinct from new.outbox_id or old.created_at is distinct from new.created_at
      or old.snapshot_at is not null and old.snapshot_at is distinct from new.snapshot_at
      or old.status in ('completed','suppressed','dead_letter') then
      raise exception using errcode='55000',message='NOTIFICATION_DELIVERY_JOB_TERMINAL';
    end if;
  elsif tg_op='UPDATE' and tg_table_name='notification_delivery_targets' then
    if (to_jsonb(old)-array['status','lease_version','claim_digest','lease_expires_at','next_attempt_at','terminal_at','reason_code','updated_at'])
      is distinct from
       (to_jsonb(new)-array['status','lease_version','claim_digest','lease_expires_at','next_attempt_at','terminal_at','reason_code','updated_at'])
      or new.lease_version < old.lease_version or new.lease_version > old.lease_version+1
      or old.status in ('delivered','suppressed','dead_letter') then
      raise exception using errcode='55000',message='NOTIFICATION_DELIVERY_TARGET_TERMINAL';
    end if;
  end if;
  return new;
end $$;

create function private.guard_notification_delivery_append_only()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' and coalesce(current_setting('app.notification_delivery_writer_mode',true),'')='typed_v1' then
    return new;
  end if;
  if tg_op='DELETE' and coalesce(current_setting('app.notification_delivery_writer_mode',true),'')='purge_v1' then
    return old;
  end if;
  raise exception using errcode='55000',message='NOTIFICATION_DELIVERY_HISTORY_IMMUTABLE';
end $$;

create trigger notification_delivery_jobs_guard before insert or update or delete
  on private.notification_delivery_jobs for each row execute function private.guard_notification_delivery_mutable();
create trigger notification_delivery_targets_guard before insert or update or delete
  on private.notification_delivery_targets for each row execute function private.guard_notification_delivery_mutable();
create trigger notification_delivery_heartbeat_guard before insert or update or delete
  on private.notification_delivery_heartbeat for each row execute function private.guard_notification_delivery_mutable();
create trigger notification_delivery_attempts_guard before insert or update or delete
  on private.notification_delivery_attempts for each row execute function private.guard_notification_delivery_append_only();
create trigger notification_delivery_permits_guard before insert or update or delete
  on private.notification_delivery_permits for each row execute function private.guard_notification_delivery_append_only();
create trigger notification_delivery_results_guard before insert or update or delete
  on private.notification_delivery_attempt_results for each row execute function private.guard_notification_delivery_append_only();
create trigger notification_delivery_events_guard before insert or update or delete
  on private.notification_delivery_events for each row execute function private.guard_notification_delivery_append_only();

create function private.append_notification_delivery_event(
  p_outbox_id uuid,p_target_id uuid,p_state text,p_reason_code text default null
) returns void language plpgsql set search_path='' as $$
begin
  insert into private.notification_delivery_events(outbox_id,target_id,state,reason_code)
  values(p_outbox_id,p_target_id,p_state,p_reason_code);
end $$;

create function private.enqueue_notification_delivery_job()
returns trigger language plpgsql set search_path='' as $$
declare previous_mode text:=current_setting('app.notification_delivery_writer_mode',true);
begin
  perform set_config('app.notification_delivery_writer_mode','typed_v1',true);
  insert into private.notification_delivery_jobs(outbox_id) values(new.id) on conflict do nothing;
  perform private.append_notification_delivery_event(new.id,null,'pending',null);
  perform set_config('app.notification_delivery_writer_mode',coalesce(previous_mode,''),true);
  return new;
exception when others then
  perform set_config('app.notification_delivery_writer_mode',coalesce(previous_mode,''),true);
  raise;
end $$;
create trigger notification_delivery_outbox_enqueue_job after insert
  on private.notification_delivery_outbox for each row execute function private.enqueue_notification_delivery_job();

select set_config('app.notification_delivery_writer_mode','typed_v1',true);
insert into private.notification_delivery_jobs(outbox_id,created_at,updated_at)
select id,enqueued_at,enqueued_at from private.notification_delivery_outbox on conflict do nothing;
insert into private.notification_delivery_events(outbox_id,state,occurred_at)
select j.outbox_id,'pending',j.created_at from private.notification_delivery_jobs j
where not exists(select 1 from private.notification_delivery_events e where e.outbox_id=j.outbox_id);
select set_config('app.notification_delivery_writer_mode','',true);

create function private.notification_delivery_target_projection(p_target_id uuid)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'targetId',t.id,'notificationId',t.notification_id,
    'subscriptionRevisionId',t.subscription_revision_id,
    'status',t.status,'leaseVersion',t.lease_version,
    'leaseExpiresAt',t.lease_expires_at,'nextAttemptAt',t.next_attempt_at,
    'reasonCode',t.reason_code
  )) from private.notification_delivery_targets t where t.id=p_target_id
$$;

create function private.refresh_notification_delivery_job(p_outbox_id uuid)
returns void language plpgsql set search_path='' as $$
declare v_old text; v_new text; v_reason text; v_now timestamptz:=clock_timestamp();
begin
  select status into v_old from private.notification_delivery_jobs where outbox_id=p_outbox_id for update;
  if exists(select 1 from private.notification_delivery_targets where outbox_id=p_outbox_id and status='operator_blocked') then
    v_new:='operator_blocked'; v_reason:='PROVIDER_CONFIGURATION_ERROR';
  elsif exists(select 1 from private.notification_delivery_targets where outbox_id=p_outbox_id and status in ('pending','claimed','retry')) then
    v_new:='materialized'; v_reason:=null;
  elsif exists(select 1 from private.notification_delivery_targets where outbox_id=p_outbox_id and status='dead_letter') then
    v_new:='dead_letter'; v_reason:='DELIVERY_DEAD_LETTER';
  else
    v_new:='completed'; v_reason:=null;
  end if;
  if v_new is distinct from v_old then
    update private.notification_delivery_jobs set status=v_new,terminal_reason=v_reason,
      terminal_at=case when v_new in ('completed','dead_letter') then v_now else null end,updated_at=v_now
      where outbox_id=p_outbox_id;
    perform private.append_notification_delivery_event(p_outbox_id,null,v_new,v_reason);
  end if;
end $$;

create function private.finish_notification_delivery_target(
  p_target_id uuid,p_attempt_id uuid,p_status text,p_outcome text,p_reason_code text,
  p_retry_at timestamptz default null,p_request_reason_code text default null,
  p_requested_retry_after_seconds integer default null
) returns jsonb language plpgsql set search_path='' as $$
declare v_target private.notification_delivery_targets; v_now timestamptz:=clock_timestamp();
begin
  select * into v_target from private.notification_delivery_targets where id=p_target_id for update;
  insert into private.notification_delivery_attempt_results(
    attempt_id,outcome,reason_code,request_reason_code,requested_retry_after_seconds,retry_at,completed_at
  ) values(
    p_attempt_id,p_outcome,p_reason_code,p_request_reason_code,p_requested_retry_after_seconds,p_retry_at,v_now
  );
  update private.notification_delivery_targets set status=p_status,
    claim_digest=null,lease_expires_at=null,next_attempt_at=coalesce(p_retry_at,next_attempt_at),
    terminal_at=case when p_status in ('delivered','suppressed','dead_letter') then v_now else null end,
    reason_code=p_reason_code,updated_at=v_now where id=p_target_id;
  perform private.append_notification_delivery_event(v_target.outbox_id,p_target_id,p_status,p_reason_code);
  perform private.refresh_notification_delivery_job(v_target.outbox_id);
  return private.notification_delivery_target_projection(p_target_id);
end $$;

create function private.retire_notification_delivery_subscription(
  p_subscription_id uuid,p_revision_id uuid,p_reason text,p_at timestamptz
) returns boolean language plpgsql set search_path='' as $$
declare v_subscription private.web_push_subscriptions; previous_mode text:=current_setting('app.web_push_writer_mode',true);
begin
  if p_reason not in ('expired','session_revoked','endpoint_gone') then
    raise exception using errcode='22023',message='NOTIFICATION_DELIVERY_RETIRE_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('web-push:membership:v1',0));
  select * into v_subscription from private.web_push_subscriptions where id=p_subscription_id for update;
  if v_subscription.id is null or v_subscription.status<>'active'
    or v_subscription.current_revision_id<>p_revision_id then return false; end if;
  perform set_config('app.web_push_writer_mode','typed_v1',true);
  delete from private.web_push_subscription_secrets where revision_id=p_revision_id;
  update private.web_push_subscriptions set status='retired',version=version+1,
    active_endpoint_digest=null,active_session_digest=null,expiration_at=null,
    retired_at=p_at,updated_at=p_at where id=p_subscription_id;
  insert into private.web_push_subscription_events(subscription_id,reason_code,occurred_at)
  values(p_subscription_id,p_reason,p_at);
  perform set_config('app.web_push_writer_mode',coalesce(previous_mode,''),true);
  return true;
exception when others then
  perform set_config('app.web_push_writer_mode',coalesce(previous_mode,''),true);
  raise;
end $$;

create function public.claim_notification_deliveries(p_claim_digest text,p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job record; v_target private.notification_delivery_targets; v_now timestamptz:=clock_timestamp();
  v_items jsonb:='[]'::jsonb; v_suppressed integer:=0; v_blocked integer:=0; v_count integer;
  v_processed integer:=0;
  v_previous text:=current_setting('app.notification_delivery_writer_mode',true);
begin
  if p_claim_digest is null or p_claim_digest !~ '^[0-9a-f]{64}$'
    or p_limit is null or p_limit not between 1 and 10 then
    raise exception using errcode='22023',message='NOTIFICATION_DELIVERY_CLAIM_INVALID';
  end if;
  perform set_config('app.notification_delivery_writer_mode','typed_v1',true);
  begin
    for v_job in
      select j.outbox_id,j.status,o.notification_id,o.event_family,o.enqueued_at,
        n.recipient_profile_id,n.contract_version,n.event_family as notification_event_family,n.resolved_at,
        p.role::text as recipient_role,p.status::text as recipient_status,p.must_change_password,
        c.push_eligible,c.requires_action
      from private.notification_delivery_jobs j
      join private.notification_delivery_outbox o on o.id=j.outbox_id
      join public.notifications n on n.id=o.notification_id
      left join public.profiles p on p.id=n.recipient_profile_id
      left join private.notification_event_catalog c on c.event_family=o.event_family
      where j.status='pending'
      order by o.enqueued_at,o.id
      for update of j skip locked limit p_limit
    loop
      v_now:=clock_timestamp();
      if v_job.enqueued_at+interval '24 hours'<=v_now then
        update private.notification_delivery_jobs set status='suppressed',snapshot_at=v_now,terminal_at=v_now,
          terminal_reason='STALE_NOTIFICATION',updated_at=v_now where outbox_id=v_job.outbox_id;
        perform private.append_notification_delivery_event(v_job.outbox_id,null,'suppressed','STALE_NOTIFICATION');
        v_suppressed:=v_suppressed+1; v_processed:=v_processed+1; continue;
      elsif v_job.resolved_at is not null then
        update private.notification_delivery_jobs set status='suppressed',snapshot_at=v_now,terminal_at=v_now,
          terminal_reason='NOTIFICATION_RESOLVED',updated_at=v_now where outbox_id=v_job.outbox_id;
        perform private.append_notification_delivery_event(v_job.outbox_id,null,'suppressed','NOTIFICATION_RESOLVED');
        v_suppressed:=v_suppressed+1; v_processed:=v_processed+1; continue;
      elsif v_job.contract_version<>1 or v_job.notification_event_family is distinct from v_job.event_family
        or not coalesce(v_job.push_eligible,false) or not coalesce(v_job.requires_action,false) then
        update private.notification_delivery_jobs set status='dead_letter',snapshot_at=v_now,terminal_at=v_now,
          terminal_reason='DELIVERY_CONTRACT_INVALID',updated_at=v_now where outbox_id=v_job.outbox_id;
        perform private.append_notification_delivery_event(v_job.outbox_id,null,'dead_letter','DELIVERY_CONTRACT_INVALID');
        v_blocked:=v_blocked+1; v_processed:=v_processed+1; continue;
      elsif v_job.recipient_role not in ('admin','maid') or v_job.recipient_status<>'active'
        or coalesce(v_job.must_change_password,true) then
        update private.notification_delivery_jobs set status='suppressed',snapshot_at=v_now,terminal_at=v_now,
          terminal_reason='RECIPIENT_NOT_ELIGIBLE',updated_at=v_now where outbox_id=v_job.outbox_id;
        perform private.append_notification_delivery_event(v_job.outbox_id,null,'suppressed','RECIPIENT_NOT_ELIGIBLE');
        v_suppressed:=v_suppressed+1; v_processed:=v_processed+1; continue;
      end if;
      insert into private.notification_delivery_targets(
        outbox_id,notification_id,recipient_profile_id,subscription_id,subscription_version,
        subscription_revision_id,next_attempt_at,created_at,updated_at
      )
      select v_job.outbox_id,v_job.notification_id,v_job.recipient_profile_id,s.id,s.version,
        s.current_revision_id,v_now,v_now,v_now
      from private.web_push_subscriptions s
      join private.web_push_subscription_revisions r on r.id=s.current_revision_id
        and r.subscription_id=s.id and r.profile_id=s.profile_id and r.revision_no=s.version
      where s.profile_id=v_job.recipient_profile_id and s.status='active'
      order by s.id on conflict(outbox_id,subscription_id) do nothing;
      get diagnostics v_count=row_count;
      if v_count=0 then
        update private.notification_delivery_jobs set status='suppressed',snapshot_at=v_now,terminal_at=v_now,
          terminal_reason='NO_ACTIVE_SUBSCRIPTION',updated_at=v_now where outbox_id=v_job.outbox_id;
        perform private.append_notification_delivery_event(v_job.outbox_id,null,'suppressed','NO_ACTIVE_SUBSCRIPTION');
        v_suppressed:=v_suppressed+1; v_processed:=v_processed+1;
      else
        update private.notification_delivery_jobs set status='materialized',snapshot_at=v_now,updated_at=v_now
          where outbox_id=v_job.outbox_id;
        perform private.append_notification_delivery_event(v_job.outbox_id,null,'materialized',null);
      end if;
    end loop;

    for v_target in
      select t.* from private.notification_delivery_targets t
      join private.notification_delivery_jobs j on j.outbox_id=t.outbox_id
      where j.status='materialized' and t.status in ('pending','retry','claimed')
        and t.next_attempt_at<=clock_timestamp()
        and (t.status<>'claimed' or t.lease_expires_at<=clock_timestamp() or t.claim_digest=p_claim_digest)
      order by t.next_attempt_at,t.id for update of t skip locked limit greatest(0,p_limit-v_processed)
    loop
      v_now:=clock_timestamp();
      -- Re-read the parent in a new statement snapshot. A configuration
      -- settlement that committed after the cursor snapshot must still fence
      -- every sibling before a new claim/attempt is appended.
      if not exists(select 1 from private.notification_delivery_jobs j
        where j.outbox_id=v_target.outbox_id and j.status='materialized') then
        continue;
      end if;
      if v_target.status='claimed' and v_target.lease_expires_at>v_now
        and v_target.claim_digest=p_claim_digest then
        v_items:=v_items||jsonb_build_array(private.notification_delivery_target_projection(v_target.id));
        continue;
      end if;
      if v_target.lease_version>=8 then
        update private.notification_delivery_targets set status='dead_letter',claim_digest=null,lease_expires_at=null,
          terminal_at=v_now,reason_code='RETRY_EXHAUSTED',updated_at=v_now where id=v_target.id;
        perform private.append_notification_delivery_event(v_target.outbox_id,v_target.id,'dead_letter','RETRY_EXHAUSTED');
        perform private.refresh_notification_delivery_job(v_target.outbox_id); v_blocked:=v_blocked+1; continue;
      end if;
      update private.notification_delivery_targets set status='claimed',lease_version=lease_version+1,
        claim_digest=p_claim_digest,lease_expires_at=v_now+interval '2 minutes',reason_code=null,updated_at=v_now
        where id=v_target.id returning * into v_target;
      insert into private.notification_delivery_attempts(target_id,attempt_no,lease_version,claim_digest,started_at)
      values(v_target.id,v_target.lease_version,v_target.lease_version,p_claim_digest,v_now);
      perform private.append_notification_delivery_event(v_target.outbox_id,v_target.id,'claimed',null);
      v_items:=v_items||jsonb_build_array(private.notification_delivery_target_projection(v_target.id));
    end loop;
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
    return jsonb_build_object('items',v_items,'suppressed',v_suppressed,'blocked',v_blocked);
  exception when others then
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true); raise;
  end;
end $$;

create function private.assert_notification_delivery_fence(
  p_target_id uuid,p_lease_version integer,p_claim_digest text
) returns private.notification_delivery_targets language plpgsql set search_path='' as $$
declare v_target private.notification_delivery_targets;
begin
  select * into v_target from private.notification_delivery_targets where id=p_target_id for update;
  if v_target.id is null or v_target.status<>'claimed' or v_target.lease_version<>p_lease_version
    or v_target.claim_digest is distinct from p_claim_digest or v_target.lease_expires_at<=clock_timestamp() then
    raise exception using errcode='40001',message='NOTIFICATION_DELIVERY_FENCE_CONFLICT';
  end if;
  return v_target;
end $$;

create function public.get_notification_delivery_envelope(
  p_target_id uuid,p_lease_version integer,p_claim_digest text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_target private.notification_delivery_targets; v_attempt private.notification_delivery_attempts;
  v_outbox private.notification_delivery_outbox; v_notice public.notifications;
  v_profile public.profiles; v_subscription private.web_push_subscriptions;
  v_revision private.web_push_subscription_revisions; v_secret private.web_push_subscription_secrets;
  v_now timestamptz:=clock_timestamp(); v_previous text:=current_setting('app.notification_delivery_writer_mode',true);
begin
  perform set_config('app.notification_delivery_writer_mode','typed_v1',true);
  begin
    v_target:=private.assert_notification_delivery_fence(p_target_id,p_lease_version,p_claim_digest);
    select * into v_attempt from private.notification_delivery_attempts
      where target_id=p_target_id and lease_version=p_lease_version;
    select * into v_outbox from private.notification_delivery_outbox where id=v_target.outbox_id;
    select * into v_notice from public.notifications where id=v_target.notification_id;
    select * into v_profile from public.profiles where id=v_target.recipient_profile_id;
    select * into v_subscription from private.web_push_subscriptions where id=v_target.subscription_id;
    select * into v_revision from private.web_push_subscription_revisions where id=v_target.subscription_revision_id;
    if v_outbox.enqueued_at+interval '24 hours'<=v_now then
      perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','STALE_NOTIFICATION');
      perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
      return jsonb_build_object('sendAllowed',false,'reasonCode','STALE_NOTIFICATION');
    elsif v_notice.resolved_at is not null then
      perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','NOTIFICATION_RESOLVED');
      perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
      return jsonb_build_object('sendAllowed',false,'reasonCode','NOTIFICATION_RESOLVED');
    elsif v_profile.role::text not in ('admin','maid') or v_profile.status::text<>'active' or v_profile.must_change_password then
      perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','RECIPIENT_NOT_ELIGIBLE');
      perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
      return jsonb_build_object('sendAllowed',false,'reasonCode','RECIPIENT_NOT_ELIGIBLE');
    elsif v_subscription.status='active' and v_subscription.current_revision_id=v_target.subscription_revision_id
      and v_subscription.version=v_target.subscription_version and v_subscription.expiration_at is not null
      and v_subscription.expiration_at<=v_now then
      perform private.retire_notification_delivery_subscription(v_subscription.id,v_target.subscription_revision_id,'expired',v_now);
      perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','SUBSCRIPTION_EXPIRED');
      perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
      return jsonb_build_object('sendAllowed',false,'reasonCode','SUBSCRIPTION_EXPIRED');
    elsif v_subscription.status<>'active' then
      perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','SUBSCRIPTION_RETIRED');
      perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
      return jsonb_build_object('sendAllowed',false,'reasonCode','SUBSCRIPTION_RETIRED');
    elsif v_subscription.current_revision_id<>v_target.subscription_revision_id
      or v_subscription.version<>v_target.subscription_version then
      perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','REVISION_SUPERSEDED');
      perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
      return jsonb_build_object('sendAllowed',false,'reasonCode','REVISION_SUPERSEDED');
    end if;
    select * into v_secret from private.web_push_subscription_secrets where revision_id=v_target.subscription_revision_id;
    if v_secret.revision_id is null or v_revision.id is null then
      perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'dead_letter','payload_rejected','ENVELOPE_UNAVAILABLE');
      perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
      return jsonb_build_object('sendAllowed',false,'reasonCode','ENVELOPE_UNAVAILABLE');
    end if;
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
    return jsonb_build_object(
      'sendAllowed',true,'attemptId',v_attempt.id,'targetId',v_target.id,
      'actorProfileId',v_target.recipient_profile_id,'subscriptionId',v_target.subscription_id,
      'revisionNo',v_revision.revision_no,'subscriptionRevisionId',v_revision.id,
      'sessionDigest',v_revision.session_digest,'endpointDigest',v_revision.endpoint_digest,
      'keyVersion',v_revision.key_version,'ciphertextBase64',replace(encode(v_secret.ciphertext,'base64'),E'\n',''),
      'nonceBase64',replace(encode(v_secret.nonce,'base64'),E'\n',''),
      'authTagBase64',replace(encode(v_secret.auth_tag,'base64'),E'\n','')
    );
  exception when others then
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true); raise;
  end;
end $$;

create function public.permit_notification_delivery(
  p_target_id uuid,p_lease_version integer,p_claim_digest text,p_session_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_target private.notification_delivery_targets; v_attempt private.notification_delivery_attempts;
  v_subscription private.web_push_subscriptions; v_profile public.profiles; v_notice public.notifications;
  v_permit private.notification_delivery_permits;
  v_outbox private.notification_delivery_outbox;
  v_payload jsonb; v_session_live boolean:=false; v_now timestamptz:=clock_timestamp();
  v_previous text:=current_setting('app.notification_delivery_writer_mode',true);
begin
  perform set_config('app.notification_delivery_writer_mode','typed_v1',true);
  begin
    v_target:=private.assert_notification_delivery_fence(p_target_id,p_lease_version,p_claim_digest);
    select * into v_attempt from private.notification_delivery_attempts where target_id=p_target_id and lease_version=p_lease_version;
    select * into v_permit from private.notification_delivery_permits where attempt_id=v_attempt.id;
    if v_permit.attempt_id is not null then
      select * into v_notice from public.notifications where id=v_target.notification_id;
    else
      select * into v_profile from public.profiles where id=v_target.recipient_profile_id for share;
      select * into v_notice from public.notifications where id=v_target.notification_id;
      select * into v_outbox from private.notification_delivery_outbox where id=v_target.outbox_id;
      if v_outbox.enqueued_at+interval '24 hours'<=v_now then
        perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','STALE_NOTIFICATION');
        perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
        return jsonb_build_object('sendAllowed',false,'reasonCode','STALE_NOTIFICATION');
      elsif v_notice.resolved_at is not null then
        perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','NOTIFICATION_RESOLVED');
        perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
        return jsonb_build_object('sendAllowed',false,'reasonCode','NOTIFICATION_RESOLVED');
      elsif v_profile.role::text not in ('admin','maid') or v_profile.status::text<>'active' or v_profile.must_change_password then
        perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','RECIPIENT_NOT_ELIGIBLE');
        perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
        return jsonb_build_object('sendAllowed',false,'reasonCode','RECIPIENT_NOT_ELIGIBLE');
      end if;
      select true into v_session_live from auth.sessions s
        where s.id=p_session_id and s.user_id=v_profile.auth_user_id for share;
      -- Match #110 membership mutation order: actor/session, then the global
      -- membership lock, then the subscription row. The permit insert below is
      -- therefore the exact-current send authorization linearization point.
      perform pg_advisory_xact_lock(hashtextextended('web-push:membership:v1',0));
      select * into v_subscription from private.web_push_subscriptions where id=v_target.subscription_id for update;
      v_now:=clock_timestamp();
      if v_subscription.status='active' and v_subscription.current_revision_id=v_target.subscription_revision_id
        and v_subscription.version=v_target.subscription_version and v_subscription.expiration_at is not null
        and v_subscription.expiration_at<=v_now then
        perform private.retire_notification_delivery_subscription(v_subscription.id,v_target.subscription_revision_id,'expired',v_now);
        perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','SUBSCRIPTION_EXPIRED');
        perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
        return jsonb_build_object('sendAllowed',false,'reasonCode','SUBSCRIPTION_EXPIRED');
      elsif v_subscription.status<>'active' then
        perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','SUBSCRIPTION_RETIRED');
        perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
        return jsonb_build_object('sendAllowed',false,'reasonCode','SUBSCRIPTION_RETIRED');
      elsif v_subscription.current_revision_id<>v_target.subscription_revision_id or v_subscription.version<>v_target.subscription_version then
        perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','REVISION_SUPERSEDED');
        perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
        return jsonb_build_object('sendAllowed',false,'reasonCode','REVISION_SUPERSEDED');
      elsif not coalesce(v_session_live,false) then
        perform private.retire_notification_delivery_subscription(v_subscription.id,v_target.subscription_revision_id,'session_revoked',v_now);
        perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','suppressed','SESSION_REVOKED');
        perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
        return jsonb_build_object('sendAllowed',false,'reasonCode','SESSION_REVOKED');
      end if;
      v_payload:=jsonb_build_object(
        'notificationId',v_notice.id,'category',v_notice.category,'title',v_notice.title,'body',v_notice.body,
        'deepLink',jsonb_build_object('kind',v_notice.deep_link_kind,'entityId',v_notice.deep_link_entity_id),
        'groupId',v_notice.notification_group_id,'occurredAt',v_notice.occurred_at
      );
      if octet_length(convert_to(v_payload::text,'UTF8'))>3072 then
        perform private.finish_notification_delivery_target(p_target_id,v_attempt.id,'dead_letter','payload_rejected','PAYLOAD_TOO_LARGE');
        perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
        return jsonb_build_object('sendAllowed',false,'reasonCode','PAYLOAD_TOO_LARGE');
      end if;
      insert into private.notification_delivery_permits(attempt_id,subscription_revision_id,permitted_at)
      values(v_attempt.id,v_target.subscription_revision_id,v_now) returning * into v_permit;
    end if;
    if v_payload is null then
      v_payload:=jsonb_build_object(
        'notificationId',v_notice.id,'category',v_notice.category,'title',v_notice.title,'body',v_notice.body,
        'deepLink',jsonb_build_object('kind',v_notice.deep_link_kind,'entityId',v_notice.deep_link_entity_id),
        'groupId',v_notice.notification_group_id,'occurredAt',v_notice.occurred_at
      );
    end if;
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
    return jsonb_build_object('sendAllowed',true,'attemptId',v_attempt.id,'payload',v_payload,'permittedAt',v_permit.permitted_at);
  exception when others then
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true); raise;
  end;
end $$;

create function public.settle_notification_delivery(
  p_target_id uuid,p_lease_version integer,p_claim_digest text,p_outcome text,p_reason_code text default null,
  p_retry_after_seconds integer default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_target private.notification_delivery_targets; v_attempt private.notification_delivery_attempts;
  v_existing private.notification_delivery_attempt_results; v_now timestamptz:=clock_timestamp();
  v_retry_at timestamptz; v_delay integer; v_result jsonb;
  v_previous text:=current_setting('app.notification_delivery_writer_mode',true);
begin
  if p_outcome is null
    or p_outcome not in ('accepted','endpoint_gone','retryable','payload_rejected','provider_configuration_error')
    or (p_outcome='retryable' and p_reason_code not in ('RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR','TIMEOUT'))
    or (p_outcome='payload_rejected' and p_reason_code is distinct from 'PAYLOAD_REJECTED')
    or (p_outcome='provider_configuration_error' and p_reason_code is distinct from 'PROVIDER_CONFIGURATION_ERROR')
    or (p_outcome in ('accepted','endpoint_gone') and p_reason_code is not null)
    or (p_retry_after_seconds is not null and (p_outcome<>'retryable' or p_retry_after_seconds not between 1 and 3600)) then
    raise exception using errcode='22023',message='NOTIFICATION_DELIVERY_SETTLE_INVALID';
  end if;
  perform set_config('app.notification_delivery_writer_mode','typed_v1',true);
  begin
    select * into v_attempt from private.notification_delivery_attempts where target_id=p_target_id and lease_version=p_lease_version;
    if v_attempt.id is null or v_attempt.claim_digest is distinct from p_claim_digest then
      raise exception using errcode='40001',message='NOTIFICATION_DELIVERY_FENCE_CONFLICT';
    end if;
    select * into v_existing from private.notification_delivery_attempt_results where attempt_id=v_attempt.id;
    if v_existing.attempt_id is not null then
      if v_existing.outcome<>p_outcome or v_existing.request_reason_code is distinct from p_reason_code
        or v_existing.requested_retry_after_seconds is distinct from p_retry_after_seconds then
        raise exception using errcode='23505',message='NOTIFICATION_DELIVERY_SETTLE_CONFLICT';
      end if;
      perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
      return private.notification_delivery_target_projection(p_target_id);
    end if;
    v_target:=private.assert_notification_delivery_fence(p_target_id,p_lease_version,p_claim_digest);
    if not exists(select 1 from private.notification_delivery_permits where attempt_id=v_attempt.id) then
      raise exception using errcode='40001',message='NOTIFICATION_DELIVERY_PERMIT_REQUIRED';
    end if;
    if p_outcome='accepted' then
      v_result:=private.finish_notification_delivery_target(p_target_id,v_attempt.id,'delivered','accepted',null,null,p_reason_code,p_retry_after_seconds);
    elsif p_outcome='endpoint_gone' then
      perform private.retire_notification_delivery_subscription(v_target.subscription_id,v_target.subscription_revision_id,'endpoint_gone',v_now);
      v_result:=private.finish_notification_delivery_target(p_target_id,v_attempt.id,'suppressed','endpoint_gone','ENDPOINT_GONE',null,p_reason_code,p_retry_after_seconds);
    elsif p_outcome='payload_rejected' then
      v_result:=private.finish_notification_delivery_target(p_target_id,v_attempt.id,'dead_letter','payload_rejected','PAYLOAD_REJECTED',null,p_reason_code,p_retry_after_seconds);
    elsif p_outcome='provider_configuration_error' then
      v_result:=private.finish_notification_delivery_target(p_target_id,v_attempt.id,'operator_blocked','provider_configuration_error','PROVIDER_CONFIGURATION_ERROR',null,p_reason_code,p_retry_after_seconds);
      v_result:=v_result||jsonb_build_object('stopBatch',true);
    else
      v_delay:=least(3600,30*(2^(v_target.lease_version-1))::integer)
        +(get_byte(extensions.digest(convert_to(v_target.id::text||':'||v_target.lease_version::text,'UTF8'),'sha256'),0)%16);
      if p_retry_after_seconds is not null then v_delay:=greatest(v_delay,p_retry_after_seconds); end if;
      if v_target.lease_version>=8 then
        v_result:=private.finish_notification_delivery_target(p_target_id,v_attempt.id,'dead_letter','retryable','RETRY_EXHAUSTED',null,p_reason_code,p_retry_after_seconds);
      else
        v_retry_at:=v_now+make_interval(secs=>v_delay);
        v_result:=private.finish_notification_delivery_target(p_target_id,v_attempt.id,'retry','retryable',p_reason_code,v_retry_at,p_reason_code,p_retry_after_seconds);
      end if;
    end if;
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
    return v_result;
  exception when others then
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true); raise;
  end;
end $$;

create function public.resume_blocked_notification_deliveries(p_limit integer default 10)
returns integer language plpgsql security definer set search_path='' as $$
declare v_job record; v_target private.notification_delivery_targets; v_count integer:=0;
  v_job_count integer; v_job_status text; v_now timestamptz:=clock_timestamp();
  v_previous text:=current_setting('app.notification_delivery_writer_mode',true);
begin
  if p_limit is null or p_limit not between 1 and 10 then
    raise exception using errcode='22023',message='NOTIFICATION_DELIVERY_RESUME_INVALID';
  end if;
  perform set_config('app.notification_delivery_writer_mode','typed_v1',true);
  begin
    -- One resume owns job selection globally, then takes target rows before the
    -- parent row. This matches target->job settlement order and prevents two
    -- resumptions from splitting one blocked fanout or deadlocking each other.
    perform pg_advisory_xact_lock(hashtextextended('notification-delivery:resume:v1',0));
    for v_job in
      select j.outbox_id from private.notification_delivery_jobs j
      where j.status='operator_blocked' order by j.updated_at,j.outbox_id limit p_limit
    loop
      select count(*) into v_job_count from private.notification_delivery_targets t
      where t.outbox_id=v_job.outbox_id and t.status in ('pending','claimed','retry','operator_blocked');
      if v_job_count=0 or v_count+v_job_count>p_limit then continue; end if;
      perform t.id from private.notification_delivery_targets t
      where t.outbox_id=v_job.outbox_id and t.status in ('pending','claimed','retry','operator_blocked')
      order by t.id for update;
      select j.status into v_job_status from private.notification_delivery_jobs j
      where j.outbox_id=v_job.outbox_id for update;
      if v_job_status<>'operator_blocked' then continue; end if;
      v_now:=clock_timestamp();
      for v_target in
        select * from private.notification_delivery_targets t
        where t.outbox_id=v_job.outbox_id and t.status in ('pending','claimed','retry','operator_blocked')
        order by t.id
      loop
        if v_target.lease_version>=8 then
          update private.notification_delivery_targets set status='dead_letter',claim_digest=null,
            lease_expires_at=null,terminal_at=v_now,reason_code='RETRY_EXHAUSTED',updated_at=v_now
            where id=v_target.id;
          perform private.append_notification_delivery_event(v_target.outbox_id,v_target.id,'dead_letter','RETRY_EXHAUSTED');
        else
          update private.notification_delivery_targets set status='retry',claim_digest=null,
            lease_expires_at=null,next_attempt_at=v_now,terminal_at=null,reason_code=null,updated_at=v_now
            where id=v_target.id;
          perform private.append_notification_delivery_event(v_target.outbox_id,v_target.id,'resumed',null);
        end if;
        v_count:=v_count+1;
      end loop;
      perform private.refresh_notification_delivery_job(v_job.outbox_id);
    end loop;
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true); return v_count;
  exception when others then perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true); raise; end;
end $$;

create function public.record_notification_delivery_heartbeat(
  p_status text,p_claimed integer,p_delivered integer,p_retrying integer,p_suppressed integer,
  p_dead_letter integer,p_blocked integer,p_deferred integer,p_error_code text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=clock_timestamp(); v_previous text:=current_setting('app.notification_delivery_writer_mode',true);
begin
  if p_status is null or p_status not in ('succeeded','degraded','failed')
    or p_claimed is null or p_claimed not between 0 and 10
    or p_delivered is null or p_delivered not between 0 and 10
    or p_retrying is null or p_retrying not between 0 and 10
    or p_suppressed is null or p_suppressed not between 0 and 10
    or p_dead_letter is null or p_dead_letter not between 0 and 10
    or p_blocked is null or p_blocked not between 0 and 10
    or p_deferred is null or p_deferred not between 0 and 10
    or (p_status='succeeded' and (p_error_code is not null or p_retrying+p_dead_letter+p_blocked+p_deferred>0))
    or (p_status='failed' and p_error_code is distinct from 'NOTIFICATION_DELIVERY_FAILED')
    or (p_status='degraded' and p_error_code is not null and p_error_code<>'PROVIDER_CONFIGURATION_ERROR') then
    raise exception using errcode='22023',message='NOTIFICATION_DELIVERY_HEARTBEAT_INVALID';
  end if;
  perform set_config('app.notification_delivery_writer_mode','typed_v1',true);
  begin
    insert into private.notification_delivery_heartbeat(singleton,status,claimed,delivered,retrying,suppressed,dead_letter,blocked,deferred,error_code,recorded_at)
    values(true,p_status,p_claimed,p_delivered,p_retrying,p_suppressed,p_dead_letter,p_blocked,p_deferred,p_error_code,v_now)
    on conflict(singleton) do update set status=excluded.status,claimed=excluded.claimed,delivered=excluded.delivered,
      retrying=excluded.retrying,suppressed=excluded.suppressed,dead_letter=excluded.dead_letter,
      blocked=excluded.blocked,deferred=excluded.deferred,error_code=excluded.error_code,recorded_at=excluded.recorded_at;
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
    return jsonb_build_object('status',p_status,'recordedAt',v_now);
  exception when others then perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true); raise; end;
end $$;

create function public.purge_notification_delivery_history(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_attempts integer:=0; v_events integer:=0; v_previous text:=current_setting('app.notification_delivery_writer_mode',true);
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode='22023',message='NOTIFICATION_DELIVERY_PURGE_INVALID';
  end if;
  perform set_config('app.notification_delivery_writer_mode','purge_v1',true);
  begin
    with doomed as (
      select a.id from private.notification_delivery_attempts a
      join private.notification_delivery_attempt_results r on r.attempt_id=a.id
      join private.notification_delivery_targets t on t.id=a.target_id
      where r.completed_at<clock_timestamp()-interval '90 days'
        and t.status in ('delivered','suppressed','dead_letter')
      order by r.completed_at,a.id limit p_limit for update of a skip locked
    ), deleted_permits as (
      delete from private.notification_delivery_permits p using doomed d where p.attempt_id=d.id
    ), deleted_results as (
      delete from private.notification_delivery_attempt_results r using doomed d where r.attempt_id=d.id
    ), deleted_attempts as (
      delete from private.notification_delivery_attempts a using doomed d where a.id=d.id returning a.id
    ) select count(*) into v_attempts from deleted_attempts;
    with doomed as (
      select e.id from private.notification_delivery_events e
      where e.occurred_at<clock_timestamp()-interval '90 days'
        and exists(select 1 from private.notification_delivery_jobs j where j.outbox_id=e.outbox_id
          and j.status in ('completed','suppressed','dead_letter'))
      order by e.occurred_at,e.id limit p_limit for update skip locked
    ), deleted as (delete from private.notification_delivery_events e using doomed d where e.id=d.id returning e.id)
    select count(*) into v_events from deleted;
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
    return jsonb_build_object('attempts',v_attempts,'events',v_events);
  exception when others then perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true); raise; end;
end $$;

create function public.get_developer_notification_delivery_status(p_actor_profile_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_h private.notification_delivery_heartbeat%rowtype; v_due integer; v_retry integer;
  v_dead integer; v_job_only_dead integer; v_blocked integer; v_expired integer;
  v_pending_jobs integer; v_oldest timestamptz;
  v_oldest_job timestamptz; v_status text; v_now timestamptz:=clock_timestamp();
begin
  perform private.assert_active_developer(p_actor_profile_id);
  select * into v_h from private.notification_delivery_heartbeat where singleton=true;
  select least(count(*) filter(where status in ('pending','retry') and next_attempt_at<=v_now),1000)::integer,
    min(next_attempt_at) filter(where status in ('pending','retry') and next_attempt_at<=v_now),
    least(count(*) filter(where status='retry'),1000)::integer,
    least(count(*) filter(where status='dead_letter'),1000)::integer,
    least(count(*) filter(where status='operator_blocked'),1000)::integer,
    least(count(*) filter(where status='claimed' and lease_expires_at<=v_now),1000)::integer
  into v_due,v_oldest,v_retry,v_dead,v_blocked,v_expired
  from private.notification_delivery_targets where status in ('pending','retry','claimed','dead_letter','operator_blocked');
  select least(count(*),1000)::integer,min(o.enqueued_at)
  into v_pending_jobs,v_oldest_job from private.notification_delivery_jobs j
  join private.notification_delivery_outbox o on o.id=j.outbox_id where j.status='pending';
  select least(count(*),1000)::integer into v_job_only_dead
  from private.notification_delivery_jobs j where j.status='dead_letter'
    and not exists(select 1 from private.notification_delivery_targets t where t.outbox_id=j.outbox_id);
  v_due:=least(1000,v_due+v_pending_jobs);
  v_oldest:=case when v_oldest is null then v_oldest_job when v_oldest_job is null then v_oldest else least(v_oldest,v_oldest_job) end;
  v_status:=case when v_h.singleton is null then 'awaiting_first_run'
    when v_h.status='failed' then 'failed'
    when v_h.recorded_at<v_now-interval '5 minutes' or v_dead>0 or v_job_only_dead>0
      or v_blocked>0 or v_expired>0
      or (v_oldest is not null and v_oldest<v_now-interval '5 minutes') then 'degraded'
    when v_h.status='degraded' then 'degraded' else 'healthy' end;
  return jsonb_build_object('status',v_status,'lastHeartbeat',case when v_h.singleton is null then null else jsonb_build_object(
    'status',v_h.status,'claimed',v_h.claimed,'delivered',v_h.delivered,'retrying',v_h.retrying,
    'suppressed',v_h.suppressed,'deadLetter',v_h.dead_letter,'blocked',v_h.blocked,'deferred',v_h.deferred,
    'errorCode',v_h.error_code,'recordedAt',v_h.recorded_at) end,
    'backlog',jsonb_build_object('due',v_due,'retrying',v_retry,'deadLetter',v_dead,
      'jobOnlyDeadLetter',v_job_only_dead,'blocked',v_blocked,'expiredLeases',v_expired,
      'oldestDueAt',v_oldest),'checkedAt',v_now);
end $$;

do $$ declare f regprocedure; begin
  foreach f in array array[
    'public.claim_notification_deliveries(text,integer)'::regprocedure,
    'public.get_notification_delivery_envelope(uuid,integer,text)'::regprocedure,
    'public.permit_notification_delivery(uuid,integer,text,uuid)'::regprocedure,
    'public.settle_notification_delivery(uuid,integer,text,text,text,integer)'::regprocedure,
    'public.resume_blocked_notification_deliveries(integer)'::regprocedure,
    'public.record_notification_delivery_heartbeat(text,integer,integer,integer,integer,integer,integer,integer,text)'::regprocedure,
    'public.purge_notification_delivery_history(integer)'::regprocedure,
    'public.get_developer_notification_delivery_status(uuid)'::regprocedure
  ] loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;

do $$ declare f regprocedure; begin
  foreach f in array array[
    'private.guard_notification_delivery_mutable()'::regprocedure,
    'private.guard_notification_delivery_append_only()'::regprocedure,
    'private.append_notification_delivery_event(uuid,uuid,text,text)'::regprocedure,
    'private.enqueue_notification_delivery_job()'::regprocedure,
    'private.notification_delivery_target_projection(uuid)'::regprocedure,
    'private.refresh_notification_delivery_job(uuid)'::regprocedure,
    'private.finish_notification_delivery_target(uuid,uuid,text,text,text,timestamptz,text,integer)'::regprocedure,
    'private.retire_notification_delivery_subscription(uuid,uuid,text,timestamptz)'::regprocedure,
    'private.assert_notification_delivery_fence(uuid,integer,text)'::regprocedure
  ] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f); end loop;
end $$;

comment on table private.notification_delivery_jobs is '#111 immutable outbox intent companion; first fanout snapshot never expands for later subscriptions.';
comment on table private.notification_delivery_targets is '#111 exact subscription/version/revision target with 2 minute fenced lease and max 8 attempts.';
comment on table private.notification_delivery_attempts is '#111 append-only attempt starts. Provider calls are at-least-once after fenced permit.';
comment on function public.permit_notification_delivery(uuid,integer,text,uuid) is '#111 exact-current send authorization linearization point. A concurrent retire immediately afterward may allow at most one old-endpoint send.';
comment on function public.purge_notification_delivery_history(integer) is '#111 bounded terminal attempt/result/event retention after 90 days. Scheduling remains #112.';
