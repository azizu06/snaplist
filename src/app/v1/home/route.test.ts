import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verifyToken, createConfiguredSupabaseHomeProjectionReader, forSeller } = vi.hoisted(
  () => ({
    verifyToken: vi.fn(),
    createConfiguredSupabaseHomeProjectionReader: vi.fn(),
    forSeller: vi.fn(),
  }),
);

vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));
vi.mock("@/lib/home/projection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/home/projection")>()),
  createConfiguredSupabaseHomeProjectionReader,
}));

import { GET } from "./route";

const environmentKeys = [
  "CLERK_SECRET_KEY",
  "CLERK_AUTHORIZED_PARTIES",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_release";
  process.env.CLERK_AUTHORIZED_PARTIES =
    "https://snaplist.example,http://127.0.0.1:3001";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_release";
  verifyToken.mockResolvedValue({
    sub: "user_release",
    role: "authenticated",
    iss: "https://clerk.snaplist.example",
    exp: Math.floor(Date.now() / 1_000) + 60,
    azp: "https://snaplist.example",
  });
  forSeller.mockResolvedValue({
    revision: 0,
    sellerState: "newSeller",
    unreadNotificationCount: 0,
    summary: { active: 0, drafts: 0, orders: 0 },
    attention: [],
    currentRun: null,
    readyToFinish: [],
    listings: [],
    recentSearches: [],
  });
  createConfiguredSupabaseHomeProjectionReader.mockReturnValue({ forSeller });
});

afterEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  vi.clearAllMocks();
});

describe("production Home route composition", () => {
  it("accepts the canonical Clerk Supabase token contract without treating role as aud", async () => {
    const response = await GET(
      new Request("https://snaplist.example/v1/home", {
        headers: { authorization: "Bearer signed-release-jwt" },
      }),
    );

    expect(response.status).toBe(200);
    expect(verifyToken).toHaveBeenCalledWith("signed-release-jwt", {
      secretKey: "sk_test_release",
      authorizedParties: ["https://snaplist.example", "http://127.0.0.1:3001"],
    });
    expect(verifyToken.mock.calls[0]?.[1]).not.toHaveProperty("audience");
    expect(createConfiguredSupabaseHomeProjectionReader).toHaveBeenCalledWith({
      supabaseURL: "https://project.supabase.co",
      anonKey: "sb_publishable_release",
    });
    expect(forSeller).toHaveBeenCalledWith({
      userId: "user_release",
      bearerToken: "signed-release-jwt",
    });
  });

  it("fails closed before projection access when the bearer is invalid", async () => {
    verifyToken.mockRejectedValue(new Error("invalid bearer"));

    const response = await GET(
      new Request("https://snaplist.example/v1/home", {
        headers: { authorization: "Bearer forged" },
      }),
    );

    expect(response.status).toBe(401);
    expect(createConfiguredSupabaseHomeProjectionReader).not.toHaveBeenCalled();
    expect(forSeller).not.toHaveBeenCalled();
  });

  it("rejects a session token for an unauthorized party", async () => {
    verifyToken.mockRejectedValue(new Error("authorized party mismatch"));

    const response = await GET(
      new Request("https://snaplist.example/v1/home", {
        headers: { authorization: "Bearer wrong-party" },
      }),
    );

    expect(response.status).toBe(401);
    expect(verifyToken).toHaveBeenCalledWith(
      "wrong-party",
      expect.objectContaining({
        authorizedParties: ["https://snaplist.example", "http://127.0.0.1:3001"],
      }),
    );
    expect(forSeller).not.toHaveBeenCalled();
  });

  it("returns an honest 503 when the RLS projection is not configured", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const response = await GET(
      new Request("https://snaplist.example/v1/home", {
        headers: { authorization: "Bearer signed-release-jwt" },
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Home is temporarily unavailable." },
    });
  });
});
