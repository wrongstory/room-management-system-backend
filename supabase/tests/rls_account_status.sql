begin;

insert into auth.users (id) values
  ('11000000-0000-4000-8000-000000000001'),
  ('11000000-0000-4000-8000-000000000002'),
  ('11000000-0000-4000-8000-000000000003');

insert into public.profiles (
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status
) values
  (
    '21000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000001',
    '활성 관리자', '활성 관리자', '활성 관리자', '활성 관리자', 0, 'admin', 'active'
  ),
  (
    '21000000-0000-4000-8000-000000000002',
    '11000000-0000-4000-8000-000000000002',
    '비활성화 대기 관리자', '비활성화 대기 관리자',
    '비활성화 대기 관리자', '비활성화 대기 관리자', 0, 'admin', 'deactivation_pending'
  ),
  (
    '21000000-0000-4000-8000-000000000003',
    '11000000-0000-4000-8000-000000000003',
    '업로드 전용 메이드', '업로드 전용 메이드',
    '업로드 전용 메이드', '업로드 전용 메이드', 0, 'maid', 'upload_only'
  );

insert into public.reservations (
  id, room_id, check_in_at, check_out_at, guest_count, created_by, updated_by
) values (
  '31000000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number = '117'),
  '2027-02-01 16:00:00+09', '2027-02-02 11:00:00+09', 2,
  '21000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001'
);

set local role authenticated;

select '1..11';

select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000001', true);

select case
  when private.current_profile_id() = '21000000-0000-4000-8000-000000000001'::uuid
    then 'ok 1 - active account resolves its profile'
  else 'not ok 1 - active account resolves its profile'
end;

select case
  when private.current_role() = 'admin'::public.app_role
    then 'ok 2 - active administrator resolves the admin role'
  else 'not ok 2 - active administrator resolves the admin role'
end;

select case
  when (select count(*) from public.reservations) = 1
    then 'ok 3 - active administrator can read reservations'
  else 'not ok 3 - active administrator can read reservations'
end;

select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000002', true);

select case
  when private.current_profile_id() is null
    then 'ok 4 - deactivation-pending account has no general profile capability'
  else 'not ok 4 - deactivation-pending account has no general profile capability'
end;

select case
  when private.current_role() is null
    then 'ok 5 - deactivation-pending administrator has no admin role capability'
  else 'not ok 5 - deactivation-pending administrator has no admin role capability'
end;

select case
  when (select count(*) from public.reservations) = 0
    then 'ok 6 - deactivation-pending administrator cannot read reservations'
  else 'not ok 6 - deactivation-pending administrator cannot read reservations'
end;

select case
  when (select count(*) from public.profiles) = 0
    then 'ok 7 - deactivation-pending administrator cannot read profiles'
  else 'not ok 7 - deactivation-pending administrator cannot read profiles'
end;

select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000003', true);

select case
  when private.current_profile_id() is null
    then 'ok 8 - upload-only account has no general profile capability'
  else 'not ok 8 - upload-only account has no general profile capability'
end;

select case
  when (select count(*) from public.rooms) = 0
    then 'ok 9 - upload-only account cannot use general room reads'
  else 'not ok 9 - upload-only account cannot use general room reads'
end;

select case
  when has_column_privilege('authenticated', 'public.notifications', 'read_at', 'UPDATE')
    then 'ok 10 - recipients can update notification read_at'
  else 'not ok 10 - recipients can update notification read_at'
end;

select case
  when not has_column_privilege('authenticated', 'public.notifications', 'resolved_at', 'UPDATE')
    then 'ok 11 - recipients cannot update notification resolved_at'
  else 'not ok 11 - recipients cannot update notification resolved_at'
end;

reset role;
rollback;
