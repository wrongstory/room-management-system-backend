-- #325: authoritative current maid-wide adjustment CAS version. The requested
-- week is validated display context, never a second adjustment-book identity.
-- Existing profile/book PKs and adjustment (maid_profile_id, book_version)
-- unique index cover these point/existence reads; no new table/index is needed.
-- Existing entries, immutable creation versions, command locks and receipts are
-- deliberately unchanged. This read neither materializes nor locks a book.
create function public.get_payroll_adjustment_book(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_maid_profile_id uuid,
  p_week_start date
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  actor public.profiles;
  evaluated_at timestamptz:=statement_timestamp();
  current_version bigint;
begin
  select * into actor from public.profiles where id=p_actor_profile_id;
  if not found or actor.role<>'admin' or actor.status<>'active' then
    raise exception using errcode='42501',message='ADMIN_REQUIRED';
  end if;
  if actor.must_change_password then
    raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED';
  end if;
  if p_session_id is null or not exists(
    select 1 from auth.sessions session
    where session.id=p_session_id and session.user_id=actor.auth_user_id
      and (session.not_after is null or session.not_after>evaluated_at)
  ) then
    raise exception using errcode='42501',message='SESSION_REVOKED';
  end if;

  if p_week_start is null or not isfinite(p_week_start)
    or extract(year from p_week_start) not between 1 and 9999 then
    raise exception using errcode='22023',message='PAYROLL_WEEK_MUST_START_MONDAY';
  end if;
  perform private.assert_readable_payroll_week(p_week_start);
  -- Former/inactive maids' historical ledgers remain readable by an admin.
  if not exists(select 1 from public.profiles maid
    where maid.id=p_maid_profile_id and maid.role='maid') then
    raise exception using errcode='P0002',message='PAYROLL_MAID_NOT_FOUND';
  end if;

  select book.version into current_version from public.payroll_adjustment_books book
    where book.maid_profile_id=p_maid_profile_id;
  if not found then
    -- A real initial book is version 0. Never guess 0 or reconstruct a version
    -- from old row creation versions if existing history has lost its book.
    if exists(select 1 from public.payroll_adjustments adjustment
      where adjustment.maid_profile_id=p_maid_profile_id) then
      raise exception using errcode='23514',message='PAYROLL_ADJUSTMENT_BOOK_INVARIANT_VIOLATION';
    end if;
    current_version:=0;
  end if;
  if current_version is null or current_version<0 or current_version>9007199254740991 then
    raise exception using errcode='23514',message='PAYROLL_ADJUSTMENT_BOOK_INVARIANT_VIOLATION';
  end if;
  return jsonb_build_object('maidProfileId',p_maid_profile_id,
    'weekStart',to_char(p_week_start,'YYYY-MM-DD'),'currentBookVersion',current_version);
end $$;

revoke all on function public.get_payroll_adjustment_book(uuid,uuid,uuid,date)
  from public,anon,authenticated,service_role;
grant execute on function public.get_payroll_adjustment_book(uuid,uuid,uuid,date) to service_role;
