import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import {
  mintInvalidVerifiedGuestJwt,
  mintVerifiedGuestJwt,
} from "@/lib/supabase/test-users";

describe("verified guest internal JWT test fixture", () => {
  it("mints only the approved short-lived capability claims", async () => {
    const subject = "guest_issue_332";
    const capabilityId = "4f47aeb4-5a74-4fef-a8f6-8d55d6b46299";
    const claims = decodeJwt(
      await mintVerifiedGuestJwt(subject, capabilityId),
    );

    expect(claims).toMatchObject({
      actor: "verified_guest",
      aud: "authenticated",
      cap_id: capabilityId,
      role: "authenticated",
      snaplist_operation_channel: "verified_guest_publishable",
      sub: subject,
    });
    expect(claims.iat).toEqual(expect.any(Number));
    expect(claims.exp).toEqual(expect.any(Number));
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(60);
  });

  it("isolates missing, wrong, and tampered channel denial fixtures", async () => {
    const subject = "guest_issue_332";
    const capabilityId = "4f47aeb4-5a74-4fef-a8f6-8d55d6b46299";
    const otherwiseValid = {
      actor: "verified_guest",
      capabilityId,
    };
    const actorFailure = decodeJwt(
      await mintInvalidVerifiedGuestJwt(subject, { capabilityId }),
    );
    const missing = decodeJwt(
      await mintInvalidVerifiedGuestJwt(subject, {
        ...otherwiseValid,
        operationChannel: null,
      }),
    );
    const wrong = decodeJwt(
      await mintInvalidVerifiedGuestJwt(subject, {
        ...otherwiseValid,
        operationChannel: "verified_guest_private",
      }),
    );
    const tampered = decodeJwt(
      await mintInvalidVerifiedGuestJwt(subject, {
        ...otherwiseValid,
        operationChannel: "tampered",
      }),
    );

    expect(actorFailure.snaplist_operation_channel).toBe(
      "verified_guest_publishable",
    );
    expect(missing).not.toHaveProperty("snaplist_operation_channel");
    expect(wrong.snaplist_operation_channel).toBe("verified_guest_private");
    expect(tampered.snaplist_operation_channel).toBe("tampered");
  });
});
