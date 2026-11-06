-- 2026-11-06 user decision: every notification category is eligible for PC/phone Web Push.
-- Only new events use this policy. No inbox/outbox backfill, recipient changes, replay or Cron activation.
drop trigger notification_event_catalog_immutable on private.notification_event_catalog;
update private.notification_event_catalog set push_eligible=true where event_family in (
 'inspection.original_approved',
 'inspection.reclean_approved',
 'inspection.complaint_rework_approved',
 'inspection.complaint_rework_rejected',
 'complaint.received',
 'complaint.corrected',
 'complaint.acknowledged',
 'complaint.closed',
 'payroll.adjustment_recorded',
 'payroll.adjustment_reversed',
 'payroll.late_earning_carried',
 'payroll.payment_started',
 'payroll.offset_settled',
 'payroll.payment_check_recorded',
 'payroll.payment_paid',
 'payroll.payment_reopened');
alter table private.notification_event_catalog add constraint notification_all_families_push_eligible check (push_eligible);
comment on constraint notification_all_families_push_eligible on private.notification_event_catalog is
 'Every notification family is push eligible; active account/session/subscription and existing self-action guard remain required.';
create trigger notification_event_catalog_immutable before update or delete on private.notification_event_catalog
for each row execute function private.guard_notification_catalog_ledgers();
