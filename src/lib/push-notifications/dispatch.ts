import { buildSellerPushMessage, type SellerPushMoment } from "./message";
import type { ApnsSender, SellerPushDevice } from "./sender";

/**
 * The two moments, dispatched (#891).
 *
 * Both fire points call this, so the pipeline path and the publish path can
 * never disagree about what a seller is told or how often.
 *
 * ORDER MATTERS. The claim is written before a single byte reaches Apple, which
 * makes a lost push possible and a duplicate push impossible. That trade is the
 * intended one: the seller notices being told twice about one listing, and the
 * cost of a push that never arrived is that they open an app they were opening
 * anyway. Sending first and recording after would invert it.
 *
 * Nothing here throws. A push is an announcement about work that already
 * finished and was already paid for; it must never be able to fail the run that
 * produced it, so every failure ends at a log line.
 */

export type SellerPushDeviceToken = SellerPushDevice;

export interface SellerPushStore {
  /**
   * Records that this moment is being announced. True only for the call that
   * won; every later call for the same logical moment gets false and stops.
   */
  claimDelivery(input: {
    userId: string;
    moment: SellerPushMoment;
    eventKey: string;
  }): Promise<boolean>;
  /**
   * The seller's registered devices. Scoped to the one named user by the
   * database, never by a filter this code remembered to add.
   */
  devicesForUser(userId: string): Promise<SellerPushDeviceToken[]>;
  forgetDevice(input: {
    userId: string;
    platform: string;
    token: string;
  }): Promise<void>;
}

export interface SellerPushReadyEvent {
  userId: string;
  /** The logical run. A retry, a redelivery, and a recovery share it. */
  runId: string;
  itemName: string | null;
}

export interface SellerPushPublishedEvent {
  userId: string;
  listingId: string;
  /** The confirmed eBay listing. Two publishes resolving here are one moment. */
  externalListingId: string;
  itemName: string | null;
}

export interface SellerPushDispatcher {
  listingReady(event: SellerPushReadyEvent): Promise<void>;
  listingPublished(event: SellerPushPublishedEvent): Promise<void>;
}

type PushLog = (event: string, detail: Record<string, unknown>) => void;

const defaultLog: PushLog = (event, detail) => {
  console.error(`[push.${event}]`, detail);
};

export function createSellerPushDispatcher(input: {
  store: SellerPushStore;
  sender: ApnsSender;
  log?: PushLog;
}): SellerPushDispatcher {
  const log = input.log ?? defaultLog;

  async function dispatch(
    moment: SellerPushMoment,
    userId: string,
    eventKey: string,
    itemName: string | null,
  ): Promise<void> {
    try {
      if (!(await input.store.claimDelivery({ userId, moment, eventKey }))) {
        return;
      }
      const devices = await input.store.devicesForUser(userId);
      const message = buildSellerPushMessage({ moment, itemName });
      for (const device of devices) {
        await deliver(device, moment, eventKey, message, userId);
      }
    } catch (error) {
      // Includes the claim itself. A database SnapList cannot reach is a reason
      // to stay quiet, never a reason to fail the caller.
      log("dispatch_failed", { moment, reason: describe(error) });
    }
  }

  async function deliver(
    device: SellerPushDeviceToken,
    moment: SellerPushMoment,
    eventKey: string,
    message: ReturnType<typeof buildSellerPushMessage>,
    userId: string,
  ): Promise<void> {
    let result;
    try {
      result = await input.sender.send({
        device,
        message,
        moment,
        collapseId: `${moment}:${eventKey}`,
      });
    } catch (error) {
      log("send_failed", { moment, reason: describe(error) });
      return;
    }
    if (result.outcome === "failed") {
      log("send_failed", { moment, reason: result.reason });
      return;
    }
    if (result.outcome === "deviceGone") {
      try {
        await input.store.forgetDevice({
          userId,
          platform: device.platform,
          token: device.token,
        });
      } catch (error) {
        log("forget_device_failed", { moment, reason: describe(error) });
      }
    }
  }

  return {
    listingReady(event) {
      return dispatch(
        "listingReady",
        event.userId,
        event.runId,
        event.itemName,
      );
    },
    listingPublished(event) {
      return dispatch(
        "listingPublished",
        event.userId,
        event.externalListingId,
        event.itemName,
      );
    },
  };
}

/**
 * Only the error's shape. A push failure can carry provider text, and the
 * moments it rides on include the seller's own generated item copy, so the log
 * records what went wrong without repeating either.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
