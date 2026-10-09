import { projectPhotoUploadOperation } from '../../src/modules/photos/photo-upload-contract.js';

const id = (n: number) => `41000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const empty = {
  operationId: id(1), objectId: id(2), attemptId: id(3), targetSlotId: id(4),
  photoItemId: null, leaseVersion: 1, leaseExpiresAt: null, photoId: null,
  photoVersion: null, collectionRevision: null, itemRevision: null,
  uploadedAt: null, purgeAfter: null, retentionPolicy: null, retentionStartsAt: null,
  expiresAt: null, purgedAt: null, mediaAvailability: null, compensationAllowed: false,
};
const retained = {
  uploadedAt: '2037-01-01T00:00:00+00:00', retentionPolicy: 'cleaning_submission',
  retentionStartsAt: null, expiresAt: null, purgeAfter: null, mediaAvailability: 'available',
};
export function photoOperationRetentionCases() {
  return [
    ...['reserved', 'reconciliation_pending'].map(status => ({ name: `${status}-null`, input: { ...empty, status } })),
    ...['reserved', 'reconciliation_pending', 'provider_succeeded', 'accepted', 'compensation_pending', 'compensated']
      .map(status => ({ name: `${status}-retained`, input: {
        ...empty, ...retained, status,
        photoId: status === 'accepted' ? id(5) : null,
        photoVersion: status === 'accepted' ? 1 : null,
        compensationAllowed: status === 'compensation_pending',
      } })),
  ].map(({ name, input }) => ({ name, body: projectPhotoUploadOperation(input) }));
}
