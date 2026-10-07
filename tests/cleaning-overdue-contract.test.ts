import { describe, expect, it } from "vitest";
import { openApiDocument } from "../supabase/functions/_shared/openapi.js";

describe("#308 retired deadline lifecycle contract", () => {
  it("advertises only the three still-supported strict lifecycle actions", () => {
    const variants = openApiDocument.components.schemas.AttemptLifecycleRequest.oneOf;
    expect(variants.map((variant) => variant.properties.action.const)).toEqual([
      "allow_finish", "allow_upload", "interrupt_handover",
    ]);
    expect(variants.every((variant) => variant.additionalProperties === false &&
      variant.required.includes("expectedProfileVersion"))).toBe(true);
  });
});
