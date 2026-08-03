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
          headers: {
            "content-type": "application/json",
            // A correction that would spend provider budget is rejected for a
            // missing key before it is rejected for a missing bearer, so the
            // request has to be otherwise valid to prove the auth boundary.
            "idempotency-key": "59700000-0000-4000-8000-00000000000a",
          },
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
