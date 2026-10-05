import { assertPayrollResponseSize } from "./payroll-cursor.ts";
import {
  payrollWorkDatabaseErrorCode,
  PayrollWorkDetailsError,
  payrollWorkErrorStatus,
  type PayrollWorkPage,
  payrollWorkProjection,
  payrollWorkQuery,
} from "./payroll-work-details-core.ts";
import {
  decodePayrollWorkCursor,
  encodePayrollWorkCursor,
  payrollWorkScope,
} from "./payroll-work-details-cursor.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requirePasswordChanged,
} from "./runtime.ts";

export async function listPayrollWorkDetails(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  sessionId: string,
): Promise<PayrollWorkPage> {
  requirePasswordChanged(actor);
  if (actor.role !== "admin" && actor.role !== "maid") {
    throw new EdgeError(
      403,
      "PAYROLL_ACCESS_REQUIRED",
      "주급 조회 권한이 필요합니다.",
    );
  }
  try {
    const input = payrollWorkQuery(new URL(request.url).searchParams);
    if (
      actor.role === "maid" &&
      actor.profileId.toLowerCase() !== input.maidProfileId
    ) throw new PayrollWorkDetailsError("PAYROLL_ACCESS_REQUIRED");
    const scope = await payrollWorkScope(
      actor.profileId,
      actor.role,
      sessionId,
      input,
    );
    const after = input.cursor
      ? await decodePayrollWorkCursor(input.cursor, scope)
      : null;
    const { data, error } = await clients.admin.rpc(
      "list_payroll_work_details_page",
      {
        p_actor_profile_id: actor.profileId,
        p_session_id: sessionId.toLowerCase(),
        p_expected_actor_role: actor.role,
        p_week_start: input.weekStart,
        p_maid_profile_id: input.maidProfileId,
        p_kind: input.kind,
        p_after_entry_date: after?.entryDate ?? null,
        p_after_entry_id: after?.entryId ?? null,
        p_limit: input.limit,
      },
    );
    if (error) {
      throw new PayrollWorkDetailsError(payrollWorkDatabaseErrorCode(error));
    }
    assertPayrollResponseSize(data);
    const page = payrollWorkProjection(data, input, after);
    const response: PayrollWorkPage = {
      weekStart: page.weekStart,
      maidProfileId: page.maidProfileId,
      kind: page.kind,
      summary: page.summary,
      entries: page.entries,
      nextCursor: page.hasMore && page.lastEntryDate && page.lastEntryId
        ? await encodePayrollWorkCursor(scope, {
          entryDate: page.lastEntryDate,
          entryId: page.lastEntryId,
        })
        : null,
    };
    assertPayrollResponseSize(response);
    return response;
  } catch (error) {
    if (error instanceof PayrollWorkDetailsError) {
      throw new EdgeError(
        payrollWorkErrorStatus(error.code),
        error.code,
        "주급 상세 정보를 처리하지 못했습니다.",
      );
    }
    throw error;
  }
}
