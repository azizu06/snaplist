import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { extractedAttributesSchema, identificationSchema } from "@/lib/pipeline/types";
import { effectivePrice } from "@/lib/pipeline";
import { DEFAULT_AUTOPILOT_THRESHOLD } from "@/lib/confidence/confidence";
import { deriveIdentification } from "@/lib/vision";
import { overridePrice } from "./actions";
import { ReviewView, type ReviewData } from "./review-view";

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
  searchParams: Promise<{ error?: string }>;
}) {
  const { itemId } = await params;
  const { error: actionError } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/review/${itemId}`);

  // RLS scopes these to the owner. A non-owner / missing id returns no row → 404.
  const { data: item } = await supabase
    .from("items")
    .select("id, photos, attributes, condition, identification, price_override, created_at")
    .eq("id", itemId)
    .single();
  if (!item) notFound();

  // This page reviews the SALE listing. Export packs (#15) persist as
  // 'facebook'/'mercari' listings rows for the same item, so pin the platform
  // or the newest export pack would shadow the eBay draft here.
  const { data: listing } = await supabase
    .from("listings")
    .select("id, platform, title, description, copy, status")
    .eq("item_id", itemId)
    .eq("platform", "ebay")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: log } = await supabase
    .from("prediction_logs")
    .select(
      "price, price_range, confidence, tier_fired, model, autopilot_enabled, autopilot_eligible",
    )
    .eq("item_id", itemId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Short-lived signed URLs for ALL the item's private photos (media card).
  let photoUrls: string[] = [];
  const photoPaths = (item.photos as string[] | null) ?? [];
  if (photoPaths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("photos")
      .createSignedUrls(photoPaths, 60 * 10);
    photoUrls = (signed ?? [])
      .map((entry) => entry.signedUrl)
      .filter((url): url is string => Boolean(url));
  }

  const rawAttrs = (item.attributes ?? {}) as Record<string, unknown>;

  // "What we think it is" — prefer the PERSISTED identification (issue #27).
  const persistedId = identificationSchema.safeParse(item.identification);
  const parsedAttrs = extractedAttributesSchema.safeParse(item.attributes ?? {});
  const identification = persistedId.success
    ? persistedId.data
    : parsedAttrs.success
      ? deriveIdentification(parsedAttrs.data, {})
      : null;

  const range = (log?.price_range ?? null) as { low?: number; high?: number } | null;
  const confidence = typeof log?.confidence === "number" ? log.confidence : null;

  // Seller price override (issue #12): the persisted override wins everywhere.
  const suggested = log?.price != null ? Number(log.price) : null;
  const override = item.price_override != null ? Number(item.price_override) : null;
  const displayPrice =
    suggested != null ? effectivePrice(suggested, override) : override;

  // Disposition transparency (issue #12): the explanation derives from the
  // RUN-TIME facts (persisted status + logged confidence + the switch value
  // persisted WITH the prediction), never the live setting.
  const confidenceFellShort =
    confidence != null && confidence < DEFAULT_AUTOPILOT_THRESHOLD;
  const runAutopilotEnabled =
    typeof log?.autopilot_enabled === "boolean" ? log.autopilot_enabled : null;
  const banner = (() => {
    switch (listing?.status) {
      case "queued":
        return {
          variant: "success" as const,
          title: "Queued — autopilot will post",
          detail:
            "High confidence and autopilot was on — this listing is eligible to post without manual approval.",
        };
      case "draft":
        return {
          variant: "warning" as const,
          title: "Waiting for your review",
          detail:
            runAutopilotEnabled === false
              ? "Autopilot was off when this listing was generated, so it waits for you."
              : confidenceFellShort
                ? "Confidence was below the autopilot threshold when this listing was generated, so it waits for you."
                : "Autopilot didn't auto-post this listing — it waits for your approval.",
        };
      case "published":
        return {
          variant: "success" as const,
          title: "Live",
          detail: "This listing is live on the marketplace.",
        };
      case "failed":
        return {
          variant: "error" as const,
          title: "Publish failed",
          detail:
            "The marketplace rejected or errored on this listing — review it and retry from the publish page.",
        };
      default:
        return null;
    }
  })();

  const data: ReviewData = {
    itemId,
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
    listing: listing
      ? {
          id: listing.id as string,
          platform: listing.platform as string,
          title: (listing.title as string | null) ?? "Untitled",
          description: (listing.description as string | null) ?? "",
          status: listing.status as string | null,
        }
      : null,
    suggested,
    override,
    displayPrice,
    range,
    confidence,
    tier: (log?.tier_fired as string | null) ?? null,
    banner,
    actionError: actionError ?? null,
  };

  return <ReviewView data={data} overrideAction={overridePrice} />;
}
