import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";
import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "../supabase/test-users";
import { StubPipeline } from "./stub";
import { runPipelineAndPersist } from "./persist";
import { readPredictionLogs } from "./prediction-log";
import { effectivePrice } from "./autopilot";
import type { Pipeline, PipelineResult } from "./types";

/**
 * Walking-skeleton end-to-end seam test (issue #19). Exercises the real spine with
 * a STUBBED pipeline against the running local Postgres:
 *
 *   upload (Storage, user-scoped path) → items row → stub pipeline →
 *   listings row + prediction_logs row → read back under RLS.
 *
 * Tested at the persistence seam (not brittle UI rendering) per the issue's METHOD.
 * Follows rls.test.ts: ephemeral confirmed users via the service role, each acting
 * through its OWN anon client so RLS sees a real session; cleaned up in afterAll.
 * Touches only its own rows. Skips (never fakes a pass) if the stack is unreachable.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let reachable = false;

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});
let admin: SupabaseClient;
let userA: ClerkTestUser;
let userB: ClerkTestUser;

// Clerk-era provisioning (issue #41): identities are minted JWTs with text
// subs — no auth.users rows. See test-users.ts.
async function provisionUser(label: string): Promise<ClerkTestUser> {
  return provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, `persist_${label}`);
}

/** Upload a tiny PNG to the user-scoped path, as the upload route would. */
async function uploadPhoto(user: ClerkTestUser): Promise<string> {
  // 1x1 transparent PNG.
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const bytes = Buffer.from(pngBase64, "base64");
  const path = `${user.id}/${Date.now()}-skeleton.png`;
  const { error } = await user.client.storage
    .from("photos")
    .upload(path, bytes, { contentType: "image/png", upsert: true });
  if (error) throw new Error(`upload failed: ${error.message}`);
  return path;
}

beforeAll(async () => {
  reachable = await stackReachable({ url: SUPABASE_URL, apiKey: ANON_KEY, requiredValues: [ANON_KEY, SERVICE_ROLE_KEY] });
  await whenStackReachable(reachable, async () => {

  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [userA, userB] = await Promise.all([provisionUser("a"), provisionUser("b")]);

  });
});

afterAll(async () => {
  if (!reachable || !admin) return;
  // No auth.users cascade anymore (Clerk migration dropped those FKs) —
  // delete owned domain rows explicitly.
  await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
});

describe("walking skeleton: upload → stub pipeline → persisted, RLS-scoped review", () => {
  it("requires a running local Supabase stack (skips otherwise, never fakes a pass)", () => {
    if (!reachable) {
      console.warn(
        "[persist.test] Local Supabase stack unreachable — skipping. " +
          "Get keys with `pnpm supabase status -o env` and map them into the env.",
      );
    }
    expect(true).toBe(true);
  });

  it("persists item + listing + prediction_log from a stubbed run, readable back by the owner", async () => {


    const photoPath = await uploadPhoto(userA);
    expect(photoPath.startsWith(`${userA.id}/`)).toBe(true);

    const { itemId, listingId, result } = await runPipelineAndPersist(
      userA.client,
      { userId: userA.id, photos: [photoPath] },
      new StubPipeline(),
    );

    // The pipeline produced a schema-valid, composed result.
    expect(result.price.suggested).toBeGreaterThan(0);
    expect(result.price.range.min).toBeLessThanOrEqual(result.price.suggested);
    expect(result.price.range.max).toBeGreaterThanOrEqual(result.price.suggested);
    expect(result.confidence.score).toBeGreaterThan(0);
    expect(result.confidence.score).toBeLessThanOrEqual(1);
    expect(["high", "medium", "low"]).toContain(result.confidence.band);
    expect(result.listing.title.length).toBeGreaterThan(0);

    // Read the item back AS THE OWNER (RLS allows).
    const { data: item, error: itemErr } = await userA.client
      .from("items")
      .select("id, user_id, photos, attributes, condition")
      .eq("id", itemId)
      .single();
    expect(itemErr).toBeNull();
    expect(item?.user_id).toBe(userA.id);
    expect(item?.photos).toContain(photoPath);
    expect((item?.attributes as { brand?: string })?.brand).toBe(result.attributes.brand);
    expect(item?.condition).toBe(result.attributes.condition);

    // Read the listing back AS THE OWNER.
    const { data: listing, error: listingErr } = await userA.client
      .from("listings")
      .select("id, user_id, item_id, platform, title, status")
      .eq("id", listingId)
      .single();
    expect(listingErr).toBeNull();
    expect(listing?.user_id).toBe(userA.id);
    expect(listing?.item_id).toBe(itemId);
    expect(listing?.platform).toBe(result.listing.platform);
    expect(listing?.status).toBe("draft");

    // A prediction_log was written (eval-harness prerequisite) — assert the FULL
    // row contract, read back through the same user-scoped helper the eval harness
    // will use, so the persisted shape can never silently drift from the mapping.
    const logs = await readPredictionLogs(userA.client, { itemId });
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.user_id).toBe(userA.id);
    expect(log.item_id).toBe(itemId);
    // extracted_attrs round-trips the exact attributes the run produced.
    expect(log.extracted_attrs).toEqual(result.attributes);
    // price == suggested; range low/high == range.min/max (numeric column comes
    // back as a number string in some drivers, so compare numerically).
    expect(Number(log.price)).toBe(result.price.suggested);
    expect(Number(log.price_range.low)).toBe(result.price.range.min);
    expect(Number(log.price_range.high)).toBe(result.price.range.max);
    // confidence == the composite score.
    expect(Number(log.confidence)).toBe(result.confidence.score);
    expect(log.tier_fired).toBe(result.price.tier);
    expect(log.model).toBe(result.model);
    // sources are persisted (the cited comps behind the price).
    expect(log.sources).toEqual(result.price.sources);
    expect(log.sources.length).toBeGreaterThan(0);
  });

  it("deletes the anchor item when the pipeline fails (nothing strands as 'Processing')", async () => {


    const photoPath = await uploadPhoto(userA);

    // The real failure mode that was stranding items: the model call throws
    // mid-run (e.g. depleted quota) after the anchor item row already exists.
    const failing: Pipeline = {
      run: async () => {
        throw new Error("simulated vision failure (quota)");
      },
    };

    await expect(
      runPipelineAndPersist(
        userA.client,
        { userId: userA.id, photos: [photoPath] },
        failing,
      ),
    ).rejects.toThrow(/simulated vision failure/);

    // No item row survives for this run — so it can never render as "Processing".
    const { data: orphans, error } = await userA.client
      .from("items")
      .select("id")
      .contains("photos", [photoPath]);
    expect(error).toBeNull();
    expect(orphans).toEqual([]);
  });

  it("RLS holds: user B cannot read user A's persisted item or listing", async () => {


    const photoPath = await uploadPhoto(userA);
    const { itemId, listingId } = await runPipelineAndPersist(
      userA.client,
      { userId: userA.id, photos: [photoPath] },
      new StubPipeline(),
    );

    const { data: bSeesItem } = await userB.client
      .from("items")
      .select("*")
      .eq("id", itemId);
    expect(bSeesItem ?? []).toHaveLength(0);

    const { data: bSeesListing } = await userB.client
      .from("listings")
      .select("*")
      .eq("id", listingId);
    expect(bSeesListing ?? []).toHaveLength(0);

    const { data: bSeesLog } = await userB.client
      .from("prediction_logs")
      .select("*")
      .eq("item_id", itemId);
    expect(bSeesLog ?? []).toHaveLength(0);
  });

  it("RLS WITH CHECK blocks persisting a run under a spoofed user_id", async () => {


    const photoPath = await uploadPhoto(userA);
    // userA's client tries to persist rows owned by userB — must fail.
    await expect(
      runPipelineAndPersist(
        userA.client,
        { userId: userB.id, photos: [photoPath] },
        new StubPipeline(),
      ),
    ).rejects.toThrow();
  });

  it("persists the pipeline's identification and reads it back under RLS (issue #27)", async () => {


    const photoPath = await uploadPhoto(userA);
    // A pipeline that produces a MODEL-FLAGGED-AMBIGUOUS identification despite strong
    // identifiers — exactly the case re-deriving from attributes alone would mask.
    const idPipeline: Pipeline = {
      async run() {
        return {
          attributes: {
            brand: "Generic",
            model: "X1",
            category: "electronics",
            condition: "good",
          },
          price: {
            suggested: 12,
            range: { min: 8, max: 16 },
            confidence: 0.4,
            sources: [],
            tier: "llm-only",
          },
          confidence: { score: 0.4, band: "low", autopilotEligible: false },
          listing: { platform: "ebay", title: "Item", description: "desc", fields: {} },
          model: "test-id-pipeline",
          identification: {
            label: "Possibly a knock-off speaker",
            confident: false,
            evidence: 0.75,
            reason: "Model flagged this identification as uncertain.",
            candidates: ["JBL Flip", "Anker Soundcore"],
          },
        };
      },
    };

    const { itemId } = await runPipelineAndPersist(
      userA.client,
      { userId: userA.id, photos: [photoPath] },
      idPipeline,
    );

    const { data: item, error } = await userA.client
      .from("items")
      .select("identification")
      .eq("id", itemId)
      .single();
    expect(error).toBeNull();
    const id = item?.identification as {
      confident?: boolean;
      reason?: string;
      candidates?: string[];
    } | null;
    expect(id).toBeTruthy();
    // The MODEL's decision survives — not a re-derived "confident" from strong fields.
    expect(id?.confident).toBe(false);
    expect(id?.reason).toMatch(/uncertain/i);
    expect(id?.candidates).toEqual(["JBL Flip", "Anker Soundcore"]);
  });

  it("leaves identification null when the pipeline produces none (review falls back to re-derivation)", async () => {


    const photoPath = await uploadPhoto(userA);
    const { itemId } = await runPipelineAndPersist(
      userA.client,
      { userId: userA.id, photos: [photoPath] },
      new StubPipeline(),
    );
    const { data: item } = await userA.client
      .from("items")
      .select("identification")
      .eq("id", itemId)
      .single();
    expect(item?.identification ?? null).toBeNull();
  });
});

/** A minimal schema-valid pipeline whose confidence (and so disposition) is injectable. */
function pipelineWithConfidence(
  confidence: PipelineResult["confidence"],
): Pipeline {
  return {
    async run() {
      const sourceUrl = "https://www.ebay.com/itm/sony-wh-1000xm4-sold";
      return {
        attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
        price: {
          suggested: 180,
          range: { min: 150, max: 210 },
          confidence: confidence.score,
          sources: [
            {
              url: sourceUrl,
              title: "Sony WH-1000XM4 sold listing",
              kind: "sold-comp",
            },
          ],
          evidence: [
            {
              id: "sony-wh-1000xm4-sold",
              sourceUrl,
              title: "Sony WH-1000XM4 sold listing",
              price: 180,
              currency: "USD",
              condition: "good",
              kind: "sold-comparable",
              priceDisclosure: "displayed-sold-price",
            },
          ],
          // Headphones have no ISBN, and every source/evidence row above is an
          // eBay sold comp, so this is the tier the router would have fired.
          tier: "ebay-sold",
        },
        confidence,
        listing: { platform: "ebay", title: "Item", description: "desc", fields: {} },
        model: "test-gate-pipeline",
      };
    },
  };
}

describe("confidence-gated publish eligibility + price override (issues #12, #127)", () => {
  it("an eligible run persists its listing QUEUED as ready for manual publish", async () => {


    const photoPath = await uploadPhoto(userA);
    const { listingId } = await runPipelineAndPersist(
      userA.client,
      { userId: userA.id, photos: [photoPath] },
      pipelineWithConfidence({ score: 0.92, band: "high", autopilotEligible: true }),
    );

    const { data: listing } = await userA.client
      .from("listings")
      .select("status")
      .eq("id", listingId)
      .single();
    expect(listing?.status).toBe("queued");
  });

  it("a NON-eligible run (low confidence, or autopilot off) persists its listing as a review DRAFT", async () => {


    const photoPath = await uploadPhoto(userA);
    // autopilotEligible false covers both causes: the gate already folded in the
    // master switch and the threshold (computeConfidence owns that rule).
    const { listingId } = await runPipelineAndPersist(
      userA.client,
      { userId: userA.id, photos: [photoPath] },
      pipelineWithConfidence({ score: 0.92, band: "high", autopilotEligible: false }),
    );

    const { data: listing } = await userA.client
      .from("listings")
      .select("status")
      .eq("id", listingId)
      .single();
    expect(listing?.status).toBe("draft");
  });

  it("the seller's price override persists on the item and wins downstream via effectivePrice", async () => {


    const photoPath = await uploadPhoto(userA);
    const { itemId, result } = await runPipelineAndPersist(
      userA.client,
      { userId: userA.id, photos: [photoPath] },
      new StubPipeline(),
    );

    // No override yet → downstream price IS the suggestion.
    const { data: fresh } = await userA.client
      .from("items")
      .select("price_override")
      .eq("id", itemId)
      .single();
    expect(fresh?.price_override ?? null).toBeNull();
    expect(effectivePrice(result.price.suggested, fresh?.price_override)).toBe(
      result.price.suggested,
    );

    // Seller overrides → persists, reads back, and wins downstream.
    const { data: updated, error: updErr } = await userA.client
      .from("items")
      .update({ price_override: 142.5 })
      .eq("id", itemId)
      .select("price_override");
    expect(updErr).toBeNull();
    expect(updated).toHaveLength(1);

    const { data: after } = await userA.client
      .from("items")
      .select("price_override")
      .eq("id", itemId)
      .single();
    expect(Number(after?.price_override)).toBe(142.5);
    expect(effectivePrice(result.price.suggested, after?.price_override)).toBe(142.5);

    // Clearing the override restores the suggestion downstream.
    await userA.client
      .from("items")
      .update({ price_override: null })
      .eq("id", itemId);
    const { data: cleared } = await userA.client
      .from("items")
      .select("price_override")
      .eq("id", itemId)
      .single();
    expect(effectivePrice(result.price.suggested, cleared?.price_override)).toBe(
      result.price.suggested,
    );
  });

  it("RLS: user B cannot set a price override on user A's item", async () => {


    const photoPath = await uploadPhoto(userA);
    const { itemId } = await runPipelineAndPersist(
      userA.client,
      { userId: userA.id, photos: [photoPath] },
      new StubPipeline(),
    );

    const { data: hijacked } = await userB.client
      .from("items")
      .update({ price_override: 1 })
      .eq("id", itemId)
      .select();
    expect(hijacked ?? []).toHaveLength(0);

    const { data: intact } = await userA.client
      .from("items")
      .select("price_override")
      .eq("id", itemId)
      .single();
    expect(intact?.price_override ?? null).toBeNull();
  });
});
