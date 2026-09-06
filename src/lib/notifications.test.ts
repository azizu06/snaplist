import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

const { reportServerError } = vi.hoisted(() => ({ reportServerError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ reportServerError }));

import { createNotification } from "./notifications";

/**
 * `createNotification` is documented as fire-and-forget: a publish or
 * failure flow that calls it must never be interrupted by a notification
 * write going wrong. These tests pin that contract directly, since the only
 * caller in the repo (the eBay publish path) is out of scope for this suite.
 */

afterEach(() => {
  reportServerError.mockReset();
});

function fakeClient(
  insert: (values: unknown) => PromiseLike<{ error: { message: string } | null }>,
): SupabaseClient {
  return { from: () => ({ insert }) } as unknown as SupabaseClient;
}

describe("createNotification", () => {
  it("maps every field to its column and never throws on success", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });

    await expect(
      createNotification(fakeClient(insert), {
        userId: "user-1",
        kind: "listing_ready",
        title: "Your listing is ready",
        body: "Review it before anything posts.",
        href: "/trophy-wall/item-1",
        itemId: "item-1",
        listingId: "listing-1",
      }),
    ).resolves.toBeUndefined();

    expect(insert).toHaveBeenCalledWith({
      user_id: "user-1",
      kind: "listing_ready",
      title: "Your listing is ready",
      body: "Review it before anything posts.",
      href: "/trophy-wall/item-1",
      item_id: "item-1",
      listing_id: "listing-1",
    });
    expect(reportServerError).not.toHaveBeenCalled();
  });

  it("nulls omitted optional fields rather than sending undefined", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });

    await createNotification(fakeClient(insert), {
      userId: "user-1",
      kind: "system",
      title: "System notice",
    });

    expect(insert).toHaveBeenCalledWith({
      user_id: "user-1",
      kind: "system",
      title: "System notice",
      body: null,
      href: null,
      item_id: null,
      listing_id: null,
    });
  });

  it("swallows a Supabase insert error and reports it instead of throwing", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: "insert failed" } });

    await expect(
      createNotification(fakeClient(insert), {
        userId: "user-1",
        kind: "pipeline_failed",
        title: "We could not finish this item",
      }),
    ).resolves.toBeUndefined();

    expect(reportServerError).toHaveBeenCalledTimes(1);
    expect(reportServerError).toHaveBeenCalledWith(
      "notifications.create",
      expect.any(Error),
      { kind: "pipeline_failed" },
    );
  });

  it("swallows a rejected insert call and reports it instead of throwing", async () => {
    const insert = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(
      createNotification(fakeClient(insert), {
        userId: "user-1",
        kind: "listing_published",
        title: "Published to eBay",
      }),
    ).resolves.toBeUndefined();

    expect(reportServerError).toHaveBeenCalledTimes(1);
    expect(reportServerError).toHaveBeenCalledWith(
      "notifications.create",
      expect.any(Error),
      { kind: "listing_published" },
    );
  });
});
