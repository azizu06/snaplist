import type { SupabaseClient } from "@supabase/supabase-js";
import { effectivePrice } from "../pipeline";
import { DEPOP_PLATFORM, FACEBOOK_PLATFORM, MERCARI_PLATFORM } from "./schema";

/**
 * Assisted-export handoff seam (issue #378).
 *
 * Facebook Marketplace, Mercari, and Depop are ASSISTED destinations: SnapList
 * prepares platform-appropriate text and photos, the seller finishes the form.
 * SnapList cannot observe those destinations, so nothing in this module may
 * infer delivery. Opening the app, dismissing the share sheet, copying the
 * text, and saving the photos all prove NOTHING — only the seller's explicit
 * confirmation writes `shared`, and the database refuses that write when the
 * pack is stale or the destination never received a handoff.
 *
 * Every mutation goes through the guarded RPCs rather than a table write, so a
 * client can neither skip the revision guard nor mint a second receipt on
 * retry. Reads go through RLS on the caller's user-scoped client.
 */

export const ASSISTED_EXPORT_PLATFORMS = [
  FACEBOOK_PLATFORM,
  MERCARI_PLATFORM,
  DEPOP_PLATFORM,
] as const;

export type AssistedExportPlatform = (typeof ASSISTED_EXPORT_PLATFORMS)[number];

/**
 * What the seller is told about one destination. Deliberately only two values:
 * SnapList knows it prepared the pack, and it knows whether the seller said
 * they posted it. `published`, `listed`, `sold`, `synced`, and `verified` are
 * not knowable and are therefore not representable.
 */
export type ExportHandoffState = "prepared" | "shared";

export interface ExportHandoffView {
  platform: AssistedExportPlatform;
  state: ExportHandoffState;
  /** When the seller handed the pack over; null when they have not yet. */
  handedOffAt: string | null;
  /** When the seller confirmed they posted it; null until they do. */
  sharedAt: string | null;
}

export type ExportHandoffsView = Record<
  AssistedExportPlatform,
  ExportHandoffView
>;

export interface ExportHandoffRead {
  itemId: string;
  /** The content revision the packs were built at. */
  reviewContentRevision: string;
}

/** Server-authoritative price and revision for one prepared export pack. */
export interface ExportHandoffPackProjection {
  handoffs: ExportHandoffsView;
  effectivePrice: number;
  reviewRevision: string;
}

export interface ExportHandoffMutation extends ExportHandoffRead {
  platform: AssistedExportPlatform;
  /** The full review revision the seller was looking at. */
  reviewRevision: string;
}

interface HandoffRow {
  platform: string;
  handoff_at: string | null;
  shared_at: string | null;
}

interface ExportPackItemRow {
  price_override: number | string | null;
  review_revision: string;
}

interface ExportPackPredictionRow {
  price: number | string | null;
}

function preparedView(platform: AssistedExportPlatform): ExportHandoffView {
  return { platform, state: "prepared", handedOffAt: null, sharedAt: null };
}

/**
 * A refused handoff RPC. The Postgres `code` is the machine-readable half of
 * the refusal and callers branch on it — `P0002` means the pack went stale
 * under the seller and the sheet must reopen, `22023` means the destination is
 * not an assisted one, `42501` means the caller is unauthenticated. Collapsing
 * these into a bare message would leave a UI unable to tell "try again" from
 * "this can never work".
 */
export class ExportHandoffError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "ExportHandoffError";
    this.code = code;
  }
}

interface PostgrestFailure {
  message: string;
  code?: string;
}

function refused(error: PostgrestFailure): never {
  throw new ExportHandoffError(error.message, error.code);
}

/**
 * The RPCs return a timestamptz, which PostgREST serializes as a string. A
 * null or non-string result means the capability did not do what its contract
 * says, and that must surface as a failure rather than as an optimistic
 * timestamp the caller renders next to the word `Shared`.
 */
function requireTimestamp(data: unknown, rpc: string): string {
  if (typeof data !== "string" || data.length === 0) {
    throw new ExportHandoffError(
      `${rpc} returned no timestamp; the handoff was not recorded.`,
      undefined,
    );
  }
  return data;
}

function assertAssisted(platform: AssistedExportPlatform): void {
  if (!(ASSISTED_EXPORT_PLATFORMS as readonly string[]).includes(platform)) {
    throw new Error(
      `${platform} is not an assisted export destination — it never receives a handoff receipt.`,
    );
  }
}

/**
 * The handoff state of all three destinations for one pack revision. A
 * destination with no row is `prepared`, not missing or failed: SnapList did
 * prepare the pack, the seller simply has not confirmed anything yet.
 *
 * Reads key on `reviewContentRevision` alone while every mutation also carries
 * the full `reviewRevision`, and the asymmetry is deliberate. Receipts belong
 * to the pack text the seller actually handed over, which is what the content
 * revision identifies; a price edit advances the full revision without
 * changing that text, so the receipt legitimately survives it. The mutation
 * guard is stricter on purpose: writing `Shared` is a claim about the listing
 * as a whole, so it fails closed the moment ANY part of the listing moved
 * under a mounted confirm sheet.
 */
export async function loadExportHandoffs(
  supabase: SupabaseClient,
  input: ExportHandoffRead,
): Promise<ExportHandoffsView> {
  const { data, error } = await supabase
    .from("export_handoffs")
    .select("platform, handoff_at, shared_at")
    .eq("item_id", input.itemId)
    .eq("source_review_revision", input.reviewContentRevision);
  if (error) {
    refused({
      message: `Failed to read export handoffs: ${error.message}`,
      code: error.code,
    });
  }

  const view = {
    [FACEBOOK_PLATFORM]: preparedView(FACEBOOK_PLATFORM),
    [MERCARI_PLATFORM]: preparedView(MERCARI_PLATFORM),
    [DEPOP_PLATFORM]: preparedView(DEPOP_PLATFORM),
  } as ExportHandoffsView;

  for (const row of (data ?? []) as HandoffRow[]) {
    if (!(row.platform in view)) continue;
    const platform = row.platform as AssistedExportPlatform;
    view[platform] = {
      platform,
      // Only a confirmation timestamp earns `shared`. A recorded handoff is
      // evidence SnapList delivered the pack, never that a listing exists.
      state: row.shared_at ? "shared" : "prepared",
      handedOffAt: row.handoff_at,
      sharedAt: row.shared_at,
    };
  }
  return view;
}

/**
 * Receipts and outbound price share this RLS-scoped read. A valid override
 * wins; otherwise the newest recommendation wins. The content-revision filter
 * refuses a pack whose copy moved on instead of mixing old copy with new price.
 */
export async function loadExportHandoffPack(
  supabase: SupabaseClient,
  input: ExportHandoffRead,
): Promise<ExportHandoffPackProjection> {
  const [handoffs, itemResult, predictionResult] = await Promise.all([
    loadExportHandoffs(supabase, input),
    supabase
      .from("items")
      .select("price_override, review_revision")
      .eq("id", input.itemId)
      .eq("review_content_revision", input.reviewContentRevision)
      .maybeSingle(),
    supabase
      .from("prediction_logs")
      .select("price")
      .eq("item_id", input.itemId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (itemResult.error) {
    throw new ExportHandoffError(
      `Failed to read the current export pack: ${itemResult.error.message}`,
      itemResult.error.code,
    );
  }
  if (predictionResult.error) {
    throw new ExportHandoffError(
      `Failed to read the current export price: ${predictionResult.error.message}`,
      predictionResult.error.code,
    );
  }

  const item = itemResult.data as ExportPackItemRow | null;
  if (!item || typeof item.review_revision !== "string") {
    throw new ExportHandoffError(
      "This listing changed after the pack was prepared.",
      "P0002",
    );
  }
  const prediction = predictionResult.data as ExportPackPredictionRow | null;
  const price = effectivePrice(prediction?.price, item.price_override);
  if (price == null) {
    throw new ExportHandoffError(
      "This listing has no usable effective price.",
      undefined,
    );
  }

  return { handoffs, effectivePrice: price, reviewRevision: item.review_revision };
}

/**
 * Record that the seller handed the pack to a destination — the share sheet
 * opened, the text was copied, the photos were saved. Idempotent: a retried
 * handoff keeps the first timestamp.
 */
export async function recordExportHandoff(
  supabase: SupabaseClient,
  input: ExportHandoffMutation,
): Promise<string> {
  assertAssisted(input.platform);
  const { data, error } = await supabase.rpc("record_export_handoff", {
    p_item_id: input.itemId,
    p_platform: input.platform,
    p_source_review_revision: input.reviewContentRevision,
    p_expected_review_revision: input.reviewRevision,
  });
  if (error) refused(error);
  return requireTimestamp(data, "record_export_handoff");
}

/**
 * The seller's explicit claim that they posted the listing. The rejection path
 * matters as much as the success path: a refused confirmation (stale pack, no
 * recorded handoff, another tenant) must surface as a failure so no caller can
 * paint an optimistic `Shared` over a write that never happened.
 */
export async function markExportShared(
  supabase: SupabaseClient,
  input: ExportHandoffMutation,
): Promise<string> {
  assertAssisted(input.platform);
  const { data, error } = await supabase.rpc("mark_export_shared", {
    p_item_id: input.itemId,
    p_platform: input.platform,
    p_source_review_revision: input.reviewContentRevision,
    p_expected_review_revision: input.reviewRevision,
  });
  if (error) refused(error);
  return requireTimestamp(data, "mark_export_shared");
}

/** Take back a confirmation. The recorded handoff stands; the claim does not. */
export async function undoExportShared(
  supabase: SupabaseClient,
  input: ExportHandoffMutation,
): Promise<void> {
  assertAssisted(input.platform);
  const { error } = await supabase.rpc("undo_export_shared", {
    p_item_id: input.itemId,
    p_platform: input.platform,
    p_source_review_revision: input.reviewContentRevision,
    p_expected_review_revision: input.reviewRevision,
  });
  if (error) refused(error);
}
