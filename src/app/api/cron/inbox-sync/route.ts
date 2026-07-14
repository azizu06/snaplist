import { NextResponse, type NextRequest } from "next/server";
import { logServerError } from "@/lib/api/errors";
import { syncInboxForSeller, SupabaseInboxSyncRepository } from "@/lib/inbox/sync";
import {
  createEbayMessagingAdapterForUser,
  ebayMessagingSyncUserIds,
} from "@/lib/marketplace/ebay";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

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
  const { data: connections, error } = await admin
    .from("ebay_connections")
    .select("user_id")
    .order("user_id")
    .limit(50);
  if (error) {
    logServerError("cron.inbox-sync.connections", error);
    return NextResponse.json({ error: "Inbox sync failed." }, { status: 500 });
  }

  const userIds = ebayMessagingSyncUserIds(
    (connections ?? []).map((connection) => connection.user_id as string),
  );
  let synced = 0;
  let failed = 0;
  let imported = 0;
  for (const userId of userIds) {
    try {
      const summary = await syncInboxForSeller({
        adapter: await createEbayMessagingAdapterForUser(admin, userId),
        repository: new SupabaseInboxSyncRepository(admin, userId, {
          client: admin,
          scheduled: true,
        }),
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
