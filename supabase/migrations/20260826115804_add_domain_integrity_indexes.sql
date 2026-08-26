-- Cover the composite foreign keys added by harden_domain_integrity and keep
-- the otherwise server-only login alias table protected by an explicit policy.

create index cleaning_targets_reservation_room_idx
on public.cleaning_targets (reservation_id, room_id)
where reservation_id is not null;

create index cleaning_targets_reclean_attempt_maid_idx
on public.cleaning_targets (reclean_of_attempt_id, reclean_maid_profile_id)
where reclean_of_attempt_id is not null;

create index cleaning_attempts_assignment_contract_idx
on public.cleaning_attempts (
  assignment_id,
  cleaning_target_id,
  maid_profile_id,
  assignment_revision
);

create index cleaning_submissions_attempt_maid_idx
on public.cleaning_submissions (cleaning_attempt_id, submitted_by);

create index earnings_submission_maid_idx
on public.earnings (submission_id, maid_profile_id);

create index payroll_items_cycle_maid_idx
on public.payroll_items (payroll_cycle_id, maid_profile_id);

create index payroll_items_earning_maid_idx
on public.payroll_items (earning_id, maid_profile_id);

create policy login_aliases_read_scoped on public.login_aliases
for select to authenticated
using (
  profile_id = (select private.current_profile_id())
  or (select private.current_role()) = 'admin'
);
