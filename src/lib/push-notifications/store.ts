import type { SellerPushMoment } from "./message";
import type { SellerPushDeviceToken, SellerPushStore } from "./dispatch";

/**
 * The dispatcher's three database operations (#891).
 *
 * All three go through `security definer` functions that take a tenant, and
 * none of them reaches a table. That is not a style choice: #890 granted the
 * server key `delete` on `public.device_tokens` and deliberately not `select`,
 * so the sender physically cannot enumerate push addresses, and the only
 * reachable read is one that answers for a single named seller. Anything here
 * that reached for `.from("device_tokens")` would fail rather than leak, and
 * the RLS suite alongside this file fails if that grant is ever widened.
 *
 * The client is passed in narrowed to `rpc` alone, so this module has no way to
 * perform an unscoped read even by mistake.
 */

export interface SellerPushRpcClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

/**
 * The database names both moments the way the activity feed does. The mapping
 * lives here, at the boundary, so the rest of the feature keeps one vocabulary.
 */
const STORED_MOMENT: Record<SellerPushMoment, string> = {
  listingReady: "listing_ready",
  listingPublished: "listing_published",
};

export function createSupabaseSellerPushStore(
  client: SellerPushRpcClient,
): SellerPushStore {
  return {
    async claimDelivery({ userId, moment, eventKey }) {
      const claimed = await call(client, "claim_seller_push_delivery", {
        p_user_id: userId,
        p_moment: STORED_MOMENT[moment],
        p_event_key: eventKey,
      });
      // A claim that cannot be read as a decision is not a decision. Returning
      // false here would look like "somebody else has it" and silence a push
      // that nobody sent; throwing lets the dispatcher log and stay quiet for a
      // reason it recorded.
      if (typeof claimed !== "boolean") {
        throw new Error("The push claim did not return a decision.");
      }
      return claimed;
    },

    async devicesForUser(userId) {
      const rows = await call(client, "seller_push_device_tokens", {
        p_user_id: userId,
      });
      if (!Array.isArray(rows)) {
        throw new Error("The device lookup did not return a device list.");
      }
      return rows.map(toDevice);
    },

    async forgetDevice({ userId, platform, token }) {
      await call(client, "forget_seller_push_device_token", {
        p_user_id: userId,
        p_platform: platform,
        p_token: token,
      });
    },
  };
}

async function call(
  client: SellerPushRpcClient,
  functionName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await client.rpc(functionName, args);
  if (error) {
    // The tenancy refusals raise from the database, and the caller above turns
    // a throw into a dropped push rather than a failed run. Surfacing the
    // message keeps a misconfigured caller diagnosable; it names the guard that
    // refused, never a seller's identity or address.
    throw new Error(`${functionName} failed: ${error.message}`);
  }
  return data;
}

/**
 * Rows come back from the database, but "the database returned it" is not the
 * same as "this is a device we can address". An environment we do not
 * recognise means the row and this code disagree about what a device is, and
 * the failure mode of guessing is a push accepted by the wrong APNs host and
 * silently dropped.
 */
function toDevice(row: unknown): SellerPushDeviceToken {
  const record = row as Record<string, unknown>;
  const token = record?.token;
  const platform = record?.platform;
  const environment = record?.apns_environment;
  if (
    platform !== "ios"
    || typeof token !== "string"
    || (environment !== "sandbox" && environment !== "production")
  ) {
    throw new Error("The device lookup returned an unrecognised device.");
  }
  return { platform, token, environment };
}
