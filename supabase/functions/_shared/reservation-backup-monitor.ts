/** #12: metadata-only monitoring; never reads a backup body or a decryption key. */
export const BACKUP_REPOSITORY = "wrongstory/room-management-system-backend";
export const BACKUP_WORKFLOW_PATH = ".github/workflows/reservation-backup.yml";
export const BACKUP_VERIFICATION_STEP =
  "Encrypted reservation backup and read-model recovery verification";
const github = `https://api.github.com/repos/${BACKUP_REPOSITORY}`;
const storage = "https://matalcofimnhuzslfhdd.supabase.co/storage/v1";
const bucket = "reservation-backups";
const dayMs = 86400000;
const maxPacket = 32 * 1024 * 1024 + 36;

export type MonitorCode =
  | "HEALTHY"
  | "BACKUP_MISSING"
  | "BACKUP_FAILED"
  | "WORKFLOW_DISABLED"
  | "MONITOR_CHECK_FAILED";
export interface MonitorHealth {
  code: MonitorCode;
  expectedDay: string;
  checkedAt: string;
  verifiedDay?: string;
  runId?: number;
  runAttempt?: number;
}
export interface BackupRunEvidence {
  id: number;
  attempt: number;
  status: string;
  conclusion: string | null;
  startedAt: string;
  headSha: string;
}
export interface BackupJobEvidence {
  name: string;
  status: string;
  conclusion: string | null;
  steps: {
    name: string;
    status: string;
    conclusion: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }[];
}
export interface BackupEvidence {
  workflowState: string;
  bucketPrivate: boolean;
  runs: BackupRunEvidence[];
  objects: {
    name: string;
    size: number;
    createdAt: string;
    updatedAt: string;
  }[];
  verifiedRun?: { runId: number; attempt: number; jobs: BackupJobEvidence[] };
}

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error("MONITOR_CHECK_FAILED");
}
function instant(value: unknown): number {
  requireValue(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
        .test(value),
  );
  requireValue(
    new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) ===
      value.slice(0, 10),
  );
  const timestamp = Date.parse(value);
  requireValue(Number.isFinite(timestamp));
  return timestamp;
}
function positiveId(value: unknown): number {
  requireValue(Number.isSafeInteger(value) && (value as number) > 0);
  return value as number;
}
function record(value: unknown): Record<string, unknown> {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number): unknown[] {
  requireValue(Array.isArray(value) && value.length <= maximum);
  return value;
}
function text(value: unknown, maximum = 200): string {
  requireValue(
    typeof value === "string" && value.length > 0 && value.length <= maximum,
  );
  return value;
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("MONITOR_CHECK_FAILED"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("MONITOR_CHECK_FAILED"));
    });
    if (signal.aborted) abort();
  });
}
function kstDay(time: number): string {
  return new Date(time + 9 * 3600000).toISOString().slice(0, 10);
}
export function expectedBackupDay(now: Date): string {
  requireValue(Number.isFinite(now.getTime()));
  // A 03:00 KST run has one hour of scheduling grace. At 04:00 it is due.
  return new Date(now.getTime() + 5 * 3600000).toISOString().slice(0, 10);
}
function health(code: MonitorCode, now: Date): MonitorHealth {
  return {
    code,
    expectedDay: expectedBackupDay(now),
    checkedAt: now.toISOString(),
  };
}

/** Only complete, current-attempt verification plus a matching private object is success. */
export function evaluateBackupEvidence(
  evidence: BackupEvidence,
  now = new Date(),
): MonitorHealth {
  const base = health("MONITOR_CHECK_FAILED", now);
  try {
    const current = now.getTime();
    requireValue(
      evidence.bucketPrivate && evidence.runs.length <= 100 &&
        evidence.objects.length < 1000,
    );
    const seen = new Set<string>();
    for (const object of evidence.objects) {
      requireValue(/^\d{4}-\d{2}-\d{2}\.rms$/.test(object.name));
      const day = object.name.slice(0, 10);
      requireValue(
        new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day,
      );
      const created = instant(object.createdAt);
      const updated = instant(object.updatedAt);
      requireValue(
        day === kstDay(created) && created <= current && day <= kstDay(current),
      );
      requireValue(updated >= created && updated <= current);
      requireValue(
        Number.isSafeInteger(object.size) && object.size > 36 &&
          object.size <= maxPacket,
      );
      requireValue(!seen.has(object.name));
      seen.add(object.name);
    }
    const runIds = new Set<number>();
    const runs = [...evidence.runs].sort((a, b) =>
      instant(b.startedAt) - instant(a.startedAt) || b.id - a.id
    );
    for (const run of runs) {
      positiveId(run.id);
      positiveId(run.attempt);
      requireValue(!runIds.has(run.id) && instant(run.startedAt) <= current);
      requireValue(/^[a-f0-9]{40}$/.test(run.headSha));
      requireValue(
        [
          "completed",
          "queued",
          "in_progress",
          "waiting",
          "pending",
          "requested",
        ].includes(run.status),
      );
      requireValue(
        run.status === "completed"
          ? typeof run.conclusion === "string"
          : run.conclusion === null,
      );
      runIds.add(run.id);
    }
    if (evidence.workflowState !== "active") {
      return { ...base, code: "WORKFLOW_DISABLED" };
    }
    const latest = runs[0];
    if (
      latest && latest.status !== "completed" &&
      current - instant(latest.startedAt) > 30 * 60000
    ) {
      return {
        ...base,
        code: "BACKUP_FAILED",
        runId: latest.id,
        runAttempt: latest.attempt,
      };
    }
    const completed = runs.find((run) => run.status === "completed");
    if (completed && completed.conclusion !== "success") {
      return {
        ...base,
        code: "BACKUP_FAILED",
        runId: completed.id,
        runAttempt: completed.attempt,
      };
    }
    if (!completed) return { ...base, code: "BACKUP_MISSING" };
    const proof = evidence.verifiedRun;
    requireValue(
      proof && proof.runId === completed.id &&
        proof.attempt === completed.attempt,
    );
    const jobs = proof.jobs.filter((job) => job.name === "backup");
    requireValue(proof.jobs.length <= 100 && jobs.length === 1);
    const job = jobs[0]!;
    const steps = job.steps.filter((step) =>
      step.name === BACKUP_VERIFICATION_STEP
    );
    if (
      job.status !== "completed" || job.conclusion !== "success" ||
      steps.length !== 1
    ) {
      return {
        ...base,
        code: "BACKUP_FAILED",
        runId: completed.id,
        runAttempt: completed.attempt,
      };
    }
    const step = steps[0]!;
    if (step.status !== "completed" || step.conclusion !== "success") {
      return {
        ...base,
        code: "BACKUP_FAILED",
        runId: completed.id,
        runAttempt: completed.attempt,
      };
    }
    const start = instant(step.startedAt);
    const end = instant(step.completedAt);
    requireValue(
      start >= instant(completed.startedAt) && start <= end && end <= current,
    );
    // A step crossing midnight cannot unambiguously identify the immutable object.
    const verifiedDay = kstDay(start);
    requireValue(verifiedDay === kstDay(end));
    const object = evidence.objects.find((item) =>
      item.name === `${verifiedDay}.rms`
    );
    if (!object || verifiedDay < base.expectedDay) {
      return {
        ...base,
        code: "BACKUP_MISSING",
        runId: completed.id,
        runAttempt: completed.attempt,
      };
    }
    // GitHub rounds step completion to whole seconds; Storage keeps microseconds.
    // Cover only that reported second, never a change in the following second.
    const completionUpperBound = typeof step.completedAt === "string" &&
        !step.completedAt.includes(".")
      ? end + 999
      : end;
    requireValue(
      instant(object.createdAt) <= completionUpperBound &&
        instant(object.updatedAt) <= completionUpperBound,
    );
    return {
      ...base,
      code: "HEALTHY",
      verifiedDay,
      runId: completed.id,
      runAttempt: completed.attempt,
    };
  } catch {
    return base;
  }
}

function parseRun(value: unknown, workflowId: number): BackupRunEvidence {
  const run = record(value);
  requireValue(run.workflow_id === workflowId && run.head_branch === "main");
  requireValue(run.event === "schedule" || run.event === "workflow_dispatch");
  requireValue(
    record(run.repository).full_name === BACKUP_REPOSITORY &&
      record(run.head_repository).full_name === BACKUP_REPOSITORY,
  );
  const startedAt = text(run.run_started_at);
  instant(startedAt);
  const conclusion = run.conclusion === null ? null : text(run.conclusion);
  const headSha = text(run.head_sha);
  requireValue(/^[a-f0-9]{40}$/.test(headSha));
  return {
    id: positiveId(run.id),
    attempt: positiveId(run.run_attempt),
    status: text(run.status),
    conclusion,
    startedAt,
    headSha,
  };
}
function parseJobs(
  value: unknown,
  run: BackupRunEvidence,
): BackupJobEvidence[] {
  const data = record(value);
  const jobs = array(data.jobs, 100);
  requireValue(
    Number.isSafeInteger(data.total_count) && data.total_count === jobs.length,
  );
  return jobs.map((item) => {
    const job = record(item);
    requireValue(
      job.run_id === run.id && job.run_attempt === run.attempt &&
        job.head_sha === run.headSha,
    );
    return {
      name: text(job.name),
      status: text(job.status),
      conclusion: job.conclusion === null ? null : text(job.conclusion),
      steps: array(job.steps, 100).map((item) => {
        const step = record(item);
        return {
          name: text(step.name, 300),
          status: text(step.status),
          conclusion: step.conclusion === null ? null : text(step.conclusion),
          startedAt: step.started_at === null ? null : text(step.started_at),
          completedAt: step.completed_at === null
            ? null
            : text(step.completed_at),
        };
      }),
    };
  });
}

/** Public GitHub reads are unauthenticated. The Storage credential never leaves its fixed origin. */
export async function collectBackupHealth(
  storageToken: string,
  options: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<MonitorHealth> {
  // Production evidence can complete while these requests are in flight.
  // Explicit test time stays fixed; otherwise evaluate at collection completion.
  const evaluationTime = () => options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;
  const total = AbortSignal.timeout(45000);
  async function request(
    origin: string,
    path: string,
    method = "GET",
    body?: string,
    limit = 1024 * 1024,
  ): Promise<unknown> {
    requireValue(origin === github || origin === storage);
    const headers: Record<string, string> = origin === github
      ? {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "rms-reservation-backup-monitor",
        "Cache-Control": "no-cache",
      }
      : {
        apikey: storageToken,
        Authorization: `Bearer ${storageToken}`,
        "Content-Type": "application/json",
      };
    const signal = AbortSignal.any([total, AbortSignal.timeout(7000)]);
    const response = await bounded(
      fetcher(`${origin}${path}`, {
        method,
        headers,
        redirect: "error",
        signal,
        ...(body === undefined ? {} : { body }),
      }),
      signal,
    );
    if (
      !response.ok || response.redirected ||
      (response.url && response.url !== `${origin}${path}`)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("MONITOR_CHECK_FAILED");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("MONITOR_CHECK_FAILED");
    }
    const reader = response.body?.getReader();
    requireValue(reader);
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await bounded(reader.read(), signal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        requireValue(size <= limit);
        parts.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }
  try {
    requireValue(
      storageToken.length > 20 && storageToken.length < 8192 &&
        !/[\r\n]/.test(storageToken),
    );
    const [workflowValue, bucketValue] = await Promise.all([
      request(
        github,
        "/actions/workflows/reservation-backup.yml",
        "GET",
        undefined,
        65536,
      ),
      request(storage, `/bucket/${bucket}`, "GET", undefined, 65536),
    ]);
    const workflow = record(workflowValue);
    const workflowId = positiveId(workflow.id);
    requireValue(workflow.path === BACKUP_WORKFLOW_PATH);
    const privateBucket = record(bucketValue);
    requireValue(privateBucket.id === bucket && privateBucket.public === false);
    const [runValues, objectValues] = await Promise.all([
      request(
        github,
        `/actions/workflows/${workflowId}/runs?branch=main&per_page=100`,
      ),
      request(
        storage,
        `/object/list/${bucket}`,
        "POST",
        JSON.stringify({
          prefix: "",
          limit: 1000,
          offset: 0,
          sortBy: { column: "name", order: "desc" },
        }),
      ),
    ]);
    const runs = array(record(runValues).workflow_runs, 100).map((run) =>
      parseRun(run, workflowId)
    );
    const objects = array(objectValues, 999).map((item) => {
      const value = record(item);
      return {
        name: text(value.name),
        size: record(value.metadata).size as number,
        createdAt: text(value.created_at),
        updatedAt: text(value.updated_at),
      };
    });
    const evidence: BackupEvidence = {
      workflowState: text(workflow.state),
      bucketPrivate: true,
      runs,
      objects,
    };
    const candidate = [...runs].sort((a, b) =>
      instant(b.startedAt) - instant(a.startedAt) || b.id - a.id
    )
      .find((run) => run.status === "completed");
    if (candidate?.conclusion === "success") {
      // Re-read the run before and after its exact attempt jobs. A rerun invalidates the old proof.
      const current = parseRun(
        await request(github, `/actions/runs/${candidate.id}`),
        workflowId,
      );
      requireValue(JSON.stringify(current) === JSON.stringify(candidate));
      const jobs = parseJobs(
        await request(
          github,
          `/actions/runs/${current.id}/attempts/${current.attempt}/jobs?per_page=100`,
        ),
        current,
      );
      const after = parseRun(
        await request(github, `/actions/runs/${current.id}`),
        workflowId,
      );
      requireValue(JSON.stringify(after) === JSON.stringify(current));
      evidence.verifiedRun = {
        runId: current.id,
        attempt: current.attempt,
        jobs,
      };
    }
    return evaluateBackupEvidence(evidence, evaluationTime());
  } catch {
    return health("MONITOR_CHECK_FAILED", evaluationTime());
  }
}
