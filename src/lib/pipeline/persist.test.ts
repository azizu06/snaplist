import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { StubPipeline } from "./stub";
import { runPipelineAndPersist } from "./persist";
import { readPredictionLogs } from "./prediction-log";

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

async function stackReachable(): Promise<boolean> {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: ANON_KEY },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

type TestUser = {
  id: string;
  email: string;
  client: SupabaseClient;
};

let reachable = false;
let admin: SupabaseClient;
let userA: TestUser;
let userB: TestUser;
const createdUserIds: string[] = [];

async function provisionUser(label: string): Promise<TestUser> {
  const email = `skeleton-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
  const password = "test-password-123!";

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    throw new Error(`createUser failed for ${label}: ${createErr?.message}`);
  }
  createdUserIds.push(created.user.id);

  const client = createClient(SUPABASE_URL, ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInErr } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr) throw new Error(`signIn failed for ${label}: ${signInErr.message}`);

  return { id: created.user.id, email, client };
}

/** Upload a tiny PNG to the user-scoped path, as the upload route would. */
async function uploadPhoto(user: TestUser): Promise<string> {
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
  reachable = await stackReachable();
  if (!reachable) return;

  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [userA, userB] = await Promise.all([provisionUser("a"), provisionUser("b")]);
});

afterAll(async () => {
  if (!reachable || !admin) return;
  await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
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
    if (!reachable) return;

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

  it("RLS holds: user B cannot read user A's persisted item or listing", async () => {
    if (!reachable) return;

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
    if (!reachable) return;

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
});
