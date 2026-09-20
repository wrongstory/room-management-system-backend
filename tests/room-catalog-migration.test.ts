import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../supabase/migrations/20260920092635_room_catalog_lifecycle.sql",
  import.meta.url,
);

describe("room catalog lifecycle migration", () => {
  it("is append-only, developer-controlled, bounded, and logical-delete only", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain(
      "add column catalog_status text not null default 'active'",
    );
    expect(sql).toContain("catalog_status in ('active','retired')");
    expect(sql).toContain(
      "raise exception using errcode='55000',message='ROOM_PHYSICAL_DELETE_FORBIDDEN'",
    );
    expect(sql).toContain(
      "create function public.list_developer_room_catalog(",
    );
    expect(sql).toContain("create function public.create_room_catalog_entry(");
    expect(sql).toContain("create function public.retire_room_catalog_entry(");
    expect(sql).toContain("active_count>=500");
    expect(sql).toContain("message='ROOM_CATALOG_ACTIVE_LIMIT_EXCEEDED'");
    expect(sql).toContain("p_limit<1 or p_limit>100");
    expect(sql).toContain("private.replay_command(");
    expect(sql).toContain("private.complete_command(");
    expect(sql).toContain("'room.catalog_created'");
    expect(sql).toContain("'room.catalog_retired'");
    expect(sql).not.toMatch(/delete\s+from\s+public\.rooms/i);
  });

  it("blocks every current/future operational reference and filters current projections", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    for (
      const table of [
        "public.reservations",
        "public.cleaning_targets",
        "private.stay_room_segments",
        "public.cleaning_assignments",
        "public.cleaning_attempts",
        "public.room_operation_blocks",
        "public.room_issues",
        "private.room_pin_change_leases",
        "private.room_pin_assignment_entitlements",
        "private.room_pin_reveal_leases",
        "private.room_pin_sheet_sync_outbox",
      ]
    ) {
      expect(sql).toContain(`on ${table}`);
    }
    for (
      const code of [
        "ROOM_RETIRE_RESERVATION_CONFLICT",
        "ROOM_RETIRE_CLEANING_CONFLICT",
        "ROOM_RETIRE_ISSUE_CONFLICT",
        "ROOM_RETIRE_OPERATION_BLOCK_CONFLICT",
        "ROOM_RETIRE_PIN_WORKFLOW_CONFLICT",
      ]
    ) {
      expect(sql).toContain(code);
    }
    expect(sql).toContain("where r.catalog_status='active'");
    expect(sql).toContain("where room.catalog_status='active'");
    expect(sql).toContain("where catalog_status='active'");
    expect(sql).toContain("where room.id=v_room_id for share");
  });

  it("uses the dynamic active snapshot for bounded Google full resync", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("snapshot_room_count between 1 and 500");
    expect(sql).toContain("sheet_row between 2 and 501");
    expect(sql).toContain(
      "select count(*)::integer into room_count from public.rooms where catalog_status='active'",
    );
    expect(sql).toContain(
      "from public.rooms r where r.catalog_status='active'",
    );
    expect(sql).toContain(
      "(select count(*) from public.rooms where catalog_status='active')<>run.snapshot_room_count",
    );
  });
});
