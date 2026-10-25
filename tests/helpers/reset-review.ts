import { createResetSnapshotBuilder, type ResetSnapshotSource } from '../../src/modules/developer-reset/snapshot-builder.js';
import { RESET_LOGICAL_REFERENCE_RULES } from '../../src/modules/developer-reset/logical-reference-registry.js';
import { RESET_TEMPLATE_REFERENCE_PATHS } from '../../src/modules/developer-reset/reset-template-evidence.js';
import { resetReviewStatementId } from '../../src/modules/developer-reset/review-composition.js';

export const reviewId = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
export const reviewScope = 'd'.repeat(64);
export const reviewStatementAt = '2026-10-25 01:02:03.123456+00';
export const reviewDbSnapshot = '100:200:110,112';
const statementId = resetReviewStatementId(reviewDbSnapshot, reviewStatementAt);
const typed = (name: string, value: string | null, pgType = 'pg_catalog.text') => ({ name, value, pgType });
export async function* reviewStream<T>(values: T[]) { for (const value of values) yield value; }
type Row = { scopeId: string; relation: string; key: ReturnType<typeof typed>[]; values: ReturnType<typeof typed>[];
  disposition: 'keep' | 'remove' | 'roomBaseline' | 'templateSource' | 'unresolved';
  references: { constraint: string; targetKey: ReturnType<typeof typed>[] | null; sourceNulls: boolean[] }[] };
export function resetReviewFixture() {
  const columns = new Map<string, Map<string, string>>();
  const add = (relation: string, names: Record<string, string> = {}) => {
    const cols = columns.get(relation) ?? new Map([['id', 'pg_catalog.uuid']]);
    for (const [name, type] of Object.entries(names)) cols.set(name, `pg_catalog.${type}`);
    columns.set(relation, cols);
  };
  for (const s of RESET_LOGICAL_REFERENCE_RULES) add(s.relation, { [s.path]: s.codec === 'json-object' ? 'jsonb' : s.codec === 'uuid' ? 'uuid' : 'text' });
  for (const [relation, path] of RESET_TEMPLATE_REFERENCE_PATHS) add(relation, { [path.split('.')[0] ?? '']: path.includes('.') ? 'jsonb' : 'uuid' });
  add('public.profiles', { auth_user_id: 'uuid', role: 'text', status: 'text', must_change_password: 'bool' }); add('auth.users');
  add('public.rooms'); add('public.room_types');
  add('private.developer_catalog_previews', { preview_kind: 'text', actor_profile_id: 'uuid' });
  add('private.actor_activity_events', { resource_type: 'text', actor_profile_id: 'uuid' });
  add('public.cleaning_template_versions', { room_type_id: 'uuid', cleaning_kind: 'text', duration_minutes: 'int4',
    photo_slots: 'jsonb', status: 'text', version: 'int4', created_by: 'uuid', created_at: 'timestamptz' });
  add('private.photo_template_slots', { template_version_id: 'uuid', slot_snapshot: 'jsonb' });
  add('private.developer_operation_control', { singleton: 'bool', target_ref: 'text', version: 'int8', lifecycle: 'text', maintenance: 'text' });
  add('private.developer_operation_admissions', { deadline_at: 'timestamptz', completed_at: 'timestamptz' });
  add('private.password_change_commands', { state: 'text', actor_profile_id: 'uuid' });
  add('private.password_reset_auth_markers', { state: 'text', actor_profile_id: 'uuid' });
  add('private.developer_reset_receipt_events', { receipt_id: 'uuid', sequence: 'int4' });
  columns.get('private.developer_reset_receipt_events')?.delete('id');
  const primary = (relation: string) => relation === 'private.developer_reset_receipt_events' ? ['receipt_id', 'sequence'] : ['id'];
  const rows: Row[] = [];
  const push = (relation: string, id: number, fields: Record<string, string | null>, disposition: Row['disposition'] = 'keep') => {
    const values = [...(columns.get(relation) ?? [])].map(([name, pgType]) => typed(name, name === 'id' ? reviewId(id) : fields[name] ?? null, pgType));
    rows.push({ scopeId: reviewScope, relation, key: values.filter(cell => primary(relation).includes(cell.name)), values, disposition, references: [] });
  };
  const slots = [{ slotKey: 'entry', displayOrder: 0, required: true, label: 'synthetic private slot' }];
  push('public.profiles', 1, { auth_user_id: reviewId(2), role: 'developer', status: 'active', must_change_password: 'false' }); push('auth.users', 2, {});
  push('public.rooms', 3, {}, 'roomBaseline'); push('public.room_types', 4, {});
  push('private.photo_drive_identities', 5, { provider_file_id: 'synthetic_file_secret', provider_folder_id: 'synthetic_folder_secret', room_number: '101' });
  push('public.cleaning_template_versions', 6, { room_type_id: reviewId(4), cleaning_kind: 'checkout', duration_minutes: '30',
    photo_slots: JSON.stringify(slots), status: 'published', version: '1', created_by: reviewId(1), created_at: '2026-01-01 00:00:00.123456+00' }, 'templateSource');
  push('private.photo_template_slots', 7, { template_version_id: reviewId(6), slot_snapshot: JSON.stringify(slots[0]) });
  push('public.cleaning_targets', 8, { template_snapshot: JSON.stringify({ id: reviewId(6) }), room_type_snapshot: JSON.stringify({ id: reviewId(4), label: 'synthetic history' }) });
  push('private.target_photo_slot_snapshots', 9, { template_version_id: reviewId(6) });
  const binding = { projectRef: 'a'.repeat(20), sourceCommit: 'b'.repeat(40), catalogFingerprint: 'c'.repeat(64), classificationFingerprint: 'e'.repeat(64) };
  const metadata = { binding, consistency: { kind: 'repeatable-read', transactionId: reviewScope },
    relations: [...columns].map(([relation, cols]) => ({ relation, columns: [...cols].map(([name, pgType]) => ({ name, pgType })), primaryKey: primary(relation) })),
    foreignKeys: [] as { source: string; target: string; name: string; sourceNullable: boolean[]; match: 's' | 'f'; validated: true }[] };
  const counts = RESET_TEMPLATE_REFERENCE_PATHS.map(([relation, path]) => {
    const sourceRows = rows.filter(r => r.relation === relation).length;
    return { relation, path, sourceRows, edgeRows: sourceRows, absent: 0, malformed: 0, detached: 0, matched: sourceRows };
  });
  const sidecar = { scopeId: reviewScope, statementId, statementAt: reviewStatementAt,
    templateEvidence: { format: 'reset-template-inventory-v1', snapshotId: statementId, templateCount: 1, slotCount: 1, orphanSlots: 0,
      templates: [{ sourceId: reviewId(6), status: 'published', cleaningKind: 'checkout', contentDigest: 'f'.repeat(64), slotRows: 1,
        historicallyReadable: true, registrationShapeValid: true, slotProjectionMatches: true, versionAvailable: true, currentPublicationPathSupported: true, creatorExists: true }], references: counts },
    gateEvidence: { format: 'developer-operation-gates-v1', lifecycle: 'UNKNOWN', controlVersion: null as string | null,
      maintenance: 'UNKNOWN', policyConfigured: false, unfinishedAdmissions: 0, expiredUnfinishedAdmissions: 0,
      unresolvedPasswordChanges: 0, preparedPasswordResets: 0, coverage: 'NOT_INTEGRATED', recentReauthentication: 'NOT_EVALUATED', executionEnabled: false } };
  const contents = rows.map(({ disposition: _d, references: _r, ...row }) => structuredClone(row));
  const census = metadata.relations.map(({ relation }) => ({ header: { scopeId: reviewScope, relation, count: contents.filter(r => r.relation === relation).length },
    contents: contents.filter(r => r.relation === relation) }));
  const request = { surfaces: RESET_LOGICAL_REFERENCE_RULES.map(({ relation, path }) => ({ relation, path })),
    templateSelection: 'CURRENT_PUBLISHED' as 'CURRENT_PUBLISHED' | 'ALL_VERSIONS' | null, developerId: reviewId(1) as string | null,
    receipt: { actorProfileId: reviewId(1), authUserId: reviewId(2), sessionDigest: '1'.repeat(64), passwordVersionDigest: '2'.repeat(64),
      expectedPostconditionFingerprint: '3'.repeat(64), policyHash: '4'.repeat(64), approvalScopeHash: '5'.repeat(64), backupProofHash: '6'.repeat(64),
      idempotencyKeyDigest: '7'.repeat(64), expiresAt: Date.now() + 60000, steps: [{ id: '8'.repeat(64), kind: 'DATABASE' as const }] } };
  const expected = structuredClone({ binding, relations: metadata.relations, foreignKeys: metadata.foreignKeys });
  const source: ResetSnapshotSource = { collect: async () => ({ metadata, rows: reviewStream(rows),
    census: reviewStream(census.map(c => ({ header: c.header, contents: reviewStream(c.contents) }))), review: sidecar }) };
  const refreshCensus = () => {
    for (const c of census) {
      c.contents = rows.filter(row => row.relation === c.header.relation).map(({ disposition: _d, references: _r, ...row }) => structuredClone(row));
      c.header.count = c.contents.length;
    }
  };
  return { rows, metadata, census, expected, sidecar, request, source, push,
    refreshCensus, run: () => createResetSnapshotBuilder(expected).buildReview(source, request) };
}
