import { createSupabasePostApprovalReportEdgeHandler } from "./post-approval-report-runtime.ts";
import type { EdgeClients } from "./runtime.ts";
const id = (n: number) =>
  `a3360000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const token = `header.${
  btoa(JSON.stringify({ session_id: id(2) })).replace(/=/g, "")
}.signature`;
const url = `https://synthetic.invalid/v1/cleaning-history/submissions/${
  id(3)
}/supplemental-room-issues/source`;
function assert(value: unknown): asserts value {
  if (!value) throw new Error("Synthetic runtime assertion failed");
}
for (
  const stage of [
    "success",
    "invalid-token",
    "inactive",
    "session-revoked",
    "rpc-session-revoked",
  ] as const
) {
  Deno.test(`report Edge runtime authenticates before domain RPC: ${stage}`, async () => {
    const calls: string[] = [];
    const clients = {
      publicClient: {
        auth: {
          getUser(received: string) {
            assert(received === token);
            calls.push("auth");
            return Promise.resolve({
              data: { user: stage === "invalid-token" ? null : { id: id(9) } },
              error: null,
            });
          },
        },
      },
      admin: {
        from(table: string) {
          assert(table === "profiles");
          calls.push("profile");
          return {
            select: () => ({
              eq: (column: string, value: string) => {
                assert(column === "auth_user_id" && value === id(9));
                return {
                  single: () =>
                    Promise.resolve({
                      data: {
                        id: id(1),
                        auth_user_id: id(9),
                        display_name: "synthetic",
                        role: "maid",
                        status: stage === "inactive" ? "inactive" : "active",
                        must_change_password: false,
                      },
                      error: null,
                    }),
                };
              },
            }),
          };
        },
        rpc(name: string, args: Record<string, unknown>) {
          calls.push(name);
          assert(args.p_session_id === id(2));
          if (name === "is_active_auth_session") {
            return Promise.resolve({
              data: stage !== "session-revoked",
              error: null,
            });
          }
          assert(
            name === "get_post_approval_room_issue_source" &&
              args.p_actor_profile_id === id(1),
          );
          return Promise.resolve({
            data: {
              source: {
                sourceSubmissionId: id(3),
                originalPerformerProfileId: id(1),
                sourceStatus: "approved",
              },
            },
            error: stage === "rpc-session-revoked"
              ? { message: "SESSION_REVOKED" }
              : null,
          });
        },
      },
    } as unknown as EdgeClients;
    const handler = createSupabasePostApprovalReportEdgeHandler(clients);
    assert([...calls].length === 0);
    const response = await handler(
      new Request(url, { headers: { authorization: `Bearer ${token}` } }),
    );
    assert(
      response?.status ===
        (stage === "success" ? 200 : stage === "inactive" ? 403 : 401),
    );
    const count = stage === "invalid-token"
      ? 1
      : stage === "inactive"
      ? 2
      : stage === "session-revoked"
      ? 3
      : 4;
    assert(calls.length === count);
    assert(response.headers.get("cache-control") === "no-store");
  });
}
