import { defineConfig } from 'vitest/config';

// Only the approved Full DB fixture runner invokes this config. The filename
// deliberately does not match Vitest's normal application test discovery.
export default defineConfig({ test: {
  include: ['scripts/fixtures/migration-readonly/atomic-pg.fixture.mjs'],
  environment: 'node', fileParallelism: false, maxWorkers: 1,
  testTimeout: 20000, hookTimeout: 10000,
} });
