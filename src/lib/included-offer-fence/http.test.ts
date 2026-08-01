import { describe, expect, it } from "vitest";
import type { IncludedOfferOutcome } from "./contract";
import {
  includedOfferDeviceTokenRequestSchema,
  includedOfferHttpStatus,
  includedOfferRedeemRequestSchema,
} from "./http";

const proof = {
  assertionObject: "c2lnbmVk",
  challengeId: "8f14e45f-ceea-467a-a3d0-2a0f4e2a1f11",
  keyId: "a2V5LWlk",
};

describe("included-offer redemption HTTP contract", () => {
  it("accepts only an App Attest-bound redemption body", () => {
    expect(
      includedOfferRedeemRequestSchema.safeParse({ appAttest: proof }).success,
    ).toBe(true);
    // A client-supplied identity or entitlement field can never grant eligibility.
    for (const forged of [
      { appAttest: proof, userId: "user_forged" },
      { appAttest: proof, includedRunAvailable: true },
      { appAttest: { ...proof, keyId: "" } },
      {},
    ]) {
      expect(includedOfferRedeemRequestSchema.safeParse(forged).success).toBe(
        false,
      );
    }
  });

  it("accepts a fresh device token only alongside fresh proof", () => {
    expect(
      includedOfferDeviceTokenRequestSchema.safeParse({
        appAttest: proof,
        deviceToken: "ZGV2aWNlLXRva2Vu",
      }).success,
    ).toBe(true);
    for (const invalid of [
      { deviceToken: "ZGV2aWNlLXRva2Vu" },
      { appAttest: proof },
      { appAttest: proof, deviceToken: "" },
      { appAttest: proof, claimId: "spoofed", deviceToken: "ZGV2aWNl" },
    ]) {
      expect(
        includedOfferDeviceTokenRequestSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });

  it("maps every typed outcome to an honest status code", () => {
    const cases: [IncludedOfferOutcome, number][] = [
      [{ claimId: "c", status: "reserved" }, 200],
      [{ claimId: "c", retryAfterMs: 2_000, status: "queued" }, 202],
      [
        {
          claimId: "c",
          status: "device_token_required",
          tokenDeadlineAt: "2026-07-31T18:00:00.000Z",
        },
        202,
      ],
      [
        {
          claimId: "c",
          paidPathAvailable: true,
          reason: "throttled",
          retryAfterMs: 2_000,
          status: "retry_required",
        },
        202,
      ],
      [
        { appealPath: "support-override", claimId: "c", status: "denied_device_consumed" },
        409,
      ],
      [{ paidPathAvailable: true, status: "denied_account_consumed" }, 409],
      [
        {
          appealPath: "support-override",
          claimId: "c",
          paidPathAvailable: true,
          status: "denied_apple_unavailable",
        },
        409,
      ],
      [{ code: "challenge_replayed", status: "invalid_proof" }, 401],
      [{ status: "claim_not_found" }, 404],
    ];
    for (const [outcome, status] of cases) {
      expect(includedOfferHttpStatus(outcome), outcome.status).toBe(status);
    }
  });
});
