import { handleReservationScheduler } from "./index.ts";
const assert = (value: unknown) => {
  if (!value) throw new Error("Scheduler boundary assertion failed");
};
Deno.test("reservation scheduler signed mode binds fixed operation and preserves legacy opt in", async () => {
  const names = [
    "SCHEDULER_INVOKE_SECRET",
    "SCHEDULER_INVOKE_MODE",
    "RESERVATION_SCHEDULER_ACTOR_PROFILE_ID",
  ];
  const old = new Map(names.map((name) => [name, Deno.env.get(name)]));
  const key = "synthetic-scheduler-invoke-key-12345678";
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const deps = {
    createClients: () =>
      ({
        admin: {
          rpc: (name: string, args: Record<string, unknown>) => {
            calls.push({ name, args });
            return Promise.resolve({ data: {}, error: null });
          },
        },
      }) as never,
  };
  const signed = async (
    audience = "reservation-scheduler:aodikrxcczbogjpsjwjt",
    offset = 0,
  ) => {
    const at = String(Math.floor(Date.now() / 1000) - offset),
      nonce = "ab".repeat(16);
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        material,
        new TextEncoder().encode(
          `rms-scheduled-invocation-v1\n${audience}\n${at}\n${nonce}\nPOST`,
        ),
      ),
    );
    return new Headers({
      "x-rms-invoke-at": at,
      "x-rms-invoke-nonce": nonce,
      "x-rms-invoke-signature": [...signature].map((value) =>
        value.toString(16).padStart(2, "0")
      ).join(""),
    });
  };
  const invoke = (headers: Headers, path = "/reservation-scheduler") =>
    handleReservationScheduler(
      new Request(
        `https://example.test${path}`,
        {
          method: "POST",
          headers,
          body: '{"scheduledAt":"1900-01-01T00:00:00Z"}',
        },
      ),
      deps,
    );
  try {
    Deno.env.set("SCHEDULER_INVOKE_SECRET", key);
    Deno.env.set(
      "RESERVATION_SCHEDULER_ACTOR_PROFILE_ID",
      "a0000000-0000-4000-8000-000000000001",
    );
    Deno.env.set("SCHEDULER_INVOKE_MODE", "signed-v1");
    assert((await invoke(await signed())).status === 200);
    assert(calls.length === 3 && !JSON.stringify(calls).includes("1900"));
    for (
      const headers of [
        await signed(undefined, 61),
        await signed(undefined, -10),
        await signed("notification-delivery:aodikrxcczbogjpsjwjt"),
        new Headers({ "x-scheduler-secret": key }),
      ]
    ) {
      assert((await invoke(headers)).status === 401);
    }
    const downgrade = await signed();
    downgrade.set("x-scheduler-secret", key);
    assert((await invoke(downgrade)).status === 401);
    assert(
      (await invoke(await signed(), "/reservation-scheduler?other=1"))
        .status === 401,
    );
    assert(
      (await invoke(await signed(), "/reservation-scheduler/other")).status ===
        401,
    );
    assert(calls.length === 3);
    Deno.env.set("SCHEDULER_INVOKE_MODE", "typo");
    assert((await invoke(await signed())).status === 503);
    Deno.env.delete("SCHEDULER_INVOKE_MODE");
    assert(
      (await invoke(new Headers({ "x-scheduler-secret": key }))).status === 200,
    );
    assert(calls.length === 6 && JSON.stringify(calls).includes("1900"));
  } finally {
    for (const [name, value] of old) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("scheduler admission protects the actual handler and preserves partial commit boundaries", async () => {
  const names = [
    "SCHEDULER_INVOKE_SECRET",
    "SCHEDULER_INVOKE_MODE",
    "RESERVATION_SCHEDULER_ACTOR_PROFILE_ID",
    "SCHEDULER_OPERATION_ADMISSION_MODE",
    "SCHEDULER_OPERATION_BUDGET_MS",
    "DEVELOPER_OPERATION_TARGET",
    "SUPABASE_URL",
  ];
  const old = new Map(names.map((name) => [name, Deno.env.get(name)]));
  const key = "synthetic-scheduler-invoke-key-12345678",
    id = "13300000-0000-4000-8000-000000000001";
  try {
    Deno.env.set("SCHEDULER_INVOKE_SECRET", key);
    Deno.env.delete("SCHEDULER_INVOKE_MODE");
    Deno.env.set("RESERVATION_SCHEDULER_ACTOR_PROFILE_ID", id);
    Deno.env.set("SCHEDULER_OPERATION_ADMISSION_MODE", "required");
    Deno.env.set("SCHEDULER_OPERATION_BUDGET_MS", "1000");
    Deno.env.set("DEVELOPER_OPERATION_TARGET", "a".repeat(20));
    Deno.env.set("SUPABASE_URL", `https://${"a".repeat(20)}.supabase.co`);
    for (
      const failed of [
        null,
        "acquire_operation_reservation_scheduler",
        "process_due_assignment_lifecycle",
        "record_scheduler_heartbeat",
        "complete_operation_reservation_scheduler",
      ]
    ) {
      const calls: string[] = [];
      const response = await handleReservationScheduler(
        new Request("https://example.test/reservation-scheduler", {
          method: "POST",
          headers: { "x-scheduler-secret": key },
          body: "{}",
        }),
        {
          createClients: () =>
            ({
              admin: {
                rpc: (name: string) => {
                  calls.push(name);
                  if (name === failed) {
                    return Promise.resolve({
                      data: null,
                      error: { code: "SYNTHETIC_UNKNOWN" },
                    });
                  }
                  const data = name.startsWith("acquire_")
                    ? { admissionId: id }
                    : name.startsWith("complete_")
                    ? { completed: true }
                    : {};
                  return Promise.resolve({ data, error: null });
                },
              },
            }) as never,
        },
      );
      assert(response.status === (failed ? 503 : 200));
      assert(calls[0] === "acquire_operation_reservation_scheduler");
      if (failed) assert(calls.at(-1) === failed);
      else {assert(
          calls.join(",") ===
            "acquire_operation_reservation_scheduler,process_due_reservation_transitions,process_due_assignment_lifecycle,record_scheduler_heartbeat,complete_operation_reservation_scheduler",
        );}
    }
    Deno.env.delete("SCHEDULER_OPERATION_BUDGET_MS");
    let called = false;
    const invalid = await handleReservationScheduler(
      new Request("https://example.test/reservation-scheduler", {
        method: "POST",
        headers: { "x-scheduler-secret": key },
        body: "{}",
      }),
      {
        createClients: () =>
          ({
            admin: {
              rpc: () => {
                called = true;
                throw new Error("unexpected write");
              },
            },
          }) as never,
      },
    );
    assert(invalid.status === 503 && !called);
  } finally {
    for (const [name, value] of old) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});
