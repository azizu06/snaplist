import { z } from "zod";
import {
  appAttestProofSchema,
  deviceCheckTokenSchema,
  type IncludedOfferOutcome,
} from "./contract";

/**
 * The redemption request carries proof and nothing else.
 *
 * `.strict()` is load-bearing: the account identity and the allowance decision
 * are both server-derived, so a body that even mentions a user or an entitlement
 * is rejected rather than quietly ignored.
 */
export const includedOfferRedeemRequestSchema = z
  .object({ appAttest: appAttestProofSchema })
  .strict();

export type IncludedOfferRedeemRequest = z.infer<
  typeof includedOfferRedeemRequestSchema
>;

/**
 * The rendezvous body. The claim is addressed by path, never by the body, so a
 * caller cannot aim a fresh proof at a claim it does not own.
 */
export const includedOfferDeviceTokenRequestSchema = z
  .object({
    appAttest: appAttestProofSchema,
    deviceToken: deviceCheckTokenSchema,
  })
  .strict();

export type IncludedOfferDeviceTokenRequest = z.infer<
  typeof includedOfferDeviceTokenRequestSchema
>;

/**
 * Status codes the native client can act on without reading the body twice.
 * Everything still in motion is `202`: the promotion is neither granted nor
 * refused yet, and the caller should follow the typed outcome it received.
 */
export function includedOfferHttpStatus(outcome: IncludedOfferOutcome): number {
  switch (outcome.status) {
    case "reserved":
      return 200;
    case "queued":
    case "device_token_required":
    case "retry_required":
      return 202;
    case "denied_device_consumed":
    case "denied_account_consumed":
    case "denied_apple_unavailable":
      return 409;
    case "invalid_proof":
      return 401;
    case "claim_not_found":
      return 404;
  }
}
