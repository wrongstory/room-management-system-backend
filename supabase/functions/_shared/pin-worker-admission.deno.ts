import { withPinIncrementalOperationAdmission } from "./pin-worker-admission.ts";
import { RoomPinSheetSyncWorker } from "./room-pin-sheet-sync.ts";
import type { OperationWorkerRpc } from "./worker-admission.ts";

const target = "a".repeat(20);
const id = "13400000-0000-4000-8000-000000000001";
const claimId = "13400000-0000-4000-8000-000000000002";
const first = {
  p_claim_id: claimId,
  p_expected_environment: "synthetic",
  p_expected_project_ref: target,
  p_expected_target_identity_digest: "c".repeat(64),
};
const incremental = {
  p_claim_id: claimId,
  p_limit: 10,
  p_expected_environment: "synthetic",
  p_expected_project_ref: target,
};

Deno.test("Edge PIN incremental adapter never calls the full-resync probe or completes before its heartbeat", async () => {
  const calls: string[] = [];
  const db: OperationWorkerRpc = {
    rpc: async (name) => {
      calls.push(name);
      return {
        data: name === "claim_operation_pin_incremental"
          ? {
            admissionId: id,
            claim: { status: "claimed", leaseFence: 4, items: [], blocked: 0 },
          }
          : name === "complete_operation_pin_incremental"
          ? { completed: true }
          : { status: "succeeded" },
        error: null,
      };
    },
  };
  await withPinIncrementalOperationAdmission({
    db,
    config: { target },
    budgetMs: 45_000,
  }, async (inner) => {
    await inner.rpc("claim_room_pin_sheet_full_resync", first);
    await inner.rpc("claim_room_pin_sheet_sync", incremental);
    await inner.rpc("record_room_pin_sheet_sync_heartbeat", {
      p_claim_id: claimId,
      p_lease_fence: 4,
    });
    if (calls.some((name) => name.startsWith("complete_"))) {
      throw new Error("premature completion");
    }
  });
  if (
    calls.join(",") !==
      "claim_operation_pin_incremental,dispatch_operation_pin_incremental,complete_operation_pin_incremental"
  ) throw new Error("unexpected effect path");
});

Deno.test("Edge PIN held claim blocks failure-heartbeat fallback and leaves completion unknown", async () => {
  const calls: string[] = [];
  const db: OperationWorkerRpc = {
    rpc: async (name) => {
      calls.push(name);
      return { data: null, error: { code: "HOLD" } };
    },
  };
  let rejected = false;
  try {
    await withPinIncrementalOperationAdmission({
      db,
      config: { target },
      budgetMs: 45_000,
    }, async (inner) => {
      try {
        await inner.rpc("claim_room_pin_sheet_full_resync", first);
      } catch { /* deliberately attempt old fallback */ }
      await inner.rpc("record_room_pin_sheet_sync_heartbeat", {
        p_claim_id: claimId,
        p_lease_fence: 4,
      });
    });
  } catch {
    rejected = true;
  }
  if (!rejected || calls.join(",") !== "claim_operation_pin_incremental") {
    throw new Error("HOLD bypassed");
  }
});

Deno.test("actual Edge PIN worker keeps the hosted mapping HOLD before RPC and provider calls", async () => {
  let calls = 0;
  const db: OperationWorkerRpc = {
    rpc: async () => {
      calls++;
      return { data: null, error: null };
    },
  };
  let rejected = false;
  try {
    await new RoomPinSheetSyncWorker(
      db,
      {
        inspect: () => {
          calls++;
          throw new Error("unexpected provider");
        },
        write: () => {
          calls++;
          throw new Error("unexpected provider");
        },
      },
      {
        key: "",
        keyVersion: "",
        keyring: {},
        environment: "synthetic",
        projectRef: target,
      },
      Date.now,
      { target },
    ).run();
  } catch {
    rejected = true;
  }
  if (!rejected || calls !== 0) {
    throw new Error("unapproved hosted mapping activated");
  }
});
