import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verifyToken, createConfiguredMobileItemSubmissionOperations, submit } = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  createConfiguredMobileItemSubmissionOperations: vi.fn(),
  submit: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));
vi.mock("@/lib/mobile-item-submission/configured", () => ({
  createConfiguredMobileItemSubmissionOperations,
}));

import { POST } from "./route";

const environmentKeys = [
  "CLERK_SECRET_KEY",
  "CLERK_AUTHORIZED_PARTIES",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
] as const;

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_release";
  process.env.CLERK_AUTHORIZED_PARTIES = "https://snaplist.example";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_release";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_release";
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
});
