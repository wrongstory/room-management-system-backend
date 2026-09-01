import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const portalSourceDirectory = resolve(projectRoot, "docs", "swagger-portal");
const maximumSpecBytes = 2 * 1024 * 1024;
const openApiMethods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
]);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`알 수 없는 인자입니다: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} 값이 필요합니다.`);
    }
    values.set(argument, value);
    index += 1;
  }
  return values;
}

function validateApiBaseUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("운영 API base URL은 HTTPS여야 합니다.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("운영 API base URL에는 자격증명, query, fragment를 넣을 수 없습니다.");
  }
  if (!parsed.hostname.endsWith(".supabase.co")) {
    throw new Error("운영 API base URL은 Supabase project domain이어야 합니다.");
  }
  if (!parsed.pathname.endsWith("/functions/v1/api")) {
    throw new Error("운영 API base URL 경로는 /functions/v1/api로 끝나야 합니다.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function parseExpectedCount(rawValue, argumentName) {
  const count = Number(rawValue);
  if (!Number.isInteger(count) || count < 1 || count > 5_000) {
    throw new Error(`${argumentName}은 1~5000 정수여야 합니다.`);
  }
  return count;
}

async function readOpenApiFromUrl(sourceUrl) {
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("OpenAPI source URL은 HTTPS여야 합니다.");
  }
  const response = await fetch(parsed, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`OpenAPI 다운로드 실패: HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`OpenAPI 응답 Content-Type이 JSON이 아닙니다: ${contentType}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maximumSpecBytes) {
    throw new Error("OpenAPI 응답이 허용 크기를 초과했습니다.");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maximumSpecBytes) {
    throw new Error("OpenAPI 응답이 허용 크기를 초과했습니다.");
  }
  return body;
}

function validateOpenApi(document, expectedPathCount, expectedOperationCount) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("OpenAPI 문서는 JSON object여야 합니다.");
  }
  if (typeof document.openapi !== "string" || !document.openapi.startsWith("3.1.")) {
    throw new Error("OpenAPI 3.1 문서만 배포할 수 있습니다.");
  }
  if (
    !document.info ||
    typeof document.info.title !== "string" ||
    document.info.title !== "CASTLE THE ART Room Management API" ||
    typeof document.info.version !== "string" ||
    !/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(document.info.version)
  ) {
    throw new Error("예상한 객실관리 API title/version 계약이 아닙니다.");
  }
  if (!document.paths || typeof document.paths !== "object" || Array.isArray(document.paths)) {
    throw new Error("OpenAPI paths가 없습니다.");
  }
  const pathNames = Object.keys(document.paths);
  if (pathNames.length === 0 || pathNames.length > 500) {
    throw new Error("OpenAPI path 수가 허용 범위를 벗어났습니다.");
  }
  for (const requiredPath of ["/health", "/openapi.json", "/v1/auth/login"]) {
    if (!(requiredPath in document.paths)) {
      throw new Error(`필수 운영 path가 없습니다: ${requiredPath}`);
    }
  }
  const operationCount = Object.values(document.paths).reduce(
    (count, pathItem) =>
      count + (
        pathItem && typeof pathItem === "object" && !Array.isArray(pathItem)
          ? Object.keys(pathItem).filter((method) => openApiMethods.has(method)).length
          : 0
      ),
    0,
  );
  if (pathNames.length !== expectedPathCount) {
    throw new Error(
      `운영 OpenAPI path 수가 release 계약과 다릅니다: expected=${expectedPathCount} actual=${pathNames.length}`,
    );
  }
  if (operationCount !== expectedOperationCount) {
    throw new Error(
      `운영 OpenAPI operation 수가 release 계약과 다릅니다: expected=${expectedOperationCount} actual=${operationCount}`,
    );
  }
  return { pathNames, operationCount };
}

function replaceRequired(template, replacements) {
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!rendered.includes(placeholder)) {
      throw new Error(`portal template placeholder가 없습니다: ${placeholder}`);
    }
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (/__[A-Z0-9_]+__/.test(rendered)) {
    throw new Error("치환되지 않은 portal template placeholder가 있습니다.");
  }
  return rendered;
}

export async function buildSwaggerPortal({
  sourceUrl,
  sourceFile,
  apiBaseUrl,
  outputDirectory,
  expectedPathCount,
  expectedOperationCount,
  generatedAt = new Date(),
}) {
  if (Boolean(sourceUrl) === Boolean(sourceFile)) {
    throw new Error("sourceUrl 또는 sourceFile 중 정확히 하나가 필요합니다.");
  }
  const normalizedApiBaseUrl = validateApiBaseUrl(apiBaseUrl);
  if (sourceUrl) {
    const expectedSourceUrl = `${normalizedApiBaseUrl}/openapi.json`;
    if (new URL(sourceUrl).toString() !== expectedSourceUrl) {
      throw new Error("OpenAPI source URL은 운영 API base URL의 /openapi.json이어야 합니다.");
    }
  }
  const rawDocument = sourceUrl
    ? await readOpenApiFromUrl(sourceUrl)
    : await readFile(resolve(sourceFile), "utf8");
  const document = JSON.parse(rawDocument);
  const { pathNames, operationCount } = validateOpenApi(
    document,
    expectedPathCount,
    expectedOperationCount,
  );

  document.servers = [
    {
      url: normalizedApiBaseUrl,
      description: "운영 Supabase Edge API",
    },
  ];
  document["x-github-pages-portal"] = {
    generatedAt: generatedAt.toISOString(),
    source: sourceUrl ?? "local-fixture",
    readOnly: true,
  };

  const serializedDocument = `${JSON.stringify(document, null, 2)}\n`;
  const digest = createHash("sha256").update(serializedDocument).digest("hex");
  const template = await readFile(resolve(portalSourceDirectory, "index.template.html"), "utf8");
  const renderedIndex = replaceRequired(template, {
    __OPENAPI_INFO_VERSION__: document.info.version,
    __OPENAPI_PATH_COUNT__: String(pathNames.length),
    __GENERATED_AT_KST__: new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Seoul",
    }).format(generatedAt),
    __OPENAPI_SHA256_SHORT__: digest.slice(0, 12),
    __API_BASE_URL__: normalizedApiBaseUrl,
  });

  const destination = resolve(outputDirectory);
  await mkdir(destination, { recursive: true });
  await Promise.all([
    writeFile(resolve(destination, "index.html"), renderedIndex, "utf8"),
    writeFile(resolve(destination, "openapi.json"), serializedDocument, "utf8"),
    writeFile(
      resolve(destination, "portal-manifest.json"),
      `${JSON.stringify(
        {
          generatedAt: generatedAt.toISOString(),
          source: sourceUrl ?? "local-fixture",
          apiBaseUrl: normalizedApiBaseUrl,
          openApi: document.openapi,
          apiVersion: document.info.version,
          pathCount: pathNames.length,
          operationCount,
          sha256: digest,
          readOnly: true,
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    copyFile(resolve(portalSourceDirectory, "portal.css"), resolve(destination, "portal.css")),
    copyFile(
      resolve(portalSourceDirectory, "swagger-initializer.js"),
      resolve(destination, "swagger-initializer.js"),
    ),
    copyFile(resolve(portalSourceDirectory, "og.png"), resolve(destination, "og.png")),
    writeFile(resolve(destination, ".nojekyll"), "", "utf8"),
  ]);

  return {
    outputDirectory: destination,
    apiVersion: document.info.version,
    pathCount: pathNames.length,
    operationCount,
    sha256: digest,
  };
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const sourceUrl = argumentsMap.get("--source-url");
  const sourceFile = argumentsMap.get("--source-file");
  const apiBaseUrl = argumentsMap.get("--api-base-url") ?? process.env.PUBLIC_API_BASE_URL;
  const outputDirectory = argumentsMap.get("--output-dir") ?? resolve(projectRoot, ".tmp", "swagger-site");
  const expectedPathCount = parseExpectedCount(
    argumentsMap.get("--expected-path-count"),
    "--expected-path-count",
  );
  const expectedOperationCount = parseExpectedCount(
    argumentsMap.get("--expected-operation-count"),
    "--expected-operation-count",
  );
  if (!apiBaseUrl) {
    throw new Error("--api-base-url 또는 PUBLIC_API_BASE_URL이 필요합니다.");
  }
  const result = await buildSwaggerPortal({
    sourceUrl,
    sourceFile,
    apiBaseUrl,
    outputDirectory,
    expectedPathCount,
    expectedOperationCount,
  });
  process.stdout.write(
    `Swagger portal build PASS: version=${result.apiVersion} paths=${result.pathCount} operations=${result.operationCount} sha256=${result.sha256}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
