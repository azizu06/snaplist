import { describe, expect, it } from "vitest";
import { POST, runtime } from "./route";

describe("POST /v1/runs/{runId}/sharpen route adapter", () => {
  it("keeps guided identity correction on the authenticated Node boundary", async () => {
    expect(runtime).toBe("nodejs");

    const response = await POST(
      new Request(
        "http://localhost/v1/runs/59700000-0000-4000-8000-000000000001/sharpen",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedReviewRevision: "59700000-0000-4000-8000-000000000003",
            addedSpecs: ["Includes original charger"],
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
