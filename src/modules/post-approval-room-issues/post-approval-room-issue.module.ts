import type { FastifyPluginAsync } from 'fastify';
import { createPostApprovalRoomIssueRoutes } from './post-approval-room-issue.routes.js';
import type { PostApprovalRoomIssueService } from './post-approval-room-issue.service.js';
import { createPostApprovalRoomIssueEvidenceRoutes, type PostApprovalRoomIssueEvidenceHttpService } from './post-approval-room-issue-evidence.routes.js';
import { createPostApprovalHandoverRoutes } from './post-approval-room-issue-handover.routes.js';
import type { SupabasePostApprovalRoomIssueHandoverService } from './post-approval-room-issue-handover.service.js';

export interface PostApprovalRoomIssueModuleServices {
  reports: PostApprovalRoomIssueService;
  evidence: PostApprovalRoomIssueEvidenceHttpService;
  handover: Pick<SupabasePostApprovalRoomIssueHandoverService, 'recover'>;
}

/** Composition candidate only. The enclosing app must supply verified auth hooks.
 * No keys, providers, workers or production routes are activated by importing this module.
 * Keep sibling scopes: evidence's raw-stream parser must not replace JSON parsers.
 */
export function createPostApprovalRoomIssueModule(services: PostApprovalRoomIssueModuleServices): FastifyPluginAsync {
  return async app => {
    await app.register(createPostApprovalRoomIssueRoutes(services.reports));
    await app.register(createPostApprovalRoomIssueEvidenceRoutes(services.evidence));
    await app.register(createPostApprovalHandoverRoutes(services.handover));
  };
}
