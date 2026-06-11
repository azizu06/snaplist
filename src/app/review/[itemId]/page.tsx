import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { extractedAttributesSchema, identificationSchema } from "@/lib/pipeline/types";
import { effectivePrice } from "@/lib/pipeline";
import { DEFAULT_AUTOPILOT_THRESHOLD } from "@/lib/confidence/confidence";
import { deriveIdentification } from "@/lib/vision";
import { StatusBadge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PendingButton, buttonClasses } from "@/components/ui/button";
import { confidenceLabel, lifecycleLabel, tierLabel } from "@/lib/ui/status";
import { overridePrice } from "./actions";

/**
 * Review page — reads the persisted item + its listing + the prediction log back
 * through the USER-SCOPED server client (so RLS proves the row belongs to the
 * caller; another user's id 404s). Renders the real pipeline's output: the
 * identification ("what we think it is", surfaced BEFORE pricing for confirmation),
 * extracted attributes, price recommendation, and the generated listing copy.
 *
 * The identification is the PERSISTED one the pipeline produced (the model's actual
 * decision, including a model-signalled ambiguity with its reason/candidates), so an
 * explicitly-uncertain item is FLAGGED here rather than presented as a confident guess
 * (issues #6 + #27). Legacy/stub rows without a persisted identification fall back to
 * re-deriving it from the validated attributes.
 *
 * Issue #40: same data spine, end-user skin — Shopify-style cards + status
 * sidebar, the X-4 vocabulary for status/confidence/tier (no raw keys), and
 * pending states on both forms. Server actions and reads are unchanged.
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
  // or the newest export pack would shadow the eBay draft here. `id` feeds the
  // link to the publish page (/listings/{id}).
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

  // Short-lived signed URL for the private photo (first one).
  let photoUrl: string | null = null;
  const firstPhoto = (item.photos as string[] | null)?.[0];
  if (firstPhoto) {
    const { data: signed } = await supabase.storage
      .from("photos")
      .createSignedUrl(firstPhoto, 60 * 10);
    photoUrl = signed?.signedUrl ?? null;
  }

  const attrs = (item.attributes ?? {}) as Record<string, unknown>;

  // "What we think it is" — surfaced BEFORE pricing. Prefer the PERSISTED
  // identification (the model's actual decision, including signalled ambiguity);
  // fall back to re-deriving only for legacy/stub rows (issue #27).
  const persistedId = identificationSchema.safeParse(item.identification);
  const parsedAttrs = extractedAttributesSchema.safeParse(item.attributes ?? {});
  const identification = persistedId.success
    ? persistedId.data
    : parsedAttrs.success
      ? deriveIdentification(parsedAttrs.data, {})
      : null;

  const range = (log?.price_range ?? null) as { low?: number; high?: number } | null;
  const confidence = typeof log?.confidence === "number" ? log.confidence : null;
  const confidenceChip = confidenceLabel(confidence);
  const tier = tierLabel(log?.tier_fired as string | null | undefined);

  // Seller price override (issue #12): the persisted override wins over the
  // suggestion for EVERY consumer of the price; here it drives the displayed price.
  const suggested = log?.price != null ? Number(log.price) : null;
  const override = item.price_override != null ? Number(item.price_override) : null;
  const displayPrice =
    suggested != null ? effectivePrice(suggested, override) : override;

  // Disposition transparency (issue #12): the explanation derives from the
  // RUN-TIME facts (persisted status + logged confidence + the switch value
  // persisted WITH the prediction), never the live setting — flipping the
  // master switch later must not rewrite history about why this listing queued.
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

  const statusChip = lifecycleLabel(listing?.status ?? null);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
            Review listing
          </h1>
          {statusChip ? (
            <StatusBadge label={statusChip.label} tone={statusChip.tone} />
          ) : null}
        </div>
        <Link href="/" className="text-sm text-muted hover:text-fg">
          ← Dashboard
        </Link>
      </header>

      {actionError ? (
        <Banner variant="error" title="Couldn’t save that">
          {actionError}
        </Banner>
      ) : null}

      {banner ? (
        <Banner variant={banner.variant} title={banner.title}>
          {banner.detail}
        </Banner>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        {/* ----- main column ----- */}
        <div className="flex min-w-0 flex-col gap-5">
          {identification ? (
            <Card>
              <CardHeader
                title="What we think it is"
                aside={
                  identification.confident ? (
                    <StatusBadge label="Identified" tone="success" />
                  ) : (
                    <StatusBadge label="Needs confirmation" tone="warning" />
                  )
                }
              />
              <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start gap-4">
                  {photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL, not a static asset
                    <img
                      src={photoUrl}
                      alt="Your item"
                      className="size-24 shrink-0 rounded-xl border border-border object-cover"
                    />
                  ) : null}
                  <div className="min-w-0">
                    <p className="text-lg font-semibold text-fg-strong">
                      {identification.label}
                    </p>
                    {identification.candidates &&
                    identification.candidates.length > 0 ? (
                      <p className="mt-1 text-sm text-muted">
                        Possible matches: {identification.candidates.join(", ")}
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-faint">
                        {(identification.evidence * 100).toFixed(0)}% of strong
                        identifiers resolved
                      </p>
                    )}
                  </div>
                </div>
                {!identification.confident ? (
                  <Banner variant="warning" title="Is this right?">
                    {identification.reason ??
                      "We couldn't identify this with certainty."}{" "}
                    Check the details below and fix your price before
                    publishing — the price research is only as good as the
                    identification.
                  </Banner>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
                {(["brand", "model", "category", "condition", "upc", "isbn"] as const).map(
                  (k) => {
                    const value =
                      k === "condition" ? (item.condition ?? attrs[k]) : attrs[k];
                    return (
                      <div key={k} className="contents">
                        <dt className="capitalize text-muted">{k}</dt>
                        <dd className="font-medium text-fg">
                          {value == null ? (
                            <span className="text-faint">— not detected</span>
                          ) : (
                            String(value)
                          )}
                        </dd>
                      </div>
                    );
                  },
                )}
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={override != null ? "Price — your override" : "Price recommendation"}
              aside={tier ? <span className="text-xs text-muted">{tier}</span> : null}
            />
            <CardBody className="flex flex-col gap-4">
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-3xl font-semibold text-fg-strong" data-nums>
                  {displayPrice != null ? `$${displayPrice}` : "—"}
                </span>
                {override != null && suggested != null ? (
                  <span className="text-sm text-faint line-through" data-nums>
                    suggested ${suggested}
                  </span>
                ) : null}
                {range?.low != null && range?.high != null ? (
                  <span className="text-sm text-muted" data-nums>
                    typical range ${range.low}–${range.high}
                  </span>
                ) : null}
              </div>

              {confidenceChip ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge
                    label={confidenceChip.label}
                    tone={confidenceChip.tone}
                  />
                  <span className="text-xs text-muted">{confidenceChip.detail}</span>
                </div>
              ) : null}

              <form action={overridePrice} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="itemId" value={itemId} />
                <input
                  type="number"
                  name="price"
                  step="0.01"
                  min="0.01"
                  defaultValue={override ?? undefined}
                  placeholder={suggested != null ? String(suggested) : "0.00"}
                  aria-label="Override price (USD)"
                  className="w-32 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-fg"
                  data-nums
                />
                <PendingButton pendingLabel="Saving…" variant="secondary" size="sm">
                  {override != null ? "Update price" : "Set my price"}
                </PendingButton>
                {override != null ? (
                  <span className="text-xs text-faint">
                    leave blank and save to use the suggestion again
                  </span>
                ) : null}
              </form>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Generated listing"
              aside={
                listing?.platform ? (
                  <span className="text-xs uppercase tracking-wide text-faint">
                    {listing.platform}
                  </span>
                ) : null
              }
            />
            <CardBody>
              {listing ? (
                <article>
                  <h3 className="font-medium text-fg-strong">{listing.title}</h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted">
                    {listing.description}
                  </p>
                </article>
              ) : (
                <p className="text-sm text-muted">No listing generated.</p>
              )}
            </CardBody>
          </Card>

          {log?.model ? (
            <p className="text-xs text-faint">
              Logged for evaluation · model: {log.model}
            </p>
          ) : null}
        </div>

        {/* ----- sidebar: actions ----- */}
        <aside className="flex flex-col gap-3 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardBody className="flex flex-col gap-2.5">
              {listing && listing.platform === "ebay" ? (
                <Link
                  href={`/listings/${listing.id}`}
                  className={buttonClasses("primary")}
                >
                  {listing.status === "published"
                    ? "View publish status"
                    : "Publish to eBay"}
                </Link>
              ) : null}
              <Link
                href={`/export/${itemId}`}
                className={buttonClasses("secondary")}
              >
                Export for Facebook &amp; Mercari
              </Link>
              <Link href="/upload" className={buttonClasses("ghost")}>
                Start another listing
              </Link>
            </CardBody>
          </Card>
        </aside>
      </div>
    </main>
  );
}
