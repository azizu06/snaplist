import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "../supabase/test-users";
import {
  createSupabaseReviewRegenerationStore,
  type ReviewRegenerationCommit,
} from "./review-regeneration";

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let reachable = false;
let admin: SupabaseClient;
let userA: ClerkTestUser;
let userB: ClerkTestUser;

async function stackReachable(): Promise<boolean> {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) return false;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: ANON_KEY },
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function seedReview(user: ClerkTestUser, label: string) {
  const { data: item, error: itemError } = await user.client
    .from("items")
    .insert({
      user_id: user.id,
      attributes: { brand: `Old ${label}`, category: "electronics", condition: "fair" },
      condition: "fair",
      price_override: 222,
    })
    .select("id")
    .single();
  if (itemError || !item) throw new Error(itemError?.message ?? "item seed failed");

  const { data: listing, error: listingError } = await user.client
    .from("listings")
    .insert({
      user_id: user.id,
      item_id: item.id,
      platform: "ebay",
      title: `Old ${label} listing`,
      description: "Old coherent copy",
      copy: {},
      status: "draft",
    })
    .select("id")
    .single();
  if (listingError || !listing) {
    throw new Error(listingError?.message ?? "listing seed failed");
  }
  return { itemId: item.id as string, listingId: listing.id as string };
}

function commitFor(itemId: string, listingId: string, runId: string): ReviewRegenerationCommit {
  const attributes = {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
    upc: "027242919662",
    specs: ["wireless", "noise-cancelling"],
    title: "Sony WH-1000XM4",
  };
  return {
    itemId,
    listingId,
    runId,
    attributes,
    condition: "good",
    identification: {
      label: "Sony WH-1000XM4",
      confident: true,
      evidence: 1,
    },
    listing: {
      platform: "ebay",
      title: "Sony WH-1000XM4 Wireless Headphones",
      description: "Corrected coherent copy",
      fields: { itemSpecifics: { Brand: "Sony", Model: "WH-1000XM4" } },
    },
    prediction: {
      user_id: "",
      item_id: itemId,
      run_id: runId,
      extracted_attrs: attributes,
      price: 165,
      price_range: { low: 145, high: 185 },
      confidence: 0.85,
      tier_fired: "ebay-sold",
      model: "vision-model",
      listing_model: "listing-model",
      pricing_model: null,
      sources: [{ url: "https://www.ebay.com/itm/1", kind: "sold-comp" }],
      autopilot_enabled: false,
      autopilot_eligible: false,
    },
  };
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [userA, userB] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "review_regen_a"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "review_regen_b"),
  ]);
});

afterAll(async () => {
  if (!reachable) return;
  await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
});

describe("review identity regeneration transaction + RLS", () => {
  it("reports when the local Supabase integration seam is unavailable", () => {
    if (!reachable) {
      console.warn(
        "[review-regeneration.rls.test] Local Supabase unavailable — DB-gated assertions skipped.",
      );
    }
    expect(true).toBe(true);
  });

  it("atomically persists corrected identity/listing/log and preserves price override", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "owner");
    const { error: exportSeedError } = await userA.client.from("listings").insert({
      user_id: userA.id,
      item_id: seeded.itemId,
      platform: "facebook",
      title: "Old identity export",
      description: "Stale cached copy",
      copy: {},
      status: "draft",
    });
    expect(exportSeedError).toBeNull();
    const runId = crypto.randomUUID();
    await createSupabaseReviewRegenerationStore(userA.client).commit(
      commitFor(seeded.itemId, seeded.listingId, runId),
    );

    const [{ data: item }, { data: listing }, { data: logs }, { data: exports }] = await Promise.all([
      userA.client
        .from("items")
        .select("attributes, condition, identification, price_override")
        .eq("id", seeded.itemId)
        .single(),
      userA.client
        .from("listings")
        .select("title, description, status, run_id")
        .eq("id", seeded.listingId)
        .single(),
      userA.client
        .from("prediction_logs")
        .select("run_id, extracted_attrs, price, sources")
        .eq("item_id", seeded.itemId)
        .eq("run_id", runId),
      userA.client
        .from("listings")
        .select("id")
        .eq("item_id", seeded.itemId)
        .in("platform", ["facebook", "mercari"]),
    ]);

    expect((item?.attributes as { model?: string })?.model).toBe("WH-1000XM4");
    expect(item?.condition).toBe("good");
    expect(Number(item?.price_override)).toBe(222);
    expect((item?.identification as { label?: string })?.label).toBe("Sony WH-1000XM4");
    expect(listing).toMatchObject({
      title: "Sony WH-1000XM4 Wireless Headphones",
      description: "Corrected coherent copy",
      status: "draft",
      run_id: runId,
    });
    expect(logs).toHaveLength(1);
    expect(Number(logs?.[0]?.price)).toBe(165);
    expect(exports ?? []).toHaveLength(0);
  });

  it("rejects another tenant and rolls back an earlier item update in the RPC", async () => {
    if (!reachable) return;
    const owner = await seedReview(userA, "rollback-owner");
    const foreign = await seedReview(userB, "foreign");
    const runId = crypto.randomUUID();

    // user A owns the item but NOT this listing id. The function updates the item
    // first, then the listing ownership predicate fails and raises. PostgreSQL must
    // roll the preceding item update back with the rest of the statement.
    await expect(
      createSupabaseReviewRegenerationStore(userA.client).commit(
        commitFor(owner.itemId, foreign.listingId, runId),
      ),
    ).rejects.toThrow();

    const { data: item } = await userA.client
      .from("items")
      .select("attributes, condition, price_override")
      .eq("id", owner.itemId)
      .single();
    expect((item?.attributes as { brand?: string })?.brand).toBe("Old rollback-owner");
    expect(item?.condition).toBe("fair");
    expect(Number(item?.price_override)).toBe(222);

    const { data: logs } = await userA.client
      .from("prediction_logs")
      .select("id")
      .eq("run_id", runId);
    expect(logs ?? []).toHaveLength(0);

    const { data: bVisibleToA } = await userA.client
      .from("listings")
      .select("id")
      .eq("id", foreign.listingId);
    expect(bVisibleToA ?? []).toHaveLength(0);
  });

  it("rejects a zero-price recommendation and retains the previous coherent state", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "zero-price");
    const runId = crypto.randomUUID();
    const invalid = commitFor(seeded.itemId, seeded.listingId, runId);
    invalid.prediction.price = 0;

    await expect(
      createSupabaseReviewRegenerationStore(userA.client).commit(invalid),
    ).rejects.toThrow(/price is invalid/i);

    const [{ data: item }, { data: listing }, { data: logs }] = await Promise.all([
      userA.client
        .from("items")
        .select("attributes, condition, price_override")
        .eq("id", seeded.itemId)
        .single(),
      userA.client
        .from("listings")
        .select("title, description, run_id")
        .eq("id", seeded.listingId)
        .single(),
      userA.client
        .from("prediction_logs")
        .select("id")
        .eq("run_id", runId),
    ]);

    expect((item?.attributes as { brand?: string })?.brand).toBe("Old zero-price");
    expect(item?.condition).toBe("fair");
    expect(Number(item?.price_override)).toBe(222);
    expect(listing).toMatchObject({
      title: "Old zero-price listing",
      description: "Old coherent copy",
      run_id: null,
    });
    expect(logs ?? []).toHaveLength(0);
  });

  it("rejects authoritative live state and an in-flight publish claim", async () => {
    if (!reachable) return;

    const live = await seedReview(userA, "authoritative-live");
    const { error: liveStateError } = await userA.client
      .from("listings")
      .update({
        ebay_listing_id: "v1|1234567890|0",
        ebay_status: "published",
      })
      .eq("id", live.listingId);
    expect(liveStateError).toBeNull();
    await expect(
      createSupabaseReviewRegenerationStore(userA.client).commit(
        commitFor(live.itemId, live.listingId, crypto.randomUUID()),
      ),
    ).rejects.toThrow(/editable eBay listing not found/i);

    const publishing = await seedReview(userA, "publishing-claim");
    const { error: claimError } = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: publishing.listingId,
      p_expected_run_id: null,
    });
    expect(claimError).toBeNull();
    await expect(
      createSupabaseReviewRegenerationStore(userA.client).commit(
        commitFor(publishing.itemId, publishing.listingId, crypto.randomUUID()),
      ),
    ).rejects.toThrow(/editable eBay listing not found/i);

    const [{ data: liveItem }, { data: publishingItem }] = await Promise.all([
      userA.client
        .from("items")
        .select("attributes")
        .eq("id", live.itemId)
        .single(),
      userA.client
        .from("items")
        .select("attributes")
        .eq("id", publishing.itemId)
        .single(),
    ]);
    expect((liveItem?.attributes as { brand?: string })?.brand).toBe(
      "Old authoritative-live",
    );
    expect((publishingItem?.attributes as { brand?: string })?.brand).toBe(
      "Old publishing-claim",
    );
  });

  it("recovers an expired publish lease without letting the stale owner finalize", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "expired-publish-lease");

    const first = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: seeded.listingId,
      p_expected_run_id: null,
    });
    expect(first.error).toBeNull();
    expect(typeof first.data).toBe("string");

    const overlapping = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: seeded.listingId,
      p_expected_run_id: null,
    });
    expect(overlapping.error?.code).toBe("P0002");

    const { error: expireError } = await admin
      .from("listings")
      .update({
        ebay_publish_claimed_at: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      })
      .eq("id", seeded.listingId);
    expect(expireError).toBeNull();

    const recovered = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: seeded.listingId,
      p_expected_run_id: null,
    });
    expect(recovered.error).toBeNull();
    expect(recovered.data).not.toBe(first.data);

    const { data: staleFinalize, error: staleFinalizeError } = await userA.client
      .from("listings")
      .update({ ebay_status: "published" })
      .eq("id", seeded.listingId)
      .eq("ebay_publish_claim_id", first.data as string)
      .select("id");
    expect(staleFinalizeError).toBeNull();
    expect(staleFinalize ?? []).toHaveLength(0);

    const { data: current } = await userA.client
      .from("listings")
      .select("ebay_status, ebay_publish_claim_id")
      .eq("id", seeded.listingId)
      .single();
    expect(current?.ebay_status).toBe("publishing");
    expect(current?.ebay_publish_claim_id).toBe(recovered.data);
  });
});
