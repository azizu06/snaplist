import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAdminClient,
  createAppAttestHttpHandler,
  createAppAttestService,
  createSupabaseAppAttestStore,
  createSupabaseVerifiedGuestCapabilityStore,
  createVerifiedGuestCapabilityService,
  enforceAppAttestRateLimit,
  issue,
} = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  createAppAttestHttpHandler: vi.fn(),
  createAppAttestService: vi.fn(),
  createSupabaseAppAttestStore: vi.fn(),
  createSupabaseVerifiedGuestCapabilityStore: vi.fn(),
  createVerifiedGuestCapabilityService: vi.fn(),
  enforceAppAttestRateLimit: vi.fn(),
  issue: vi.fn(),
}));

vi.mock("@/lib/abuse", () => ({ enforceAppAttestRateLimit }));
vi.mock("@/lib/app-attest/http", () => ({ createAppAttestHttpHandler }));
vi.mock("@/lib/app-attest/service", () => ({ createAppAttestService }));
vi.mock("@/lib/app-attest/supabase-store", () => ({ createSupabaseAppAttestStore }));
vi.mock("@/lib/app-attest/apple-verifier", () => ({
  createAppleAppAttestVerifier: vi.fn(() => ({ verifier: true })),
}));
vi.mock("@/lib/guest-capability/service", () => ({
  createVerifiedGuestCapabilityService,
}));
vi.mock("@/lib/guest-capability/supabase-store", () => ({
  createSupabaseVerifiedGuestCapabilityStore,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import { POST } from "./route";

const keys = [
  "APP_ATTEST_APP_ID",
  "APP_ATTEST_ENVIRONMENT",
  "APP_ATTEST_CHALLENGE_TTL_SECONDS",
] as const;

describe("App Attest production GuestBearer composition", () => {
  beforeEach(() => {
    process.env.APP_ATTEST_APP_ID = "TEAMID1234.dev.snaplist.ios";
    process.env.APP_ATTEST_ENVIRONMENT = "production";
    process.env.APP_ATTEST_CHALLENGE_TTL_SECONDS = "300";
    enforceAppAttestRateLimit.mockResolvedValue(null);
    const admin = { rpc: vi.fn() };
    createAdminClient.mockReturnValue(admin);
    createSupabaseAppAttestStore.mockReturnValue({ appAttestStore: true });
    createSupabaseVerifiedGuestCapabilityStore.mockReturnValue({
      capabilityStore: true,
    });
    createAppAttestService.mockReturnValue({ appAttestService: true });
    createVerifiedGuestCapabilityService.mockReturnValue({ issue });
    issue.mockResolvedValue({
      bearerToken: "guestcap_opaque",
      expiresAt: "2026-07-28T15:30:00.000Z",
      refreshAfter: "2026-07-28T15:25:00.000Z",
    });
    createAppAttestHttpHandler.mockImplementation(
      (
        dependency: () => unknown,
        options: { issueGuestCapability: (assertion: unknown) => Promise<unknown> },
      ) =>
        async () => {
          dependency();
          const guestCapability = await options.issueGuestCapability({
            appId: "TEAMID1234.dev.snaplist.ios",
            environment: "production",
            keyId: "verified-key",
            kind: "assertion",
            status: "verified",
          });
          return Response.json({ data: { guestCapability } });
        },
    );
  });

  afterEach(() => {
    for (const key of keys) delete process.env[key];
    vi.clearAllMocks();
  });

  it("shares one private persistence client and issues only from verified assertion truth", async () => {
    const response = await POST(new Request("https://snaplist.dev/api/app-attest", {
      body: "{}",
      method: "POST",
    }));

    expect(response.status).toBe(200);
    expect(createAdminClient).toHaveBeenCalledOnce();
    expect(createSupabaseAppAttestStore).toHaveBeenCalledWith(
      createAdminClient.mock.results[0]!.value,
    );
    expect(createSupabaseVerifiedGuestCapabilityStore).toHaveBeenCalledWith(
      createAdminClient.mock.results[0]!.value,
    );
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({
      kind: "assertion",
      status: "verified",
    }));
    await expect(response.json()).resolves.toMatchObject({
      data: {
        guestCapability: {
          bearerToken: "guestcap_opaque",
          expiresAt: "2026-07-28T15:30:00.000Z",
          refreshAfter: "2026-07-28T15:25:00.000Z",
        },
      },
    });
  });
});
