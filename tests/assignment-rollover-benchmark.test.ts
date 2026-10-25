import { describe, expect, it } from 'vitest';
import { fixture, legacy, optimized } from '../scripts/benchmark-assignment-rollover.js';

describe('offline assignment rollover cost fixture', () => {
  it.each([[1, 1, false], [100, 10, false], [1000, 10, false], [1000, 1000, true]] as const)(
    'preserves results and inputs for %i cards, %i revisions, shared=%s', (cards, revisions, shared) => {
      const input = fixture(cards, revisions, shared);
      const before = JSON.stringify(input);
      expect(optimized(input)).toEqual(legacy(input));
      expect(JSON.stringify(input)).toBe(before);
      expect(input.requests).toHaveLength(cards);
      expect(input.rows).toHaveLength(shared ? revisions : cards * revisions);
    });
});
