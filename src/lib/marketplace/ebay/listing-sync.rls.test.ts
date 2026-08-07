import {
  skipIfStackUnreachable,
  stackReachable,
  whenStackReachable,
} from "@/test/supabase-stack";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireExclusiveTestResource,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";
import {
  cleanupClerkTestUsers,
  mintUserJwt,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";
import { StubPipeline } from "@/lib/pipeline/stub";
import { runPipelineAndPersist } from "@/lib/pipeline/persist";
import { serverRpcHeaders } from "@/lib/supabase/server-rpc-auth";
import { saveEbayConnection } from "./connections";
import { ingestEbayListingObservation } from "./listing-sync";
import { createSupabaseEbayListingSyncStore } from "./listing-sync-store";

/**
 * Post-publish eBay authority against the real database (issue #169).
 *
 * The decision logic is proved offline in `listing-sync.test.ts`. What can only
 * be proved here is that the decision cannot escape its tenant: two sellers,
 * two published listings, one shared eBay listing id, and every read and write
 * confined to its owner by RLS and by the guarded functions themselves.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const SERVER_RPC_SECRET = process.env.SERVER_RPC_SECRET;
const TEST_TIMEOUT_MS = 30_000;
const TEST_ENV = {
  EBAY_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

let reachable = false;
let lease: ExclusiveTestResourceLease | undefined;
let admin: SupabaseClient;
let userA: ClerkTestUser;
let userB: ClerkTestUser;
let serverA: SupabaseClient;
let serverB: SupabaseClient;
let listingA: PublishedListing;
let listingB: PublishedListing;
const uploadedPhotos: string[] = [];

interface PublishedListing {
  listingId: string;
  itemId: string;
  ebayListingId: string;
  reviewRevision: string;
  accountGeneration: string;
  connectionGeneration: string;
}

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

async function tenantServerClient(userId: string): Promise<SupabaseClient> {
  const token = await mintUserJwt(userId);
  return createClient(SUPABASE_URL, SECRET_KEY!, {
    accessToken: async () => token,
    global: { headers: serverRpcHeaders(SERVER_RPC_SECRET!) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function uploadPhoto(user: ClerkTestUser): Promise<string> {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const path = `${user.id}/${randomBytes(8).toString("hex")}-sync.png`;
  const { error } = await user.client.storage
    .from("photos")
    .upload(path, bytes, { contentType: "image/png" });
  if (error) throw new Error(`Photo upload failed: ${error.message}`);
  uploadedPhotos.push(path);
  return path;
}

/**
 * A listing in the exact state eBay authority begins from: a confirmed publish
 * that supplied an external identity. The publish path itself is proved by its
 * own suites, so the terminal row is written directly — what matters here is
 * that the sync seam treats it as eBay's, not SnapList's.
 */
async function publishedListing(
  user: ClerkTestUser,
  server: SupabaseClient,
  prefix: string,
  ebayListingId: string,
): Promise<PublishedListing> {
  const photo = await uploadPhoto(user);
  const { listingId, itemId } = await runPipelineAndPersist(
    user.client,
    { userId: user.id, photos: [photo] },
    new StubPipeline(),
  );

  await saveEbayConnection(
    server,
    {
      accessToken: `${prefix}-access-token`,
      refreshToken: `${prefix}-refresh-token`,
      accessTokenExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
      scopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
    },
    { userId: `EBAYUID-SYNC-${prefix}`, username: `${prefix}-seller` },
    TEST_ENV,
  );

  const { error: publishError } = await admin
    .from("listings")
    .update({
      ebay_status: "published",
      ebay_listing_id: ebayListingId,
      ebay_offer_id: `${prefix}-offer`,
      ebay_publish_binding: { marketplaceId: "EBAY_US" },
    })
    .eq("id", listingId);
  if (publishError) {
    throw new Error(`Could not stage published listing: ${publishError.message}`);
  }

  const { data: item, error: itemError } = await admin
    .from("items")
    .select("review_revision")
    .eq("id", itemId)
    .single();
  if (itemError) throw new Error(`Missing item: ${itemError.message}`);
  const { data: connection, error: connectionError } = await admin
    .from("ebay_connections")
    .select("account_generation, connection_generation")
    .eq("user_id", user.id)
    .single();
  if (connectionError) {
    throw new Error(`Missing eBay connection: ${connectionError.message}`);
  }

  return {
    listingId,
    itemId,
    ebayListingId,
    reviewRevision: item.review_revision as string,
    accountGeneration: connection.account_generation as string,
    connectionGeneration: connection.connection_generation as string,
  };
}

function observationFor(
  listing: PublishedListing,
  overrides: Record<string, unknown> = {},
) {
  return {
    eventId: `notification-${randomUUID()}`,
    source: "notification" as const,
    ebayListingId: listing.ebayListingId,
    marketplaceId: "EBAY_US",
    accountGeneration: listing.accountGeneration,
    connectionGeneration: listing.connectionGeneration,
    status: "ended" as const,
    price: { value: "31.00", currency: "USD" },
    quantity: 0,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * A reachable stack is not the same as a stack that has this branch's sync
 * tables. Without this check the suite would skip every tenancy assertion the
 * moment the surface was missing and still report green — the two-tenant proof
 * would vanish silently, which is the one thing an isolation suite may not do.
 *
 * The two answers mirror the pgTAP `require_installed_migrations` flag exactly:
 * where CI builds the stack from this branch's migrations an absent surface is
 * a real defect and raises; a shared local stack that simply does not contain
 * this branch skips instead of reporting a failure for work it lacks.
 */
async function syncSurfaceInstalled(client: SupabaseClient): Promise<boolean> {
  const probes = await Promise.all(
    ["ebay_listing_sync_state", "ebay_listing_sync_conflicts"].map(
      async (table) => {
        const { error } = await client.from(table).select("listing_id").limit(0);
        // Only "not in the schema cache" means absent. `service_role` has no
        // select grant on these tables by design — that is the tenancy this
        // suite exists to prove — so `42501 permission denied` comes back
        // instead, and it is itself proof the table is there.
        return error === null || error.code !== "PGRST205";
      },
    ),
  );
  const installed = probes.every(Boolean);
  if (!installed && process.env.SNAPLIST_REQUIRE_DB_STACK === "1") {
    throw new Error(
      "SNAPLIST_REQUIRE_DB_STACK=1 requires the eBay listing sync migration",
    );
  }
  return installed;
}

beforeAll(async () => {
  reachable = await stackReachable({
    url: SUPABASE_URL,
    apiKey: PUBLISHABLE_KEY,
    requiredValues: [
      PUBLISHABLE_KEY?.startsWith("sb_publishable_"),
      SECRET_KEY?.startsWith("sb_secret_"),
      SERVER_RPC_SECRET,
      ["127.0.0.1", "localhost", "::1"].includes(new URL(SUPABASE_URL).hostname),
    ],
  });
  if (reachable) {
    admin = createClient(SUPABASE_URL, SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    reachable = await syncSurfaceInstalled(admin);
  }
  await whenStackReachable(reachable, async () => {
    lease = await acquireExclusiveTestResource(
      `local-db:ebay-listing-sync:${SUPABASE_URL}`,
    );
    [userA, userB] = await Promise.all([
      provisionClerkTestUser(SUPABASE_URL, PUBLISHABLE_KEY!, "listing_sync_a"),
      provisionClerkTestUser(SUPABASE_URL, PUBLISHABLE_KEY!, "listing_sync_b"),
    ]);
    [serverA, serverB] = await Promise.all([
      tenantServerClient(userA.id),
      tenantServerClient(userB.id),
    ]);
    // Both sellers publish under the SAME eBay listing id. Nothing about the
    // provider's identity may be what separates their rows.
    const shared = `EBAY-SHARED-${randomBytes(4).toString("hex")}`;
    listingA = await publishedListing(userA, serverA, "sync-a", shared);
    listingB = await publishedListing(userB, serverB, "sync-b", shared);
  });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await whenStackReachable(reachable, async () => {
    try {
      if (admin && uploadedPhotos.length > 0) {
        await admin.storage.from("photos").remove(uploadedPhotos);
      }
      await cleanupClerkTestUsers(
        admin,
        [userA, userB].filter(Boolean).map((user) => user.id),
      );
    } finally {
      await lease?.release();
    }
  });
}, TEST_TIMEOUT_MS);

describe("eBay listing sync tenancy", () => {
  it(
    "confines confirmed provider truth and its conflicts to the owning seller",
    async () => {
      const store = createSupabaseEbayListingSyncStore(serverA);

      const outcome = await ingestEbayListingObservation({
        listingId: listingA.listingId,
        observation: observationFor(listingA),
        store,
      });
      expect(outcome.state).toBe("applied");

      const { data: ownState } = await userA.client
        .from("ebay_listing_sync_state")
        .select("listing_id, provider_status, provider_price_value");
      expect(ownState).toEqual([
        expect.objectContaining({
          listing_id: listingA.listingId,
          provider_status: "ended",
        }),
      ]);

      // The listing ended while SnapList still held a live price, so BOTH
      // dimensions diverge and each is its own explicit conflict row.
      const { data: ownConflicts } = await userA.client
        .from("ebay_listing_sync_conflicts")
        .select("field, kind, provider_value")
        .order("field");
      expect(ownConflicts?.map((row) => row.field)).toEqual(["price", "status"]);
      expect(
        ownConflicts?.every((row) => row.kind === "providerDiverged"),
      ).toBe(true);

      // The other seller shares the eBay listing id and sees none of it.
      const { data: otherState } = await userB.client
        .from("ebay_listing_sync_state")
        .select("listing_id");
      expect(otherState).toEqual([]);
      const { data: otherConflicts } = await userB.client
        .from("ebay_listing_sync_conflicts")
        .select("id");
      expect(otherConflicts).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses to apply one seller's observation to another seller's listing",
    async () => {
      const store = createSupabaseEbayListingSyncStore(serverB);

      // B asks for A's listing by id. The read is RLS-scoped, so there is
      // nothing to read and eBay authority never begins.
      const outcome = await ingestEbayListingObservation({
        listingId: listingA.listingId,
        observation: observationFor(listingA),
        store,
      });
      expect(outcome).toEqual({ state: "refused", reason: "notPublished" });

      // And the guarded write refuses on its own, without relying on the
      // service having checked first.
      await expect(
        store.applyProviderTruth({
          listingId: listingA.listingId,
          eventId: `cross-tenant-${randomUUID()}`,
          source: "notification",
          ebayListingId: listingA.ebayListingId,
          marketplaceId: "EBAY_US",
          accountGeneration: listingA.accountGeneration,
          connectionGeneration: listingA.connectionGeneration,
          providerStatus: "ended",
          providerPrice: "1.00",
          providerCurrency: "USD",
          providerQuantity: 0,
          providerObservedAt: new Date().toISOString(),
          expectedReviewRevision: listingA.reviewRevision,
          expectedLastEventId: null,
          conflicts: [],
          convergedFields: [],
        }),
      ).rejects.toThrow(/Listing not found/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses an observation carrying a review the item has moved past",
    async () => {
      const store = createSupabaseEbayListingSyncStore(serverB);

      await expect(
        store.applyProviderTruth({
          listingId: listingB.listingId,
          eventId: `stale-revision-${randomUUID()}`,
          source: "poll",
          ebayListingId: listingB.ebayListingId,
          marketplaceId: "EBAY_US",
          accountGeneration: listingB.accountGeneration,
          connectionGeneration: listingB.connectionGeneration,
          providerStatus: "active",
          providerPrice: "12.00",
          providerCurrency: "USD",
          providerQuantity: 1,
          providerObservedAt: new Date().toISOString(),
          expectedReviewRevision: randomUUID(),
          expectedLastEventId: null,
          conflicts: [],
          convergedFields: [],
        }),
      ).rejects.toThrow(/corrected during eBay sync/);

      const { data } = await userB.client
        .from("ebay_listing_sync_state")
        .select("listing_id");
      expect(data).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the seller's own sync rows read-only from the client",
    async () => {
      const { error } = await userA.client
        .from("ebay_listing_sync_state")
        .update({ provider_status: "active" })
        .eq("listing_id", listingA.listingId);

      expect(error).not.toBeNull();
      const { data } = await userA.client
        .from("ebay_listing_sync_state")
        .select("provider_status")
        .eq("listing_id", listingA.listingId)
        .single();
      expect(data?.provider_status).toBe("ended");
    },
    TEST_TIMEOUT_MS,
  );
});
