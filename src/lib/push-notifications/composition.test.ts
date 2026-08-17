import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApnsTestEnv, configureApnsTestEnv } from "@/test/apns-test-config";
import { createSellerPushDispatcherFor } from "./composition";
import type { SellerPushRpcClient } from "./store";

/**
 * Issue #891. What a deployment missing the APNs credential is allowed to break.
 *
 * The eager resolve is right and stays. What was wrong is where its failure
 * landed: this factory is called inside a queue-worker tick and inside a publish
 * request, so a throw here took down draining the queue and publishing to eBay,
 * neither of which needs a push credential to be correct. These tests pin the
 * boundary: the misconfiguration is loud, and it is confined to the push.
 */

function recordingClient() {
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  return { rpc } as unknown as SellerPushRpcClient & { rpc: typeof rpc };
}

describe("building the seller push dispatcher without a credential", () => {
  beforeEach(() => {
    clearApnsTestEnv();
  });
  afterEach(() => {
    configureApnsTestEnv();
  });

  it("hands back a dispatcher instead of failing the caller that asked for one", () => {
    // The callers are a cron tick and an eBay publish request. A throw here
    // stops the queue draining and stops listings publishing, and reads as an
    // eBay fault rather than a missing key.
    expect(() => createSellerPushDispatcherFor(recordingClient())).not.toThrow();
  });

  it("stays quiet for both moments rather than rejecting into the publish path", async () => {
    const push = createSellerPushDispatcherFor(recordingClient());

    await expect(
      push.listingReady({ userId: "user-1", runId: "run-1", itemName: "Lamp" }),
    ).resolves.toBeUndefined();
    await expect(
      push.listingPublished({
        userId: "user-1",
        listingId: "listing-1",
        externalListingId: "ebay-1",
        itemName: "Lamp",
      }),
    ).resolves.toBeUndefined();
  });

  it("leaves the moment unclaimed, so a fixed deployment can still tell the seller", async () => {
    // Claiming here would be worse than the throw it replaces. The claim is
    // permanent and once-only: burning it for a send that never happened would
    // mean repairing the credential and still never announcing that listing.
    const client = recordingClient();

    await createSellerPushDispatcherFor(client).listingReady({
      userId: "user-1",
      runId: "run-1",
      itemName: "Lamp",
    });

    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("reports the misconfiguration by name every time it drops a moment", async () => {
    // The failure this replaces was at least loud. Silence would be the worse
    // half of the original trade: a push path that looks healthy and is dead.
    const log = vi.fn();

    await createSellerPushDispatcherFor(recordingClient(), log).listingReady({
      userId: "user-1",
      runId: "run-1",
      itemName: "Lamp",
    });

    expect(log).toHaveBeenCalledWith(
      "push_not_configured",
      expect.objectContaining({
        moment: "listingReady",
        reason: expect.stringContaining("APNS_KEY_ID"),
      }),
    );
  });
});

describe("building the seller push dispatcher with a credential", () => {
  it("stops reporting the misconfiguration once the credential is supplied", async () => {
    // The sender is built once per process and kept, because Apple refuses a
    // provider that re-signs too often and throttles a connection per push. It
    // is keyed on the configuration so that keeping it cannot mean keeping a
    // failure: a process that starts unconfigured and is then given the key
    // must recover without a restart, and the test above leaves exactly that
    // state behind.
    clearApnsTestEnv();
    const log = vi.fn();
    await createSellerPushDispatcherFor(recordingClient(), log).listingReady({
      userId: "user-1",
      runId: "run-1",
      itemName: "Lamp",
    });
    expect(log).toHaveBeenCalledOnce();

    configureApnsTestEnv();
    const client = recordingClient();
    await createSellerPushDispatcherFor(client, log).listingReady({
      userId: "user-1",
      runId: "run-1",
      itemName: "Lamp",
    });

    expect(log).toHaveBeenCalledOnce();
    expect(client.rpc).toHaveBeenCalled();
  });

  it("reaches the database for the claim, which is the configured path", async () => {
    configureApnsTestEnv();
    const client = recordingClient();

    await createSellerPushDispatcherFor(client).listingReady({
      userId: "user-1",
      runId: "run-1",
      itemName: "Lamp",
    });

    expect(client.rpc).toHaveBeenCalledWith(
      "claim_seller_push_delivery",
      expect.objectContaining({ p_user_id: "user-1" }),
    );
  });
});
