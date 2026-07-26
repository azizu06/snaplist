import { afterEach, describe, expect, it, vi } from "vitest";

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import { POST } from "./route";

const keys = [
  "APP_ATTEST_APP_ID",
  "APP_ATTEST_ENVIRONMENT",
  "APP_ATTEST_CHALLENGE_TTL_SECONDS",
] as const;

afterEach(() => {
  for (const key of keys) delete process.env[key];
  createAdminClient.mockReset();
});

function configure() {
  process.env.APP_ATTEST_APP_ID = "TEAMID1234.dev.snaplist.ios";
  process.env.APP_ATTEST_ENVIRONMENT = "production";
  process.env.APP_ATTEST_CHALLENGE_TTL_SECONDS = "300";
}

describe("App Attest route", () => {
  it("returns typed unavailable without configuration or database authority", async () => {
    const response = await POST(
      new Request("https://snaplist.dev/api/app-attest", {
        body: "{}",
        method: "POST",
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      data: { code: "service_unavailable", status: "unavailable" },
    });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("rejects malformed evidence before creating private persistence authority", async () => {
    configure();
    const response = await POST(
      new Request("https://snaplist.dev/api/app-attest", {
        body: "{}",
        method: "POST",
      }),
    );
    expect(response.status).toBe(400);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("issues one bounded challenge through only the narrow RPC", async () => {
    configure();
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    createAdminClient.mockReturnValue({ rpc });
    const response = await POST(
      new Request("https://snaplist.dev/api/app-attest", {
        body: JSON.stringify({ kind: "attestation", operation: "challenge" }),
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ kind: "attestation" });
    expect(Buffer.from(body.data.challenge, "base64url")).toHaveLength(32);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0]?.[0]).toBe("issue_app_attest_challenge");
  });
});
