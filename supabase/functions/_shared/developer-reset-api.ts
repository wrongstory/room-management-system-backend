import { readResetPreview, ResetPreviewError } from "./reset-preview.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requireDeveloper,
  requirePasswordChanged,
  verifiedRequestSessionId,
} from "./runtime.ts";

export async function developerResetPreview(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requirePasswordChanged(actor);
  requireDeveloper(actor);
  if (new URL(request.url).search) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "조회 조건을 지정할 수 없습니다.",
      { "Cache-Control": "no-store" },
    );
  }
  try {
    return await readResetPreview(
      async (name, args, signal) => {
        const { data, error } = await clients.admin.rpc(name, args).abortSignal(
          signal,
        );
        return { data, error };
      },
      actor,
      verifiedRequestSessionId(request),
    );
  } catch (error) {
    if (error instanceof ResetPreviewError) {
      throw new EdgeError(
        error.status,
        error.code,
        "초기화 영향 조회 조건을 확인해 주세요.",
        { "Cache-Control": "no-store" },
      );
    }
    if (error instanceof EdgeError) throw error;
    throw new EdgeError(
      503,
      "RESET_PREVIEW_UNAVAILABLE",
      "초기화 영향을 조회하지 못했습니다.",
      { "Cache-Control": "no-store" },
    );
  }
}
