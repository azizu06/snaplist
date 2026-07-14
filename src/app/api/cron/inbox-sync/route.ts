import { NextResponse, type NextRequest } from "next/server";
import { logServerError } from "@/lib/api/errors";
import { syncInboxForSeller, SupabaseInboxSyncRepository } from "@/lib/inbox/sync";
import {
  createEbayMessagingAdapterForUser,
  ebayMessagingSyncUserIds,
  listScheduledEbayConnectionUserIds,
} from "@/lib/marketplace/ebay";
import { createAdminClient } from "@/lib/supabase/admin";
import { SupabaseMessagePolicyRepository } from "@/lib/inbox/policy-repository";
import { sendCanonicalReply, SupabaseDeliveryRepository } from "@/lib/inbox/transport";

export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Bearer-authenticated GET/POST scheduler entry point. It discovers connected
 * sellers plus an optional operator Sandbox seller, isolates each seller's
 * failure, and returns aggregate `{ sellers, synced, failed, imported }` counts.
 */
async function handle(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "Inbox synchronization cron is not configured." },
      { status: 503 },
    );
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const admin = createAdminClient();
  let connectedUserIds: string[];
  try {
    connectedUserIds = await listScheduledEbayConnectionUserIds(admin);
  } catch (error) {
    logServerError("cron.inbox-sync.connections", error);
    return NextResponse.json({ error: "Inbox sync failed." }, { status: 500 });
  }

  const userIds = ebayMessagingSyncUserIds(connectedUserIds);
  let synced = 0;
  let failed = 0;
  let imported = 0;
  for (const userId of userIds) {
    try {
      const adapter = await createEbayMessagingAdapterForUser(admin, userId, {
        scheduled: true,
        credentialClient: admin,
      });
      const deliveryRepository = new SupabaseDeliveryRepository(
        admin,
        userId,
        true,
        admin,
        true,
      );
      const summary = await syncInboxForSeller({
        adapter,
        repository: new SupabaseInboxSyncRepository(admin, userId, {
          client: admin,
          scheduled: true,
        }),
        policy: {
          repository: new SupabaseMessagePolicyRepository(
            admin,
            userId,
            adapter,
            { client: admin, scheduled: true },
          ),
          send: (messageId, authorization) =>
            sendCanonicalReply({
              repository: deliveryRepository,
              adapter,
              messageId,
              deliveryActor: "automatic",
              marketplaceObservedAt: authorization.marketplaceObservedAt,
              questionObservedAt: authorization.questionObservedAt,
            }),
        },
      });
      synced += 1;
      imported += summary.imported;
    } catch (syncError) {
      failed += 1;
      logServerError("cron.inbox-sync.seller", syncError);
    }
  }
  return NextResponse.json({ sellers: userIds.length, synced, failed, imported });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
