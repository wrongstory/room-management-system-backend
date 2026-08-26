import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const initialMigrationUrl = new URL(
  '../supabase/migrations/20260825141441_initial_core_schema.sql',
  import.meta.url
);

const hardeningMigrationUrl = new URL(
  '../supabase/migrations/20260825163315_harden_data_api_grants.sql',
  import.meta.url
);

describe('initial migration contract', () => {
  it('seeds 121 unique room numbers', async () => {
    const sql = await readFile(initialMigrationUrl, 'utf8');
    const catalogSection = sql.slice(sql.indexOf('with catalog('), sql.indexOf('insert into public.rooms'));
    const roomNumbers = [...catalogSection.matchAll(/\('([0-9]+)','(?:standard|premium|oceanPremium|oceanFamily)'/g)]
      .map((match) => match[1]);

    expect(roomNumbers).toHaveLength(121);
    expect(new Set(roomNumbers).size).toBe(121);
  });

  it('enables RLS for every public base table', async () => {
    const sql = await readFile(initialMigrationUrl, 'utf8');
    const tables = [...sql.matchAll(/create table public\.([a-z_]+)/g)].map((match) => match[1]);
    const rlsTables = [...sql.matchAll(/alter table public\.([a-z_]+) enable row level security/g)]
      .map((match) => match[1]);

    expect(new Set(rlsTables)).toEqual(new Set(tables));
  });

  it('keeps business state mutations behind the server command boundary', async () => {
    const sql = await readFile(initialMigrationUrl, 'utf8');
    const authenticatedGrants = sql.slice(
      sql.indexOf('revoke all privileges on all tables in schema public'),
      sql.indexOf('-- The backend secret')
    );

    expect(authenticatedGrants).not.toMatch(/grant (insert|delete)\b/);
    expect(authenticatedGrants).not.toContain('grant update on');
    expect(authenticatedGrants).toContain(
      'grant update (read_at, resolved_at) on public.notifications to authenticated'
    );
    expect(sql).not.toContain('auth.role()');
    expect(sql).not.toContain('user_metadata');
    expect(sql).toContain(
      'revoke all privileges on all tables in schema public from anon, authenticated'
    );
  });

  it('stores only Drive photo metadata with a 300 KiB and seven-day policy', async () => {
    const sql = await readFile(initialMigrationUrl, 'utf8');
    const authenticatedGrants = sql.slice(
      sql.indexOf('revoke all privileges on all tables in schema public'),
      sql.indexOf('-- The backend secret')
    );

    expect(sql).toContain('drive_file_id text not null unique');
    expect(sql).toContain('size_bytes > 0 and size_bytes <= 307200');
    expect(sql).toContain("new.purge_after = new.uploaded_at + interval '7 days'");
    expect(sql).not.toContain('insert into storage.buckets');
    expect(authenticatedGrants).not.toContain('public.submission_photos');
  });

  it('hardens existing projects that auto-expose Data API privileges', async () => {
    const sql = await readFile(hardeningMigrationUrl, 'utf8');

    expect(sql).toContain('revoke all on schema public from public, anon, authenticated');
    expect(sql).toContain('revoke all privileges on all tables in schema public');
    expect(sql).toContain('alter default privileges for role postgres in schema public');
    expect(sql).toContain('drop policy if exists notifications_read_scoped');
    expect(sql).toContain('create policy notifications_read_scoped');
  });
});
