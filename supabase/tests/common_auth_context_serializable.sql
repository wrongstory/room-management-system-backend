begin isolation level serializable;
select plan(1);
select is(public.get_active_auth_context(null,null),jsonb_build_object('code','AUTH_CONTEXT_UNAVAILABLE'),
  'serializable also cannot authorize from transaction-old snapshot');
select * from finish();
rollback;
