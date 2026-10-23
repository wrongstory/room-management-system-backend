import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';
import { postApprovalRoomIssueOpenApiFragment } from '../src/modules/post-approval-room-issues/post-approval-room-issue.openapi.js';

describe('deployed Swagger descriptions', () => {
  it('does not describe deployed memo-only and planning-date contracts as candidates', () => {
    const document = JSON.stringify(openApiDocument);
    expect(document).not.toContain('#446 미배포 후보');
    expect(document).not.toContain('#442 source 후보');
    expect(document).not.toContain('성능 계측 (source 후보)');
    expect(document).not.toContain('#474 메모 전용 등록은 미배포 후보');
    const fragment = JSON.stringify(postApprovalRoomIssueOpenApiFragment);
    expect(fragment).toContain('메모 전용 등록을 지원한다');
    expect(fragment).toContain('expectedEvidenceRevision: 0');
    expect(fragment).toContain('메모는 항상 필수다');
    expect(fragment).toContain('폭탄방 증빙의 사진 필수 조건은 변경하지 않는다');
  });
});
