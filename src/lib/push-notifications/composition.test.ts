import { generateKeyPairSync } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const FIXED_APNS_CONFIG = {
  bundleId: "com.snaplist.app.test",
  keyId: "TEST_KEY_ID",
  privateKeyPem: "test-pem",
  teamId: "TEST_TEAM_ID",
};

/**
 * Issue #891 standards review. Every other test in this file proves the
 * *keying* (recovery once the config changes). None of them proves the
 * headline behavior of the commit: `createHttpApnsSender` runs once per
 * process, not once per caller. A regression back to per-call construction,
 * with keyed failure caching left intact, would pass every other test here.
 */
describe("building the sender once per process, not once per caller", () => {
  afterEach(() => {
    vi.doUnmock("./apns");
    vi.resetModules();
    configureApnsTestEnv();
  });

  it("calls createHttpApnsSender once across two calls with an unchanged environment", async () => {
    vi.resetModules();
    const createHttpApnsSender = vi.fn(() => ({ send: vi.fn() }));
    vi.doMock("./apns", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./apns")>();
      return {
        ...actual,
        createHttpApnsSender,
        resolveApnsConfig: vi.fn(() => FIXED_APNS_CONFIG),
        createApnsHttp2Transport: vi.fn(() => ({})),
      };
    });
    const { createSellerPushDispatcherFor } = await import("./composition");
    configureApnsTestEnv();

    createSellerPushDispatcherFor(recordingClient());
    createSellerPushDispatcherFor(recordingClient());

    expect(createHttpApnsSender).toHaveBeenCalledTimes(1);
  });

  it("calls createHttpApnsSender twice when the environment changes between calls", async () => {
    vi.resetModules();
    const createHttpApnsSender = vi.fn(() => ({ send: vi.fn() }));
    vi.doMock("./apns", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./apns")>();
      return {
        ...actual,
        createHttpApnsSender,
        resolveApnsConfig: vi.fn(() => FIXED_APNS_CONFIG),
        createApnsHttp2Transport: vi.fn(() => ({})),
      };
    });
    const { createSellerPushDispatcherFor } = await import("./composition");
    configureApnsTestEnv();

    createSellerPushDispatcherFor(recordingClient());
    process.env.APNS_TEAM_ID = "TEST_TEAM_ID_2";
    createSellerPushDispatcherFor(recordingClient());

    expect(createHttpApnsSender).toHaveBeenCalledTimes(2);
  });
});

/**
 * Issue #891 standards review, second pass. Nothing proved the self-healing
 * behavior itself, end to end: a transient `resolveApnsConfig` failure — one
 * that is not an `ApnsMisconfiguredError` — must not be cached, so the very
 * next call re-resolves and gets a working sender rather than staying stuck
 * reporting the same failure for the life of the process.
 *
 * This drives the real `resolveApnsConfig` from ./apns, not a mock of it, so
 * a regression that mislabels the read-failure branch as
 * `ApnsMisconfiguredError` (the exact bug this fix closed) fails this test
 * too, not just the unit test of `resolveApnsConfig` in apns.test.ts.
 * `createHttpApnsSender` and the transport are mocked only to skip real JWT
 * signing and HTTP/2, neither of which this test is about.
 */
describe("recovering from a transient resolveApnsConfig failure", () => {
  afterEach(() => {
    vi.doUnmock("./apns");
    vi.resetModules();
    configureApnsTestEnv();
  });

  it("re-resolves and reaches the database once a transient key-read failure clears", async () => {
    vi.resetModules();
    const createHttpApnsSender = vi.fn(() => ({ send: vi.fn() }));
    vi.doMock("./apns", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./apns")>();
      return {
        ...actual,
        createHttpApnsSender,
        createApnsHttp2Transport: vi.fn(() => ({})),
      };
    });
    const { createSellerPushDispatcherFor } = await import("./composition");

    // A key file that does not exist yet — the mid-mount or mid-rotation
    // moment the fix in #891 exists to survive.
    const keyPath = join(
      tmpdir(),
      `snaplist-transient-apns-test-${process.pid}.p8`,
    );
    if (existsSync(keyPath)) unlinkSync(keyPath);
    process.env.APNS_KEY_ID = "TEST_KEY_ID";
    process.env.APNS_TEAM_ID = "TEST_TEAM_ID";
    process.env.APNS_BUNDLE_ID = "com.snaplist.app.test";
    process.env.APNS_AUTH_KEY_PATH = keyPath;

    try {
      const log = vi.fn();
      const firstClient = recordingClient();
      await createSellerPushDispatcherFor(firstClient, log).listingReady({
        userId: "user-1",
        runId: "run-1",
        itemName: "Lamp",
      });

      expect(log).toHaveBeenCalledWith(
        "push_not_configured",
        expect.objectContaining({
          reason: expect.stringContaining("APNS_AUTH_KEY_PATH"),
        }),
      );
      expect(firstClient.rpc).not.toHaveBeenCalled();

      // The key lands — the mount finishes, the rotation completes.
      writeFileSync(
        keyPath,
        generateKeyPairSync("ec", { namedCurve: "P-256" })
          .privateKey.export({ format: "pem", type: "pkcs8" })
          .toString(),
      );

      const secondClient = recordingClient();
      await createSellerPushDispatcherFor(secondClient, log).listingReady({
        userId: "user-1",
        runId: "run-1",
        itemName: "Lamp",
      });

      expect(secondClient.rpc).toHaveBeenCalled();
      expect(createHttpApnsSender).toHaveBeenCalledTimes(1);
    } finally {
      if (existsSync(keyPath)) unlinkSync(keyPath);
    }
  });
});
