import { handlePhotoPurge, PhotoPurgeWorker } from "./photo-purge.ts";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("photo purge assertion failed");
}
Deno.test("dedicated purge route refuses client credentials, aliases, clock and body", async () => {
  const secret = "synthetic-photo-purge-secret-at-least-32";
  let calls = 0;
  const run = async () => {
    calls++;
    return {
      claimed: 0,
      deleted: 0,
      notFound: 0,
      retryable: 0,
      deferred: 0,
      blocked: 0,
      acceptedClaimed: 0,
      orphanClaimed: 0,
      folderClaimed: 0,
    };
  };
  for (
    const [path, method, body, header, expected] of [
      ["/photo-purge", "POST", undefined, undefined, 401],
      ["/photo-purge/extra", "POST", undefined, secret, 404],
      ["/photo-purge?now=2026-01-01", "POST", undefined, secret, 404],
      ["/photo-purge", "GET", undefined, secret, 405],
      ["/photo-purge", "POST", "{}", secret, 400],
      ["/photo-purge", "POST", "", secret, 200],
    ] as const
  ) {
    const response = await handlePhotoPurge(
      new Request(`https://local.invalid${path}`, {
        method,
        body,
        headers: header ? { "x-photo-purge-secret": header } : {},
      }),
      secret,
      run,
    );
    assert(response.status === expected);
    assert(!response.headers.has("access-control-allow-origin"));
    assert(!(await response.text()).includes(secret));
  }
  assert(calls === 1);
});
Deno.test("DB rejects stale due/fence before deletion and raw errors are not reflected", async () => {
  let deletes = 0;
  const worker = new PhotoPurgeWorker({
    rpc: async (name) =>
      name === "claim_due_photo_purges"
        ? {
          data: {
            items: [{
              objectId: "00000000-0000-4000-8000-000000000001",
              leaseVersion: 1,
            }],
            blocked: 0,
          },
          error: null,
        }
        : { data: null, error: { message: "private provider locator" } },
  }, {
    purgeRemove: async () => {
      deletes++;
      return "deleted";
    },
    purgeExists: async () => true,
    purgeEmptyFolder: async () => "empty",
  });
  let code = "";
  try {
    await worker.run();
  } catch (error) {
    code = (error as Error).message;
  }
  assert(code === "PHOTO_PURGE_FAILED" && deletes === 0);
});
