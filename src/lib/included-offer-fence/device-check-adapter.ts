/**
 * Apple DeviceCheck, reduced to the only two questions the included-offer fence
 * asks: has this physical device already consumed the promotion, and can we
 * record that it just did?
 *
 * Every failure mode Apple can return collapses to `ambiguous`, never to a
 * clear device. Treating an unreachable, throttled, or unparseable answer as
 * "unused" is precisely the bug that makes the fence worthless, so the type
 * system refuses to express it.
 */
export type DeviceCheckAmbiguousReason =
  | "timeout"
  | "throttled"
  | "server_error"
  | "unavailable"
  | "unauthorized"
  | "malformed_response";

export type DeviceCheckQueryResult =
  | { bit0: boolean; bit1: boolean; status: "resolved" }
  | { reason: DeviceCheckAmbiguousReason; status: "ambiguous" };

export type DeviceCheckUpdateResult =
  | { status: "updated" }
  | { reason: DeviceCheckAmbiguousReason; status: "ambiguous" };

export interface DeviceCheckAdapter {
  /**
   * `deviceToken` is ephemeral request material. Implementations must not
   * persist, log, hash for later identity, or otherwise retain it.
   */
  queryTwoBits(input: { deviceToken: string }): Promise<DeviceCheckQueryResult>;
  updateTwoBits(input: {
    bit0: boolean;
    bit1: boolean;
    deviceToken: string;
  }): Promise<DeviceCheckUpdateResult>;
}
