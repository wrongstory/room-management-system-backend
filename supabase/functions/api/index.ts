import {
  authenticate,
  cors,
  createEdgeClients,
  EdgeError,
  errorResponse,
  jsonResponse,
  requestId,
  requireBusinessAdmin,
} from "../_shared/runtime.ts";

function routePath(url: string): string {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const functionIndex = segments.lastIndexOf("api");
  if (functionIndex < 0) {
    return "/";
  }
  return `/${segments.slice(functionIndex + 1).join("/")}`;
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let corsHeaders: Record<string, string> = {};
  try {
    corsHeaders = cors(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const path = routePath(request.url);
    if (request.method === "GET" && path === "/health") {
      return jsonResponse(
        {
          status: "ok",
          service: "room-management-system-edge-api",
          timestamp: new Date().toISOString(),
        },
        200,
        corsHeaders,
      );
    }

    const clients = createEdgeClients();
    const actor = await authenticate(request, clients);
    if (request.method === "GET" && path === "/v1/auth/me") {
      return jsonResponse({ user: actor }, 200, corsHeaders);
    }

    if (request.method === "GET" && path === "/v1/rooms") {
      if (actor.mustChangePassword) {
        throw new EdgeError(
          403,
          "PASSWORD_CHANGE_REQUIRED",
          "계속하려면 먼저 임시 비밀번호를 변경해 주세요.",
        );
      }
      requireBusinessAdmin(actor);
      const { data, error } = await clients.admin.rpc(
        "get_room_operational_projection",
        {
          p_actor_profile_id: actor.profileId,
          p_room_id: null,
        },
      );
      if (error) {
        throw new EdgeError(
          500,
          "ROOM_COMMAND_FAILED",
          "객실 정보를 처리하지 못했습니다.",
        );
      }
      return jsonResponse({ rooms: data ?? [] }, 200, corsHeaders);
    }

    throw new EdgeError(
      404,
      "ROUTE_NOT_FOUND",
      "요청한 API 경로를 찾을 수 없습니다.",
    );
  } catch (error) {
    return errorResponse(error, id, corsHeaders);
  }
});
