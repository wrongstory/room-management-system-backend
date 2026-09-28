import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../supabase/tests/reservation_long_stay.sql", import.meta.url),
  "utf8",
);
// Fixed local container only. Each scenario executes the complete SQL suite and
// rolls back its fixtures; no remote URL or server-clock override is accepted.
const scenarios = [
  "2026-09-23 23:59:59+09",
  "2026-09-24 00:00:00+09",
  "2026-09-24 00:04:00+09",
  "2026-09-24 00:05:00+09",
  "2026-09-24 12:00:00+09",
];
for (const time of scenarios) {
  const output = execFileSync(
    "docker",
    [
      "exec", "-i", "supabase_db_room-management-system-backend",
      "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
      "-U", "postgres", "-d", "postgres",
    ],
    {
      input: `set rms_test.long_stay_clock = '${time}';\n${sql}`,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  // pgTAP failures do not make psql exit nonzero. Require a full numbered
  // passing plan as well as successful SQL execution (including rollback).
  const plans = [...output.matchAll(/^1\.\.(\d+)\s*$/gm)];
  const assertions = [...output.matchAll(/^(?:not )?ok (\d+)\b.*$/gm)];
  if (
    plans.length !== 1 ||
    Number(plans[0][1]) !== 29 ||
    assertions.length !== 29 ||
    assertions.some((match, index) =>
      !match[0].startsWith("ok ") || Number(match[1]) !== index + 1
    ) ||
    /^Bail out!/im.test(output)
  ) {
    throw new Error(`long-stay boundary regression failed at ${time}:\n${output}`);
  }
  process.stdout.write(`long-stay clock ${time}: 29 assertions PASS\n`);
}
