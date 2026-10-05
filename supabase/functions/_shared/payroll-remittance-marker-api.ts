import { readJsonBody } from "./account-api.ts";
import { assertPayrollResponseSize } from "./payroll-cursor.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requirePasswordChanged,
} from "./runtime.ts";
import {
  normalizeRemittanceCommand,
  PayrollRemittanceCursor,
  PayrollRemittanceError,
  type RemittanceCommand,
  remittanceDatabaseError,
  remittanceErrorStatus,
  type RemittanceHistoryInput,
  type RemittanceHistoryPage,
  remittanceHistoryProjection,
  type RemittanceInput,
  type RemittanceProjection,
  remittanceProjection,
  remittanceQuery,
  remittanceRequestFingerprint,
  remittanceRequestHash,
  type RemittanceSetInput,
} from "./payroll-remittance-marker-core.ts";

export async function payrollRemittanceMarker(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  sessionId: string,
  action: "get" | "set" | "reconfirm" | "history",
): Promise<RemittanceProjection | RemittanceHistoryPage> {
  requirePasswordChanged(actor);
  try {
    const write = action === "set" || action === "reconfirm";
    if (write && actor.role !== "admin") {
      throw new PayrollRemittanceError("ADMIN_REQUIRED");
    }
    if (actor.role !== "admin" && actor.role !== "maid") {
      throw new PayrollRemittanceError("PAYROLL_ACCESS_REQUIRED");
    }
    const search = new URL(request.url).searchParams;
    if (write && [...search.keys()].length !== 0) {
      throw new PayrollRemittanceError("VALIDATION_ERROR");
    }
    const input = write
      ? normalizeRemittanceCommand(
        await readJsonBody(request),
        request.headers.get("idempotency-key"),
        action === "set",
      )
      : remittanceQuery(search, action === "history");
    if (
      actor.role === "maid" &&
      actor.profileId.toLowerCase() !== input.maidProfileId
    ) throw new PayrollRemittanceError("PAYROLL_ACCESS_REQUIRED");
    const common = {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId.toLowerCase(),
      p_expected_actor_role: actor.role,
      p_maid_profile_id: input.maidProfileId,
      p_week_start: input.weekStart,
    };
    if (action === "history") {
      const history = input as RemittanceHistoryInput;
      const cursors = new PayrollRemittanceCursor(
        Deno.env.get("PAYROLL_CURSOR_HMAC_SECRET")?.trim() ?? "",
      );
      const scope = await cursors.scope(
        actor.profileId,
        actor.role,
        sessionId,
        history,
      );
      const after = history.cursor
        ? await cursors.decode(history.cursor, scope)
        : null;
      const { data, error } = await clients.admin.rpc(
        "list_payroll_remittance_marker_history",
        { ...common, p_after_version: after, p_limit: history.limit },
      );
      if (error) throw remittanceDatabaseError(error);
      assertPayrollResponseSize(data);
      const page = remittanceHistoryProjection(data, history, after);
      const response = {
        maidProfileId: history.maidProfileId,
        weekStart: history.weekStart,
        entries: page.entries,
        nextCursor: page.hasMore && page.lastVersion !== null
          ? await cursors.encode(scope, page.lastVersion)
          : null,
      };
      assertPayrollResponseSize(response);
      return response;
    }
    const command = input as RemittanceCommand;
    const { data, error } = await clients.admin.rpc(
      action === "get"
        ? "get_payroll_remittance_marker"
        : action === "set"
        ? "set_payroll_remittance_marker"
        : "reconfirm_payroll_remittance_marker",
      {
        ...common,
        ...(write
          ? {
            p_expected_version: command.expectedVersion,
            p_expected_basis_fingerprint: command.expectedBasisFingerprint,
            p_idempotency_key: command.idempotencyKey,
            p_request_hash: await remittanceRequestHash(
              remittanceRequestFingerprint(
                actor.profileId,
                command,
                action === "set",
              ),
            ),
            ...(action === "set"
              ? { p_marked: (input as RemittanceSetInput).marked }
              : {}),
          }
          : {}),
      },
    );
    if (error) throw remittanceDatabaseError(error);
    assertPayrollResponseSize(data);
    const response = remittanceProjection(
      data,
      input as RemittanceInput,
      actor.role,
    );
    assertPayrollResponseSize(response);
    return response;
  } catch (error) {
    if (error instanceof PayrollRemittanceError) {
      throw new EdgeError(
        remittanceErrorStatus(error.code),
        error.code,
        "송금 표시 정보를 처리하지 못했습니다.",
      );
    }
    throw error;
  }
}
