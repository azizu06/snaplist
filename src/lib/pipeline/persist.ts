import type { SupabaseClient } from "@supabase/supabase-js";
import type { Pipeline, PipelineResult } from "./types";
import { pipeline as defaultPipeline } from "./stub";
import { logPrediction } from "./prediction-log";
import { initialListingStatus } from "./autopilot";

/**
 * Persistence layer for one pipeline run — the end-to-end spine the walking
 * skeleton proves: photo paths → `items` row → pipeline → `listings` row +
 * `prediction_logs` row, all through the caller's USER-SCOPED Supabase client so
 * RLS enforces tenancy on every write (AGENTS.md non-negotiable #1).
 *
 * The `supabase` client must be authenticated as the owning user (the request's
 * server client). `user_id` is passed explicitly and pinned on every row; RLS's
 * WITH CHECK (auth.uid() = user_id) rejects any attempt to write another user's
 * rows, so a spoofed id can never persist.
 *
 * The `pipeline` is injected (defaults to the stub) — the seam where real
 * vision/pricing/listing swap in with zero changes here.
 */

export interface RunAndPersistInput {
  /** The owning user's id (must equal the client's auth.uid()). */
  userId: string;
  /** Storage object paths under the private `photos` bucket, scoped by user_id. */
  photos: string[];
  /** Master autopilot switch (User Story 24). Forwarded to the pipeline. */
  autopilotEnabled?: boolean;
}

export interface RunAndPersistResult {
  itemId: string;
  listingId: string;
  result: PipelineResult;
}

export async function runPipelineAndPersist(
  supabase: SupabaseClient,
  input: RunAndPersistInput,
  pipeline: Pipeline = defaultPipeline,
): Promise<RunAndPersistResult> {
  if (input.photos.length === 0) {
    throw new Error("runPipelineAndPersist requires at least one photo path");
  }

  // One id for this run, stamped on BOTH the listing and the prediction log so
  // downstream consumers (the eval harness) can pair them by identity instead
  // of by created_at coincidence — independent "newest row" lookups can mix
  // rows from different runs under concurrency or partial failures.
  const runId = crypto.randomUUID();

  // 1. Create the items row FIRST (so the run is anchored to a persisted item
  //    even if a later step fails). RLS pins ownership via WITH CHECK.
  const { data: item, error: itemErr } = await supabase
    .from("items")
    .insert({
      user_id: input.userId,
      photos: input.photos,
      // attributes/condition are filled after extraction (step 3 update); start empty.
      attributes: {},
    })
    .select("id")
    .single();
  if (itemErr || !item) {
    throw new Error(`Failed to create item: ${itemErr?.message ?? "no row returned"}`);
  }
  const itemId = item.id as string;

  // 2. Run the pipeline (stubbed AI). photos → attributes + price + confidence + listing.
  const result = await pipeline.run({
    photos: input.photos,
    autopilotEnabled: input.autopilotEnabled,
  });

  // 3. Backfill the extracted attributes + condition + identification onto the item.
  //    Persisting `identification` lets the review page render the MODEL's actual
  //    decision (incl. its ambiguity flag/reason/candidates) instead of re-deriving
  //    it from attributes alone (issue #27). Null when the pipeline produced none
  //    (the stub pipeline) — the review page falls back to re-derivation then.
  const { error: updErr } = await supabase
    .from("items")
    .update({
      attributes: result.attributes,
      condition: result.attributes.condition ?? null,
      identification: result.identification ?? null,
    })
    .eq("id", itemId);
  if (updErr) {
    throw new Error(`Failed to update item attributes: ${updErr.message}`);
  }

  // 4. Log the prediction for the eval harness (PRD non-negotiable: log every
  //    run) BEFORE any listing becomes queued: these two writes are not
  //    transactional, and the failure modes are asymmetric. A log row without
  //    a listing is inert; a QUEUED listing without its mandatory evaluation
  //    record is a publishable run the upload request reported as failed —
  //    a queue consumer could post it, and a retried upload could duplicate it.
  await logPrediction(supabase, input.userId, itemId, result, {
    autopilotEnabled: input.autopilotEnabled,
    runId,
  });

  // 5. Persist the generated listing. The initial status is the confidence-gated
  //    autopilot disposition (issue #12): autopilot-eligible runs (master switch ON
  //    and high-confidence) are QUEUED for auto-post; everything else (low/medium
  //    confidence, or autopilot turned off) stays a DRAFT awaiting review.
  const { data: listing, error: listingErr } = await supabase
    .from("listings")
    .insert({
      user_id: input.userId,
      item_id: itemId,
      platform: result.listing.platform,
      title: result.listing.title,
      description: result.listing.description,
      copy: result.listing.fields,
      status: initialListingStatus(result.confidence),
      run_id: runId,
    })
    .select("id")
    .single();
  if (listingErr || !listing) {
    throw new Error(
      `Failed to create listing: ${listingErr?.message ?? "no row returned"}`,
    );
  }
  const listingId = listing.id as string;

  return { itemId, listingId, result };
}
