import { authenticate, bearerToken, type EdgeClients } from "./runtime.ts";
import type { PhotoProvider } from "./google-drive.ts";
import { createPostApprovalReportEdgeHandler } from "./post-approval-report-api.ts";
import { SupabasePostApprovalRoomIssueService } from "./post-approval-report-service.ts";
import { createPostApprovalEvidenceEdgeHandler } from "./post-approval-evidence-api.ts";
import {
  postApprovalRoomIssueEvidenceActorContext,
  SupabasePostApprovalRoomIssueEvidenceService,
} from "./post-approval-evidence-service.ts";
import { SupabasePostApprovalRoomIssueHandoverService } from "./post-approval-evidence-handover-service.ts";
import { preparePostApprovalRoomIssueHandover } from "./post-approval-evidence-handover-contract.ts";
import { AppError } from "./post-approval-report-error.ts";

export interface PostApprovalEdgeDependencies {
  clients: EdgeClients;
  provider: () => PhotoProvider;
  initializeDecoder: () => Promise<void>;
  /** Persistent dedicated server key; missing configuration blocks recovery only. */
  handoverFenceKey?: Uint8Array | (() => Uint8Array | undefined);
}

/** No provider/env access or background jobs on import/construction. Authentication
 * remains active-only; the original photo maid/limited guard is not reused here. */
export function createSupabasePostApprovalModuleEdgeHandler(
  dependencies: PostApprovalEdgeDependencies,
) {
  const { clients } = dependencies;
  const auth = async (request: Request) => ({
    ...await authenticate(request, clients),
    accessToken: bearerToken(request),
  });
  const reports = createPostApprovalReportEdgeHandler(
    new SupabasePostApprovalRoomIssueService(clients),
    auth,
  );
  const evidence = new SupabasePostApprovalRoomIssueEvidenceService(
    clients.admin,
    dependencies.provider,
    dependencies.initializeDecoder,
  );
  const handover = {
    recover: async (
      actor: Parameters<typeof evidence.status>[0],
      input: unknown,
      key: string,
    ) => {
      const trusted = postApprovalRoomIssueEvidenceActorContext(actor);
      if (actor.role !== "admin") {
        throw new AppError(403, "ADMIN_REQUIRED", "관리자 권한이 필요합니다.");
      }
      // Preserve auth/role/input precedence even for a directly injected caller.
      preparePostApprovalRoomIssueHandover(trusted, input, key);
      let material: Uint8Array | undefined;
      try {
        material = typeof dependencies.handoverFenceKey === "function"
          ? dependencies.handoverFenceKey()
          : dependencies.handoverFenceKey;
      } catch {
        /* Configuration failures have one safe, retryable projection. */
      }
      if (!(material instanceof Uint8Array) || material.byteLength !== 32) {
        throw new AppError(
          503,
          "POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED",
          "증빙 인계 설정을 확인해 주세요.",
        );
      }
      return new SupabasePostApprovalRoomIssueHandoverService(
        clients.admin,
        material,
        evidence,
      )
        .recover(actor, input, key);
    },
  };
  const evidenceHandler = createPostApprovalEvidenceEdgeHandler(
    evidence,
    handover,
    auth,
  );
  return async (request: Request, path?: string): Promise<Response | null> =>
    await reports(request, path) ?? await evidenceHandler(request, path);
}
