import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const migration = read('supabase/migrations/20261106002729_availability_change_notifications.sql');
const regression = read('supabase/tests/availability_notifications.sql');
describe('availability notification source preparation (DB NOT RUN)', () => {
  it.each([15, 17])('parses migration and rollback-only SQL fixture with PostgreSQL %i grammar', async version => {
    const parser = require(`@pgsql/parser/v${version}`);
    expect((await parser.parse(migration)).stmts.length).toBeGreaterThan(10);
    expect((await parser.parse(regression)).stmts.length).toBeGreaterThan(25);
    expect((await parser.parse(read('supabase/migrations/20261106010813_all_notification_device_push.sql'))).stmts.length).toBe(5);
    expect((await parser.parse(read('ops/notification-delivery/activate.sql'))).stmts.length).toBe(5);
    expect(regression.trim()).toMatch(/^begin;[\s\S]*rollback;$/);
  });
  it('pins the appended migration and limits new private functions to their owner', () => {
    const manifest = JSON.parse(read('supabase/migration-manifest.dev.json'));
    expect(manifest.migrations[150]).toEqual({order:151,name:'availability_change_notifications',sha256:createHash('sha256').update(migration).digest('hex')});
    expect(migration).toContain('from public,anon,authenticated,service_role');
    expect(migration).not.toMatch(/grant\s|update public\.availability|delete from|insert into public\.notifications/i);
    expect(migration).toContain('request.status::text=p_phase');
    expect(migration).toContain('private.emit_notification_v1(');
    expect(migration).toContain('private.resolve_notifications_v1(');
  });
});
