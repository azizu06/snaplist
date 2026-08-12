import { afterEach, describe, expect, it, vi } from "vitest";
import { generateTestPkcs8PrivateKeyPem } from "./lib/guest-capability/signer.testing";
import { register } from "./instrumentation";

/**
 * Server boot (issue #62 for Sentry; #501 for the provider fence). `register()`
 * runs once per server instance, which is the earliest point a deploy can be
 * told its configuration is unusable.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("register", () => {
  // Keep Sentry inert: `register()` initializes it, and a developer with a real
  // SENTRY_DSN exported would otherwise start a live client from a unit test.
  const localEnv = (nodeEnv: string) => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    delete process.env.SENTRY_DSN;
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "google-test");
  };

  const deployedEnv = () => {
    localEnv("production");
    for (const [name, value] of Object.entries({
      APPLE_TEAM_ID: "A1B2C3D4E5",
      APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
      APP_ATTEST_BUNDLE_ID: "dev.snaplist.ios",
      APP_ATTEST_TEAM_ID: "A1B2C3D4E5",
      CLERK_AUTHORIZED_PARTIES: "https://app.snaplist.example",
      EBAY_BASE_URL: "https://api.sandbox.ebay.com",
      LLM_PROVIDER: "openai",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test",
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      OPENAI_API_KEY: "sk-test",
      REVENUECAT_PROJECT_ID: "project-test",
      REVENUECAT_SECRET_API_KEY: "revenuecat-secret",
      SERVER_RPC_SECRET: "dOD9IRVTwgq/GTVsIoNQ29nsUWHdqgRjpgdYQN7Yy0QUqS7yFBsMq6fknzT+jiTI",
      SNAPLIST_PUBLIC_ORIGIN: "https://app.snaplist.example",
      SUPABASE_GUEST_JWT_KEY_ID: "guest-es256-test",
      SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM: generateTestPkcs8PrivateKeyPem(),
      SUPABASE_SECRET_KEY: "sb_secret_test",
    })) {
      vi.stubEnv(name, value);
    }
  };

  it("rejects startup when LLM_PROVIDER is unset outside local development (#501)", async () => {
    localEnv("production");
    vi.stubEnv("LLM_PROVIDER", "");
    await expect(register()).rejects.toThrow(/LLM_PROVIDER/);
  });

  it("starts normally on a local development machine, where the provider may be omitted", async () => {
    localEnv("development");
    delete process.env.LLM_PROVIDER;
    await expect(register()).resolves.toBeUndefined();
  });

  it("starts normally on a deploy that chose a provider (#501)", async () => {
    deployedEnv();
    await expect(register()).resolves.toBeUndefined();
  });

  it("rejects startup before runs when seller-context transcription has no provider adapter", async () => {
    deployedEnv();
    vi.stubEnv("LLM_PROVIDER", "google");
    vi.stubEnv("SELLER_CONTEXT_TRANSCRIPTION_ENABLED", "true");

    await expect(register()).rejects.toThrow(
      /SELLER_CONTEXT_TRANSCRIPTION_ENABLED.*LLM_PROVIDER.*google/i,
    );
  });

  it("rejects deployment startup when deployed validation rejects the Sandbox default", async () => {
    deployedEnv();
    vi.stubEnv("EBAY_BASE_URL", "");

    await expect(register()).rejects.toThrow(/EBAY_BASE_URL/);
  });

  it("rejects deployment startup when the verified-guest signing key id is invalid", async () => {
    deployedEnv();
    vi.stubEnv("SUPABASE_GUEST_JWT_KEY_ID", "guest signer with spaces");

    await expect(register()).rejects.toThrow(
      /SUPABASE_GUEST_JWT_KEY_ID.*valid signing key id/,
    );
  });

  it.each([
    [
      "malformed",
      "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----",
    ],
    ["non-ES256", generateTestPkcs8PrivateKeyPem("P-384")],
  ])(
    "rejects deployment startup when the verified-guest private key is %s",
    async (_kind, privateKeyPem) => {
      deployedEnv();
      vi.stubEnv("SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM", privateKeyPem);

      await expect(register()).rejects.toThrow(
        /SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM.*importable ES256 private key/,
      );
    },
  );
});
