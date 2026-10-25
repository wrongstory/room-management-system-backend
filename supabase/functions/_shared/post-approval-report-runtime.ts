import { authenticate, bearerToken, type EdgeClients } from "./runtime.ts";
import { createPostApprovalReportEdgeHandler } from "./post-approval-report-api.ts";
import { SupabasePostApprovalRoomIssueService } from "./post-approval-report-service.ts";

/** Explicit construction only; importing this does not activate a route or read secrets. */
export function createSupabasePostApprovalReportEdgeHandler(
  clients: EdgeClients,
) {
  return createPostApprovalReportEdgeHandler(
    new SupabasePostApprovalRoomIssueService(clients),
    async (request) => ({
      ...await authenticate(request, clients),
      accessToken: bearerToken(request),
    }),
  );
}
