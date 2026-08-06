import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, verifyToken } = vi.hoisted(() => ({
  createClient: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient }));
vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));

import { DELETE } from "./route";

const ITEM_ID = "18100000-0000-4000-8000-000000000001";
const CALLER_BEARER = "caller-clerk-bearer";

describe("item deletion route composition", () => {
  const rpc = vi.fn();

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_caller_only");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_181");
    vi.stubEnv("CLERK_AUTHORIZED_PARTIES", "https://app.snaplist.test");
    verifyToken.mockResolvedValue({ sub: "user_181" });
    rpc.mockResolvedValue({
      data: {
        status: "deleted",
        item_id: ITEM_ID,
        blocked_by: [],
        retained_records: ["ebay-live-listing"],
      },
      error: null,
    });
    createClient.mockReturnValue({ rpc });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("reaches the executor through a client scoped to the caller's own bearer", async () => {
    const response = await DELETE(
      new Request(`https://api.test/v1/items/${ITEM_ID}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${CALLER_BEARER}` },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { itemId: ITEM_ID, retainedRecords: ["ebay-live-listing"] },
    });
    expect(rpc).toHaveBeenCalledWith("delete_item", { p_item_id: ITEM_ID });
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

  it("refuses to delete when Supabase is unconfigured rather than reporting success", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");

    const response = await DELETE(
      new Request(`https://api.test/v1/items/${ITEM_ID}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${CALLER_BEARER}` },
      }),
    );

    expect(response.status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });
});
