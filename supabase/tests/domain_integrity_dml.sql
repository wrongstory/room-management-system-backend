begin;

insert into auth.users (id) values
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004');

insert into public.profiles (
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status
) values
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '검증 관리자', '검증 관리자', '검증 관리자', '검증 관리자', 0, 'admin', 'active'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '검증 메이드1', '검증 메이드1', '검증 메이드1', '검증 메이드1', 0, 'maid', 'active'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000003',
    '검증 메이드2', '검증 메이드2', '검증 메이드2', '검증 메이드2', 0, 'maid', 'active'
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000004',
    '비활성 메이드', '비활성 메이드', '비활성 메이드', '비활성 메이드', 0, 'maid', 'inactive'
  );

insert into public.reservations (
  id, room_id, check_in_at, check_out_at, guest_count, created_by, updated_by
) values
  (
    '30000000-0000-4000-8000-000000000001',
    (select id from public.rooms where room_number = '117'),
    '2027-01-01 15:00:00+09', '2027-01-02 11:00:00+09', 2,
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    (select id from public.rooms where room_number = '117'),
    '2027-01-02 15:00:00+09', '2027-01-03 11:00:00+09', 2,
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    (select id from public.rooms where room_number = '117'),
    '2027-01-03 15:00:00+09', '2027-01-04 11:00:00+09', 2,
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
  );

insert into public.cleaning_targets (
  id, room_id, reservation_id, cleaning_kind, source, source_key,
  original_service_date, effective_service_date,
  room_type_snapshot, fee_snapshot, template_snapshot, created_by
) values
  (
    '40000000-0000-4000-8000-000000000001',
    (select id from public.rooms where room_number = '117'),
    '30000000-0000-4000-8000-000000000001',
    'checkout', 'scheduled_checkout', 'test:reservation:1:checkout',
    '2027-01-02', '2027-01-02', '{}'::jsonb, 16000, '{}'::jsonb,
    '20000000-0000-4000-8000-000000000001'
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    (select id from public.rooms where room_number = '117'),
    '30000000-0000-4000-8000-000000000002',
    'checkout', 'scheduled_checkout', 'test:reservation:2:checkout',
    '2027-01-03', '2027-01-03', '{}'::jsonb, 16000, '{}'::jsonb,
    '20000000-0000-4000-8000-000000000001'
  );

do $$
begin
  if (
    select count(*) from public.cleaning_targets
    where room_id = (select id from public.rooms where room_number = '117')
  ) <> 2 then
    raise exception 'MULTIPLE_FUTURE_TARGETS_NOT_ALLOWED';
  end if;
end;
$$;

do $$
begin
  begin
    insert into public.cleaning_targets (
      room_id, reservation_id, cleaning_kind, source, source_key,
      original_service_date, effective_service_date,
      room_type_snapshot, fee_snapshot, template_snapshot, created_by
    ) values (
      (select id from public.rooms where room_number = '117'),
      '30000000-0000-4000-8000-000000000001',
      'checkout', 'manual_checkout', 'test:reservation:1:manual-checkout',
      '2027-01-02', '2027-01-02', '{}'::jsonb, 16000, '{}'::jsonb,
      '20000000-0000-4000-8000-000000000001'
    );
    raise exception 'DUPLICATE_CHECKOUT_TARGET_ACCEPTED';
  exception when unique_violation then
    null;
  end;
end;
$$;

do $$
begin
  begin
    insert into public.cleaning_targets (
      room_id, reservation_id, cleaning_kind, source, source_key,
      original_service_date, effective_service_date,
      room_type_snapshot, fee_snapshot, template_snapshot, created_by
    ) values (
      (select id from public.rooms where room_number = '135'),
      '30000000-0000-4000-8000-000000000003',
      'checkout', 'scheduled_checkout', 'test:wrong-room',
      '2027-01-02', '2027-01-02', '{}'::jsonb, 16000, '{}'::jsonb,
      '20000000-0000-4000-8000-000000000001'
    );
    raise exception 'RESERVATION_ROOM_MISMATCH_ACCEPTED';
  exception when foreign_key_violation then
    null;
  end;
end;
$$;

insert into public.cleaning_assignments (
  id, cleaning_target_id, maid_profile_id, sequence_number, revision, changed_by
) values
  (
    '50000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002', 1, 1,
    '20000000-0000-4000-8000-000000000001'
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002', 1, 1,
    '20000000-0000-4000-8000-000000000001'
  );

do $$
begin
  begin
    insert into public.cleaning_assignments (
      cleaning_target_id, maid_profile_id, sequence_number, revision, changed_by
    ) values (
      '40000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000004', 2, 2,
      '20000000-0000-4000-8000-000000000001'
    );
    raise exception 'INACTIVE_MAID_ASSIGNMENT_ACCEPTED';
  exception when check_violation then
    null;
  end;
end;
$$;

insert into public.cleaning_attempts (
  id, cleaning_target_id, assignment_id, maid_profile_id,
  attempt_number, assignment_revision, template_snapshot, room_snapshot
) values (
  '60000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  1, 1, '{}'::jsonb, '{}'::jsonb
);

do $$
begin
  begin
    insert into public.cleaning_attempts (
      cleaning_target_id, assignment_id, maid_profile_id,
      attempt_number, assignment_revision, template_snapshot, room_snapshot
    ) values (
      '40000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      1, 1, '{}'::jsonb, '{}'::jsonb
    );
    raise exception 'ATTEMPT_ASSIGNMENT_MISMATCH_ACCEPTED';
  exception when foreign_key_violation then
    null;
  end;
end;
$$;

update public.cleaning_assignments
set maid_profile_id = '20000000-0000-4000-8000-000000000003'
where id = '50000000-0000-4000-8000-000000000002';

insert into public.cleaning_attempts (
  id, cleaning_target_id, assignment_id, maid_profile_id,
  attempt_number, assignment_revision, template_snapshot, room_snapshot
) values (
  '60000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
  1, 1, '{}'::jsonb, '{}'::jsonb
);

do $$
begin
  begin
    insert into public.cleaning_submissions (
      cleaning_attempt_id, client_submission_id, version,
      photo_manifest, submitted_by
    ) values (
      '60000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000001', 1, '{}'::jsonb,
      '20000000-0000-4000-8000-000000000003'
    );
    raise exception 'SUBMISSION_MAID_MISMATCH_ACCEPTED';
  exception when foreign_key_violation then
    null;
  end;
end;
$$;

insert into public.cleaning_submissions (
  id, cleaning_attempt_id, client_submission_id, version,
  photo_manifest, submitted_by
) values (
  '70000000-0000-4000-8000-000000000002',
  '60000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000002', 1, '{}'::jsonb,
  '20000000-0000-4000-8000-000000000002'
);

do $$
begin
  begin
    insert into public.earnings (
      earning_entitlement_id, submission_id, maid_profile_id,
      earned_on, base_amount, bomb_room_bonus
    ) values (
      '80000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003',
      '2027-01-02', 16000, 0
    );
    raise exception 'EARNING_MAID_MISMATCH_ACCEPTED';
  exception when foreign_key_violation then
    null;
  end;
end;
$$;

do $$
begin
  begin
    insert into public.earnings (
      earning_entitlement_id, submission_id, maid_profile_id,
      earned_on, base_amount, bomb_room_bonus
    ) values (
      '80000000-0000-4000-8000-000000000002',
      '70000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002',
      '2027-01-02', 16000, 5000
    );
    raise exception 'INVALID_BOMB_BONUS_ACCEPTED';
  exception when check_violation then
    null;
  end;
end;
$$;

insert into public.earnings (
  id, earning_entitlement_id, submission_id, maid_profile_id,
  earned_on, base_amount, bomb_room_bonus
) values (
  '80000000-0000-4000-8000-000000000003',
  '80000000-0000-4000-8000-000000000003',
  '70000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000002',
  '2027-01-02', 16000, 16000
);

insert into public.payroll_cycles (
  id, maid_profile_id, week_start
) values (
  '90000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '2026-12-28'
);

insert into public.payroll_items (
  payroll_cycle_id, earning_id, maid_profile_id, locked_amount
) values (
  '90000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000002', 1
);

update public.payroll_cycles
set status = 'paying',
    locked_amount = 32000,
    payment_started_by = '20000000-0000-4000-8000-000000000001',
    payment_started_at = now()
where id = '90000000-0000-4000-8000-000000000001';

do $$
begin
  if (
    select locked_amount from public.payroll_items
    where earning_id = '80000000-0000-4000-8000-000000000003'
  ) <> 32000 then
    raise exception 'PAYROLL_ITEM_AMOUNT_NOT_DERIVED';
  end if;
end;
$$;

do $$
begin
  begin
    update public.payroll_cycles
    set status = 'open',
        locked_amount = null,
        payment_started_by = null,
        payment_started_at = null,
        version = version + 1
    where id = '90000000-0000-4000-8000-000000000001';
    raise exception 'PAYROLL_REOPEN_WITHOUT_REASON_ACCEPTED';
  exception when check_violation then
    null;
  end;
end;
$$;

update public.payroll_cycles
set status = 'open',
    locked_amount = null,
    payment_started_by = null,
    payment_started_at = null,
    last_reopen_reason = 'transfer_not_sent',
    last_reopened_by = '20000000-0000-4000-8000-000000000001',
    last_reopened_at = now(),
    version = version + 1
where id = '90000000-0000-4000-8000-000000000001';

update public.payroll_cycles
set status = 'paying',
    locked_amount = 32000,
    payment_started_by = '20000000-0000-4000-8000-000000000001',
    payment_started_at = now()
where id = '90000000-0000-4000-8000-000000000001';

update public.payroll_cycles
set status = 'check',
    check_reason = 'transfer_result_unknown'
where id = '90000000-0000-4000-8000-000000000001';

update public.payroll_cycles
set status = 'open',
    locked_amount = null,
    payment_started_by = null,
    payment_started_at = null,
    check_reason = null,
    last_reopen_reason = 'bank_confirmed_not_sent',
    last_reopened_by = '20000000-0000-4000-8000-000000000001',
    last_reopened_at = now(),
    version = version + 1
where id = '90000000-0000-4000-8000-000000000001';

update public.payroll_cycles
set status = 'paying',
    locked_amount = 32000,
    payment_started_by = '20000000-0000-4000-8000-000000000001',
    payment_started_at = now()
where id = '90000000-0000-4000-8000-000000000001';

update public.payroll_cycles
set status = 'paid', paid_at = now()
where id = '90000000-0000-4000-8000-000000000001';

do $$
begin
  begin
    update public.payroll_cycles
    set status = 'open',
        locked_amount = null,
        payment_started_by = null,
        payment_started_at = null,
        paid_at = null,
        last_reopen_reason = 'must_not_reopen_paid',
        last_reopened_by = '20000000-0000-4000-8000-000000000001',
        last_reopened_at = now(),
        version = version + 1
    where id = '90000000-0000-4000-8000-000000000001';
    raise exception 'PAID_PAYROLL_REOPEN_ACCEPTED';
  exception when object_not_in_prerequisite_state then
    null;
  end;
end;
$$;

do $$
begin
  begin
    update public.payroll_cycles
    set locked_amount = 64000
    where id = '90000000-0000-4000-8000-000000000001';
    raise exception 'PAID_PAYROLL_AMOUNT_REWRITE_ACCEPTED';
  exception when object_not_in_prerequisite_state then
    null;
  end;
end;
$$;

do $$
begin
  begin
    insert into public.payroll_items (
      payroll_cycle_id, earning_id, maid_profile_id, locked_amount
    ) values (
      '90000000-0000-4000-8000-000000000001',
      '80000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000002', 32000
    );
    raise exception 'PAID_PAYROLL_ITEM_INSERT_ACCEPTED';
  exception when object_not_in_prerequisite_state then
    null;
  end;
end;
$$;

insert into public.payroll_cycles (
  id, maid_profile_id, week_start
) values (
  '90000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000002',
  '2027-01-04'
);

do $$
begin
  begin
    insert into public.payroll_items (
      payroll_cycle_id, earning_id, maid_profile_id, locked_amount
    ) values (
      '90000000-0000-4000-8000-000000000002',
      '80000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000002', 32000
    );
    raise exception 'WRONG_WEEK_EARNING_ACCEPTED';
  exception when check_violation then
    null;
  end;
end;
$$;

set constraints all immediate;

do $$
begin
  begin
    update public.payroll_items
    set locked_amount = 1
    where earning_id = '80000000-0000-4000-8000-000000000003';
    raise exception 'PAYROLL_ITEM_MUTATION_ACCEPTED';
  exception when object_not_in_prerequisite_state then
    null;
  end;
end;
$$;

insert into public.cleaning_targets (
  id, room_id, cleaning_kind, source, source_key,
  reclean_of_attempt_id, reclean_maid_profile_id,
  original_service_date, effective_service_date,
  room_type_snapshot, fee_snapshot, template_snapshot, created_by
) values (
  '40000000-0000-4000-8000-000000000003',
  (select id from public.rooms where room_number = '117'),
  'reclean', 'inspection_reclean', 'test:inspection-reclean:1',
  '60000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '2027-01-02', '2027-01-02', '{}'::jsonb, 0, '{}'::jsonb,
  '20000000-0000-4000-8000-000000000001'
);

do $$
begin
  begin
    insert into public.cleaning_assignments (
      cleaning_target_id, maid_profile_id, sequence_number, revision, changed_by
    ) values (
      '40000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000003', 2, 1,
      '20000000-0000-4000-8000-000000000001'
    );
    raise exception 'RECLEAN_REASSIGNMENT_ACCEPTED';
  exception when check_violation then
    null;
  end;
end;
$$;

do $$
begin
  begin
    update public.cleaning_targets
    set reclean_of_attempt_id = '60000000-0000-4000-8000-000000000002',
        reclean_maid_profile_id = '20000000-0000-4000-8000-000000000003'
    where id = '40000000-0000-4000-8000-000000000003';
    raise exception 'RECLEAN_ORIGIN_RETARGET_ACCEPTED';
  exception when object_not_in_prerequisite_state then
    null;
  end;
end;
$$;

rollback;

select '1..17';
select format('ok %s - %s', test_number, description)
from (
  values
    (1, 'same room accepts checkout targets for separate reservations'),
    (2, 'same reservation rejects a second checkout target'),
    (3, 'target room must match reservation room'),
    (4, 'inactive maid cannot be assigned'),
    (5, 'attempt must match assignment target maid and revision'),
    (6, 'submission author must match attempt maid'),
    (7, 'earning owner must match submission maid'),
    (8, 'bomb-room bonus must equal zero or base amount'),
    (9, 'payroll item amount is derived and immutable'),
    (10, 'payroll reopen requires a recorded reason actor and time'),
    (11, 'paying payroll can reopen after an unsent transfer is recorded'),
    (12, 'check payroll can reopen after an unsent transfer is confirmed'),
    (13, 'paid payroll cannot reopen'),
    (14, 'inspection reclean stays with the original maid'),
    (15, 'inspection reclean origin cannot be retargeted'),
    (16, 'paid payroll membership and amount are immutable'),
    (17, 'earning date must belong to the payroll week')
) as passed_checks(test_number, description);
