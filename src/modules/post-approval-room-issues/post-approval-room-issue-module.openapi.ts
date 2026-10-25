import { postApprovalRoomIssueOpenApiFragment } from './post-approval-room-issue.openapi.js';
import { postApprovalRoomIssueEvidenceOpenApiFragment, postApprovalRoomIssueHandoverOpenApiFragment } from './post-approval-room-issue-evidence.openapi.js';

/** Complete module contract for release integration. Not a deployment claim:
 * the published Edge document must only include this after runtime parity gates.
 */
export const postApprovalRoomIssueModuleOpenApiFragment = {
  paths: {
    ...postApprovalRoomIssueOpenApiFragment.paths,
    ...postApprovalRoomIssueEvidenceOpenApiFragment.paths,
    ...postApprovalRoomIssueHandoverOpenApiFragment.paths
  }
} as const;
