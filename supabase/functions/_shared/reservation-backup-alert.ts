// Independent monitor and GitHub failure job share the same bounded, redacted publisher.
const repository = "wrongstory/room-management-system-backend";
const origin = "https://api.github.com";
const publishers = new Set([
  "github-actions[bot]",
  "rms-reservation-backup-wrongstory[bot]",
]);
export const ALERT_MARKER = "<!-- rms-reservation-backup-monitor:v1 -->";
const codes = [
  "HEALTHY",
  "BACKUP_MISSING",
  "BACKUP_FAILED",
  "WORKFLOW_DISABLED",
  "MONITOR_CHECK_FAILED",
];
export interface BackupAlertHealth {
  code: string;
  expectedDay: string;
  checkedAt: string;
  verifiedDay?: string;
  runId?: number;
  runAttempt?: number;
}
function validDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function assert(ok: unknown): asserts ok {
  if (!ok) throw new Error("BACKUP_ALERT_FAILED");
}
function bounded<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("BACKUP_ALERT_FAILED"));
    signal.addEventListener("abort", abort, { once: true });
    value.then((result) => {
      signal.removeEventListener("abort", abort);
      resolve(result);
    }, () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("BACKUP_ALERT_FAILED"));
    });
    if (signal.aborted) abort();
  });
}
function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export async function publishBackupAlert(
  health: BackupAlertHealth,
  config: { token: string; issue: number; fetcher?: typeof fetch },
): Promise<{ published: boolean }> {
  assert(codes.includes(health.code) && validDay(health.expectedDay));
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(health.checkedAt) &&
      Number.isFinite(Date.parse(health.checkedAt)),
  );
  assert(new Date(health.checkedAt).toISOString() === health.checkedAt);
  assert(health.verifiedDay === undefined || validDay(health.verifiedDay));
  assert(
    health.runId === undefined ||
      (Number.isSafeInteger(health.runId) && health.runId > 0),
  );
  assert(
    health.runAttempt === undefined ||
      (health.runId !== undefined && Number.isSafeInteger(health.runAttempt) &&
        health.runAttempt > 0),
  );
  assert(Number.isSafeInteger(config.issue) && config.issue > 0);
  assert(/^ghs_[A-Za-z0-9_.-]{20,8192}$/.test(config.token));
  const fetcher = config.fetcher ?? fetch;
  const issuePath = `/repos/${repository}/issues/${config.issue}`;
  const total = AbortSignal.timeout(25000);
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> => {
    const signal = AbortSignal.any([total, AbortSignal.timeout(7000)]);
    const response = await bounded(
      fetcher(`${origin}${path}`, {
        method,
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      signal,
    );
    if (
      !response.ok || response.redirected ||
      (response.url && response.url !== `${origin}${path}`)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("BACKUP_ALERT_FAILED");
    }
    const reader = response.body?.getReader();
    assert(reader);
    const parts: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const value = await bounded(reader.read(), signal);
        if (value.done) break;
        length += value.value.length;
        assert(length <= 1024 * 1024);
        parts.push(value.value);
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return result;
  };
  try {
    const issue = record(await request(issuePath));
    assert(
      issue.number === config.issue && !issue.pull_request &&
        issue.state === "open",
    );
    assert(
      typeof issue.body === "string" && issue.body.startsWith(ALERT_MARKER),
    );
    const body = issue.body as string;
    const matches = [
      ...body.matchAll(
        /<!-- rms-backup-state:([A-Z_]+):(\d{4}-\d{2}-\d{2}):(none|[1-9]\d*):(none|[1-9]\d*) -->/g,
      ),
    ];
    assert(matches.length <= 1);
    const previous = matches[0];
    // Healthy days remain quiet; alerts remind once per expected day or new failed run.
    const marker =
      `<!-- rms-backup-state:${health.code}:${health.expectedDay}:${
        health.runId ?? "none"
      }:${health.runAttempt ?? "none"} -->`;
    if (
      previous?.[0] === marker ||
      (health.code === "BACKUP_FAILED" && previous?.[1] === health.code &&
        health.runId !== undefined &&
        previous?.[3] === String(health.runId) &&
        previous?.[4] === String(health.runAttempt ?? "none")) ||
      (health.code === "HEALTHY" && previous?.[1] === "HEALTHY")
    ) return { published: false };
    const summaries: Record<string, string> = {
      HEALTHY: "예약 백업 정상 확인",
      BACKUP_MISSING: "기한 내 예약 백업 확인 불가",
      BACKUP_FAILED: "예약 백업 실행 실패 또는 지연",
      WORKFLOW_DISABLED: "예약 백업 예약 작업 비활성",
      MONITOR_CHECK_FAILED: "예약 백업 상태 확인 실패",
    };
    // Only allowlisted status, calendar dates and a validated numeric run ID leave this process.
    const message = [
      `**${summaries[health.code]}**`,
      `상태: \`${health.code}\``,
      `확인 시각: ${health.checkedAt}`,
      `필요한 백업 날짜(KST): ${health.expectedDay}`,
      ...(health.verifiedDay
        ? [`확인된 사본 날짜(KST): ${health.verifiedDay}`]
        : []),
      ...(health.runId
        ? [
          `[실행 기록](https://github.com/${repository}/actions/runs/${health.runId})`,
        ]
        : []),
      "예약 원문·고객 정보·비밀번호·백업 암호화 키는 포함하지 않습니다.",
    ].join("\n\n");
    const incident =
      health.code === "BACKUP_FAILED" && health.runId !== undefined
        ? `${health.code}:run:${health.runId}:${health.runAttempt ?? "none"}`
        : `${health.code}:${health.expectedDay}:${health.runId ?? "none"}:${
          health.runAttempt ?? "none"
        }`;
    const eventMarker = `<!-- rms-backup-event:${incident} -->`;
    let alreadySent = false;
    assert(
      Number.isSafeInteger(issue.comments) && (issue.comments as number) >= 0 &&
        (issue.comments as number) <= 100000,
    );
    const lastPage = Math.max(1, Math.ceil((issue.comments as number) / 100));
    // Recover a POST-success/PATCH-failure without resending. Two most recent pages are bounded.
    if ((issue.comments as number) > 0) {
      for (const page of [...new Set([Math.max(1, lastPage - 1), lastPage])]) {
        const comments = await request(
          `${issuePath}/comments?per_page=100&page=${page}`,
        );
        assert(Array.isArray(comments) && comments.length <= 100);
        alreadySent ||= comments.some((item) => {
          const comment = record(item);
          const user = record(comment.user);
          return user.type === "Bot" && publishers.has(String(user.login)) &&
            typeof comment.body === "string" &&
            comment.body.includes(eventMarker);
        });
      }
    }
    // Initial healthy baseline updates state without manufacturing a recovery notification.
    const shouldNotify = health.code !== "HEALTHY" || Boolean(previous);
    if (shouldNotify && !alreadySent) {
      await request(`${issuePath}/comments`, "POST", {
        body: `${message}\n\n${eventMarker}`,
      });
    }
    const nextBody = previous
      ? body.replace(previous[0], marker)
      : `${body}\n\n${marker}`;
    await request(issuePath, "PATCH", { body: nextBody });
    return { published: shouldNotify && !alreadySent };
  } catch {
    throw new Error("BACKUP_ALERT_FAILED");
  }
}
