import type { SupabaseClients } from '../../lib/supabase.js';
import type { PhotoProvider } from '../photos/google-drive.js';
import { AppError } from '../../lib/app-error.js';
import { SupabasePostApprovalRoomIssueService } from './post-approval-room-issue.service.js';
import { postApprovalRoomIssueEvidenceActorContext, SupabasePostApprovalRoomIssueEvidenceService } from './post-approval-room-issue-evidence.service.js';
import { SupabasePostApprovalRoomIssueHandoverService } from './post-approval-room-issue-handover.service.js';
import { preparePostApprovalRoomIssueHandover } from './post-approval-room-issue-handover-contract.js';
import type { PostApprovalRoomIssueModuleServices } from './post-approval-room-issue.module.js';

export interface PostApprovalRoomIssueRuntimeDependencies {
  clients: SupabaseClients;
  provider: () => PhotoProvider;
  initializeDecoder: () => Promise<void>;
  /** Dedicated persistent 32-byte server key; never derive from PIN/Auth keys or generate per request. */
  handoverFenceKey?: Uint8Array;
}

/** Construction does not read env, start workers, register routes or contact providers.
 * Missing handover configuration must not disable source/report/status reads.
 */
export function createPostApprovalRoomIssueRuntime(
  dependencies: PostApprovalRoomIssueRuntimeDependencies
): PostApprovalRoomIssueModuleServices {
  const evidence = new SupabasePostApprovalRoomIssueEvidenceService(
    dependencies.clients.admin, dependencies.provider, dependencies.initializeDecoder
  );
  const fenceKey = dependencies.handoverFenceKey instanceof Uint8Array
    ? new Uint8Array(dependencies.handoverFenceKey) : undefined;
  let handoverService: SupabasePostApprovalRoomIssueHandoverService | undefined;
  const handover: PostApprovalRoomIssueModuleServices['handover'] = Object.freeze({
    async recover(actor, input, rawKey) {
      // Preserve caller/auth/request validation before the lazy configuration
      // boundary. No lease RPC or provider work may occur without the key.
      const trusted = postApprovalRoomIssueEvidenceActorContext(actor);
      if (actor.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
      preparePostApprovalRoomIssueHandover(trusted, input, rawKey);
      if (!fenceKey) throw new AppError(503, 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED', '증빙 인계 설정을 확인해 주세요.');
      handoverService ??= new SupabasePostApprovalRoomIssueHandoverService(
        dependencies.clients.admin, fenceKey, evidence
      );
      return handoverService.recover(actor, input, rawKey);
    }
  });
  return Object.freeze({
    reports: new SupabasePostApprovalRoomIssueService(dependencies.clients),
    evidence,
    handover
  });
}

/** Keep default app registration independent from provider/DB configuration.
 * The enclosing route authenticates and validates before it invokes a service.
 * Explicit forwarding preserves each initialized service's receiver and ensures
 * a single runtime is shared by reports, evidence and handover after first use. */
export function createLazyPostApprovalRoomIssueRuntime(
  initialize: () => PostApprovalRoomIssueModuleServices
): PostApprovalRoomIssueModuleServices {
  let runtime: PostApprovalRoomIssueModuleServices | undefined;
  const current = () => runtime ??= initialize();
  const reports = Object.freeze<PostApprovalRoomIssueModuleServices['reports']>({
    source: (actor, source) => current().reports.source(actor, source),
    list: (actor, source) => current().reports.list(actor, source),
    draft: (actor, source, report) => current().reports.draft(actor, source, report),
    saveDraft: (actor, input, key) => current().reports.saveDraft(actor, input, key),
    finalize: (actor, input, key) => current().reports.finalize(actor, input, key),
    report: (actor, source, report) => current().reports.report(actor, source, report),
    close: (actor, input, key) => current().reports.close(actor, input, key)
  });
  const evidence = Object.freeze<PostApprovalRoomIssueModuleServices['evidence']>({
    upload: (actor, input, key, readBody) => current().evidence.upload(actor, input, key, readBody),
    status: (actor, operation) => current().evidence.status(actor, operation),
    content: (actor, evidence, revision) => current().evidence.content(actor, evidence, revision)
  });
  const handover = Object.freeze<PostApprovalRoomIssueModuleServices['handover']>({
    recover: (actor, input, key) => current().handover.recover(actor, input, key)
  });
  return Object.freeze({ reports, evidence, handover });
}
