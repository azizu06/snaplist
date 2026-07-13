import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUserId: vi.fn(async () => "user-1"),
  revalidatePath: vi.fn(),
  reportServerError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ getUserId: mocks.getUserId }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/sentry", () => ({ reportServerError: mocks.reportServerError }));

import { archiveListings, bulkUpdateListings } from "./actions";

describe("dashboard review mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue("user-1");
  });

  it("persists price and cost basis through one revision-advancing RPC", async () => {
    const rpc = vi.fn(async () => ({ error: null }));
    mocks.createClient.mockResolvedValue({ rpc });

    await bulkUpdateListings([
      {
        itemId: "item-1",
        listingId: null,
        price: 125,
        costBasis: 40,
      },
    ]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("update_dashboard_review", {
      p_item_id: "item-1",
      p_listing_id: null,
      p_set_price_override: true,
      p_price_override: 125,
      p_set_cost_basis: true,
      p_cost_basis: 40,
      p_set_status: false,
      p_status: null,
    });
  });

  it("archives a non-live listing through the same atomic RPC", async () => {
    const rpc = vi.fn(async () => ({ error: null }));
    const listingQuery = {
      select: () => listingQuery,
      in: async () => ({
        data: [{ id: "listing-1", ebay_listing_id: null, ebay_status: null }],
        error: null,
      }),
    };
    mocks.createClient.mockResolvedValue({
      from: () => listingQuery,
      rpc,
    });

    await archiveListings(["listing-1"]);

    expect(rpc).toHaveBeenCalledWith("update_dashboard_review", {
      p_item_id: null,
      p_listing_id: "listing-1",
      p_set_price_override: false,
      p_price_override: null,
      p_set_cost_basis: false,
      p_cost_basis: null,
      p_set_status: true,
      p_status: "archived",
    });
  });
});
