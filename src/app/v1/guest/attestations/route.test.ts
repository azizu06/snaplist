import { beforeEach, describe, expect, it, vi } from "vitest";

const { createConfiguredGuestClaimHandoff, enforceAppAttestRateLimit } = vi.hoisted(
  () => ({
    createConfiguredGuestClaimHandoff: vi.fn(),
    enforceAppAttestRateLimit: vi.fn(),
  }),
);

vi.mock("@/lib/abuse", () => ({ enforceAppAttestRateLimit }));
vi.mock("@/lib/app-attest/configured-guest-handoff", () => ({
  createConfiguredGuestClaimHandoff,
}));

import { POST } from "./route";

describe("guest App Attest handoff route", () => {
  beforeEach(() => {
    enforceAppAttestRateLimit.mockReset().mockResolvedValue(null);
    createConfiguredGuestClaimHandoff.mockReset();
  });

  it("rate-limits before composing attestation or private database authority", async () => {
    enforceAppAttestRateLimit.mockResolvedValue(
      Response.json(
        { data: { code: "rate_limited", status: "unavailable" } },
        { status: 429, headers: { "Retry-After": "42" } },
      ),
    );
    const request = new Request("https://snaplist.test/v1/guest/attestations", {
      body: "{}",
      method: "POST",
    });

    const response = await POST(request);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(await response.json()).toMatchObject({
      error: {
        code: "rate_limited",
        message: "Too many App Attest requests.",
        requestId: expect.any(String),
      },
    });
    expect(createConfiguredGuestClaimHandoff).not.toHaveBeenCalled();
  });

  it("delegates the public request through configured Apple and Postgres verification", async () => {
    const handleAttestation = vi.fn().mockResolvedValue(
      Response.json({ data: { handoffToken: "opaque" } }, { status: 201 }),
    );
    createConfiguredGuestClaimHandoff.mockReturnValue({ handleAttestation });
    const request = new Request("https://snaplist.test/v1/guest/attestations", {
      body: "{}",
      method: "POST",
    });

    expect((await POST(request)).status).toBe(201);
    expect(handleAttestation).toHaveBeenCalledWith(request);
  });

  it("fails closed when cryptographic or persistence configuration is absent", async () => {
    createConfiguredGuestClaimHandoff.mockImplementation(() => {
      throw new Error("missing signing key");
    });

    const response = await POST(
      new Request("https://snaplist.test/v1/guest/attestations", {
        body: "{}",
        method: "POST",
      }),
    );

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatchObject({
      code: "internal_error",
      message: "Guest attestation is not configured.",
    });
  });
});
