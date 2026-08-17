import "server-only";
import {
  createApnsHttp2Transport,
  createHttpApnsSender,
  resolveApnsConfig,
} from "./apns";
import { createSellerPushDispatcher, type SellerPushDispatcher } from "./dispatch";
import { createSupabaseSellerPushStore, type SellerPushRpcClient } from "./store";

/**
 * The one place a real seller push dispatcher is built (#891).
 *
 * Both publish entry points and the pipeline worker come through here, so there
 * is no arrangement in which one of them announces a moment differently from
 * another, or announces one the others do not.
 *
 * It resolves the APNs credential eagerly and throws when it is absent. That is
 * deliberate and it is the whole point: the alternative is a dispatcher that
 * exists, claims every moment, sends nothing, and looks healthy. A caller that
 * legitimately has no push capability passes none, which is a visible argument
 * rather than a silent runtime fallback, and in production nothing does.
 */
export function createSellerPushDispatcherFor(
  client: SellerPushRpcClient,
): SellerPushDispatcher {
  return createSellerPushDispatcher({
    store: createSupabaseSellerPushStore(client),
    sender: createHttpApnsSender({
      config: resolveApnsConfig(process.env),
      transport: createApnsHttp2Transport(),
    }),
  });
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
