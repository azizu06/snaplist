import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { syncInboxForSeller, SupabaseInboxSyncRepository } from "@/lib/inbox/sync";
import {
  createEbayMessagingAdapterForUser,
  getEbayConnectionStatus,
  hasEbayMessagingSandboxFallback,
} from "@/lib/marketplace/ebay";
import { createClient } from "@/lib/supabase/server";
import { logServerError, serverErrorJson } from "@/lib/api/errors";
import { enforceRateLimit } from "@/lib/abuse";
import { createTenantServerClient } from "@/lib/supabase/tenant-server";
import { cleanupOwnExpiredMessagePhotoUploads } from "@/lib/inbox/attachment-cleanup";

/**
 * Cookie-authenticated, rate-limited foreground refresh. Disconnected sellers
 * return `{ skipped: "ebay_not_connected" }`; connected sellers receive the
 * shared service's sync summary. Existing messages remain unchanged on provider
 * failure, and the five-minute cron invokes the same domain service.
 */
export async function POST(request: Request) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await enforceRateLimit(request, userId);
  if (limited) return limited;
  let tenantServer: Awaited<ReturnType<typeof createTenantServerClient>> | null = null;
  try {
    tenantServer = await createTenantServerClient();
    await cleanupOwnExpiredMessagePhotoUploads(tenantServer);
  } catch (error) {
    logServerError("inbox.sync.photo-cleanup", error);
  }
  const supabase = await createClient();
  try {
    const { connected } = await getEbayConnectionStatus(supabase, userId);
    if (!connected && !hasEbayMessagingSandboxFallback(userId)) {
      return NextResponse.json({ skipped: "ebay_not_connected" });
    }
    tenantServer ??= await createTenantServerClient();
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
