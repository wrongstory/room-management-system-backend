import { handleHeldPhotoPurge } from "./index.ts";

Deno.test("actual photo purge entry remains held without inspecting credentials, body or caller unlock flags", async () => {
  for (const path of ["/photo-purge", "/functions/v1/photo-purge"]) {
    const request = new Request(`https://synthetic.invalid${path}`, {
      method: "POST",
      body: "do-not-read",
      headers: { "x-photo-purge-enabled": "true" },
    });
    Object.defineProperties(request, {
      headers: {
        get() {
          throw new Error("unexpected header inspection");
        },
      },
      body: {
        get() {
          throw new Error("unexpected body consumption");
        },
      },
    });
    const response = handleHeldPhotoPurge(request);
    if (
      response.status !== 503 ||
      response.headers.get("cache-control") !== "no-store" ||
      (await response.json()).error.code !== "PHOTO_PURGE_HELD"
    ) throw new Error("HOLD bypassed");
  }
});
Deno.test("actual photo purge entry rejects alternate routes and methods", () => {
  for (
    const [path, method, status] of [
      ["/photo-purge?enabled=true", "POST", 404],
      ["/photo-purge/execute", "POST", 404],
      ["/photo-purge", "DELETE", 405],
    ] as const
  ) {
    if (
      handleHeldPhotoPurge(
        new Request(`https://synthetic.invalid${path}`, { method }),
      ).status !== status
    ) throw new Error("route bypass");
  }
});
