import {
  OperationWorkerAdmissionError,
  type OperationWorkerConfig,
  type OperationWorkerRpc,
} from "./worker-admission.js";
const fail = (): never => {
  throw new OperationWorkerAdmissionError();
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : fail();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const keySet = (value: Record<string, unknown>, keys: string) =>
  Object.keys(value).sort().join(",") === keys;
const actions: Record<string, string> = {
  renew_room_pin_sheet_sync_run: "RENEW",
  authorize_room_pin_sheet_write: "AUTHORIZE",
  settle_room_pin_sheet_sync: "SETTLE",
  record_room_pin_sheet_sync_heartbeat: "HEARTBEAT",
};

/** Incremental-only source. The first old full-resync probe is replaced by a
 * combined incremental claim that refuses pending/uncertain full-board work.
 * It never invokes full-resync RPCs, credentials, a provider or a reset itself. */
export async function withPinIncrementalOperationAdmission<T>(input: {
  config?: OperationWorkerConfig | undefined;
  db: OperationWorkerRpc;
  budgetMs: number;
  clock?: () => number;
  nonce?: () => string;
}, run: (db: OperationWorkerRpc) => Promise<T>): Promise<T> {
  if (!input.config) return run(input.db);
  const clock = input.clock ?? Date.now, deadline = clock() + input.budgetMs;
  if (
    !Number.isSafeInteger(input.budgetMs) || input.budgetMs < 1 ||
    !Number.isSafeInteger(deadline) ||
    !Number.isFinite(new Date(deadline).getTime())
  ) return fail();
  const nonce = input.nonce?.() ??
    Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (v) => v.toString(16).padStart(2, "0"),
    ).join("");
  if (
    !/^[a-f0-9]{64}$/.test(nonce) || !/^[a-z]{20}$/.test(input.config.target)
  ) return fail();
  let blocked = false, started = false, consumed = false, finished = false;
  let admission: string | null | undefined,
    claim: Record<string, unknown> | undefined,
    identity: Record<string, unknown> | undefined;
  const call = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const remaining = deadline - clock();
    if (remaining <= 0 || signal?.aborted) return fail();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = input.db.rpc(name, args);
      return await Promise.race([
        Promise.resolve(raw.abortSignal?.(controller.signal) ?? raw),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new OperationWorkerAdmissionError());
          }, Math.min(remaining, 2147483647));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  const execute = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    if (blocked || finished) return fail();
    if (name === "claim_room_pin_sheet_full_resync") {
      if (
        started ||
        !keySet(
          args,
          "p_claim_id,p_expected_environment,p_expected_project_ref,p_expected_target_identity_digest",
        ) ||
        typeof args.p_claim_id !== "string" || !uuid.test(args.p_claim_id) ||
        args.p_expected_project_ref !== input.config?.target ||
        typeof args.p_expected_environment !== "string" ||
        !/^[A-Za-z0-9._:-]{1,80}$/.test(args.p_expected_environment) ||
        typeof args.p_expected_target_identity_digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(args.p_expected_target_identity_digest)
      ) return fail();
      started = true;
      identity = { ...args };
      try {
        const response = await call("claim_operation_pin_incremental", {
          ...args,
          p_target: input.config?.target,
          p_nonce: nonce,
          p_deadline: new Date(deadline).toISOString(),
        }, signal);
        if (response.error) return fail();
        const data = object(response.data);
        claim = object(data.claim);
        if (
          !keySet(data, "admissionId,claim") ||
          (data.admissionId !== null &&
            (typeof data.admissionId !== "string" ||
              !uuid.test(data.admissionId))) ||
          !["claimed", "busy", "operator_blocked"].includes(
            String(claim.status),
          ) || !Number.isSafeInteger(claim.leaseFence) ||
          (claim.leaseFence as number) < 0 || !Array.isArray(claim.items) ||
          claim.items.length > 10
        ) return fail();
        admission = data.admissionId as string | null;
        if (
          claim.status !== "claimed" &&
          (admission !== null || claim.items.length)
        ) return fail();
        return {
          data: {
            status: claim.status === "claimed" ? "empty" : claim.status,
            leaseFence: claim.leaseFence,
          },
          error: null,
        };
      } catch {
        blocked = true;
        return fail();
      }
    }
    if (name === "claim_room_pin_sheet_sync") {
      if (
        !claim || !identity || claim.status !== "claimed" || consumed ||
        !keySet(
          args,
          "p_claim_id,p_expected_environment,p_expected_project_ref,p_limit",
        ) || args.p_limit !== 10 ||
        ["p_claim_id", "p_expected_environment", "p_expected_project_ref"].some(
          (key) => args[key] !== identity?.[key],
        )
      ) return fail();
      consumed = true;
      return { data: claim, error: null };
    }
    const action = actions[name];
    if (
      !action || !consumed || admission === undefined || !identity ||
      args.p_claim_id !== identity.p_claim_id ||
      args.p_lease_fence !== claim?.leaseFence
    ) return fail();
    const response = await call(
      admission === null ? name : "dispatch_operation_pin_incremental",
      admission === null ? args : {
        p_target: input.config?.target,
        p_admission_id: admission,
        p_nonce: nonce,
        p_action: action,
        p_args: args,
      },
      signal,
    );
    if (response.error) return response;
    if (action === "HEARTBEAT") finished = true;
    return response;
  };
  const wrapped: OperationWorkerRpc = {
    rpc(name, args) {
      let signal: AbortSignal | undefined,
        execution: ReturnType<typeof execute> | undefined;
      const query = {
        abortSignal(value: AbortSignal) {
          signal = value;
          return query;
        },
        // biome-ignore lint/suspicious/noThenProperty: Keep the lazy Supabase RPC builder behavior.
        then<TResult1 = Awaited<ReturnType<typeof execute>>, TResult2 = never>(
          resolve?:
            | ((
              value: Awaited<ReturnType<typeof execute>>,
            ) => TResult1 | PromiseLike<TResult1>)
            | null,
          reject?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null,
        ) {
          execution ??= execute(name, args, signal);
          return execution.then(resolve, reject);
        },
      };
      return query;
    },
  };
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      run(wrapped),
      new Promise<never>((_, reject) => {
        runTimer = setTimeout(() => {
          blocked = true;
          reject(new OperationWorkerAdmissionError());
        }, Math.min(input.budgetMs, 2147483647));
      }),
    ]);
    blocked = true; // A retained runtime reference cannot write after run returns.
    if (
      !started || admission === undefined || !claim ||
      (claim.status === "claimed" && (!consumed || !finished))
    ) return fail();
    if (admission !== null) {
      const response = await call("complete_operation_pin_incremental", {
        p_target: input.config.target,
        p_admission_id: admission,
        p_nonce: nonce,
      });
      if (response.error) return fail();
      const value = object(response.data);
      if (!keySet(value, "completed") || value.completed !== true) {
        return fail();
      }
    }
    return result;
  } finally {
    blocked = true;
    if (runTimer) clearTimeout(runTimer);
  }
}
