import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { extractedAttributesSchema, identificationSchema } from "@/lib/pipeline/types";
import { effectivePrice } from "@/lib/pipeline";
import { DEFAULT_AUTOPILOT_THRESHOLD } from "@/lib/confidence/confidence";
import { reviewDisposition } from "@/lib/ui/publish-eligibility";
import {
  deriveIdentification,
  signPhotoUrlMap,
  garmentClassOf,
  needsReference,
  formatMeasurement,
  trimInches,
  GARMENT_MEASUREMENT_SETS,
  MEASUREMENT_LABELS,
} from "@/lib/vision";
import { deriveStrategies } from "@/lib/pricing/strategies";
import { priceSourceSchema, type PricingTier } from "@/lib/pricing/types";
import { generateClarifyingOptions } from "@/lib/clarify/generate";
import { loadReviewSnapshot } from "@/lib/pipeline/review-snapshot";
import {
  regenerateCorrectedIdentity,
  saveReview,
  sharpenEstimate,
} from "./actions";
import { ReviewView, type ReviewData } from "./review-view";
import { ConsumeUploadDraft } from "./consume-upload-draft";
import { PipelineRunProgress } from "@/components/pipeline-run-progress";
import {
  PIPELINE_PROGRESS_SELECT,
  pipelineProgressRunSchema,
} from "@/lib/pipeline-progress";

/** True only for absolute http(s) URLs — used to keep `javascript:`/`data:` and
 *  other non-web schemes out of rendered source <a href>s. The URL constructor
 *  normalizes obfuscated schemes (control chars, casing) that a regex misses. */
function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Review page — reads the persisted item + its listing + the prediction log back
 * through the USER-SCOPED server client (so RLS proves the row belongs to the
 * caller; another user's id 404s). Renders the real pipeline's output via the
 * Shopify-style ReviewView (issue #40 round 2 — this file is data assembly
 * only; the presentation lives in review-view.tsx).
 *
 * The identification is the PERSISTED one the pipeline produced (the model's
 * actual decision, including a model-signalled ambiguity with its reason/
 * candidates), so an explicitly-uncertain item is FLAGGED rather than presented
 * as a confident guess (issues #6 + #27). Legacy/stub rows without a persisted
 * identification fall back to re-deriving from the validated attributes.
 */
export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ error?: string; new?: string; ready?: string }>;
}) {
  const { itemId } = await params;
  const { error: actionError, new: fromUpload } = await searchParams;

  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect(`/login?next=/review/${itemId}`);

  const { data: rawRun, error: runError } = await supabase
    .from("pipeline_runs")
    .select(PIPELINE_PROGRESS_SELECT)
    .eq("item_id", itemId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runError) throw new Error(`Failed to load pipeline progress: ${runError.message}`);
  const parsedRun = pipelineProgressRunSchema.safeParse(rawRun);
  if (parsedRun.success && parsedRun.data.status !== "succeeded") {
    return (
      <>
        {fromUpload ? <ConsumeUploadDraft /> : null}
        <main
          data-testid="durable-progress"
          className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6"
        >
          <header>
            <h1 className="font-display text-[22px] font-bold tracking-tight text-fg-strong">
              Listing progress
            </h1>
            <p className="mt-1 text-[14px] leading-relaxed text-muted">
              This status is saved to your account. You can close this page and come back later.
            </p>
          </header>
          <PipelineRunProgress
            userId={userId}
            initialRun={parsedRun.data}
            reviewHref={`/review/${itemId}?ready=1`}
          />
        </main>
      </>
    );
  }

  const snapshot = await loadReviewSnapshot(supabase, itemId);
  if (!snapshot) notFound();
  const { item, listing, prediction: log } = snapshot;

  // Short-lived signed URLs for ALL the item's private photos (media card).
  const photoPaths = (item.photos as string[] | null) ?? [];
  const signedPhotos = await signPhotoUrlMap(supabase, photoPaths);
  const photoUrls = photoPaths
    .map((path) => signedPhotos.get(path))
    .filter((url): url is string => Boolean(url));

  const rawAttrs = (item.attributes ?? {}) as Record<string, unknown>;

  // "What we think it is" — prefer the PERSISTED identification (issue #27).
  const persistedId = identificationSchema.safeParse(item.identification);
  const parsedAttrs = extractedAttributesSchema.safeParse(item.attributes ?? {});
  const identification = persistedId.success
    ? persistedId.data
    : parsedAttrs.success
      ? deriveIdentification(parsedAttrs.data, {})
      : null;

  // Garment measurements (issue #104): render the type's measurement set, each as
  // a confirmable DRAFT with its tolerance band. The four listing-grade
  // measurements arrive pre-filled; inseam/sleeve (and other reference-only points)
  // stay blank with a "measure with a tape" prompt until the seller enters them.
  const garmentClass = parsedAttrs.success ? garmentClassOf(parsedAttrs.data) : null;
  const storedMeasurements = parsedAttrs.success ? (parsedAttrs.data.measurements ?? []) : [];
  const measurements = garmentClass
    ? {
        garmentClass,
        fields: GARMENT_MEASUREMENT_SETS[garmentClass].map((name) => {
          const draft = storedMeasurements.find((m) => m.name === name);
          return {
            name,
            label: MEASUREMENT_LABELS[name],
            value: draft ? trimInches(draft.value_in) : "",
            toleranceText: draft ? formatMeasurement(draft.value_in, draft.tolerance_in) : null,
            method: draft?.method ?? null,
            confirmed: draft?.confirmed ?? false,
            needsReference: needsReference(name),
          };
        }),
      }
    : null;

  const range = (log?.price_range ?? null) as { low?: number; high?: number } | null;
  const confidence = typeof log?.confidence === "number" ? log.confidence : null;

  // The cited comps behind the price (PRD story 9: "I want to see the sources").
  // Schema-validated so a malformed legacy row degrades to an empty list rather
  // than rendering broken links; optional fields normalize to null for the view.
  const parsedSources = priceSourceSchema.array().safeParse(log?.sources ?? []);
  // Source URLs come from the pricing pipeline (web search / scraper / LLM), and
  // priceSourceSchema only checks non-empty — so a hostile or hallucinated
  // `javascript:` / `data:` URL could otherwise reach the rendered <a href> and
  // execute on click. Allowlist http(s) here, at the render boundary, before the
  // links reach the client (XSS defense-in-depth).
  const sources = (parsedSources.success ? parsedSources.data : [])
    .filter((s) => isHttpUrl(s.url))
    .map((s) => ({
      url: s.url,
      title: s.title ?? null,
      kind: s.kind ?? null,
    }));

  // Seller price override (issue #12): the persisted override wins everywhere.
  const suggested = log?.price != null ? Number(log.price) : null;
  const override = item.price_override != null ? Number(item.price_override) : null;
  // #101: what the seller paid (numeric comes back as number OR string).
  const costBasis = item.cost_basis != null ? Number(item.cost_basis) : null;
  const displayPrice =
    suggested != null ? effectivePrice(suggested, override) : override;

  // Seller pricing strategies (#94: quick/balanced/maximize) — positions in the
  // real comp band. Pure + honesty-gated: a tight/low-confidence tier yields a
  // single "Suggested" point, never a fabricated spread.
  const strategies =
    suggested != null
      ? deriveStrategies({
          suggested,
          range: { min: range?.low ?? suggested, max: range?.high ?? suggested },
          tier: (log?.tier_fired as PricingTier | null) ?? "llm-only",
        })
      : [];

  // Dynamic per-product clarify options (#93) — generated only for a non-high
  // estimate we can still sharpen, and only when parsed attributes exist.
  // Best-effort: the generator returns [] on any failure, so the page never
  // blocks on it (one model call per low-confidence review render).
  const clarifyEligible =
    suggested != null && confidence != null && confidence < DEFAULT_AUTOPILOT_THRESHOLD;
  const clarifyOptions =
    clarifyEligible && parsedAttrs.success
      ? (await generateClarifyingOptions({ attributes: parsedAttrs.data })).options
      : [];

  // Disposition transparency (issue #12): the explanation derives from the
  // RUN-TIME facts (persisted status + logged confidence + the switch value
  // persisted WITH the prediction), never the live setting.
  const confidenceFellShort =
    confidence != null && confidence < DEFAULT_AUTOPILOT_THRESHOLD;
  const runAutopilotEnabled =
    typeof log?.autopilot_enabled === "boolean" ? log.autopilot_enabled : null;
  const banner = reviewDisposition({
    status: listing?.status,
    eligibilityEnabled: runAutopilotEnabled,
    confidenceFellShort,
  });

  const data: ReviewData = {
    itemId,
    reviewRevision: item.review_revision as string,
    reviewBlocked: snapshot.reviewBlocked,
    runId: (listing?.run_id as string | null) ?? null,
    photoUrls,
    identification: identification
      ? {
          label: identification.label,
          confident: identification.confident,
          reason: identification.reason ?? null,
          candidates: identification.candidates ?? [],
          evidence: identification.evidence,
        }
      : null,
    attrs: (["brand", "model", "category", "condition", "upc", "isbn"] as const).map(
      (key) => {
        const value =
          key === "condition" ? (item.condition ?? rawAttrs[key]) : rawAttrs[key];
        return { key, value: value == null ? null : String(value) };
      },
    ),
    specs: parsedAttrs.success ? (parsedAttrs.data.specs ?? []) : [],
    listing: listing
      ? {
          id: listing.id as string,
          platform: listing.platform as string,
          title: (listing.title as string | null) ?? "Untitled",
          description: (listing.description as string | null) ?? "",
          status: listing.status as string | null,
          ebayListingId: (listing.ebay_listing_id as string | null) ?? null,
          ebayStatus: (listing.ebay_status as string | null) ?? null,
        }
      : null,
    suggested,
    override,
    displayPrice,
    costBasis,
    measurements,
    range,
    confidence,
    tier: (log?.tier_fired as string | null) ?? null,
    sources,
    strategies,
    clarifyOptions,
    banner,
    actionError: actionError ?? null,
  };

  return (
    <>
      {/* Consume the pending-upload draft ONLY when we arrived from a fresh upload
          (the action redirects to /review/:id?new=1). Gating on that signal is
          essential: this page is also opened for EXISTING items, and clearing
          unconditionally would wipe a half-built upload draft a seller left on
          /upload (Codex). With the flag, a successful upload still can't leave
          photos behind to be resubmitted as a duplicate. */}
      {fromUpload ? <ConsumeUploadDraft /> : null}
      <ReviewView
        data={data}
        saveAction={saveReview}
        sharpenAction={sharpenEstimate}
        regenerateAction={regenerateCorrectedIdentity}
      />
    </>
  );
}
