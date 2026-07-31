import { describe, expect, it, vi } from "vitest";
import {
  createConfiguredIncludedOfferFence,
  narrowIncludedOfferRpcClient,
} from "./configured";

/** Throwaway P-256 key generated for this test; it signs nothing real. */
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgESRBNp49X7ZnW8MS\nNL32AaTviYXFpYFJWij2KD/TB2+hRANCAAR69+bvrqAo5ZQhnnP/cn7uynmBPmj7\nPQeZPDnjjQ/nGXSvGybtlzq5b3GctAxnZExvn3LpeAk/2eYwVmp2Zwx7\n-----END PRIVATE KEY-----\n";

const ENV = {
  APPLE_DEVICECHECK_KEY_ID: "DCKEY12345",
  APPLE_DEVICECHECK_PRIVATE_KEY_PEM: TEST_PEM,
  APPLE_TEAM_ID: "TEAMID1234",
  APP_ATTEST_APP_ID: "TEAMID1234.dev.snaplist.ios",
  APP_ATTEST_ENVIRONMENT: "production",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "service",
};

describe("configured included-offer fence", () => {
  it("hands the redemption authority no generic domain access", () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const generic = { from: vi.fn(), rpc, storage: {} };
    const narrowed = narrowIncludedOfferRpcClient(generic);

    // The store can still reach its own audited RPCs...
    void narrowed.rpc("find_included_offer_claim", { p_claim_id: "c" });
    expect(rpc).toHaveBeenCalledWith("find_included_offer_claim", {
      p_claim_id: "c",
    });
    // ...but the table and storage surfaces are simply not there to reach.
    expect(Object.keys(narrowed)).toEqual(["rpc"]);
    expect((narrowed as { from?: unknown }).from).toBeUndefined();
    expect(generic.from).not.toHaveBeenCalled();
  });

  it("builds a fence and its single-writer worker from a complete environment", () => {
    // Negative control for the test below: without this, a fence that always
    // threw would make every "missing credential" assertion pass vacuously.
    const built = createConfiguredIncludedOfferFence(ENV);
    expect(typeof built.fence.redeem).toBe("function");
    expect(typeof built.worker.advance).toBe("function");
  });

  it("refuses to build a fence when any Apple credential is missing", () => {
    for (const missing of [
      "APPLE_DEVICECHECK_KEY_ID",
      "APPLE_DEVICECHECK_PRIVATE_KEY_PEM",
      "APPLE_TEAM_ID",
      "APP_ATTEST_ENVIRONMENT",
      "SUPABASE_SERVICE_ROLE_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
    ]) {
      const env = { ...ENV, [missing]: undefined };
      // Failing to build is the safe direction: the route then reports the
      // offer unavailable instead of granting an unfenced included run.
      expect(
        () => createConfiguredIncludedOfferFence(env),
        missing,
      ).toThrowError();
    }
  });

  it("refuses an Apple environment value it does not recognise", () => {
    expect(() =>
      createConfiguredIncludedOfferFence({
        ...ENV,
        APP_ATTEST_ENVIRONMENT: "sandbox",
      }),
    ).toThrowError();
  });
});
