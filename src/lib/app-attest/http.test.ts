import { describe, expect, it, vi } from "vitest";
import { createAppAttestHttpHandler } from "./http";

describe("App Attest HTTP truth boundary", () => {
  it("issues a challenge and returns only typed invalid attestation truth", async () => {
    const service = {
      issueChallenge: vi.fn().mockResolvedValue({
        challenge: "fixed-challenge",
        challengeId: "00000000-0000-4000-8000-000000000331",
        expiresAt: "2026-07-20T20:05:00.000Z",
        kind: "attestation",
      }),
      verifyAssertion: vi.fn(),
      verifyAttestation: vi.fn().mockResolvedValue({
        code: "invalid_evidence",
        kind: "attestation",
        status: "invalid",
      }),
    };
    const handle = createAppAttestHttpHandler(service);

    const challengeResponse = await handle(
      new Request("https://snaplist.dev/api/app-attest", {
        body: JSON.stringify({ kind: "attestation", operation: "challenge" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(challengeResponse.status).toBe(200);
    await expect(challengeResponse.json()).resolves.toEqual({
      data: {
        challenge: "fixed-challenge",
        challengeId: "00000000-0000-4000-8000-000000000331",
        expiresAt: "2026-07-20T20:05:00.000Z",
        kind: "attestation",
      },
    });

    const verificationResponse = await handle(
      new Request("https://snaplist.dev/api/app-attest", {
        body: JSON.stringify({
          attestationObject: Buffer.from("fixed-attestation").toString("base64"),
          challengeId: "00000000-0000-4000-8000-000000000331",
          keyId: Buffer.alloc(32, 0x33).toString("base64"),
          operation: "attestation",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(verificationResponse.status).toBe(401);
    await expect(verificationResponse.json()).resolves.toEqual({
      data: {
        code: "invalid_evidence",
        kind: "attestation",
        status: "invalid",
      },
    });
    expect(service).not.toHaveProperty("mintGuestCapability");
  });

  it("rejects a malformed request body encoding before assertion verification", async () => {
    const service = {
      issueChallenge: vi.fn(),
      verifyAssertion: vi.fn(),
      verifyAttestation: vi.fn(),
    };
    const response = await createAppAttestHttpHandler(service as never)(
      new Request("https://snaplist.dev/api/app-attest", {
        body: JSON.stringify({
          assertionObject: "ZmFrZQ==",
          challengeId: "00000000-0000-4000-8000-000000000331",
          keyId: Buffer.alloc(32, 0x33).toString("base64"),
          operation: "assertion",
          requestBody: "%%%",
        }),
        method: "POST",
      }),
    );
    expect(response.status).toBe(400);
    expect(service.verifyAssertion).not.toHaveBeenCalled();
  });
});
