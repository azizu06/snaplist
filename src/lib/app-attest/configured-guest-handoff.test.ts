import { describe, expect, it } from "vitest";
import { resolveGuestClaimHandoffConfiguration } from "./configured-guest-handoff";

const configuredEnv = {
  APP_ATTEST_BUNDLE_ID: "dev.snaplist.ios",
  APP_ATTEST_CHALLENGE_TTL_SECONDS: "300",
  APP_ATTEST_ENVIRONMENT: "production",
  APP_ATTEST_HANDOFF_SIGNING_KEY: Buffer.alloc(32, 0x61).toString("base64url"),
  APP_ATTEST_HANDOFF_TTL_SECONDS: "300",
  APP_ATTEST_ROOT_CA_PEM: "-----BEGIN CERTIFICATE-----\\nplaceholder\\n-----END CERTIFICATE-----",
  APP_ATTEST_TEAM_ID: "TEAMID1234",
};

describe("configured guest claim handoff", () => {
  it("derives the Apple App ID and requires every cryptographic value from env", () => {
    expect(resolveGuestClaimHandoffConfiguration(configuredEnv)).toEqual({
      appId: "TEAMID1234.dev.snaplist.ios",
      appleRootCertificatePem:
        "-----BEGIN CERTIFICATE-----\nplaceholder\n-----END CERTIFICATE-----",
      challengeTtlMs: 300_000,
      environment: "production",
      handoffSigningKey: Buffer.alloc(32, 0x61),
      handoffTtlMs: 300_000,
    });
  });

  it.each([
    "APP_ATTEST_TEAM_ID",
    "APP_ATTEST_BUNDLE_ID",
    "APP_ATTEST_ROOT_CA_PEM",
    "APP_ATTEST_HANDOFF_SIGNING_KEY",
  ] as const)("fails closed when %s is absent", (name) => {
    expect(() =>
      resolveGuestClaimHandoffConfiguration({ ...configuredEnv, [name]: undefined }),
    ).toThrow(/not configured|invalid/i);
  });
});
