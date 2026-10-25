import { createHash } from 'node:crypto';
import { RESET_RELATION_GROUPS } from './reset-relation-classification.mjs';

// Investigation requirements, never delete dispositions or an execution allowlist.
// Every mixed/review relation is named explicitly; new tables cannot inherit a rule.
const groups = [
  { code: 'ACCOUNT_SECURITY', required: ['DEVELOPER_PRESERVATION', 'AUTH_DRAIN', 'ROW_FK_CLOSURE', 'BACKUP_SCOPE'], relations: [
    'public.profiles', 'public.login_aliases', 'private.auth_password_versions',
    'private.password_change_commands', 'private.password_reset_auth_markers',
    'private.password_verification_rate_limits', 'private.developer_catalog_previews',
    'private.developer_diagnostic_rate_limits', 'private.login_rate_limit_windows',
    'private.actor_activity_aggregates', 'private.actor_activity_events',
    'private.actor_authorization_denial_aggregates', 'private.command_executions', 'public.audit_events',
  ] },
  { code: 'ROOM_AND_RESERVATION', required: ['ROOM_BASELINE_PRESERVATION', 'ROW_FK_CLOSURE', 'BACKUP_SCOPE', 'WORKER_DRAIN'], relations: [
    'public.rooms', 'private.assignment_activation_scan_cursor', 'private.assignment_unavailability_cancellations',
    'private.preparation_proof_usages', 'private.reservation_room_move_events', 'private.reservation_stays',
    'private.room_display_status_overrides', 'private.room_occupancy_corrections',
    'private.stay_room_segments', 'private.stay_segment_checkout_obligations', 'private.scheduler_invocation_heartbeats',
  ] },
  { code: 'WORK_AUTHORIZATION', required: ['SESSION_REVOCATION', 'ROW_FK_CLOSURE', 'BACKUP_SCOPE', 'WORKER_DRAIN'], relations: [
    'private.attempt_capability_grants', 'private.attempt_capability_revocations', 'private.attempt_capability_session_roots',
    'private.attempt_handover_events', 'private.limited_session_eligibility', 'private.limited_session_roots',
    'private.offline_completion_events', 'private.offline_event_resolutions',
    'private.offline_work_lease_revocations', 'private.offline_work_leases',
  ] },
  { code: 'NOTIFICATION_DELIVERY', required: ['WORKER_DRAIN', 'ROW_FK_CLOSURE', 'BACKUP_SCOPE', 'NO_EXTERNAL_DELIVERY'], relations: [
    'private.cleaning_overdue_events', 'private.cleaning_overdue_recipients', 'private.cleaning_overdue_scan_cursor',
    'private.complaint_response_attention_events', 'private.complaint_response_attention_recipients',
    'private.complaint_response_attention_scan_cursor', 'private.notification_delivery_attempt_results',
    'private.notification_delivery_attempts', 'private.notification_delivery_events', 'private.notification_delivery_heartbeat',
    'private.notification_delivery_jobs', 'private.notification_delivery_outbox', 'private.notification_delivery_permits',
    'private.notification_delivery_targets', 'private.notification_groups', 'private.notification_outbox',
    'private.web_push_registration_limits', 'private.web_push_subscription_events', 'private.web_push_subscription_revisions',
    'private.web_push_subscription_secrets', 'private.web_push_subscriptions',
  ] },
  { code: 'PAYROLL_HISTORY', required: ['IMMUTABLE_HISTORY_PROTECTION', 'ROW_FK_CLOSURE', 'BACKUP_SCOPE'], relations: [
    'private.payroll_payment_projection_transitions', 'private.payroll_remittance_marker_revisions', 'private.payroll_remittance_markers',
  ] },
  { code: 'PIN_AND_SHEET', required: ['NONCE_REGISTRY_PRESERVATION', 'ROW_FK_CLOSURE', 'BACKUP_SCOPE', 'SHEET_REIMPORT_BOUNDARY', 'WORKER_DRAIN'], relations: [
    'private.room_current_pin', 'private.room_pin_access_scheduled_revocations', 'private.room_pin_assignment_entitlements',
    'private.room_pin_change_leases', 'private.room_pin_reveal_leases', 'private.room_pin_revisions',
    'private.room_pin_sheet_full_resync_items', 'private.room_pin_sheet_full_resync_runs',
    'private.room_pin_sheet_sync_heartbeat', 'private.room_pin_sheet_sync_outbox', 'private.room_pin_sheet_sync_worker_state',
  ] },
  { code: 'PHOTO_AND_EVIDENCE', required: ['PHOTO_DELETION_ON_HOLD', 'PROVIDER_IDENTITY_PRESERVATION', 'ROW_FK_CLOSURE', 'BACKUP_SCOPE', 'WORKER_DRAIN'], relations: [
    'private.attempt_photo_changes', 'private.attempt_photo_collection_changes', 'private.attempt_photo_collection_items',
    'private.attempt_photo_collection_states', 'private.attempt_photo_current', 'private.attempt_photo_purge_states',
    'private.attempt_photo_versions', 'private.attempt_room_issue_reports', 'private.bomb_room_decisions',
    'private.bomb_room_report_evidence', 'private.bomb_room_report_seals', 'private.bomb_room_reports',
    'private.flat_evidence_migration_receipts', 'private.photo_cleanup_events', 'private.photo_collection_commands',
    'private.photo_drive_folder_bindings', 'private.photo_drive_folder_identities', 'private.photo_drive_identities',
    'private.photo_folder_purge_jobs', 'private.photo_orphan_purge_jobs', 'private.photo_provider_identity_tombstones',
    'private.photo_provider_objects', 'private.photo_purge_heartbeat', 'private.photo_purge_jobs', 'private.photo_quota_pending',
    'private.photo_retention_links', 'private.photo_retention_records', 'private.photo_storage_names',
    'private.photo_storage_quota_snapshot', 'private.photo_upload_acceptances', 'private.photo_upload_admission_bindings',
    'private.photo_upload_admission_limits', 'private.photo_upload_admissions', 'private.photo_upload_batches', 'private.photo_upload_batch_members',
    'private.photo_upload_events',
    'private.photo_upload_operations', 'private.photo_upload_rate_limits', 'private.photo_upload_states',
    'private.post_approval_issue_collections', 'private.post_approval_issue_delete_barriers',
    'private.post_approval_issue_evidence_acceptances', 'private.post_approval_issue_evidence_items',
    'private.post_approval_issue_folder_bindings', 'private.post_approval_issue_identity_tombstones',
    'private.post_approval_issue_provider_objects', 'private.post_approval_issue_purge_jobs', 'private.post_approval_issue_purge_scan',
    'private.post_approval_issue_quota_pending', 'private.post_approval_issue_quota_permit_uses', 'private.post_approval_issue_quota_permits',
    'private.post_approval_issue_quota_refreshes', 'private.post_approval_issue_report_closures', 'private.post_approval_issue_report_seals',
    'private.post_approval_issue_upload_admissions', 'private.post_approval_issue_upload_events', 'private.post_approval_issue_upload_handovers',
    'private.post_approval_issue_upload_operations', 'private.post_approval_issue_upload_states', 'private.post_approval_room_issue_draft_revisions',
    'private.post_approval_room_issue_drafts', 'private.post_approval_room_issue_reports',
    'private.submission_current_pointers', 'private.submission_photo_binding_sets', 'private.submission_photo_bindings',
    'private.target_photo_slot_snapshots', 'private.target_photo_snapshot_contracts',
  ] },
];
const expected = [...RESET_RELATION_GROUPS.mixed, ...RESET_RELATION_GROUPS.review].sort();
const actual = groups.flatMap((group) => group.relations).sort();
if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error('RESET_REVIEW_COVERAGE_MISMATCH');
}
export const RESET_REVIEW_REQUIREMENTS = Object.freeze(groups.map((group) => Object.freeze({ ...group,
  required: Object.freeze(group.required), relations: Object.freeze(group.relations),
})));

export function summarizeResetReviewRequirements() {
  return {
    version: '396-review-dependencies-v1', relationCount: expected.length,
    requirementsFingerprint: createHash('sha256').update(JSON.stringify(RESET_REVIEW_REQUIREMENTS)).digest('hex'),
    groups: RESET_REVIEW_REQUIREMENTS.map((group) => ({ code: group.code, relationCount: group.relations.length, required: [...group.required] })),
    // Naming a dependency does not satisfy it or approve a destructive policy.
    classificationComplete: false, executionEnabled: false,
  };
}
