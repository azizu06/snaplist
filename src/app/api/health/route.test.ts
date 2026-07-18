import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("proves the production runtime composes and resolves the Scout contract", async () => {
    const response = GET();

    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "snaplist",
      contracts: {
        scoutGuidance: {
          version: "scout-guidance-v1",
          state: "onboarding.outcome",
          title: "Photograph an item to check sold comps and prepare a listing.",
        },
      },
    });
  });
});
