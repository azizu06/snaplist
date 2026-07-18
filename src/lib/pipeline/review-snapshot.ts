import type { SupabaseClient } from "@supabase/supabase-js";

/** Item projection returned by the atomic, tenant-scoped review snapshot RPC. */
export interface ReviewSnapshotItem {
  id: string;
  photos: unknown;
  attributes: unknown;
  condition: string | null;
  identification: unknown;
  price_override: number | string | null;
  cost_basis: number | string | null;
  review_revision: string;
  created_at: string;
}

/** eBay listing projection paired with the review's current applicable run. */
export interface ReviewSnapshotListing {
  id: string;
  platform: string;
  title: string | null;
  description: string | null;
  copy: unknown;
  status: string | null;
  run_id: string | null;
  ebay_listing_id: string | null;
  ebay_status: string | null;
}

/** Latest applicable prediction projection displayed by review. */
export interface ReviewSnapshotPrediction {
  price: number | string | null;
  price_range: unknown;
  confidence: number | null;
  tier_fired: string | null;
  model: string | null;
  sources: unknown;
  autopilot_enabled: boolean | null;
  autopilot_eligible: boolean | null;
}

/** Coherent item/listing/prediction read plus an all-eBay-row mutation guard. */
export interface ReviewSnapshot {
  item: ReviewSnapshotItem;
  listing: ReviewSnapshotListing | null;
  prediction: ReviewSnapshotPrediction | null;
  reviewBlocked: boolean;
}

const loadedReviewSnapshotItems = new WeakMap<object, ReviewSnapshotItem>();

/** True only for snapshots returned by the tenant-scoped snapshot RPC seam. */
export function isLoadedReviewSnapshot(value: unknown): value is ReviewSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    loadedReviewSnapshotItems.has(value)
  );
}

/** Immutable-at-load item projection for trusted downstream fact derivation. */
export function loadedReviewSnapshotItem(
  value: unknown,
): ReviewSnapshotItem | null {
  if (!isLoadedReviewSnapshot(value)) return null;
  return structuredClone(loadedReviewSnapshotItems.get(value)!);
}

/** Load one RLS-scoped review projection in a single database statement. */
export async function loadReviewSnapshot(
  supabase: SupabaseClient,
  itemId: string,
): Promise<ReviewSnapshot | null> {
  const { data, error } = await supabase.rpc("get_review_snapshot", {
    p_item_id: itemId,
  });
  if (error) throw new Error(`Failed to load review: ${error.message}`);
  if (data == null) return null;
  if (
    typeof data !== "object" ||
    Array.isArray(data) ||
    !("item" in data) ||
    typeof data.item !== "object" ||
    data.item === null ||
    Array.isArray(data.item) ||
    !("reviewBlocked" in data) ||
    typeof data.reviewBlocked !== "boolean"
  ) {
    throw new Error("Failed to load review: invalid snapshot.");
  }
  const snapshot = data as unknown as ReviewSnapshot;
  loadedReviewSnapshotItems.set(snapshot, structuredClone(snapshot.item));
  return snapshot;
}
