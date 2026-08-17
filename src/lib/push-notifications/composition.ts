import "server-only";
import {
  createApnsHttp2Transport,
  createHttpApnsSender,
  resolveApnsConfig,
} from "./apns";
import { reportServerError } from "@/lib/sentry";
import { createSellerPushDispatcher, type SellerPushDispatcher } from "./dispatch";
import type { SellerPushMoment } from "./message";
import type { ApnsSender } from "./sender";
import { createSupabaseSellerPushStore, type SellerPushRpcClient } from "./store";

/**
 * How a deployment learns its push credential is unusable. Injected so the test
 * can read what an operator would, rather than asserting on a console spy.
 */
export type SellerPushMisconfigurationLog = (
  event: "push_not_configured",
  detail: { moment: SellerPushMoment; reason: string },
) => void;

/**
 * The sender, built once per process rather than once per caller (#891).
 *
 * Every call site here is a request handler or a cron tick, so building it per
 * call meant a fresh provider-token cache and a fresh HTTP/2 session pool every
 * time. Both exist precisely to be reused: Apple refuses a provider that
 * re-signs more often than every twenty minutes, and throttles a connection per
 * notification, so rebuilding them defeated the two things they are for and
 * turned a busy deployment into a source of Apple-side refusals.
 *
 * Keyed on the configuration itself, so a process whose environment differs
 * gets its own. The consequence worth naming: a `.p8` replaced at the same path
 * is picked up on the next process, not the next request.
 */
let cachedSender:
  | { key: string; sender: ApnsSender }
  | { key: string; failure: string }
  | undefined;

function senderForCurrentEnvironment():
  | { sender: ApnsSender }
  | { failure: string } {
  const env = process.env;
  const key = JSON.stringify([
    env.APNS_KEY_ID,
    env.APNS_TEAM_ID,
    env.APNS_BUNDLE_ID,
    env.APNS_AUTH_KEY_PATH,
  ]);
  if (cachedSender?.key !== key) {
    try {
      cachedSender = {
        key,
        sender: createHttpApnsSender({
          config: resolveApnsConfig(env),
          transport: createApnsHttp2Transport(),
        }),
      };
    } catch (error) {
      // The message names the missing variables and never the key material, so
      // it is safe to report and is the only thing that makes this diagnosable.
      cachedSender = {
        key,
        failure:
          error instanceof Error
            ? error.message
            : "Seller push is not configured.",
      };
    }
  }
  return "sender" in cachedSender
    ? { sender: cachedSender.sender }
    : { failure: cachedSender.failure };
}

/**
 * The one place a real seller push dispatcher is built (#891).
 *
 * Both publish entry points and the pipeline worker come through here, so there
 * is no arrangement in which one of them announces a moment differently from
 * another, or announces one the others do not.
 *
 * The credential is resolved eagerly, because the alternative is a dispatcher
 * that claims every moment, sends nothing, and looks healthy. What that resolve
 * must not do is throw at the caller. There is no startup here to fail: this
 * runs inside a queue-worker tick and inside a publish request, so a throw stops
 * the queue draining and stops listings reaching eBay, neither of which needs an
 * APNs key to be correct, and the operator sees a 500 on publish rather than a
 * missing variable. The misconfiguration is reported once per moment it costs,
 * which is loud, attributable, and confined to the push.
 *
 * A caller that legitimately has no push capability passes none. That is a
 * visible argument rather than a silent fallback, and in production nothing does.
 */
export function createSellerPushDispatcherFor(
  client: SellerPushRpcClient,
  log: SellerPushMisconfigurationLog = (event, detail) => {
    reportServerError(`push.${event}`, detail.reason, { moment: detail.moment });
  },
): SellerPushDispatcher {
  const resolved = senderForCurrentEnvironment();
  if ("failure" in resolved) {
    return unconfiguredSellerPushDispatcher(resolved.failure, log);
  }
  return createSellerPushDispatcher({
    store: createSupabaseSellerPushStore(client),
    sender: resolved.sender,
  });
}

/**
 * What a deployment with no usable APNs credential gets.
 *
 * It deliberately does not reach the database. Claiming would be worse than the
 * throw this replaces: the claim is permanent and once-only, so burning it for a
 * send that never happened would mean repairing the credential and still never
 * announcing that listing to that seller.
 */
function unconfiguredSellerPushDispatcher(
  reason: string,
  log: SellerPushMisconfigurationLog,
): SellerPushDispatcher {
  return {
    async listingReady() {
      log("push_not_configured", { moment: "listingReady", reason });
    },
    async listingPublished() {
      log("push_not_configured", { moment: "listingPublished", reason });
    },
  };
}

/**
 * Narrows a Supabase client to the three scoped functions the store calls.
 * Passing the client itself would hand the store a generic `.from()`, and the
 * read this feature is allowed to do is the scoped function, never the table.
 */
export function sellerPushRpcClient(client: {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}): SellerPushRpcClient {
  return {
    async rpc(functionName, args) {
      const { data, error } = await client.rpc(functionName, args);
      return { data, error: error ? { message: error.message } : null };
    },
  };
}
