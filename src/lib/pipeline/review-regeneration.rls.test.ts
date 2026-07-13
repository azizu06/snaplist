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
    .select("id, review_revision")
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
  return {
    itemId: item.id as string,
    listingId: listing.id as string,
    reviewRevision: item.review_revision as string,
  };
}

function commitFor(
  itemId: string,
  listingId: string,
  runId: string,
  expectedReviewRevision: string,
  expectedRunId: string | null = null,
): ReviewRegenerationCommit {
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
    expectedRunId,
    expectedReviewRevision,
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
      commitFor(seeded.itemId, seeded.listingId, runId, seeded.reviewRevision),
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
        commitFor(owner.itemId, foreign.listingId, runId, owner.reviewRevision),
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

  it("rejects a stale regeneration version and keeps the newer coherent run", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "stale-regeneration");
    const firstRunId = crypto.randomUUID();
    const first = commitFor(
      seeded.itemId,
      seeded.listingId,
      firstRunId,
      seeded.reviewRevision,
    );
    first.attributes.brand = "Newest identity";
    await createSupabaseReviewRegenerationStore(userA.client).commit(first);

    const staleRunId = crypto.randomUUID();
    const stale = commitFor(
      seeded.itemId,
      seeded.listingId,
      staleRunId,
      seeded.reviewRevision,
    );
    stale.attributes.brand = "Stale identity";
    await expect(
      createSupabaseReviewRegenerationStore(userA.client).commit(stale),
    ).rejects.toThrow(/editable eBay listing not found/i);

    const [{ data: item }, { data: listing }, { data: staleLogs }] = await Promise.all([
      userA.client.from("items").select("attributes").eq("id", seeded.itemId).single(),
      userA.client.from("listings").select("run_id").eq("id", seeded.listingId).single(),
      userA.client.from("prediction_logs").select("id").eq("run_id", staleRunId),
    ]);
    expect((item?.attributes as { brand?: string })?.brand).toBe("Newest identity");
    expect(listing?.run_id).toBe(firstRunId);
    expect(staleLogs ?? []).toHaveLength(0);
  });

  it("rejects a zero-price recommendation and retains the previous coherent state", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "zero-price");
    const runId = crypto.randomUUID();
    const invalid = commitFor(
      seeded.itemId,
      seeded.listingId,
      runId,
      seeded.reviewRevision,
    );
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
        commitFor(
          live.itemId,
          live.listingId,
          crypto.randomUUID(),
          live.reviewRevision,
        ),
      ),
    ).rejects.toThrow(/editable eBay listing not found/i);

    const publishing = await seedReview(userA, "publishing-claim");
    const { error: claimError } = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: publishing.listingId,
      p_expected_run_id: null,
      p_expected_review_revision: publishing.reviewRevision,
    });
    expect(claimError).toBeNull();
    await expect(
      createSupabaseReviewRegenerationStore(userA.client).commit(
        commitFor(
          publishing.itemId,
          publishing.listingId,
          crypto.randomUUID(),
          publishing.reviewRevision,
        ),
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

  it("checks and advances one review revision while ordinary save preserves identity", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "shared-review-revision");
    const savedRevision = crypto.randomUUID();
    const savedAttributes = {
      brand: "Forged brand",
      category: "forged category",
      condition: "poor",
    };
    const saved = await userA.client.rpc("save_review_edits", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_expected_review_revision: seeded.reviewRevision,
      p_new_review_revision: savedRevision,
      p_attributes: savedAttributes,
      p_condition: "poor",
      p_price_override: 199,
      p_cost_basis: 80,
      p_listing_title: "Seller edited title",
      p_listing_description: "Seller edited description",
    });
    expect(saved.error).toBeNull();

    const { data: savedItem } = await userA.client
      .from("items")
      .select("attributes, condition")
      .eq("id", seeded.itemId)
      .single();
    expect((savedItem?.attributes as { brand?: string; category?: string })?.brand).toBe(
      "Old shared-review-revision",
    );
    expect((savedItem?.attributes as { category?: string })?.category).toBe(
      "electronics",
    );
    expect(savedItem?.condition).toBe("fair");

    const stale = await userA.client.rpc("save_review_edits", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_expected_review_revision: seeded.reviewRevision,
      p_new_review_revision: crypto.randomUUID(),
      p_attributes: { ...savedAttributes, brand: "Stale brand" },
      p_condition: "poor",
      p_price_override: 199,
      p_cost_basis: 80,
      p_listing_title: "Stale title",
      p_listing_description: "Stale description",
    });
    expect(stale.error?.code).toBe("P0002");

    const sharpenRevision = crypto.randomUUID();
    const sharpenedAttributes = {
      brand: "Old shared-review-revision",
      category: "electronics",
      condition: "fair",
      specs: ["512GB"],
    };
    const sharpened = await userA.client.rpc("sharpen_review_estimate", {
      p_item_id: seeded.itemId,
      p_expected_review_revision: savedRevision,
      p_run_id: sharpenRevision,
      p_attributes: sharpenedAttributes,
      p_price: 175,
      p_price_range: { low: 160, high: 190 },
      p_confidence: 0.8,
      p_tier_fired: "ebay-sold",
      p_model: "vision-model",
      p_listing_model: "listing-model",
      p_pricing_model: null,
      p_sources: [{ url: "https://www.ebay.com/itm/1", kind: "sold-comp" }],
      p_autopilot_enabled: false,
      p_autopilot_eligible: false,
    });
    expect(sharpened.error).toBeNull();

    const [{ data: item }, { data: listing }, { data: logs }] = await Promise.all([
      userA.client
        .from("items")
        .select("attributes, condition, review_revision")
        .eq("id", seeded.itemId)
        .single(),
      userA.client
        .from("listings")
        .select("title")
        .eq("id", seeded.listingId)
        .single(),
      userA.client
        .from("prediction_logs")
        .select("run_id")
        .eq("run_id", sharpenRevision),
    ]);
    expect(item?.review_revision).toBe(sharpenRevision);
    expect((item?.attributes as { brand?: string; category?: string })?.brand).toBe(
      "Old shared-review-revision",
    );
    expect((item?.attributes as { category?: string })?.category).toBe("electronics");
    expect(item?.condition).toBe("fair");
    expect(listing?.title).toBe("Seller edited title");
    expect(logs ?? []).toHaveLength(1);
  });

  it("rejects ordinary review saves for an authoritative live eBay listing", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "live-save-guard");
    const { error: liveStateError } = await userA.client
      .from("listings")
      .update({
        ebay_listing_id: "v1|9876543210|0",
        ebay_status: "published",
      })
      .eq("id", seeded.listingId);
    expect(liveStateError).toBeNull();

    const saved = await userA.client.rpc("save_review_edits", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_expected_review_revision: seeded.reviewRevision,
      p_new_review_revision: crypto.randomUUID(),
      p_attributes: { brand: "Forged", category: "electronics" },
      p_condition: "fair",
      p_price_override: 199,
      p_cost_basis: 80,
      p_listing_title: "Stale seller title",
      p_listing_description: "Stale seller description",
    });
    expect(saved.error?.code).toBe("P0002");

    const [{ data: item }, { data: listing }] = await Promise.all([
      userA.client
        .from("items")
        .select("price_override, review_revision")
        .eq("id", seeded.itemId)
        .single(),
      userA.client
        .from("listings")
        .select("title, description")
        .eq("id", seeded.listingId)
        .single(),
    ]);
    expect(Number(item?.price_override)).toBe(222);
    expect(item?.review_revision).toBe(seeded.reviewRevision);
    expect(listing).toMatchObject({
      title: "Old live-save-guard listing",
      description: "Old coherent copy",
    });
  });

  it("rejects sharpened estimates for an authoritative live eBay listing", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "live-sharpen-guard");
    const { error: liveStateError } = await userA.client
      .from("listings")
      .update({ ebay_status: "publishing" })
      .eq("id", seeded.listingId);
    expect(liveStateError).toBeNull();

    const runId = crypto.randomUUID();
    const sharpened = await userA.client.rpc("sharpen_review_estimate", {
      p_item_id: seeded.itemId,
      p_expected_review_revision: seeded.reviewRevision,
      p_run_id: runId,
      p_attributes: {
        brand: "Stale sharpened brand",
        category: "electronics",
        condition: "fair",
      },
      p_price: 175,
      p_price_range: { low: 160, high: 190 },
      p_confidence: 0.8,
      p_tier_fired: "ebay-sold",
      p_model: "vision-model",
      p_listing_model: "listing-model",
      p_pricing_model: null,
      p_sources: [],
      p_autopilot_enabled: false,
      p_autopilot_eligible: false,
    });
    expect(sharpened.error?.code).toBe("P0002");

    const [{ data: item }, { data: logs }] = await Promise.all([
      userA.client
        .from("items")
        .select("attributes, review_revision")
        .eq("id", seeded.itemId)
        .single(),
      userA.client.from("prediction_logs").select("id").eq("run_id", runId),
    ]);
    expect((item?.attributes as { brand?: string })?.brand).toBe(
      "Old live-sharpen-guard",
    );
    expect(item?.review_revision).toBe(seeded.reviewRevision);
    expect(logs ?? []).toHaveLength(0);
  });

  it("advances the review revision when publishing is claimed", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "publish-revision");
    const claim = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: seeded.listingId,
      p_expected_run_id: null,
      p_expected_review_revision: seeded.reviewRevision,
    });
    expect(claim.error).toBeNull();

    const { data: item } = await userA.client
      .from("items")
      .select("review_revision")
      .eq("id", seeded.itemId)
      .single();
    expect(item?.review_revision).toBe(claim.data);

    const staleSave = await userA.client.rpc("save_review_edits", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_expected_review_revision: seeded.reviewRevision,
      p_new_review_revision: crypto.randomUUID(),
      p_attributes: { brand: "Stale", category: "electronics" },
      p_condition: "fair",
      p_price_override: null,
      p_cost_basis: null,
      p_listing_title: "Stale title",
      p_listing_description: "Stale description",
    });
    expect(staleSave.error?.code).toBe("P0002");

    const staleSharpen = await userA.client.rpc("sharpen_review_estimate", {
      p_item_id: seeded.itemId,
      p_expected_review_revision: seeded.reviewRevision,
      p_run_id: crypto.randomUUID(),
      p_attributes: {
        brand: "Stale sharpen",
        category: "electronics",
        condition: "fair",
      },
      p_price: 175,
      p_price_range: { low: 160, high: 190 },
      p_confidence: 0.8,
      p_tier_fired: "ebay-sold",
      p_model: "vision-model",
      p_listing_model: "listing-model",
      p_pricing_model: null,
      p_sources: [],
      p_autopilot_enabled: false,
      p_autopilot_eligible: false,
    });
    expect(staleSharpen.error?.code).toBe("P0002");
  });

  it("rejects an export pack persisted from an obsolete review revision", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "stale-export-pack");
    const currentRevision = crypto.randomUUID();
    const saved = await userA.client.rpc("save_review_edits", {
      p_item_id: seeded.itemId,
      p_listing_id: seeded.listingId,
      p_expected_review_revision: seeded.reviewRevision,
      p_new_review_revision: currentRevision,
      p_attributes: { brand: "Current brand", category: "electronics" },
      p_condition: "good",
      p_price_override: null,
      p_cost_basis: null,
      p_listing_title: "Current listing",
      p_listing_description: "Current description",
    });
    expect(saved.error).toBeNull();

    const packs = [
      {
        platform: "facebook",
        title: "Stale Facebook pack",
        description: "Stale identity copy",
        copy: { copyBlock: "Stale Facebook pack\n\nStale identity copy" },
      },
    ];
    const stale = await userA.client.rpc("persist_export_packs", {
      p_item_id: seeded.itemId,
      p_source_review_revision: seeded.reviewRevision,
      p_packs: packs,
    });
    expect(stale.error?.code).toBe("P0002");

    const current = await userA.client.rpc("persist_export_packs", {
      p_item_id: seeded.itemId,
      p_source_review_revision: currentRevision,
      p_packs: packs,
    });
    expect(current.error).toBeNull();

    const { data: rows } = await userA.client
      .from("listings")
      .select("source_review_revision")
      .eq("item_id", seeded.itemId)
      .eq("platform", "facebook");
    expect(rows ?? []).toEqual([
      expect.objectContaining({ source_review_revision: currentRevision }),
    ]);
  });

  it("replaces an invalid current export pack and prunes packs on save and sharpen", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "export-pack-lifecycle");
    const invalidPack = [
      {
        platform: "mercari",
        title: "x".repeat(41),
        description: "Invalid cached copy",
        copy: { copyBlock: "invalid" },
      },
    ];
    expect(
      (
        await userA.client.rpc("persist_export_packs", {
          p_item_id: seeded.itemId,
          p_source_review_revision: seeded.reviewRevision,
          p_packs: invalidPack,
        })
      ).error,
    ).toBeNull();

    const validPack = [
      {
        platform: "mercari",
        title: "Valid current pack",
        description: "Valid regenerated copy",
        copy: { copyBlock: "Valid current pack\n\nValid regenerated copy" },
      },
    ];
    expect(
      (
        await userA.client.rpc("persist_export_packs", {
          p_item_id: seeded.itemId,
          p_source_review_revision: seeded.reviewRevision,
          p_packs: validPack,
        })
      ).error,
    ).toBeNull();

    const { data: replacedRows } = await userA.client
      .from("listings")
      .select("title")
      .eq("item_id", seeded.itemId)
      .eq("platform", "mercari");
    expect(replacedRows ?? []).toEqual([{ title: "Valid current pack" }]);

    const savedRevision = crypto.randomUUID();
    expect(
      (
        await userA.client.rpc("save_review_edits", {
          p_item_id: seeded.itemId,
          p_listing_id: seeded.listingId,
          p_expected_review_revision: seeded.reviewRevision,
          p_new_review_revision: savedRevision,
          p_attributes: {
            brand: "Old export-pack-lifecycle",
            category: "electronics",
            condition: "fair",
          },
          p_condition: "fair",
          p_price_override: null,
          p_cost_basis: null,
          p_listing_title: "Seller edited title",
          p_listing_description: "Seller edited description",
        })
      ).error,
    ).toBeNull();

    const { data: afterSave } = await userA.client
      .from("listings")
      .select("id")
      .eq("item_id", seeded.itemId)
      .in("platform", ["facebook", "mercari"]);
    expect(afterSave ?? []).toHaveLength(0);

    expect(
      (
        await userA.client.rpc("persist_export_packs", {
          p_item_id: seeded.itemId,
          p_source_review_revision: savedRevision,
          p_packs: validPack,
        })
      ).error,
    ).toBeNull();

    const sharpenRevision = crypto.randomUUID();
    expect(
      (
        await userA.client.rpc("sharpen_review_estimate", {
          p_item_id: seeded.itemId,
          p_expected_review_revision: savedRevision,
          p_run_id: sharpenRevision,
          p_attributes: {
            brand: "Old export-pack-lifecycle",
            category: "electronics",
            condition: "fair",
            specs: ["512GB"],
          },
          p_price: 175,
          p_price_range: { low: 160, high: 190 },
          p_confidence: 0.8,
          p_tier_fired: "ebay-sold",
          p_model: "vision-model",
          p_listing_model: "listing-model",
          p_pricing_model: null,
          p_sources: [],
          p_autopilot_enabled: false,
          p_autopilot_eligible: false,
        })
      ).error,
    ).toBeNull();

    const { data: afterSharpen } = await userA.client
      .from("listings")
      .select("id")
      .eq("item_id", seeded.itemId)
      .in("platform", ["facebook", "mercari"]);
    expect(afterSharpen ?? []).toHaveLength(0);
  });

  it("recovers an expired publish lease without letting the stale owner finalize", async () => {
    if (!reachable) return;
    const seeded = await seedReview(userA, "expired-publish-lease");

    const first = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: seeded.listingId,
      p_expected_run_id: null,
      p_expected_review_revision: seeded.reviewRevision,
    });
    expect(first.error).toBeNull();
    expect(typeof first.data).toBe("string");

    const overlapping = await userA.client.rpc("begin_ebay_publish", {
      p_listing_id: seeded.listingId,
      p_expected_run_id: null,
      p_expected_review_revision: seeded.reviewRevision,
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
      p_expected_review_revision: first.data as string,
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
