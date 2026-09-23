import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertLocalSyntheticTarget,
  assertManifestSafe,
  assertMigrationMatchesSource,
  assertSafeOutputRoot,
  publishSuccessfulRun,
  pruneExpiredSuccessfulRuns,
  sha256File,
  validateDataDump,
  validateRolesDump,
  validateSchemaDump,
  verifyArtifactHashes,
} from '../scripts/lib/backup-recovery-dry-run.mjs';

describe('backup recovery dry-run safety', () => {
  it('accepts only the explicit local synthetic target and local .tmp output root', () => {
    const root = resolve('C:/workspace/project');
    expect(() => assertLocalSyntheticTarget('local-synthetic')).not.toThrow();
    expect(() => assertLocalSyntheticTarget('production')).toThrow('BACKUP_TARGET_NOT_LOCAL_SYNTHETIC');
    expect(assertSafeOutputRoot(root, resolve(root, '.tmp/backup-recovery/run'))).toBe(
      resolve(root, '.tmp/backup-recovery/run'),
    );
    expect(() => assertSafeOutputRoot(root, resolve(root, 'backups'))).toThrow(
      'BACKUP_OUTPUT_OUTSIDE_LOCAL_TMP',
    );
  });

  it('allows app schema dumps and protected-schema references inside functions or foreign keys', () => {
    const source = `
      CREATE SCHEMA IF NOT EXISTS "private";
      CREATE SCHEMA IF NOT EXISTS "public";
      CREATE TABLE "public"."profiles" ("id" uuid, "auth_user_id" uuid);
      ALTER TABLE ONLY "public"."profiles" ADD CONSTRAINT "profiles_user_fk"
        FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id");
      CREATE FUNCTION "public"."logout"() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN DELETE FROM auth.sessions; END;
      $$;
    `;
    expect(() => validateSchemaDump(source)).not.toThrow();
  });

  it('rejects top-level protected schema changes and protected data copies', () => {
    expect(() =>
      validateSchemaDump(
        'CREATE SCHEMA IF NOT EXISTS "private"; CREATE SCHEMA IF NOT EXISTS "public"; CREATE TABLE auth.users(id uuid);',
      ),
    ).toThrow('BACKUP_SCHEMA_TOUCHES_PROTECTED_SCHEMA:auth');
    expect(() =>
      validateSchemaDump(
        'CREATE SCHEMA IF NOT EXISTS "private"; CREATE SCHEMA IF NOT EXISTS "public"; DROP SCHEMA auth;',
      ),
    ).toThrow('BACKUP_SCHEMA_TOUCHES_PROTECTED_SCHEMA:auth');
    expect(() =>
      validateSchemaDump(
        'CREATE SCHEMA IF NOT EXISTS "private"; CREATE SCHEMA IF NOT EXISTS "public"; GRANT USAGE ON SCHEMA "vault" TO authenticated;',
      ),
    ).toThrow('BACKUP_SCHEMA_TOUCHES_PROTECTED_SCHEMA:vault');
    expect(() => validateDataDump('COPY "auth"."users" ("id") FROM stdin;\n\\.')).toThrow(
      'BACKUP_DATA_SCHEMA_NOT_ALLOWED:auth',
    );
  });

  it('allows only bounded local role settings', () => {
    expect(() =>
      validateRolesDump(`
        SET client_encoding = 'UTF8';
        ALTER ROLE "anon" SET "statement_timeout" TO '3s';
        ALTER ROLE "authenticated" SET "statement_timeout" TO '8s';
        RESET ALL;
      `),
    ).not.toThrow();
    expect(() => validateRolesDump('ALTER ROLE "postgres" PASSWORD \'secret\';')).toThrow(
      'BACKUP_ROLES_COMMAND_NOT_ALLOWED',
    );
  });

  it('fails closed when an artifact is changed after the manifest is written', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'rms-backup-hash-'));
    const filePath = resolve(directory, 'schema.sql');
    await writeFile(filePath, 'safe', 'utf8');
    const manifest = {
      artifacts: [{ file: 'schema.sql', bytes: 4, sha256: await sha256File(filePath) }],
    };
    await expect(verifyArtifactHashes(directory, manifest)).resolves.toBeUndefined();
    await writeFile(filePath, 'tampered', 'utf8');
    await expect(verifyArtifactHashes(directory, manifest)).rejects.toThrow(
      'BACKUP_ARTIFACT_SIZE_MISMATCH:schema.sql',
    );
  });

  it('fails closed when the source migration history is missing or stale', () => {
    expect(() =>
      assertMigrationMatchesSource(
        { count: 81, name: 'room_operations_pagination', version: '20260923121000' },
        { totalCount: 81, head: 'room_operations_pagination' },
        '20260923121000',
      ),
    ).not.toThrow();
    expect(() =>
      assertMigrationMatchesSource(
        { count: 80, name: 'inspection_queue_pagination', version: '20260923020000' },
        { totalCount: 81, head: 'room_operations_pagination' },
        '20260923121000',
      ),
    ).toThrow('BACKUP_MIGRATION_COUNT_MISMATCH');
  });

  it('does not replace the last success pointer when publication validation fails', async () => {
    const outputRoot = await mkdtemp(resolve(tmpdir(), 'rms-backup-publish-'));
    const staging = resolve(outputRoot, '.staging-test');
    await mkdir(staging);
    const artifactPath = resolve(staging, 'schema.sql');
    await writeFile(artifactPath, 'safe', 'utf8');
    await writeFile(resolve(staging, 'manifest.json'), '{}\n', 'utf8');
    await writeFile(resolve(outputRoot, 'latest-success.json'), '{"stable":true}\n', 'utf8');
    const manifest = {
      artifacts: [{ file: 'schema.sql', bytes: 7, sha256: await sha256File(artifactPath) }],
    };

    await expect(
      publishSuccessfulRun({ outputRoot, stagingDirectory: staging, manifest }),
    ).rejects.toThrow('BACKUP_ARTIFACT_SIZE_MISMATCH:schema.sql');
    await expect(readFile(resolve(outputRoot, 'latest-success.json'), 'utf8')).resolves.toBe(
      '{"stable":true}\n',
    );
  });

  it('keeps credential and guest fields out of manifest metadata', () => {
    expect(() => assertManifestSafe({ target: 'local-synthetic', artifacts: [] })).not.toThrow();
    expect(() => assertManifestSafe({ guestName: 'fixture' })).toThrow(
      'BACKUP_MANIFEST_FORBIDDEN_KEY:guestName',
    );
    expect(() => assertManifestSafe({ endpoint: 'postgresql://example.invalid/db' })).toThrow(
      'BACKUP_MANIFEST_CONTAINS_CREDENTIAL_MATERIAL',
    );
  });

  it('removes only successful artifacts older than 15 days', async () => {
    const outputRoot = await mkdtemp(resolve(tmpdir(), 'rms-backup-retention-'));
    const oldSuccess = resolve(outputRoot, 'success-old');
    const recentSuccess = resolve(outputRoot, 'success-recent');
    const failed = resolve(outputRoot, 'failed-old');
    await Promise.all([mkdir(oldSuccess), mkdir(recentSuccess), mkdir(failed)]);
    await writeFile(
      resolve(oldSuccess, 'manifest.json'),
      JSON.stringify({ completedAt: '2026-08-01T00:00:00.000Z' }),
    );
    await writeFile(
      resolve(recentSuccess, 'manifest.json'),
      JSON.stringify({ completedAt: '2026-09-20T00:00:00.000Z' }),
    );
    await writeFile(
      resolve(failed, 'manifest.json'),
      JSON.stringify({ completedAt: '2026-08-01T00:00:00.000Z' }),
    );

    await expect(pruneExpiredSuccessfulRuns(outputRoot, new Date('2026-09-23T00:00:00.000Z'))).resolves.toEqual([
      'success-old',
    ]);
    await expect(readFile(resolve(recentSuccess, 'manifest.json'), 'utf8')).resolves.toContain('2026-09-20');
    await expect(readFile(resolve(failed, 'manifest.json'), 'utf8')).resolves.toContain('2026-08-01');
  });
});
