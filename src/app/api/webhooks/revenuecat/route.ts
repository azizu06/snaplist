import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logEvent } from "@/lib/observability";
import { reportServerError } from "@/lib/sentry";
import {
  createSupabaseRevenueCatEntitlementStore,
  handleRevenueCatWebhook,
  parseAndVerifyRevenueCatWebhook,
  resolveRevenueCatServerConfig,
} from "@/lib/billing";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let config;
  try {
    config = resolveRevenueCatServerConfig();
  } catch (error) {
    reportServerError("billing.revenuecat.configuration", error);
    return NextResponse.json({ error: "RevenueCat webhook is misconfigured." }, { status: 503 });
  }
  if (!config) {
    return NextResponse.json({ error: "RevenueCat webhook is not configured." }, { status: 503 });
  }

  const rawBody = await request.text().catch(() => "");
  let webhook;
  try {
    webhook = parseAndVerifyRevenueCatWebhook({
      rawBody,
      signature: request.headers.get("x-revenuecat-webhook-signature"),
      authorization: request.headers.get("authorization"),
      config,
    });
  } catch (error) {
    logEvent("billing.revenuecat.bad_webhook", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Invalid RevenueCat webhook." }, { status: 400 });
  }

  try {
    const result = await handleRevenueCatWebhook(
      webhook,
      () => createSupabaseRevenueCatEntitlementStore(createAdminClient()),
      config,
    );
    logEvent("billing.revenuecat.handled", {
      type: webhook.event.type,
      environment: webhook.event.environment,
      processed: result.processed,
      ...(!result.processed ? { reason: result.reason } : {}),
    });
    return new NextResponse(null, { status: 200 });
  } catch (error) {
    reportServerError("billing.revenuecat.webhook", error, {
      type: webhook.event.type,
    });
    return NextResponse.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
