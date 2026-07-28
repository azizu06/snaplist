import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createConfiguredMobileItemSubmissionOperations,
  createConfiguredVerifiedGuestPrincipalResolver,
  resolveGuest,
  signGuestOperation,
  submit,
  verifyToken,
} = vi.hoisted(() => ({
  createConfiguredMobileItemSubmissionOperations: vi.fn(),
  createConfiguredVerifiedGuestPrincipalResolver: vi.fn(),
  resolveGuest: vi.fn(),
  signGuestOperation: vi.fn(),
  submit: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));
vi.mock("@/lib/mobile-item-submission/configured", () => ({
  createConfiguredMobileItemSubmissionOperations,
}));
vi.mock("@/lib/guest-capability/configured", () => ({
  createConfiguredVerifiedGuestPrincipalResolver,
}));

import { POST } from "./route";

const environmentKeys = [
  "CLERK_SECRET_KEY",
  "CLERK_AUTHORIZED_PARTIES",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_GUEST_JWT_KEY_ID",
  "SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM",
] as const;

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_release";
  process.env.CLERK_AUTHORIZED_PARTIES = "https://snaplist.example";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_release";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_release";
  process.env.SUPABASE_GUEST_JWT_KEY_ID = "guest-es256-release";
  process.env.SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM = "-----BEGIN PRIVATE KEY-----\\nfixed";
  verifyToken.mockResolvedValue({ sub: "user_release" });
  submit.mockResolvedValue({
    outcome: "created",
    receipt: {
      itemId: "33430000-0000-4000-8000-000000000002",
      runId: "33430000-0000-4000-8000-000000000003",
      status: "queued",
      stage: "queued",
      photoIdentity: {
        kind: "content_sha256_set_v1",
        fingerprint: "a".repeat(64),
      },
      photos: [{
        ordinal: 0,
        contentSha256: "b".repeat(64),
        byteLength: 4,
        mediaType: "image/jpeg",
      }],
    },
  });
  createConfiguredMobileItemSubmissionOperations.mockReturnValue({ submit });
  resolveGuest.mockResolvedValue({
    capabilityId: "33200000-0000-4000-8000-000000000002",
    kind: "verifiedGuest",
    mintOperationToken: signGuestOperation,
    userId: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  createConfiguredVerifiedGuestPrincipalResolver.mockReturnValue({
    resolve: resolveGuest,
  });
});

afterEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  vi.clearAllMocks();
});

describe("production mobile item submission route", () => {
  it("verifies Clerk and composes only current Supabase publishable/secret keys", async () => {
    const body = new FormData();
    body.append(
      "photo",
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "item.jpg", {
        type: "image/jpeg",
      }),
    );
    const response = await POST(new Request("https://snaplist.example/v1/items/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer signed-release-jwt",
        "idempotency-key": "33430000-0000-4000-8000-000000000001",
      },
      body,
    }));

    expect(response.status).toBe(202);
    expect(verifyToken).toHaveBeenCalledWith("signed-release-jwt", {
      secretKey: "sk_test_release",
      authorizedParties: ["https://snaplist.example"],
    });
    expect(createConfiguredMobileItemSubmissionOperations).toHaveBeenCalledWith({
      supabaseURL: "https://project.supabase.co",
      publishableKey: "sb_publishable_release",
      secretKey: "sb_secret_release",
    });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      principal: {
        kind: "clerk",
        userId: "user_release",
        bearerToken: "signed-release-jwt",
      },
      idempotencyKey: "33430000-0000-4000-8000-000000000001",
      photos: [expect.objectContaining({ contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })],
    }));
    await expect(response.json()).resolves.toMatchObject({
      data: { runId: "33430000-0000-4000-8000-000000000003" },
    });
  });

  it("accepts the documented Supabase env names when they contain current keys", async () => {
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_documented";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_documented";
    const body = new FormData();
    body.append(
      "photo",
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "item.jpg", {
        type: "image/jpeg",
      }),
    );

    const response = await POST(new Request("https://snaplist.example/v1/items/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer signed-release-jwt",
        "idempotency-key": "33430000-0000-4000-8000-000000000001",
      },
      body,
    }));

    expect(response.status).toBe(202);
    expect(createConfiguredMobileItemSubmissionOperations).toHaveBeenCalledWith({
      supabaseURL: "https://project.supabase.co",
      publishableKey: "sb_publishable_documented",
      secretKey: "sb_secret_documented",
    });
  });

  it("resolves GuestBearer without Clerk fallback and passes no service credential to submission", async () => {
    const body = new FormData();
    body.append(
      "photo",
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "item.jpg", {
        type: "image/jpeg",
      }),
    );
    const guestBearer = `guestcap_${"A".repeat(43)}`;

    const response = await POST(new Request("https://snaplist.example/v1/items/runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${guestBearer}`,
        "idempotency-key": "33430000-0000-4000-8000-000000000001",
      },
      body,
    }));

    expect(response.status).toBe(202);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(createConfiguredVerifiedGuestPrincipalResolver).toHaveBeenCalledWith({
      keyId: "guest-es256-release",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\\nfixed",
      secretKey: "sb_secret_release",
      supabaseURL: "https://project.supabase.co",
    });
    expect(resolveGuest).toHaveBeenCalledWith(guestBearer);
    expect(createConfiguredMobileItemSubmissionOperations).toHaveBeenCalledWith({
      publishableKey: "sb_publishable_release",
      supabaseURL: "https://project.supabase.co",
    });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({
        capabilityId: "33200000-0000-4000-8000-000000000002",
        kind: "verifiedGuest",
        userId: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    }));
    expect(JSON.stringify(submit.mock.calls)).not.toContain(guestBearer);
  });

  it("never falls through a rejected GuestBearer to Clerk", async () => {
    resolveGuest.mockRejectedValueOnce(new Error("Inactive guest capability."));
    const body = new FormData();
    body.append(
      "photo",
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "item.jpg", {
        type: "image/jpeg",
      }),
    );

    const response = await POST(new Request("https://snaplist.example/v1/items/runs", {
      method: "POST",
      headers: {
        authorization: `Bearer guestcap_${"Z".repeat(43)}`,
        "idempotency-key": "33430000-0000-4000-8000-000000000001",
      },
      body,
    }));

    expect(response.status).toBe(401);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
