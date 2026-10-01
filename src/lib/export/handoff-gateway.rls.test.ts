import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  resolveStackAnonKey,
  resolveStackServiceRoleKey,
  resolveStackUrl,
  skipIfStackUnreachable,
  stackReachable,
  whenStackReachable,
} from "@/test/supabase-stack";
import { cleanupClerkTestUsers, mintUserJwt } from "@/lib/supabase/test-users";
import { createMobileApiHandler } from "@/lib/mobile-api";
import { createConfiguredAssistedExportGateway } from "./handoff-gateway";

/**
 * The native sharing drawer against the real database.
 *
 * Every other assisted-export suite injects a fake gateway or a fake RPC, and
 * the pgTAP contract seeds the prepared `listings` rows by hand. Nothing wrote
 * those rows in production once the web export page (the only caller of
 * `loadOrGenerateExportPacks`) was retired in #598, so on a real saved listing
 * `record_export_handoff` refused every Facebook Marketplace, Mercari, and
 * Depop handoff with P0002. The route turned that into 409, and the native
 * client showed "Couldn't complete that action. Try again." for Copy listing
 * text, Save photos, and Open — while the pasteboard and photo library had
 * already received the pack.
 *
 * This suite composes the route exactly as `/v1/items/[itemId]/export-handoffs`
 * does — the configured gateway, a client scoped to the seller's own bearer,
 * the guarded RPCs — and starts from what the native drawer actually has: a
 * saved eBay draft at its review revisions, and no assisted pack rows at all.
 */

const SUPABASE_URL = resolveStackUrl();
const ANON_KEY = resolveStackAnonKey();
const SERVICE_ROLE_KEY = resolveStackServiceRoleKey();

let reachable = false;
let admin: SupabaseClient;
const stamp = Date.now();
const sellerId = `user_test_export_handoff_seller_${stamp}`;
const strangerId = `user_test_export_handoff_stranger_${stamp}`;
let sellerToken = "";
let strangerToken = "";

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

interface SavedListing {
  itemId: string;
  reviewContentRevision: string;
  reviewRevision: string;
}

async function seedSavedListing(): Promise<SavedListing> {
  const itemId = crypto.randomUUID();
  const reviewContentRevision = crypto.randomUUID();
  const reviewRevision = crypto.randomUUID();
  const item = await admin.from("items").insert({
    id: itemId,
    user_id: sellerId,
    attributes: { brand: "Nintendo", model: "Switch OLED" },
    condition: "used_good",
    review_content_revision: reviewContentRevision,
    review_revision: reviewRevision,
  });
  if (item.error) throw new Error(`seed item: ${item.error.message}`);
  const listing = await admin.from("listings").insert({
    user_id: sellerId,
    item_id: itemId,
    platform: "ebay",
    title: "Nintendo Switch OLED Console White Joy-Con Dock Tested",
    description: "Works perfectly. Dock, Joy-Con, and charger included.",
    copy: { itemSpecifics: { Brand: "Nintendo" } },
    status: "draft",
    source_review_revision: reviewContentRevision,
  });
  if (listing.error) throw new Error(`seed listing: ${listing.error.message}`);
  const prediction = await admin.from("prediction_logs").insert({
    user_id: sellerId,
    item_id: itemId,
    price: 214.5,
    listing_model: "test-model",
  });
  if (prediction.error) {
    throw new Error(`seed prediction: ${prediction.error.message}`);
  }
  return { itemId, reviewContentRevision, reviewRevision };
}

function handler(userId: string) {
  return createMobileApiHandler({
    async authenticate() {
      return { kind: "clerk", userId };
    },
    worker: {} as never,
    assistedExport: createConfiguredAssistedExportGateway({
      supabaseURL: SUPABASE_URL,
      anonKey: ANON_KEY!,
    }),
  });
}

function action(
  listing: SavedListing,
  platform: "facebook" | "mercari" | "depop",
  kind: "handoff" | "shared",
  bearer = sellerToken,
  overrides: Partial<SavedListing> = {},
): Request {
  const revisions = { ...listing, ...overrides };
  return new Request(
    `https://api.test/v1/items/${listing.itemId}/export-handoffs`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        platform,
        action: kind,
        reviewContentRevision: revisions.reviewContentRevision,
        reviewRevision: revisions.reviewRevision,
      }),
    },
  );
}

interface HandoffBody {
  data: {
    handoffs: Array<{
      platform: string;
      state: string;
      handedOffAt: string | null;
      sharedAt: string | null;
    }>;
  };
}

function receipt(body: HandoffBody, platform: string) {
  return body.data.handoffs.find((handoff) => handoff.platform === platform);
}

beforeAll(async () => {
  reachable = await stackReachable();
  await whenStackReachable(reachable, async () => {
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    [sellerToken, strangerToken] = await Promise.all([
      mintUserJwt(sellerId),
      mintUserJwt(strangerId),
    ]);
  });
});

afterAll(async () => {
  await whenStackReachable(reachable, async () => {
    await admin
      .from("export_handoffs")
      .delete()
      .in("user_id", [sellerId, strangerId]);
    await cleanupClerkTestUsers(admin, [sellerId, strangerId]);
  });
});

describe("native assisted export handoff against the real database", () => {
  it.each(["mercari", "depop", "facebook"] as const)(
    "records a %s handoff for a saved listing without claiming it was shared",
    async (platform) => {
      const listing = await seedSavedListing();

      const response = await handler(sellerId)(
        action(listing, platform, "handoff"),
      );

      expect(response.status).toBe(200);
      const handed = receipt((await response.json()) as HandoffBody, platform);
      expect(handed?.handedOffAt).toEqual(expect.any(String));
      expect(handed?.state).toBe("prepared");
      expect(handed?.sharedAt).toBeNull();
    },
  );

  it("lets the seller confirm Shared only after that handoff", async () => {
    const listing = await seedSavedListing();
    await handler(sellerId)(action(listing, "mercari", "handoff"));

    const response = await handler(sellerId)(
      action(listing, "mercari", "shared"),
    );

    expect(response.status).toBe(200);
    expect(
      receipt((await response.json()) as HandoffBody, "mercari")?.state,
    ).toBe("shared");
  });

  it("still refuses a handoff for a pack the listing has moved past", async () => {
    const listing = await seedSavedListing();

    const response = await handler(sellerId)(
      action(listing, "depop", "handoff", sellerToken, {
        reviewContentRevision: crypto.randomUUID(),
      }),
    );

    expect(response.status).toBe(409);
  });

  it("never lets another account hand off the seller's listing", async () => {
    const listing = await seedSavedListing();

    const response = await handler(strangerId)(
      action(listing, "mercari", "handoff", strangerToken),
    );

    expect(response.status).not.toBe(200);
    const read = await handler(sellerId)(
      new Request(
        `https://api.test/v1/items/${listing.itemId}/export-handoffs?reviewContentRevision=${listing.reviewContentRevision}`,
        { headers: { authorization: `Bearer ${sellerToken}` } },
      ),
    );
    expect(read.status).toBe(200);
    expect(
      receipt((await read.json()) as HandoffBody, "mercari")?.handedOffAt,
    ).toBeNull();
  });
});
