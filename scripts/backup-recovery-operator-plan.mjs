import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPlanContainsNoSecretMaterial,
  buildSafeOperatorPlan,
} from "./lib/backup-recovery-operator-plan.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const values = { configPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") values.configPath = argv[++index];
    else throw new Error(`BACKUP_ARGUMENT_NOT_ALLOWED:${argument}`);
  }
  if (!values.configPath) throw new Error("BACKUP_CONFIG_PATH_REQUIRED");
  const configPath = isAbsolute(values.configPath) ? values.configPath : resolve(process.cwd(), values.configPath);
  return { configPath };
}

async function main() {
  const { configPath } = parseArguments(process.argv.slice(2));
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const plan = assertPlanContainsNoSecretMaterial(
    buildSafeOperatorPlan(config, { repositoryRoot: projectRoot, configPath }),
  );
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

await main();
