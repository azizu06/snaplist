import { describe, it, expect } from "vitest";
import { generateTestPkcs8PrivateKeyPem } from "./guest-capability/signer.testing";
import { parseEnv } from "./env";

const DEPLOYED_SERVER_RPC_SECRET =
  "dd0Gf7bUC6iOCfyI1cXgM7pPDSpyDGd9zM6rhFgDFk6r2sW7d2VKB/EkB2WRUM/p";
const DEPLOYED_GUEST_OPERATION_SIGNER = {
  SUPABASE_GUEST_JWT_KEY_ID: "guest-es256-test",
  SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM: generateTestPkcs8PrivateKeyPem(),
};

const valid = {
  OPENAI_API_KEY: "sk-test",
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test",
  SERVER_RPC_SECRET: "server-rpc-secret-with-at-least-32-characters",
};

function verifiedGuestSignerDeployment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ...valid,
    ...DEPLOYED_GUEST_OPERATION_SIGNER,
    SERVER_RPC_SECRET: DEPLOYED_SERVER_RPC_SECRET,
    NODE_ENV: "production",
    LLM_PROVIDER: "openai",
    EBAY_BASE_URL: "https://api.sandbox.ebay.com",
    APPLE_TEAM_ID: "A1B2C3D4E5",
    APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
    APP_ATTEST_TEAM_ID: "A1B2C3D4E5",
    APP_ATTEST_BUNDLE_ID: "dev.snaplist.ios",
    SUPABASE_SECRET_KEY: "sb_secret_test",
    REVENUECAT_SECRET_API_KEY: "sk_revenuecat_test",
    REVENUECAT_PROJECT_ID: "proj_test",
    SNAPLIST_PUBLIC_ORIGIN: "https://app.snaplist.example",
    CLERK_AUTHORIZED_PARTIES: "https://app.snaplist.example",
    ...overrides,
  };
}

describe("parseEnv", () => {
  it("accepts a minimal valid env and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.OPENAI_API_KEY).toBe("sk-test");
    // env-configurable eBay base defaults to sandbox
    expect(env.EBAY_BASE_URL).toBe("https://api.sandbox.ebay.com");
    expect(env.NODE_ENV).toBe("development");
  });

  it("keeps hosted seller-context transcription default-off with an explicit boolean gate", () => {
    expect(() => parseEnv(valid)).not.toThrow();
    expect(() => parseEnv({
      ...valid,
      SELLER_CONTEXT_TRANSCRIPTION_ENABLED: "false",
    })).not.toThrow();
    expect(() => parseEnv({
      ...valid,
      SELLER_CONTEXT_TRANSCRIPTION_ENABLED: "true",
    })).not.toThrow();
    expect(() => parseEnv({
      ...valid,
      SELLER_CONTEXT_TRANSCRIPTION_ENABLED: "1",
    })).toThrowError(/SELLER_CONTEXT_TRANSCRIPTION_ENABLED/);
    const googlePhotosOnly = {
      ...valid,
      LLM_PROVIDER: "google",
      GOOGLE_GENERATIVE_AI_API_KEY: "google-test-key",
    };
    expect(() => parseEnv(googlePhotosOnly)).not.toThrow();
    expect(() => parseEnv({
      ...googlePhotosOnly,
      SELLER_CONTEXT_TRANSCRIPTION_ENABLED: "false",
    })).not.toThrow();
  });

  it("fails startup when seller-context transcription is enabled for an unsupported provider", () => {
    expect(() => parseEnv({
      ...valid,
      LLM_PROVIDER: "google",
      GOOGLE_GENERATIVE_AI_API_KEY: "google-test-key",
      SELLER_CONTEXT_TRANSCRIPTION_ENABLED: "true",
    })).toThrowError(
      /SELLER_CONTEXT_TRANSCRIPTION_ENABLED.*LLM_PROVIDER.*google/i,
    );
  });

  it("requires the production eBay API origin when mobile production is enabled", () => {
    const deployed = {
      ...valid,
      ...DEPLOYED_GUEST_OPERATION_SIGNER,
      SERVER_RPC_SECRET: DEPLOYED_SERVER_RPC_SECRET,
      NODE_ENV: "production",
      LLM_PROVIDER: "openai",
      EBAY_PRODUCTION_MOBILE_ENABLED: "true",
      APPLE_TEAM_ID: "A1B2C3D4E5",
      APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
      APP_ATTEST_TEAM_ID: "A1B2C3D4E5",
      APP_ATTEST_BUNDLE_ID: "dev.snaplist.ios",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      REVENUECAT_SECRET_API_KEY: "sk_revenuecat_test",
      REVENUECAT_PROJECT_ID: "proj_test",
      SNAPLIST_PUBLIC_ORIGIN: "https://app.snaplist.example",
      CLERK_AUTHORIZED_PARTIES: "https://app.snaplist.example",
    };

    expect(() => parseEnv(deployed)).toThrowError(/EBAY_BASE_URL/);
    expect(() =>
      parseEnv({
        ...deployed,
        EBAY_BASE_URL: "https://api.sandbox.ebay.com",
      }),
    ).toThrowError(/EBAY_BASE_URL/);
    expect(() =>
      parseEnv({ ...deployed, EBAY_BASE_URL: "https://api.ebay.com" }),
    ).not.toThrow();
  });

  it("requires non-placeholder App Attest identities for every deployed consumer", () => {
    const deployed = {
      ...valid,
      ...DEPLOYED_GUEST_OPERATION_SIGNER,
      SERVER_RPC_SECRET: DEPLOYED_SERVER_RPC_SECRET,
      NODE_ENV: "production",
      LLM_PROVIDER: "openai",
      EBAY_BASE_URL: "https://api.sandbox.ebay.com",
      APP_ATTEST_TEAM_ID: "A1B2C3D4E5",
      APP_ATTEST_BUNDLE_ID: "dev.snaplist.ios",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      REVENUECAT_SECRET_API_KEY: "sk_revenuecat_test",
      REVENUECAT_PROJECT_ID: "proj_test",
      SNAPLIST_PUBLIC_ORIGIN: "https://app.snaplist.example",
      CLERK_AUTHORIZED_PARTIES: "https://app.snaplist.example",
    };

    expect(() => parseEnv(deployed)).toThrowError(/APPLE_TEAM_ID/);
    expect(() =>
      parseEnv({
        ...deployed,
        APPLE_TEAM_ID: "TEAMID1234",
        APP_ATTEST_APP_ID: "TEAMID1234.dev.snaplist.ios",
      }),
    ).toThrowError(/APPLE_TEAM_ID/);
    expect(() =>
      parseEnv({
        ...deployed,
        APPLE_TEAM_ID: "A1B2C3D4E5",
        APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
        APP_ATTEST_TEAM_ID: "TEAMID1234",
      }),
    ).toThrowError(/APP_ATTEST_TEAM_ID/);
    expect(() =>
      parseEnv({
        ...deployed,
        APPLE_TEAM_ID: "A1B2C3D4E5",
        APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
        APP_ATTEST_BUNDLE_ID: undefined,
      }),
    ).toThrowError(/APP_ATTEST_BUNDLE_ID/);
    expect(() =>
      parseEnv({
        ...deployed,
        APPLE_TEAM_ID: "A1B2C3D4E5",
        APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
      }),
    ).not.toThrow();
  });

  it("requires the account-erasure Supabase and RevenueCat configuration in deployments", () => {
    const deployed = {
      ...valid,
      ...DEPLOYED_GUEST_OPERATION_SIGNER,
      SERVER_RPC_SECRET: DEPLOYED_SERVER_RPC_SECRET,
      NODE_ENV: "production",
      LLM_PROVIDER: "openai",
      EBAY_BASE_URL: "https://api.sandbox.ebay.com",
      APPLE_TEAM_ID: "A1B2C3D4E5",
      APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
      APP_ATTEST_TEAM_ID: "A1B2C3D4E5",
      APP_ATTEST_BUNDLE_ID: "dev.snaplist.ios",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      REVENUECAT_SECRET_API_KEY: "sk_revenuecat_test",
      REVENUECAT_PROJECT_ID: "proj_test",
      SNAPLIST_PUBLIC_ORIGIN: "https://app.snaplist.example",
      CLERK_AUTHORIZED_PARTIES: "https://app.snaplist.example",
    };

    for (const missing of [
      "SUPABASE_SECRET_KEY",
      "REVENUECAT_SECRET_API_KEY",
      "REVENUECAT_PROJECT_ID",
    ] as const) {
      const withoutRequiredValue: Record<string, string> = { ...deployed };
      delete withoutRequiredValue[missing];
      expect(() => parseEnv(withoutRequiredValue)).toThrowError(new RegExp(missing));
    }

    const env = parseEnv(deployed);
    expect(env.SUPABASE_SECRET_KEY).toBe("sb_secret_test");
    expect(env.REVENUECAT_SECRET_API_KEY).toBe("sk_revenuecat_test");
    expect(env.REVENUECAT_PROJECT_ID).toBe("proj_test");
  });

  it("requires the complete verified-guest operation signer configuration in Production", () => {
    const deployed = verifiedGuestSignerDeployment();

    for (const missing of [
      "SUPABASE_GUEST_JWT_KEY_ID",
      "SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM",
    ] as const) {
      const incomplete: Record<string, string> = { ...deployed };
      delete incomplete[missing];
      expect(() => parseEnv(incomplete)).toThrowError(new RegExp(missing));
    }

    expect(() =>
      parseEnv({ ...deployed, SUPABASE_SECRET_KEY: "legacy-service-role-key" }),
    ).toThrowError(/SUPABASE_SECRET_KEY.*current Supabase secret key/);
    expect(() =>
      parseEnv({
        ...deployed,
        SUPABASE_GUEST_JWT_KEY_ID: "guest signer with spaces",
      }),
    ).toThrowError(/SUPABASE_GUEST_JWT_KEY_ID.*valid signing key id/);
    expect(() => parseEnv(deployed)).not.toThrow();
  });

  it.each([
    [
      "malformed",
      "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----",
    ],
    ["non-ES256", generateTestPkcs8PrivateKeyPem("P-384")],
  ])("rejects a %s verified-guest private key in Production", (_kind, privateKeyPem) => {
    expect(() =>
      parseEnv(
        verifiedGuestSignerDeployment({
          SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM: privateKeyPem,
        }),
      ),
    ).toThrowError(
      /SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM.*importable ES256 private key/,
    );
  });

  it("rejects missing, non-public, or malformed Clerk authorized parties in deployments", () => {
    const deployed = {
      ...valid,
      ...DEPLOYED_GUEST_OPERATION_SIGNER,
      SERVER_RPC_SECRET: DEPLOYED_SERVER_RPC_SECRET,
      NODE_ENV: "production",
      LLM_PROVIDER: "openai",
      EBAY_BASE_URL: "https://api.sandbox.ebay.com",
      APPLE_TEAM_ID: "A1B2C3D4E5",
      APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
      APP_ATTEST_TEAM_ID: "A1B2C3D4E5",
      APP_ATTEST_BUNDLE_ID: "dev.snaplist.ios",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      REVENUECAT_SECRET_API_KEY: "sk_revenuecat_test",
      REVENUECAT_PROJECT_ID: "proj_test",
      SNAPLIST_PUBLIC_ORIGIN: "https://app.snaplist.example",
    };

    expect(() => parseEnv(deployed)).toThrowError(/CLERK_AUTHORIZED_PARTIES/);
    expect(() =>
      parseEnv({
        ...deployed,
        CLERK_AUTHORIZED_PARTIES: "http://localhost:3000,http://127.0.0.1:3001",
      }),
    ).toThrowError(/CLERK_AUTHORIZED_PARTIES/);
    expect(() =>
      parseEnv({
        ...deployed,
        CLERK_AUTHORIZED_PARTIES: "https://app.snaplist.example,not a URL",
      }),
    ).toThrowError(/public HTTPS origin/);
    expect(() =>
      parseEnv({
        ...deployed,
        CLERK_AUTHORIZED_PARTIES: "https://app.snaplist.example",
      }),
    ).not.toThrow();
  });

  it.each([
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:10.0.0.1]",
    "https://[::ffff:192.168.1.1]",
    "https://[::ffff:7f00:1]",
    "https://[::ffff:0:127.0.0.1]",
  ])("rejects IPv4-mapped non-public Clerk authorized party %s", (party) => {
    expect(() =>
      parseEnv({
        ...valid,
        ...DEPLOYED_GUEST_OPERATION_SIGNER,
        SERVER_RPC_SECRET: DEPLOYED_SERVER_RPC_SECRET,
        NODE_ENV: "production",
        LLM_PROVIDER: "openai",
        EBAY_BASE_URL: "https://api.sandbox.ebay.com",
        APPLE_TEAM_ID: "A1B2C3D4E5",
        APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
        APP_ATTEST_TEAM_ID: "A1B2C3D4E5",
        APP_ATTEST_BUNDLE_ID: "dev.snaplist.ios",
        SUPABASE_SECRET_KEY: "sb_secret_test",
        REVENUECAT_SECRET_API_KEY: "sk_revenuecat_test",
        REVENUECAT_PROJECT_ID: "proj_test",
        SNAPLIST_PUBLIC_ORIGIN: "https://app.snaplist.example",
        CLERK_AUTHORIZED_PARTIES: party,
      }),
    ).toThrowError(/CLERK_AUTHORIZED_PARTIES/);
  });

  it("accepts public IPv6 and hostname Clerk authorized parties in deployments", () => {
    expect(() =>
      parseEnv({
        ...valid,
        ...DEPLOYED_GUEST_OPERATION_SIGNER,
        SERVER_RPC_SECRET: DEPLOYED_SERVER_RPC_SECRET,
        NODE_ENV: "production",
        LLM_PROVIDER: "openai",
        EBAY_BASE_URL: "https://api.sandbox.ebay.com",
        APPLE_TEAM_ID: "A1B2C3D4E5",
        APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
        APP_ATTEST_TEAM_ID: "A1B2C3D4E5",
        APP_ATTEST_BUNDLE_ID: "dev.snaplist.ios",
        SUPABASE_SECRET_KEY: "sb_secret_test",
        REVENUECAT_SECRET_API_KEY: "sk_revenuecat_test",
        REVENUECAT_PROJECT_ID: "proj_test",
        SNAPLIST_PUBLIC_ORIGIN: "https://app.snaplist.example",
        CLERK_AUTHORIZED_PARTIES:
          "https://[2001:4860:4860::8888],https://app.snaplist.example",
      }),
    ).not.toThrow();
  });

  it.each([
    "https://[fe90::1]",
    "https://[ff02::1]",
    "https://[2001:db8::1]",
  ])("rejects non-global special IPv6 Clerk authorized party %s", (party) => {
    expect(() =>
      parseEnv({
        ...valid,
        ...DEPLOYED_GUEST_OPERATION_SIGNER,
        NODE_ENV: "production",
        LLM_PROVIDER: "openai",
        EBAY_BASE_URL: "https://api.sandbox.ebay.com",
        APPLE_TEAM_ID: "A1B2C3D4E5",
        APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
        APP_ATTEST_TEAM_ID: "A1B2C3D4E5",
        APP_ATTEST_BUNDLE_ID: "dev.snaplist.ios",
        SUPABASE_SECRET_KEY: "sb_secret_test",
        REVENUECAT_SECRET_API_KEY: "sk_revenuecat_test",
        REVENUECAT_PROJECT_ID: "proj_test",
        SNAPLIST_PUBLIC_ORIGIN: "https://app.snaplist.example",
        CLERK_AUTHORIZED_PARTIES: party,
      }),
    ).toThrowError(/CLERK_AUTHORIZED_PARTIES/);
  });

  it("throws when NO LLM provider key is present (names OPENAI_API_KEY)", () => {
    // OPENAI_API_KEY is no longer required on its own (dev runs on Gemini), but at
    // least one provider key must be set — the guard message names OPENAI_API_KEY.
    const { OPENAI_API_KEY, ...missingKey } = valid;
    void OPENAI_API_KEY;
    expect(() => parseEnv(missingKey)).toThrowError(/OPENAI_API_KEY/);
  });

  it("accepts a Gemini-only dev env (no OpenAI key) and parses LLM_PROVIDER", () => {
    const { OPENAI_API_KEY, ...noOpenAI } = valid;
    void OPENAI_API_KEY;
    const env = parseEnv({
      ...noOpenAI,
      GOOGLE_GENERATIVE_AI_API_KEY: "g-test",
      LLM_PROVIDER: "gemini",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("g-test");
    expect(env.LLM_PROVIDER).toBe("gemini");
  });

  it("rejects a provider/key mismatch (LLM_PROVIDER=google but only OPENAI_API_KEY)", () => {
    // The "at least one key" check isn't enough: the SELECTED provider needs its
    // own key, or every request fails at runtime (#55 review).
    expect(() => parseEnv({ ...valid, LLM_PROVIDER: "google" })).toThrowError(
      /selected LLM provider/,
    );
  });

  it("fails config startup when LLM_PROVIDER is unset outside local development (#501)", () => {
    // Reported as a normal validation issue, alongside every other bad variable,
    // rather than escaping as a bare provider error mid-parse.
    expect(() => parseEnv({ ...valid, NODE_ENV: "production" })).toThrowError(
      /Invalid environment variables[\s\S]*LLM_PROVIDER/,
    );
    // A deploy marker makes it a deploy even when NODE_ENV reads as local.
    expect(() => parseEnv({ ...valid, NODE_ENV: "development", VERCEL: "1" })).toThrowError(
      /Invalid environment variables[\s\S]*LLM_PROVIDER/,
    );
  });

  it("treats web-search and service-role keys as optional", () => {
    const env = parseEnv(valid);
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });

  it("requires an openssl-generated server RPC secret in deployed environments", () => {
    const deployed = {
      ...valid,
      ...DEPLOYED_GUEST_OPERATION_SIGNER,
      SERVER_RPC_SECRET: DEPLOYED_SERVER_RPC_SECRET,
      NODE_ENV: "production",
      LLM_PROVIDER: "openai",
      EBAY_BASE_URL: "https://api.sandbox.ebay.com",
      APPLE_TEAM_ID: "A1B2C3D4E5",
      APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
      APP_ATTEST_TEAM_ID: "A1B2C3D4E5",
      APP_ATTEST_BUNDLE_ID: "dev.snaplist.ios",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      REVENUECAT_SECRET_API_KEY: "sk_revenuecat_test",
      REVENUECAT_PROJECT_ID: "proj_test",
      SNAPLIST_PUBLIC_ORIGIN: "https://app.snaplist.example",
      CLERK_AUTHORIZED_PARTIES: "https://app.snaplist.example",
    };
    const { SERVER_RPC_SECRET, ...withoutServerRpcSecret } = deployed;
    void SERVER_RPC_SECRET;

    expect(() =>
      parseEnv(withoutServerRpcSecret),
    ).toThrowError(/SERVER_RPC_SECRET/);

    expect(parseEnv(deployed).SERVER_RPC_SECRET).toBe(DEPLOYED_SERVER_RPC_SECRET);

    for (const predictableSecret of [
      "server-rpc-secret-with-at-least-32-characters",
      "a".repeat(64),
      "correcthorsebatterystaple".repeat(3).slice(0, 64),
      "fKq9Y3n8ouWON6TS".repeat(4),
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
    ]) {
      expect(() =>
        parseEnv({ ...deployed, SERVER_RPC_SECRET: predictableSecret }),
      ).toThrowError(/SERVER_RPC_SECRET/);
    }

    for (const generatedSecret of [
      "fKqdY3n8ouiON63S3PdDwc9OfiLiPP1UF1uPAaC5MfiL4X0nQ2i8GjA2zLE4Ynh4",
      "fsUFJNTcQ3cmQN8BYaPasb8JS0e44qdDOitQP40ydXRCiFO8ecO6JNuY5Ou0KxL5",
      "l+fIGcA3DQizPFLjJ3mc0gDQkCNikkK34ffoYIuYf3xxk9z1x/hIxMfrkTVTN9E8",
    ]) {
      expect(parseEnv({ ...deployed, SERVER_RPC_SECRET: generatedSecret }).SERVER_RPC_SECRET).toBe(
        generatedSecret,
      );
    }
  });

  it("requires a public HTTPS eBay photo origin in deployed environments", () => {
    const deployed = {
      ...valid,
      ...DEPLOYED_GUEST_OPERATION_SIGNER,
      SERVER_RPC_SECRET: DEPLOYED_SERVER_RPC_SECRET,
      NODE_ENV: "production",
      LLM_PROVIDER: "openai",
      EBAY_BASE_URL: "https://api.sandbox.ebay.com",
      APPLE_TEAM_ID: "A1B2C3D4E5",
      APP_ATTEST_APP_ID: "A1B2C3D4E5.dev.snaplist.ios",
      APP_ATTEST_TEAM_ID: "A1B2C3D4E5",
      APP_ATTEST_BUNDLE_ID: "dev.snaplist.ios",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      REVENUECAT_SECRET_API_KEY: "sk_revenuecat_test",
      REVENUECAT_PROJECT_ID: "proj_test",
      SNAPLIST_PUBLIC_ORIGIN: "https://app.snaplist.example",
      CLERK_AUTHORIZED_PARTIES: "https://app.snaplist.example",
    };

    expect(() => parseEnv(deployed)).not.toThrow();

    const { SNAPLIST_PUBLIC_ORIGIN, ...withoutOrigin } = deployed;
    void SNAPLIST_PUBLIC_ORIGIN;
    // Without enforcement the origin eBay fetches published pictures from
    // silently falls back to CLERK_AUTHORIZED_PARTIES ordering — the exact
    // defect the dedicated variable exists to close.
    expect(() => parseEnv(withoutOrigin)).toThrowError(/SNAPLIST_PUBLIC_ORIGIN/);

    for (const invalidOrigin of [
      "/m",
      "ftp://snaplist.example",
      "http://snaplist.example",
      "https://localhost",
      "https://10.0.0.5",
      "https://snaplist.example/media",
    ]) {
      expect(() =>
        parseEnv({ ...deployed, SNAPLIST_PUBLIC_ORIGIN: invalidOrigin }),
      ).toThrowError(/SNAPLIST_PUBLIC_ORIGIN/);
    }
  });

  it("keeps the eBay photo origin optional in local development", () => {
    expect(() => parseEnv(valid)).not.toThrow();
    expect(
      parseEnv({ ...valid, SNAPLIST_PUBLIC_ORIGIN: "http://localhost:3000" })
        .SNAPLIST_PUBLIC_ORIGIN,
    ).toBe("http://localhost:3000");
  });

  it("keeps local and test server RPC fixtures permissive", () => {
    expect(parseEnv(valid).SERVER_RPC_SECRET).toBe(
      "server-rpc-secret-with-at-least-32-characters",
    );
    expect(parseEnv({ ...valid, NODE_ENV: "test" }).SERVER_RPC_SECRET).toBe(
      "server-rpc-secret-with-at-least-32-characters",
    );
  });

  it("rejects a configured server RPC secret that is too short", () => {
    expect(() =>
      parseEnv({ ...valid, SERVER_RPC_SECRET: "too-short" }),
    ).toThrowError(/SERVER_RPC_SECRET/);
  });

  it("rejects the public local server RPC secret in deployed environments", () => {
    expect(() =>
      parseEnv({
        ...valid,
        NODE_ENV: "production",
        LLM_PROVIDER: "openai",
        SERVER_RPC_SECRET:
          "snaplist-local-server-rpc-secret-do-not-use-in-hosted",
      }),
    ).toThrowError(/public local\/CI secret is forbidden/);
  });

  it("accepts the server-only listing-example experiment controls", () => {
    const env = parseEnv({
      ...valid,
      LISTING_EXAMPLE_RETRIEVAL_ENABLED: "true",
      LISTING_EXAMPLE_RETRIEVAL_TIMEOUT_MS: "2000",
    });

    expect(env.LISTING_EXAMPLE_RETRIEVAL_ENABLED).toBe("true");
    expect(env.LISTING_EXAMPLE_RETRIEVAL_TIMEOUT_MS).toBe("2000");
  });

  it("treats a missing or blank sold-comps proxy template as optional", () => {
    expect(parseEnv(valid).EBAY_SOLD_PROXY_TEMPLATE).toBeUndefined();
    expect(
      parseEnv({ ...valid, EBAY_SOLD_PROXY_TEMPLATE: "   " })
        .EBAY_SOLD_PROXY_TEMPLATE,
    ).toBeUndefined();
  });

  it("accepts a valid HTTPS sold-comps proxy template", () => {
    const env = parseEnv({
      ...valid,
      EBAY_SOLD_PROXY_TEMPLATE:
        "https://proxy.example/fetch?token=deploy-secret&url={url}",
    });

    expect(env.EBAY_SOLD_PROXY_TEMPLATE).toContain("{url}");
  });

  it.each([
    ["missing placeholder", "https://proxy.example/fetch"],
    ["non-HTTPS transport", "http://proxy.example/fetch?url={url}"],
    ["embedded credentials", "https://user:pass@proxy.example/fetch?url={url}"],
    ["unparseable URL", "not-a-url/{url}"],
  ])("rejects a malformed sold-comps proxy template: %s", (_label, template) => {
    expect(() =>
      parseEnv({ ...valid, EBAY_SOLD_PROXY_TEMPLATE: template }),
    ).toThrowError(/EBAY_SOLD_PROXY_TEMPLATE/);
  });
});
