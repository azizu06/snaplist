import type { SupabaseClient } from "@supabase/supabase-js";

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

export interface ReviewSnapshot {
  item: ReviewSnapshotItem;
  listing: ReviewSnapshotListing | null;
  prediction: ReviewSnapshotPrediction | null;
  reviewBlocked: boolean;
}

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
    !("reviewBlocked" in data) ||
    typeof data.reviewBlocked !== "boolean"
  ) {
    throw new Error("Failed to load review: invalid snapshot.");
  }
  return data as unknown as ReviewSnapshot;
}
