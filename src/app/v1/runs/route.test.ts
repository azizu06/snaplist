import { describe, expect, it } from "vitest";
import { GET, runtime } from "./route";

describe("GET /v1/runs route adapter", () => {
  it("keeps the collection on the Node runtime and requires bearer authentication", async () => {
    expect(runtime).toBe("nodejs");

    const response = await GET(new Request("http://localhost/v1/runs"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required.",
        requestId: expect.any(String),
      },
    });
  });

  it("rejects non-GET methods at the shared HTTP boundary", async () => {
    const response = await GET(
      new Request("http://localhost/v1/runs", { method: "POST" }),
    );

    expect(response.status).toBe(405);
  });
});
