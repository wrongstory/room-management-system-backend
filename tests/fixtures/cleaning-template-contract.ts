// Synthetic wire fixtures shared by Fastify, Edge, JSON Schema and client generation.
export const flatTemplateRequest = {
  roomTypeCode: 'standard', cleaningKind: 'checkout', expectedVersion: 0,
  slots: [
    { slotKey: 'cleaning-proof', displayOrder: 0, required: true, label: '청소 사진', maxPhotos: 20 },
    { slotKey: 'bomb-proof', displayOrder: 1, required: false, label: '폭탄방 증빙', maxPhotos: 10 },
    { slotKey: 'issue-proof', displayOrder: 2, required: false, label: '특이사항 증빙', maxPhotos: 10 }
  ]
};

export function invalidFlatTemplateRequests() {
  const change = (patch: Record<string, unknown>, index = 0) => ({
    ...structuredClone(flatTemplateRequest),
    slots: flatTemplateRequest.slots.map((slot, i) => i === index ? { ...slot, ...patch } : { ...slot })
  });
  return [
    ['missing slot', { ...flatTemplateRequest, slots: flatTemplateRequest.slots.slice(0, 2) }],
    ['extra slot', { ...flatTemplateRequest, slots: [...flatTemplateRequest.slots, flatTemplateRequest.slots[0]] }],
    ['duplicate key', change({ slotKey: 'bomb-proof' })],
    ['wrong key', change({ slotKey: 'extra-proof' }, 2)],
    ['required cleaning', change({ required: false })],
    ['optional bomb', change({ required: true }, 1)],
    ['optional issue', change({ required: true }, 2)],
    ['duplicate order', change({ displayOrder: 1 })],
    ['order gap', change({ displayOrder: 3 }, 2)],
    ['swapped roles', { ...flatTemplateRequest, slots: flatTemplateRequest.slots.map((slot, i) => ({ ...slot, displayOrder: i === 0 ? 1 : i === 1 ? 0 : 2 })) }],
    ['cleaning capacity', change({ maxPhotos: 19 })],
    ['bomb capacity', change({ maxPhotos: 20 }, 1)],
    ['issue capacity', change({ maxPhotos: 9 }, 2)],
    ['missing capacity', change({ maxPhotos: undefined })],
    ['invalid version', { ...flatTemplateRequest, expectedVersion: -1 }]
  ] as const;
}

export function historicalTemplateRequest(roomTypeCode = 'standard', legacy = false) {
  const count = ({ standard: 9, premium: 10, oceanPremium: 12, oceanFamily: 14 }[roomTypeCode] ?? 9) + Number(legacy);
  return {
    roomTypeCode, cleaningKind: 'checkout', expectedVersion: 0,
    slots: Array.from({ length: count }, (_, displayOrder) => ({
      slotKey: displayOrder === 0 ? 'tv-on' : displayOrder === 1 ? 'entry-storage' :
        displayOrder === count - 1 ? 'extra-proof' : `slot-${displayOrder}`,
      displayOrder, required: displayOrder < count - 1, label: `사진 ${displayOrder + 1}`,
      ...(legacy ? {} : { maxPhotos: displayOrder === count - 1 ? 10 : 1 })
    }))
  };
}

export function templateProjection(slots = flatTemplateRequest.slots, version = 9) {
  return {
    id: '30000000-0000-4000-8000-000000000001', version, status: 'published',
    durationMinutes: null, slots, publishedAt: '2030-01-01T00:00:00Z', createdAt: '2030-01-01T00:00:00Z'
  };
}
