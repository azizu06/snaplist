import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { syncInboxForSeller, SupabaseInboxSyncRepository } from "@/lib/inbox/sync";
import {
  createEbayMessagingAdapterForUser,
  getEbayConnectionStatus,
  hasEbayMessagingSandboxFallback,
} from "@/lib/marketplace/ebay";
import { createClient } from "@/lib/supabase/server";
import { serverErrorJson } from "@/lib/api/errors";
import { enforceRateLimit } from "@/lib/abuse";
import { createTenantServerClient } from "@/lib/supabase/tenant-server";

/** Explicit/foreground refresh; the shared service owns all domain behavior. */
export async function POST(request: Request) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await enforceRateLimit(request, userId);
  if (limited) return limited;
  const supabase = await createClient();
  try {
    const { connected } = await getEbayConnectionStatus(supabase, userId);
    if (!connected && !hasEbayMessagingSandboxFallback(userId)) {
      return NextResponse.json({ skipped: "ebay_not_connected" });
    }
    const tenantServer = await createTenantServerClient();
    const summary = await syncInboxForSeller({
      adapter: await createEbayMessagingAdapterForUser(supabase, userId, {
        credentialClient: tenantServer,
      }),
      repository: new SupabaseInboxSyncRepository(supabase, userId, {
        client: tenantServer,
        scheduled: false,
      }),
    });
    return NextResponse.json(summary);
  } catch (error) {
    return serverErrorJson(
      "inbox.sync",
      error,
      "Inbox refresh could not reach eBay. Existing messages are unchanged.",
    );
  }
}
