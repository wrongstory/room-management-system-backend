import { afterEach, describe, expect, it, vi } from "vitest";
import { operationWorkerConfig, recordNotificationOperationConfigurationFailure, withNotificationOperationAdmission,
  type OperationWorkerRpc } from "../src/modules/developer-reset/worker-admission.js";
import { NotificationDeliveryWorker } from "../src/modules/notifications/notification-delivery.js";

const target = "a".repeat(20), nonce = "b".repeat(64), digest = "c".repeat(64);
const id = "13200000-0000-4000-8000-000000000001";
const config = { target };
const claimArgs = { p_claim_digest: digest, p_limit: 10 };
const claim = { items: [], suppressed: 0, blocked: 0 };
const ok = (data: unknown) => ({ data, error: null });
function fake(options: { inactive?: boolean; claimError?: boolean; terminal?: boolean; malformed?: unknown } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db: OperationWorkerRpc = { rpc: vi.fn(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_operation_notification_deliveries") {
      if (options.claimError) return { data: null, error: { code: "UNKNOWN" } };
      return ok(options.malformed ?? { admissionId: options.inactive ? null : id, claim });
    }
    if (name === "complete_operation_notification_deliveries") return options.terminal === false
      ? { data: null, error: { code: "OPERATION_WORKER_COMPLETION_UNVERIFIED" } } : ok({ completed: true });
    return ok({ status: "succeeded" });
  }) };
  return { db, calls };
}
const options = (db: OperationWorkerRpc) => ({ config, db, budgetMs: 45_000, nonce: () => nonce });
afterEach(() => vi.useRealTimers());

describe("worker admission runtime and real worker integration", () => {
  it("keeps disabled mode byte-for-byte on the original RPC object", async () => {
    const { db, calls } = fake();
    const result = await withNotificationOperationAdmission({ ...options(db), config: undefined }, async inner => {
      expect(inner).toBe(db); return 7;
    });
    expect(result).toBe(7); expect(calls).toEqual([]);
  });
  it("uses the immutable claim wrapper then completes only after the whole run", async () => {
    const { db, calls } = fake();
    await withNotificationOperationAdmission(options(db), async inner => {
      expect((await inner.rpc("claim_notification_deliveries", claimArgs)).data).toEqual(claim);
      await inner.rpc("record_notification_delivery_heartbeat", { p_status: "succeeded" });
      expect(calls.some(c => c.name.startsWith("complete_"))).toBe(false);
    });
    expect(calls.map(c => c.name)).toEqual(["claim_operation_notification_deliveries", "record_notification_delivery_heartbeat", "complete_operation_notification_deliveries"]);
    expect(calls[0]?.args).toMatchObject({ p_target: target, p_nonce: nonce, ...claimArgs });
    expect(calls[2]?.args).toEqual({ p_target: target, p_nonce: nonce, p_admission_id: id });
  });
  it("does not complete absent-control legacy work or turn absence into a receipt", async () => {
    const { db, calls } = fake({ inactive: true });
    await withNotificationOperationAdmission(options(db), async inner => { await inner.rpc("claim_notification_deliveries", claimArgs); });
    expect(calls.map(c => c.name)).toEqual(["claim_operation_notification_deliveries"]);
  });
  it("requires DB terminal evidence even if provider/runtime resolved successfully", async () => {
    const { db } = fake({ terminal: false });
    await expect(withNotificationOperationAdmission(options(db), async inner => {
      await inner.rpc("claim_notification_deliveries", claimArgs); return { delivered: 1 };
    })).rejects.toThrow("OPERATION_WORKER_ADMISSION_UNAVAILABLE");
  });
  it("leaves the lease unresolved when worker execution throws", async () => {
    const { db, calls } = fake();
    await expect(withNotificationOperationAdmission(options(db), async inner => {
      await inner.rpc("claim_notification_deliveries", claimArgs); throw new Error("synthetic unknown provider result");
    })).rejects.toThrow("synthetic unknown");
    expect(calls.some(c => c.name.startsWith("complete_"))).toBe(false);
  });
  it("blocks fallback heartbeat after an unobserved or rolled-back claim", async () => {
    const { db, calls } = fake({ claimError: true });
    await expect(withNotificationOperationAdmission(options(db), async inner => {
      await expect(inner.rpc("claim_notification_deliveries", claimArgs)).rejects.toThrow();
      await expect(inner.rpc("record_notification_delivery_heartbeat", {})).rejects.toThrow();
    })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it.each([{ admissionId: id }, { admissionId: "wrong", claim }, { admissionId: id, claim, unexpected: true }, { admissionId: id, claim: [] }])(
    "rejects malformed claim envelope without subsequent writes", async malformed => {
      const { db, calls } = fake({ malformed });
      await expect(withNotificationOperationAdmission(options(db), async inner => {
        await inner.rpc("claim_notification_deliveries", claimArgs);
      })).rejects.toThrow();
      expect(calls).toHaveLength(1);
    },
  );
  it("rejects pre-claim and unrelated RPCs without executing them", async () => {
    const { db, calls } = fake();
    await expect(withNotificationOperationAdmission(options(db), async inner => {
      await expect(inner.rpc("record_notification_delivery_heartbeat", {})).rejects.toThrow();
      await inner.rpc("claim_notification_deliveries", claimArgs);
      await inner.rpc("purge_notification_delivery_history", {});
    })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("refuses a second claim and arbitrary claim arguments", async () => {
    const { db, calls } = fake();
    await expect(withNotificationOperationAdmission(options(db), async inner => {
      await expect(inner.rpc("claim_notification_deliveries", { ...claimArgs, p_unreviewed: true })).rejects.toThrow();
      await inner.rpc("claim_notification_deliveries", claimArgs);
      await inner.rpc("claim_notification_deliveries", claimArgs);
    })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("keeps lazy RPC execution one-shot when awaited twice", async () => {
    const { db, calls } = fake();
    await withNotificationOperationAdmission(options(db), async inner => {
      const query = inner.rpc("claim_notification_deliveries", claimArgs);
      expect(calls).toHaveLength(0); await query; await query;
    });
    expect(calls.filter(c => c.name.startsWith("claim_"))).toHaveLength(1);
  });
  it("a stuck remote call reaches its finite deadline without claiming rollback", async () => {
    vi.useFakeTimers();
    const db: OperationWorkerRpc = { rpc: () => new Promise(() => undefined) };
    const pending = withNotificationOperationAdmission({ ...options(db), budgetMs: 10 }, async inner => {
      await inner.rpc("claim_notification_deliveries", claimArgs);
    });
    const rejection = expect(pending).rejects.toThrow("OPERATION_WORKER_ADMISSION_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(10); await rejection;
  });
  it("does not issue completion after elapsed run budget", async () => {
    const { db, calls } = fake(); let clock = 1_000;
    await expect(withNotificationOperationAdmission({ ...options(db), clock: () => clock }, async inner => {
      await inner.rpc("claim_notification_deliveries", claimArgs); clock += 45_001;
    })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("actually wraps the production Node worker including its final heartbeat", async () => {
    const { db, calls } = fake(); const send = vi.fn();
    const result = await new NotificationDeliveryWorker(db, { send }, { key: "", keyVersion: "", keyring: {} }, Date.now, config).run();
    expect(result.claimed).toBe(0); expect(send).not.toHaveBeenCalled();
    expect(calls.map(c => c.name)).toEqual(["claim_operation_notification_deliveries", "record_notification_delivery_heartbeat", "complete_operation_notification_deliveries"]);
  });
  it("the real worker never writes a failure heartbeat when admission was refused", async () => {
    const { db, calls } = fake({ claimError: true }); const send = vi.fn();
    await expect(new NotificationDeliveryWorker(db, { send }, { key: "", keyVersion: "", keyring: {} }, Date.now, config).run()).rejects.toThrow();
    expect(calls).toHaveLength(1); expect(send).not.toHaveBeenCalled();
  });
  it("protects pre-claim configuration failure using only the fixed atomic RPC", async () => {
    const { db, calls } = fake();
    await recordNotificationOperationConfigurationFailure({ config, db, budgetMs: 45_000 });
    expect(calls[0]?.name).toBe("record_operation_notification_configuration_failure");
    expect(Object.keys(calls[0]?.args ?? {}).sort()).toEqual(["p_deadline", "p_nonce", "p_target"]);
  });
  it("preserves default configuration-failure heartbeat", async () => {
    const { db, calls } = fake();
    await recordNotificationOperationConfigurationFailure({ config: undefined, db, budgetMs: 45_000 });
    expect(calls[0]?.name).toBe("record_notification_delivery_heartbeat");
    expect(calls[0]?.args.p_error_code).toBe("PROVIDER_CONFIGURATION_ERROR");
  });
  it("validates the trusted configured Supabase project, not a request target", () => {
    expect(operationWorkerConfig(undefined, undefined, undefined)).toBeUndefined();
    expect(operationWorkerConfig("required", target, `https://${target}.supabase.co`)).toEqual(config);
    for (const url of [`https://${target}.supabase.co.attacker.invalid`, `http://${target}.supabase.co`, `https://user@${target}.supabase.co`, `https://${target}.supabase.co/extra`, `https://${target}.supabase.co?x=1`]) {
      expect(() => operationWorkerConfig("required", target, url)).toThrow();
    }
    expect(() => operationWorkerConfig("auto", target, `https://${target}.supabase.co`)).toThrow();
  });
});
