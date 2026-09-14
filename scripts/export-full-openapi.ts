import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openApiDocument } from "../supabase/functions/_shared/openapi.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const outputPath = resolve(projectRoot, ".tmp", "full-openapi.json");
const source = structuredClone(openApiDocument) as Record<string, unknown>;
source.servers = [{ url: "https://example.supabase.co/functions/v1/api" }];

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
process.stdout.write(`${outputPath}\n`);
