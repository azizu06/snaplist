import { describe, expect, it, vi } from "vitest";
import type { IncludedOfferOutcome } from "@/lib/included-offer-fence/contract";
import type { IncludedOfferFence } from "@/lib/included-offer-fence/service";
import { createMobileApiHandler, type MobileApiPrincipal } from "./app";

const USER_ID = "user_native";
const CLAIM_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const IDEMPOTENCY_KEY = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
const PROOF = {
  assertionObject: "c2lnbmVk",
  challengeId: "3f2504e0-4f89-41d3-9a0c-0305e82c3303",
  keyId: "a2V5LWlk",
};

function fence(overrides: Partial<IncludedOfferFence> = {}): IncludedOfferFence {
  return {
    readClaim: vi
      .fn()
      .mockResolvedValue({ claimId: CLAIM_ID, status: "reserved" }),
    redeem: vi.fn().mockResolvedValue({
      claimId: CLAIM_ID,
      retryAfterMs: 2_000,
      status: "queued",
    }),
    submitDeviceToken: vi
      .fn()
      .mockResolvedValue({ claimId: CLAIM_ID, status: "reserved" }),
    ...overrides,
  };
}

function handler(input: {
  includedOffer?: IncludedOfferFence;
  principal?: MobileApiPrincipal;
}) {
  return createMobileApiHandler({
    authenticate: vi
      .fn()
      .mockResolvedValue(input.principal ?? { kind: "clerk", userId: USER_ID }),
    includedOffer: input.includedOffer ?? fence(),
    requestId: () => "request-included-offer",
    runOperations: { cancel: vi.fn(), get: vi.fn(), retry: vi.fn() },
    worker: { consume: vi.fn() },
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://api.snaplist.test${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: "Bearer clerk-bearer",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

describe("mobile included-offer redemption endpoints", () => {
  it("derives the account from the session and never from the request body", async () => {
    const includedOffer = fence();
    const response = await handler({ includedOffer })(
      post(
        "/v1/included-offer/redemptions",
        { appAttest: PROOF },
        { "idempotency-key": IDEMPOTENCY_KEY },
      ),
    );
    expect(response.status).toBe(202);
    expect(includedOffer.redeem).toHaveBeenCalledWith({
      appAttest: PROOF,
      idempotencyKey: IDEMPOTENCY_KEY,
      userId: USER_ID,
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { claimId: CLAIM_ID, status: "queued" },
    });
  });

  it("rejects a body that tries to supply identity or entitlement", async () => {
    const includedOffer = fence();
    const response = await handler({ includedOffer })(
      post(
        "/v1/included-offer/redemptions",
        { appAttest: PROOF, userId: "user_someone_else" },
        { "idempotency-key": IDEMPOTENCY_KEY },
      ),
    );
    expect(response.status).toBe(400);
    expect(includedOffer.redeem).not.toHaveBeenCalled();
  });

  it("requires authentication and a durable idempotency key", async () => {
    const includedOffer = fence();
    const anonymous = await handler({ includedOffer })(
      new Request("https://api.snaplist.test/v1/included-offer/redemptions", {
        body: JSON.stringify({ appAttest: PROOF }),
        headers: { "idempotency-key": IDEMPOTENCY_KEY },
        method: "POST",
      }),
    );
    expect(anonymous.status).toBe(401);

    const unkeyed = await handler({ includedOffer })(
      post("/v1/included-offer/redemptions", { appAttest: PROOF }),
    );
    expect(unkeyed.status).toBe(400);
    expect(includedOffer.redeem).not.toHaveBeenCalled();
  });

  it("routes a fresh device token to the claim named in the path", async () => {
    const includedOffer = fence();
    const response = await handler({ includedOffer })(
      post(`/v1/included-offer/redemptions/${CLAIM_ID}/device-token`, {
        appAttest: PROOF,
        deviceToken: "ZGV2aWNlLXRva2Vu",
      }),
    );
    expect(response.status).toBe(200);
    expect(includedOffer.submitDeviceToken).toHaveBeenCalledWith({
      appAttest: PROOF,
      claimId: CLAIM_ID,
      deviceToken: "ZGV2aWNlLXRva2Vu",
      userId: USER_ID,
    });
  });

  it("maps each denial to its own status without leaking a claim to another tenant", async () => {
    const denied = await handler({
      includedOffer: fence({
        submitDeviceToken: vi.fn().mockResolvedValue({
          appealPath: "support-override",
          claimId: CLAIM_ID,
          status: "denied_device_consumed",
        } satisfies IncludedOfferOutcome),
      }),
    })(
      post(`/v1/included-offer/redemptions/${CLAIM_ID}/device-token`, {
        appAttest: PROOF,
        deviceToken: "ZGV2aWNlLXRva2Vu",
      }),
    );
    expect(denied.status).toBe(409);
    await expect(denied.json()).resolves.toMatchObject({
      data: { appealPath: "support-override", status: "denied_device_consumed" },
    });

    const foreign = await handler({
      includedOffer: fence({
        readClaim: vi
          .fn()
          .mockResolvedValue({ status: "claim_not_found" } satisfies IncludedOfferOutcome),
      }),
    })(
      new Request(
        `https://api.snaplist.test/v1/included-offer/redemptions/${CLAIM_ID}`,
        { headers: { authorization: "Bearer clerk-bearer" } },
      ),
    );
    expect(foreign.status).toBe(404);
  });

  it("reports the fence unavailable rather than granting anything when unconfigured", async () => {
    const response = await createMobileApiHandler({
      authenticate: vi.fn().mockResolvedValue({ kind: "clerk", userId: USER_ID }),
      requestId: () => "request-included-offer",
      runOperations: { cancel: vi.fn(), get: vi.fn(), retry: vi.fn() },
      worker: { consume: vi.fn() },
    })(
      post(
        "/v1/included-offer/redemptions",
        { appAttest: PROOF },
        { "idempotency-key": IDEMPOTENCY_KEY },
      ),
    );
    expect(response.status).toBe(503);
  });
});
