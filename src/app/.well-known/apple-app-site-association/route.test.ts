import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("Apple app site association route", () => {
  it("serves the native HTTPS callback association directly", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      webcredentials: {
        apps: ["35YFS8XJRQ.dev.snaplist.ios"],
      },
    });
  });
});
