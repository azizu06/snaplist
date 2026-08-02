import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, verifyToken } = vi.hoisted(() => ({
  createClient: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient }));
vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));

import { GET } from "./route";

const ITEM_ID = "58100000-0000-4000-8000-000000000001";
const CONTENT_REVISION = "58100000-0000-4000-8000-0000000000c0";
const CALLER_BEARER = "caller-clerk-bearer";

describe("assisted export handoffs route composition", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_caller_only");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_581");
    vi.stubEnv("CLERK_AUTHORIZED_PARTIES", "https://app.snaplist.test");
    verifyToken.mockResolvedValue({ sub: "user_581" });
    createClient.mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(async () => ({ data: [], error: null })),
          })),
        })),
      })),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("composes the production route through a caller-scoped Supabase gateway", async () => {
    const response = await GET(
      new Request(
        `https://api.test/v1/items/${ITEM_ID}/export-handoffs?reviewContentRevision=${CONTENT_REVISION}`,
        { headers: { authorization: `Bearer ${CALLER_BEARER}` } },
      ),
    );

    expect(response.status).toBe(200);
    expect(createClient).toHaveBeenCalledWith(
      "https://project.supabase.co",
      "sb_publishable_caller_only",
      expect.objectContaining({
        accessToken: expect.any(Function),
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    );
    const options = createClient.mock.calls[0]?.[2] as {
      accessToken: () => Promise<string>;
    };
    await expect(options.accessToken()).resolves.toBe(CALLER_BEARER);
  });
});
