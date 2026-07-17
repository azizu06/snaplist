import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(() => {
    throw new Error("database must not be reached before verification");
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient,
}));
vi.mock("@/lib/sentry", () => ({ reportServerError: vi.fn() }));
vi.mock("@/lib/observability", () => ({ logEvent: vi.fn() }));

import { POST } from "./route";

const keys = [
  "REVENUECAT_WEBHOOK_SIGNING_SECRET",
  "REVENUECAT_WEBHOOK_AUTHORIZATION",
  "REVENUECAT_APP_ID",
  "REVENUECAT_ENTITLEMENT_ID",
  "REVENUECAT_MONTHLY_PRODUCT_ID",
  "SNAPLIST_PRO_MONTHLY_AI_ITEM_ALLOWANCE",
] as const;

afterEach(() => {
  for (const key of keys) delete process.env[key];
  createAdminClient.mockReset();
  createAdminClient.mockImplementation(() => {
    throw new Error("database must not be reached before verification");
  });
});

function configure() {
  process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET = "offline-secret";
  process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = "Bearer offline";
  process.env.REVENUECAT_APP_ID = "app_fixture";
  process.env.REVENUECAT_ENTITLEMENT_ID = "pro";
  process.env.REVENUECAT_MONTHLY_PRODUCT_ID = "snaplist-pro-fixture";
  process.env.SNAPLIST_PRO_MONTHLY_AI_ITEM_ALLOWANCE = "24";
}

describe("RevenueCat webhook route boundary", () => {
  it("returns a truthful 503 without any hosted configuration", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/revenuecat", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(503);
  });

  it("rejects a forged body before creating a service-role capability", async () => {
    configure();
    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/revenuecat", {
        method: "POST",
        headers: {
          authorization: "Bearer offline",
          "x-revenuecat-webhook-signature": "t=1,v1=forged",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("returns the provider-required 200 after verified idempotent processing", async () => {
    configure();
    const eventTimestamp = Date.now();
    const rawBody = JSON.stringify({
      api_version: "1.0",
      event: {
        id: "route-event",
        type: "INITIAL_PURCHASE",
        event_timestamp_ms: eventTimestamp,
        app_id: "app_fixture",
        app_user_id: "user_fixture",
        original_app_user_id: "user_fixture",
        aliases: ["user_fixture"],
        product_id: "snaplist-pro-fixture",
        entitlement_ids: ["pro"],
        purchased_at_ms: Date.parse("2026-07-01T00:00:00Z"),
        expiration_at_ms: Date.parse("2026-08-01T00:00:00Z"),
        store: "APP_STORE",
        original_transaction_id: "original-fixture",
      },
    });
    const timestamp = Math.floor(eventTimestamp / 1000);
    const signature = createHmac("sha256", "offline-secret")
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    const rpc = vi.fn(async (name: string) => {
      if (name === "resolve_revenuecat_customer") {
        return {
          data: [{ user_id: "user_fixture", transition_state: "not_required" }],
          error: null,
        };
      }
      if (name === "record_verified_revenuecat_ai_item_period") {
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC: ${name}`);
    });
    createAdminClient.mockReturnValue({ rpc } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/revenuecat", {
        method: "POST",
        headers: {
          authorization: "Bearer offline",
          "x-revenuecat-webhook-signature": `t=${timestamp},v1=${signature}`,
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
