import { createMobileApiHandler } from "@/lib/mobile-api";
import type { ItemDeletionGateway } from "@/lib/mobile-api";
import { createConfiguredItemDeletionGateway } from "@/lib/item-deletion/gateway";
import { clerkPrincipal, unavailableWorker } from "../../mobile-api-composition";

export const runtime = "nodejs";

/**
 * Composed per request for the same reason as every other v1 route: a missing
 * Supabase configuration must answer 503 on the route that needs it rather
 * than crash the import. It matters more here than elsewhere — an unconfigured
 * deletion route that failed open would tell the seller their item was gone
 * while every row of it survived.
 */
function itemDeletionGateway(): ItemDeletionGateway | undefined {
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseURL || !anonKey) return undefined;
  return createConfiguredItemDeletionGateway({ supabaseURL, anonKey });
}

/**
 * Delete one non-guest item and everything SnapList owns beneath it (#181).
 *
 * The route decides nothing. `public.delete_item` refuses while a run, publish,
 * or sync is in flight, publishes the Storage objects to the cleanup executor,
 * and reports the provider-owned records it cannot touch.
 */
export function DELETE(request: Request): Promise<Response> {
  return createMobileApiHandler({
    authenticate: clerkPrincipal,
    itemDeletion: itemDeletionGateway(),
    worker: unavailableWorker("item deletion"),
  })(request);
}
