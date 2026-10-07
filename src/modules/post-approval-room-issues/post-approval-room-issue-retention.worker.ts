import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import { requestHash } from '../../lib/command.js';
import type { PhotoProvider } from '../photos/google-drive.js';
import type { PostApprovalRoomIssueEvidenceRpc } from './post-approval-room-issue-evidence.service.js';

const id = z.uuid().transform(value => value.toLowerCase());
const lease = z.int().min(1).max(8);
const claimSchema = z.object({ items: z.array(z.object({ objectId: id, leaseVersion: lease })).max(10), blocked: z.int().min(0).max(10) })
  .refine(value => new Set(value.items.map(item => item.objectId)).size === value.items.length);
const contextSchema = z.object({ objectId: id, deleteToken: id, fileId: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/).nullable() });
const settledSchema = z.object({ status: z.enum(['purged', 'retryable']) });
function invalid(): AppError { return new AppError(503, 'POST_APPROVAL_ROOM_ISSUE_RETENTION_RETRY_REQUIRED', '증빙 보존 정리를 다시 확인해야 합니다.'); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try { const parsed = schema.safeParse(value); if (parsed.success) return parsed.data; } catch { /* Never serialize provider/SQL data. */ }
  throw invalid();
}

/** Separate service-only worker boundary. No user/session authority and no upload/finalize RPC reuse.
 * Source-only/unregistered: constructing this worker does not schedule Cron or activate provider DELETE.
 */
export class PostApprovalRoomIssueRetentionWorker {
  constructor(private readonly database: PostApprovalRoomIssueEvidenceRpc, private readonly provider: () => Pick<PhotoProvider, 'remove'>) {}
  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    try { const result = await this.database.rpc(name, args); if (result.error) throw invalid(); return result.data; }
    catch { throw invalid(); }
  }
  async run(limit = 10): Promise<{ claimed: number; purged: number; retrying: number; blocked: number }> {
    const bounded = z.int().min(1).max(10).safeParse(limit);
    if (!bounded.success) throw new AppError(400, 'VALIDATION_ERROR', '정리 batch 상한을 확인해 주세요.');
    const digest = requestHash({ worker: 'post_approval_room_issue_retention', nonce: randomUUID() });
    const claim = parse(claimSchema, await this.rpc('claim_post_approval_room_issue_purges', { p_claim_digest: digest, p_limit: bounded.data }));
    if (claim.items.length > bounded.data) throw invalid();
    let purged = 0, retrying = 0;
    for (const item of claim.items) {
      const args = { p_object_id: item.objectId, p_lease_version: item.leaseVersion, p_claim_digest: digest };
      try {
        // Context commits the permanent DELETE barrier before any provider call.
        // A second read verifies current worker fence/references immediately before DELETE.
        const prepared = parse(contextSchema, await this.rpc('get_post_approval_room_issue_purge_context', args));
        const live = parse(contextSchema, await this.rpc('get_post_approval_room_issue_purge_context', args));
        if (prepared.objectId !== item.objectId || live.objectId !== item.objectId || prepared.deleteToken !== live.deleteToken
          || prepared.fileId !== live.fileId) throw invalid();
        let outcome: 'deleted' | 'not_found' | 'retryable' = 'not_found';
        if (live.fileId !== null) {
          try { outcome = await this.provider().remove(live.fileId); }
          catch { outcome = 'retryable'; }
        }
        const settled = parse(settledSchema, await this.rpc('settle_post_approval_room_issue_purge', { ...args, p_outcome: outcome }));
        if (settled.status === 'purged' && outcome !== 'retryable') purged++; else retrying++;
      } catch {
        // Lost DELETE/settle response is not success. Durable barrier and immutable
        // identity survive for the next bounded lease; no locator is logged/returned.
        retrying++;
      }
    }
    return { claimed: claim.items.length, purged, retrying, blocked: claim.blocked };
  }
}
