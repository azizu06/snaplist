import { describe, expect, it, vi } from "vitest";
import { createAppAttestHttpHandler } from "./http";

const verifiedAssertion = {
  appId: "TEAMID1234.dev.snaplist.ios",
  bundleVersion: "42",
  counter: 9,
  environment: "production" as const,
  keyId: "fixed-key",
  kind: "assertion" as const,
  requestHash: "request-hash",
  status: "verified" as const,
  validationCategory: 4,
};

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

  it("issues GuestBearer only after a verified assertion and returns no internal JWT", async () => {
    const service = {
      issueChallenge: vi.fn(),
      verifyAssertion: vi.fn().mockResolvedValue(verifiedAssertion),
      verifyAttestation: vi.fn(),
    };
    const issueGuestCapability = vi.fn().mockResolvedValue({
      bearerToken: "guestcap_opaque",
      expiresAt: "2026-07-28T15:30:00.000Z",
      refreshAfter: "2026-07-28T15:25:00.000Z",
    });
    const handle = createAppAttestHttpHandler(service as never, {
      issueGuestCapability,
    });

    const response = await handle(
      new Request("https://snaplist.dev/api/app-attest", {
        body: JSON.stringify({
          assertionObject: Buffer.from("fixed-assertion").toString("base64"),
          challengeId: "00000000-0000-4000-8000-000000000331",
          keyId: Buffer.alloc(32, 0x33).toString("base64"),
          operation: "assertion",
          requestBody: Buffer.from("refresh-request").toString("base64"),
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(issueGuestCapability).toHaveBeenCalledWith(verifiedAssertion);
    const body = await response.json();
    expect(body.data.guestCapability).toEqual({
      bearerToken: "guestcap_opaque",
      expiresAt: "2026-07-28T15:30:00.000Z",
      refreshAfter: "2026-07-28T15:25:00.000Z",
    });
    expect(JSON.stringify(body)).not.toMatch(/internalJwt|privateKey|serviceRole/i);
  });

  it("returns a replacement bearer from a distinct fresh assertion after the first response is lost", async () => {
    const service = {
      issueChallenge: vi.fn(),
      verifyAssertion: vi
        .fn()
        .mockResolvedValueOnce(verifiedAssertion)
        .mockResolvedValueOnce({ ...verifiedAssertion, counter: 10 }),
      verifyAttestation: vi.fn(),
    };
    const issueGuestCapability = vi
      .fn()
      .mockResolvedValueOnce({
        bearerToken: "guestcap_unreachable_response",
        expiresAt: "2026-07-28T15:30:00.000Z",
        refreshAfter: "2026-07-28T15:25:00.000Z",
      })
      .mockResolvedValueOnce({
        bearerToken: "guestcap_replacement",
        expiresAt: "2026-07-28T15:30:01.000Z",
        refreshAfter: "2026-07-28T15:25:01.000Z",
      });
    const handle = createAppAttestHttpHandler(service as never, {
      issueGuestCapability,
    });
    const request = (challengeId: string) =>
      new Request("https://snaplist.dev/api/app-attest", {
        body: JSON.stringify({
          assertionObject: Buffer.from("fixed-assertion").toString("base64"),
          challengeId,
          keyId: Buffer.alloc(32, 0x33).toString("base64"),
          operation: "assertion",
          requestBody: Buffer.from("refresh-request").toString("base64"),
        }),
        method: "POST",
      });

    await handle(request("00000000-0000-4000-8000-000000000331"));
    const replacementResponse = await handle(
      request("00000000-0000-4000-8000-000000000332"),
    );

    expect(replacementResponse.status).toBe(200);
    await expect(replacementResponse.json()).resolves.toMatchObject({
      data: {
        counter: 10,
        guestCapability: {
          bearerToken: "guestcap_replacement",
        },
      },
    });
    expect(issueGuestCapability).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ counter: 10, status: "verified" }),
    );
  });
});
