import {
  AssignmentPreviewError,
  optimizeAssignmentPreview,
} from "./assignment-preview-core.ts";

Deno.test("preview core never falls back to demo durations", async () => {
  try {
    await optimizeAssignmentPreview({
      serviceDate: "2037-01-05",
      planningAt: "2037-01-05T09:00:00+09:00",
      durationPolicy: null,
      maids: [],
      targets: [],
    }, "test");
    throw new Error("Expected fail-closed");
  } catch (error) {
    if (
      !(error instanceof AssignmentPreviewError) ||
      error.code !== "ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED"
    ) throw error;
  }
});
Deno.test("preview core canonical fingerprint and seed reproducibility are runtime neutral", async () => {
  const snapshot = {
    serviceDate: "2037-01-05",
    planningAt: "2037-01-05T09:00:00+09:00",
    durationPolicy: {
      version: 1,
      status: "confirmed",
      standardMinutes: 30,
      premiumMinutes: 40,
      oceanPremiumMinutes: 50,
      oceanFamilyMinutes: 60,
    },
    maids: [],
    targets: [],
  };
  const first = await optimizeAssignmentPreview(snapshot, "seed"),
    second = await optimizeAssignmentPreview(snapshot, "seed");
  if (
    JSON.stringify(first) !== JSON.stringify(second) || !first.decisionReady ||
    first.inputFingerprint.length !== 64
  ) throw new Error("Preview reproducibility failure");
});
