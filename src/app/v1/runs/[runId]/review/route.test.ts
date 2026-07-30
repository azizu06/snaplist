import { describe, expect, it } from "vitest";
import { PUT, runtime } from "./route";

describe("PUT /v1/runs/{runId}/review route adapter", () => {
  it("keeps Listing Review saves on the authenticated Node boundary", async () => {
    expect(runtime).toBe("nodejs");

    const response = await PUT(
      new Request(
        "http://localhost/v1/runs/54900000-0000-4000-8000-000000000001/review",
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "54900000-0000-4000-8000-000000000005",
          },
          body: JSON.stringify({
            expectedReviewRevision:
              "54900000-0000-4000-8000-000000000004",
            title: "Sony headphones",
            description: "Tested and working.",
            condition: "good",
            specifics: [{ name: "Brand", value: "Sony" }],
            sellerPriceOverride: null,
          }),
        },
      ),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required.",
        requestId: expect.any(String),
      },
    });
  });
});
