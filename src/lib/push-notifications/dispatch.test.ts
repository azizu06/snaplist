import { describe, expect, it, vi } from "vitest";
import { MockApnsSender } from "./sender";
import {
  createSellerPushDispatcher,
  type SellerPushDeviceToken,
  type SellerPushStore,
} from "./dispatch";

/**
 * Issue #891. One push per moment, and nothing the pipeline can trip over.
 *
 * The claim is taken before anything is sent, so the only failure this design
 * permits is a push that never arrives. That is deliberate: a listing announced
 * twice is a defect the seller reports, and a push that silently did not arrive
 * costs them one trip into an app they were going to open anyway.
 */

const OWNER = "user_owner";
// Deliberately different environments: a seller running a development build and
// a shipped one is one tenant with two addresses on two APNs hosts.
const DEVICE_A: SellerPushDeviceToken = {
  platform: "ios",
  token: "a".repeat(64),
  environment: "production",
};
const DEVICE_B: SellerPushDeviceToken = {
  platform: "ios",
  token: "b".repeat(64),
  environment: "sandbox",
};

/** What `forgetDevice` is told: the device, not the row it came from. */
interface ForgottenDevice {
  platform: string;
  token: string;
}

function createStore(
  overrides: Partial<SellerPushStore> & { devices?: SellerPushDeviceToken[] } = {},
): SellerPushStore & { claims: string[]; forgotten: ForgottenDevice[] } {
  const claimed = new Set<string>();
  const claims: string[] = [];
  const forgotten: ForgottenDevice[] = [];
  const devices = overrides.devices ?? [DEVICE_A];
  return {
    claims,
    forgotten,
    async claimDelivery({ userId, moment, eventKey }) {
      const key = `${userId}:${moment}:${eventKey}`;
      claims.push(key);
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    async devicesForUser() {
      return devices;
    },
    async forgetDevice(device) {
      forgotten.push({ platform: device.platform, token: device.token });
    },
    ...overrides,
  };
}

describe("seller push dispatch (#891)", () => {
  it("tells every device the seller registered that a listing is ready", async () => {
    const sender = new MockApnsSender();
    const dispatcher = createSellerPushDispatcher({
      store: createStore({ devices: [DEVICE_A, DEVICE_B] }),
      sender,
    });

    await dispatcher.listingReady({
      userId: OWNER,
      runId: "run-1",
      itemName: "Sony WH-1000XM4",
    });

    expect(sender.sent.map((entry) => entry.device.token)).toEqual([
      DEVICE_A.token,
      DEVICE_B.token,
    ]);
    expect(sender.sent[0].message.title).toBe(
      "Sony WH-1000XM4 is ready to review",
    );
  });

  it("fires once for a logical run however many times the run is delivered", async () => {
    const sender = new MockApnsSender();
    const store = createStore();
    const dispatcher = createSellerPushDispatcher({ store, sender });

    await dispatcher.listingReady({ userId: OWNER, runId: "run-1", itemName: "Kit" });
    await dispatcher.listingReady({ userId: OWNER, runId: "run-1", itemName: "Kit" });
    await dispatcher.listingReady({ userId: OWNER, runId: "run-1", itemName: "Kit" });

    expect(sender.sent).toHaveLength(1);
  });

  it("keys the ready claim on the run, so a different run still gets its push", async () => {
    const sender = new MockApnsSender();
    const dispatcher = createSellerPushDispatcher({ store: createStore(), sender });

    await dispatcher.listingReady({ userId: OWNER, runId: "run-1", itemName: "Kit" });
    await dispatcher.listingReady({ userId: OWNER, runId: "run-2", itemName: "Kit" });

    expect(sender.sent).toHaveLength(2);
  });

  it("fires once for a publish that resolves to the same external listing", async () => {
    const sender = new MockApnsSender();
    const dispatcher = createSellerPushDispatcher({ store: createStore(), sender });

    const publish = {
      userId: OWNER,
      listingId: "listing-1",
      externalListingId: "EBAY-9001",
      itemName: "Kit",
    };
    await dispatcher.listingPublished(publish);
    await dispatcher.listingPublished(publish);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].message.title).toBe("Kit is live on eBay");
  });

  it("never reads a seller's devices for a moment it did not claim", async () => {
    const store = createStore();
    const devicesForUser = vi.fn(async () => [DEVICE_A]);
    const dispatcher = createSellerPushDispatcher({
      store: { ...store, devicesForUser },
      sender: new MockApnsSender(),
    });

    await dispatcher.listingReady({ userId: OWNER, runId: "run-1", itemName: "Kit" });
    await dispatcher.listingReady({ userId: OWNER, runId: "run-1", itemName: "Kit" });

    expect(devicesForUser).toHaveBeenCalledTimes(1);
  });

  it("forgets a device APNs reports as gone and keeps delivering to the rest", async () => {
    const sender = new MockApnsSender({
      [DEVICE_A.token]: { outcome: "deviceGone" },
    });
    const store = createStore({ devices: [DEVICE_A, DEVICE_B] });
    const dispatcher = createSellerPushDispatcher({ store, sender });

    await dispatcher.listingReady({ userId: OWNER, runId: "run-1", itemName: "Kit" });

    expect(store.forgotten).toEqual([
      { platform: DEVICE_A.platform, token: DEVICE_A.token },
    ]);
    expect(sender.sent.map((entry) => entry.device.token)).toEqual([
      DEVICE_A.token,
      DEVICE_B.token,
    ]);
  });

  it("logs and drops a send that fails without disturbing the caller", async () => {
    const log = vi.fn();
    const sender = new MockApnsSender({
      [DEVICE_A.token]: { outcome: "failed", reason: "apns_unavailable" },
    });
    const dispatcher = createSellerPushDispatcher({
      store: createStore(),
      sender,
      log,
    });

    await expect(
      dispatcher.listingReady({ userId: OWNER, runId: "run-1", itemName: "Kit" }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("survives a sender that throws", async () => {
    const log = vi.fn();
    const dispatcher = createSellerPushDispatcher({
      store: createStore(),
      sender: {
        async send() {
          throw new Error("connection reset");
        },
      },
      log,
    });

    await expect(
      dispatcher.listingReady({ userId: OWNER, runId: "run-1", itemName: "Kit" }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("survives a store that cannot be reached at all", async () => {
    const log = vi.fn();
    const sender = new MockApnsSender();
    const dispatcher = createSellerPushDispatcher({
      store: {
        async claimDelivery() {
          throw new Error("database unreachable");
        },
        async devicesForUser() {
          return [];
        },
        async forgetDevice() {},
      },
      sender,
      log,
    });

    await expect(
      dispatcher.listingPublished({
        userId: OWNER,
        listingId: "listing-1",
        externalListingId: "EBAY-9001",
        itemName: "Kit",
      }),
    ).resolves.toBeUndefined();
    expect(sender.sent).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it("says nothing when the seller has no registered device", async () => {
    const sender = new MockApnsSender();
    const dispatcher = createSellerPushDispatcher({
      store: createStore({ devices: [] }),
      sender,
    });

    await dispatcher.listingReady({ userId: OWNER, runId: "run-1", itemName: "Kit" });

    expect(sender.sent).toEqual([]);
  });
});
