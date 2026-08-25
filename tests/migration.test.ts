import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../supabase/migrations/20260825141441_initial_core_schema.sql',
  import.meta.url
);

describe('initial migration contract', () => {
  it('seeds 121 unique room numbers', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const catalogSection = sql.slice(sql.indexOf('with catalog('), sql.indexOf('insert into public.rooms'));
    const roomNumbers = [...catalogSection.matchAll(/\('([0-9]+)','(?:standard|premium|oceanPremium|oceanFamily)'/g)]
      .map((match) => match[1]);

    expect(roomNumbers).toHaveLength(121);
    expect(new Set(roomNumbers).size).toBe(121);
  });

  it('enables RLS for every public base table', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const tables = [...sql.matchAll(/create table public\.([a-z_]+)/g)].map((match) => match[1]);
    const rlsTables = [...sql.matchAll(/alter table public\.([a-z_]+) enable row level security/g)]
      .map((match) => match[1]);

    expect(new Set(rlsTables)).toEqual(new Set(tables));
  });
});
