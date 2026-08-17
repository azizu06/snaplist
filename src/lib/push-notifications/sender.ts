import type { SellerPushMessage, SellerPushMoment } from "./message";

/**
 * The APNs seam (#891).
 *
 * Modelled on the eBay adapter: one narrow interface, a mock that proves the
 * behaviour offline, and an HTTP implementation the operator activates with a
 * credential. Nothing above this interface knows that Apple exists, so the two
 * fire moments are provable without a key, a certificate, or a device.
 */

/** The APNs host a token is addressable on. Reported by the registering build. */
export type ApnsEnvironment = "sandbox" | "production";

export interface SellerPushDevice {
  platform: "ios";
  token: string;
  /**
   * Travels with the address, not with the process. One auth key serves both
   * APNs hosts, and which host a token belongs to is fixed by the
   * `aps-environment` entitlement of the build that registered it, so a single
   * seller can hold a development device and a shipped one at the same time.
   * Sending to the wrong host is accepted by Apple and then dropped.
   */
  environment: ApnsEnvironment;
}

export interface ApnsSendRequest {
  device: SellerPushDevice;
  message: SellerPushMessage;
  moment: SellerPushMoment;
  /**
   * Collapses duplicates on the device itself. APNs replaces an unread
   * notification carrying the same id, which is a second, independent guard
   * against the seller seeing one moment twice.
   */
  collapseId: string;
}

export type ApnsSendOutcome =
  /** Apple accepted the notification for delivery. */
  | { outcome: "delivered" }
  /**
   * Apple says this token no longer addresses an installed app. The row is a
   * dead address and the sender's caller removes it; a reinstall registers a
   * new one.
   */
  | { outcome: "deviceGone" }
  | { outcome: "failed"; reason: string };

export interface ApnsSender {
  send(request: ApnsSendRequest): Promise<ApnsSendOutcome>;
}

/**
 * The offline sender. Records what it was asked to deliver and answers with
 * whatever outcome the test scripted for that token, defaulting to delivered.
 */
export class MockApnsSender implements ApnsSender {
  readonly sent: ApnsSendRequest[] = [];

  constructor(
    private readonly outcomes: Record<string, ApnsSendOutcome> = {},
  ) {}

  async send(request: ApnsSendRequest): Promise<ApnsSendOutcome> {
    this.sent.push(request);
    return this.outcomes[request.device.token] ?? { outcome: "delivered" };
  }
}
