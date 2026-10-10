begin isolation level repeatable read;
select plan(1);
select is(public.get_active_auth_context(null,null),jsonb_build_object('code','AUTH_CONTEXT_UNAVAILABLE'),
  'transaction-old snapshot is infrastructure denial, not missing profile');
select * from finish();
rollback;
