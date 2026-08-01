import { describe, expect, it } from "vitest";
import { createConfiguredAccountErasureOperations } from "./configured";

const baseInput = {
  supabaseURL: "https://project.supabase.co",
  secretKey: "sb_secret_current",
  clerkSecretKey: "sk_test_account_erasure",
  revenueCatSecretKey: "sk_revenuecat_account_erasure",
};

describe("configured account erasure", () => {
  it("accepts the current Supabase secret-key form", () => {
    expect(() => createConfiguredAccountErasureOperations(baseInput)).not.toThrow();
  });

  it.each([
    "eyJhbGciOiJIUzI1NiJ9.legacy",
    "",
    "sb_publishable_not_privileged",
  ])("rejects a non-current secret capability: %s", (secretKey) => {
    expect(() => createConfiguredAccountErasureOperations({
      ...baseInput,
      secretKey,
    })).toThrow(/current Supabase secret key/);
  });
});
