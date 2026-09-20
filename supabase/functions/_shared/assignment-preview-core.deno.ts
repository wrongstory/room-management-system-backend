import { optimizeAssignmentPreview } from "./assignment-preview-core.ts";

Deno.test("preview core works without duration policy", async () => {
  const result = await optimizeAssignmentPreview({
    serviceDate: "2037-01-05",
    planningAt: "2037-01-05T09:00:00+09:00",
    durationPolicy: null,
    maids: [],
    targets: [],
  }, "test");
  if (
    !result.decisionReady || result.durationPolicy !== null ||
    result.durationPolicyStatus !== "retired" || result.durationPolicyRequired
  ) throw new Error("Retired duration policy contract failure");
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

Deno.test("historical duration policy does not affect preview fingerprint", async () => {
  const base = {
    serviceDate: "2037-01-05",
    planningAt: "2037-01-05T09:00:00+09:00",
    maids: [],
    targets: [],
  };
  const withoutPolicy = await optimizeAssignmentPreview(base, "a");
  const withPolicy = await optimizeAssignmentPreview({
    ...base,
    durationPolicy: {
      version: 99,
      status: "confirmed",
      standardMinutes: 1,
      premiumMinutes: 2,
      oceanPremiumMinutes: 3,
      oceanFamilyMinutes: 4,
    },
  }, "b");
  if (withoutPolicy.inputFingerprint !== withPolicy.inputFingerprint) {
    throw new Error("Historical policy influenced preview fingerprint");
  }
});
