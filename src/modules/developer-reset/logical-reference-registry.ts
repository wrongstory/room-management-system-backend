import { requestHash } from '../../lib/command.js';

export type LogicalReferenceRule = Readonly<{
  relation: string;
  path: string;
  semantics: 'CURRENT_POINTER' | 'HISTORICAL_SNAPSHOT' | 'EXTERNAL_LOCATOR';
  codec: 'uuid' | 'json-object' | 'provider-id' | 'room-number' | 'folder-room' | 'file-name';
  nullable: boolean;
  variants: readonly string[];
  targets: Readonly<Record<string, string>>;
  source: string;
}>;

// This finite source registry is not a discovery query or a deletion allowlist.
// Whole historical JSON fields retain every original nested field; they are never
// hydrated against current rows, rewritten, or promoted to current authority.
const rules: LogicalReferenceRule[] = [];
function add(relation: string, paths: readonly string[], semantics: LogicalReferenceRule['semantics'],
  codec: LogicalReferenceRule['codec'], source: string, nullable = false,
  variants: readonly string[] = [], targets: Readonly<Record<string, string>> = {}) {
  for (const path of paths) rules.push(Object.freeze({ relation, path, semantics, codec, nullable,
    variants: Object.freeze([...variants]), targets: Object.freeze({ ...targets }), source }));
}
const base = '20260825141441_initial_core_schema.sql';
const photos = '20260908180643_photo_drive_upload_read.sql';
const collection = '20260916090000_extra_proof_photo_collection.sql';
const schedule = '20261002101126_assignment_reservation_schedule_snapshot.sql';
const naming = '20261004184937_photo_storage_names.sql';
const postApproval = '20261005023103_post_approval_room_issue_ledger.sql';
add('private.developer_catalog_previews', ['entity_id'], 'CURRENT_POINTER', 'uuid',
  '20260920144042_developer_room_catalog_capacity.sql', false,
  ['room_type_capacity', 'room_deactivation'],
  { room_type_capacity: 'public.room_types', room_deactivation: 'public.rooms' });
// The resource pair is immutable sensitive-read history. An old reservation ID
// must not be resolved into a new current reservation or silently erased.
add('private.actor_activity_events', ['resource_id'], 'HISTORICAL_SNAPSHOT', 'uuid',
  '20260831124140_actor_activity_audit_contract.sql', true, ['reservation']);
add('public.cleaning_targets', ['room_type_snapshot'], 'HISTORICAL_SNAPSHOT', 'json-object', base);
add('public.cleaning_attempts', ['room_snapshot'], 'HISTORICAL_SNAPSHOT', 'json-object', base);
add('public.cleaning_target_schedule_revisions', ['reservation_schedule_snapshot'], 'HISTORICAL_SNAPSHOT', 'json-object', schedule, true);
add('public.cleaning_assignments', ['notified_reservation_schedule_snapshot'], 'HISTORICAL_SNAPSHOT', 'json-object', schedule, true);
add('private.photo_collection_commands', ['photo_item_id'], 'HISTORICAL_SNAPSHOT', 'uuid', collection);
add('private.photo_collection_commands', ['response_payload'], 'HISTORICAL_SNAPSHOT', 'json-object', collection);
// post_approval_room_issue_reports actor provenance participates in the existing
// five-column FK; that collector owns its closure, not this non-FK registry.
add('private.photo_drive_identities', ['provider_file_id', 'provider_folder_id'], 'EXTERNAL_LOCATOR', 'provider-id', photos);
add('private.photo_drive_folder_identities', ['provider_folder_id', 'parent_folder_id'], 'EXTERNAL_LOCATOR', 'provider-id', photos);
add('private.post_approval_issue_provider_objects', ['provider_file_id', 'provider_folder_id'], 'EXTERNAL_LOCATOR', 'provider-id', postApproval, true);
add('public.submission_photos', ['drive_file_id', 'drive_folder_id'], 'EXTERNAL_LOCATOR', 'provider-id', base);
add('private.photo_drive_identities', ['room_number'], 'HISTORICAL_SNAPSHOT', 'room-number', photos);
add('private.photo_drive_folder_identities', ['scope_room_number'], 'HISTORICAL_SNAPSHOT', 'folder-room', photos);
add('private.photo_storage_names', ['room_number'], 'HISTORICAL_SNAPSHOT', 'room-number', naming);
add('private.photo_storage_names', ['file_name'], 'EXTERNAL_LOCATOR', 'file-name', naming);

export const RESET_LOGICAL_REFERENCE_RULES: readonly LogicalReferenceRule[] = Object.freeze(
  rules.sort((a, b) => `${a.relation}:${a.path}` < `${b.relation}:${b.path}` ? -1 : 1),
);
export const RESET_LOGICAL_REFERENCE_REGISTRY_FINGERPRINT = requestHash({
  version: '396-logical-references-v1', rules: RESET_LOGICAL_REFERENCE_RULES,
  // The seven template paths remain exclusively owned by the existing 129
  // collector and summarizeResetTemplateEvidence, with their policy blockers.
  templateOwner: 'reset-template-inventory-v1',
});

export function findResetLogicalReferenceRule(relation: string, path: string) {
  return RESET_LOGICAL_REFERENCE_RULES.find(rule => rule.relation === relation && rule.path === path);
}
