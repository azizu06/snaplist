import { describe, expect, it, vi } from "vitest";
import { MockEbayAdapter } from "./mock";
import { publishListingToEbayAndNotify } from "./publish";
import { EbayApiError } from "./types";
import { fakePublishClient } from "./publish.test-fixture";

/**
 * Issue #891. The second of the two moments a seller is told about.
 *
 * A confirmed publish is the only thing that earns this push. Everything else
 * on this path (a validation refusal, an auth failure, an ambiguous write) is
 * either not an outcome yet or not one worth interrupting someone for.
 *
 * Fully offline: the repository's mock adapter, the shared publish double, and
 * a spy for the announcement.
 */

function dispatcherSpy() {
  return {
    listingReady: vi.fn(async () => undefined),
    listingPublished: vi.fn(async () => undefined),
  };
}

describe("confirmed-publish push (#891)", () => {
  it("tells the seller once, naming the item and the confirmed eBay listing", async () => {
    const { client, listing } = fakePublishClient(null);
    const adapter = new MockEbayAdapter();
    const push = dispatcherSpy();

    const outcome = await publishListingToEbayAndNotify(
      client,
      "user-1",
      listing.id,
      adapter,
      { push },
    );

    expect(push.listingPublished).toHaveBeenCalledTimes(1);
    expect(push.listingPublished).toHaveBeenCalledWith({
      userId: "user-1",
      listingId: listing.id,
      externalListingId: outcome.ebayListingId,
      itemName: "Sony WH-1000XM4 Headphones",
    });
  });

  it("says nothing when a retried publish resolves to the stored result", async () => {
    const { client, listing } = fakePublishClient(null);
    const adapter = new MockEbayAdapter();
    const push = dispatcherSpy();

    const first = await publishListingToEbayAndNotify(
      client,
      "user-1",
      listing.id,
      adapter,
      { push },
    );
    const replay = await publishListingToEbayAndNotify(
      client,
      "user-1",
      listing.id,
      adapter,
      { push },
    );

    expect(replay).toMatchObject({
      alreadyPublished: true,
      ebayListingId: first.ebayListingId,
    });
    expect(adapter.requests).toHaveLength(1);
    expect(push.listingPublished).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the publish fails", async () => {
    const { client, listing, notifications } = fakePublishClient(null);
    const adapter = new MockEbayAdapter();
    adapter.failWith = new EbayApiError("eBay refused the offer", 400, {});
    const push = dispatcherSpy();

    await expect(
      publishListingToEbayAndNotify(client, "user-1", listing.id, adapter, {
        push,
      }),
    ).rejects.toBe(adapter.failWith);

    expect(push.listingPublished).not.toHaveBeenCalled();
    // The existing in-app activity row is untouched by #891.
    expect(notifications.at(-1)).toMatchObject({ kind: "listing_failed" });
  });

  it("announces only after the published outcome is persisted", async () => {
    const { client, listing } = fakePublishClient(null);
    const push = dispatcherSpy();
    const persistedAt: number[] = [];
    const adapter = new MockEbayAdapter();

    await publishListingToEbayAndNotify(client, "user-1", listing.id, adapter, {
      push,
    });

    persistedAt.push(listing.ebay_status === "published" ? 1 : 0);
    expect(persistedAt).toEqual([1]);
    expect(push.listingPublished).toHaveBeenCalledTimes(1);
  });

  it("returns the publish outcome even when the announcement throws", async () => {
    const { client, listing } = fakePublishClient(null);
    const push = dispatcherSpy();
    push.listingPublished.mockRejectedValue(new Error("push unavailable"));

    const outcome = await publishListingToEbayAndNotify(
      client,
      "user-1",
      listing.id,
      new MockEbayAdapter(),
      { push },
    );

    expect(outcome).toMatchObject({ ebayStatus: "published" });
  });

  it("publishes normally when no announcement capability is wired", async () => {
    const { client, listing } = fakePublishClient(null);

    const outcome = await publishListingToEbayAndNotify(
      client,
      "user-1",
      listing.id,
      new MockEbayAdapter(),
    );

    expect(outcome).toMatchObject({ ebayStatus: "published" });
  });
});
