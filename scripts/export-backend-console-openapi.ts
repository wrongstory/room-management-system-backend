import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openApiDocument } from "../supabase/functions/_shared/openapi.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const outputPath = resolve(
  projectRoot,
  ".tmp",
  "backend-console-openapi.json",
);

const allowedPrefixes = ["/v1/auth/", "/v1/accounts", "/v1/developer/"];
const source = structuredClone(openApiDocument) as Record<string, unknown> & {
  paths: Record<string, unknown>;
};

source.paths = Object.fromEntries(
  Object.entries(source.paths).filter(([path]) =>
    allowedPrefixes.some((prefix) => path.startsWith(prefix))
  ),
);

function collectSchemaReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaReferences(item, references);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (
      key === "$ref" && typeof item === "string" &&
      item.startsWith("#/components/schemas/")
    ) {
      references.add(item.slice("#/components/schemas/".length));
    } else {
      collectSchemaReferences(item, references);
    }
  }
}

const components = source.components as {
  schemas: Record<string, unknown>;
};
const requiredSchemas = new Set<string>();
collectSchemaReferences(source.paths, requiredSchemas);
const pendingSchemas = [...requiredSchemas];
const processedSchemas = new Set<string>();
while (pendingSchemas.length > 0) {
  const name = pendingSchemas.pop() as string;
  if (processedSchemas.has(name)) continue;
  processedSchemas.add(name);
  const before = new Set(requiredSchemas);
  collectSchemaReferences(components.schemas[name], requiredSchemas);
  for (const referenced of requiredSchemas) {
    if (!before.has(referenced)) {
      pendingSchemas.push(referenced);
    }
  }
}
components.schemas = Object.fromEntries(
  Object.entries(components.schemas).filter(([name]) => requiredSchemas.has(name)),
);
source.servers = [{ url: "https://example.supabase.co/functions/v1/api" }];
source.info = {
  ...(source.info as Record<string, unknown>),
  title: "CASTLE THE ART Backend Console API",
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
process.stdout.write(`${outputPath}\n`);
