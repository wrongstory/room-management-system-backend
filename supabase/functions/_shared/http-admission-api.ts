import {
  type AdmissionConfig,
  admissionConfig,
  type AdmissionRpc,
  assertAdmissionTarget,
  beginHttpAdmission,
  HttpAdmissionError,
  httpAdmissionRoute,
  withAdmissionRpc,
  withAtomicAdmissionRpc,
} from "./http-admission.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  verifiedRequestSessionId,
} from "./runtime.ts";

interface AdmissionOptions {
  operationAdmissionConfig?: AdmissionConfig | null;
  operationAdmissionRpc?: AdmissionRpc;
}
function configFor(options: AdmissionOptions): AdmissionConfig | undefined {
  const mode = options.operationAdmissionConfig === undefined
    ? Deno.env.get("DEVELOPER_OPERATION_ADMISSION_MODE")
    : undefined;
  const config = options.operationAdmissionConfig === null
    ? undefined
    : options.operationAdmissionConfig ??
      admissionConfig(
        mode,
        mode === "required"
          ? Deno.env.get("DEVELOPER_OPERATION_TARGET")
          : undefined,
        mode === "required"
          ? Deno.env.get("DEVELOPER_OPERATION_BUDGET_MS")
          : undefined,
      );
  if (options.operationAdmissionConfig === undefined && config) {
    assertAdmissionTarget(config, Deno.env.get("SUPABASE_URL"));
  }
  return config;
}

/** Installed before authentication, including GET routes and error audits. */
export function installAtomicHttpAdmission(
  clients: EdgeClients,
  options: AdmissionOptions,
): void {
  const config = configFor(options);
  if (!config) return;
  clients.admin = withAtomicAdmissionRpc(clients.admin, {
    config,
    rpc: options.operationAdmissionRpc,
    error: () =>
      new EdgeError(
        503,
        "OPERATION_ATOMIC_RPC_UNAVAILABLE",
        "현재 작업을 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      ),
  });
}

export async function prepareHttpAdmission(
  request: Request,
  path: string,
  clients: EdgeClients,
  actor: () => Promise<EdgeActor | undefined>,
  options: AdmissionOptions,
): Promise<void> {
  const route = httpAdmissionRoute(request.method, path);
  if (!route) return;
  try {
    const config = configFor(options);
    if (!config) return;
    const scope = await beginHttpAdmission({
      config,
      route,
      identity: async () => {
        if (route.routeId === "AUTH_LOGIN") return undefined;
        const current = await actor();
        return current
          ? {
            profileId: current.profileId,
            authUserId: current.authUserId,
            sessionId: verifiedRequestSessionId(request),
          }
          : undefined;
      },
      rpc: options.operationAdmissionRpc ?? (async (name, args, signal) => {
        const result = await clients.admin.rpc(name, args).abortSignal(signal);
        return { data: result.data, error: result.error };
      }),
    });
    if (scope) {
      clients.operationAdmission = () => scope;
      clients.admin = withAdmissionRpc(clients.admin, () => scope);
    }
  } catch (error) {
    if (error instanceof HttpAdmissionError) {
      throw new EdgeError(
        error.status,
        error.code,
        "현재 작업을 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
    throw error;
  }
}
