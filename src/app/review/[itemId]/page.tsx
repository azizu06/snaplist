import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { extractedAttributesSchema, identificationSchema } from "@/lib/pipeline/types";
import { effectivePrice } from "@/lib/pipeline";
import { getAutopilotEnabled } from "@/lib/settings/user-settings";
import { deriveIdentification } from "@/lib/vision";
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
 * This closes the loop the issue requires: "identification surfaced before pricing".
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

  // Master autopilot switch — shown so the queue/auto-post status is explainable.
  const autopilotEnabled = await getAutopilotEnabled(supabase, user.id);

  const { data: listing } = await supabase
    .from("listings")
    .select("platform, title, description, copy, status")
    .eq("item_id", itemId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: log } = await supabase
    .from("prediction_logs")
    .select("price, price_range, confidence, tier_fired, model")
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
  // identification: it carries the model's actual decision, including a model-signalled
  // ambiguity (and its reason/candidates) that a strong attribute set would otherwise
  // mask. Only fall back to re-deriving from the validated attributes for legacy/stub
  // rows that have no persisted identification (issue #27).
  const persistedId = identificationSchema.safeParse(item.identification);
  const parsedAttrs = extractedAttributesSchema.safeParse(item.attributes ?? {});
  const identification = persistedId.success
    ? persistedId.data
    : parsedAttrs.success
      ? deriveIdentification(parsedAttrs.data, {})
      : null;

  const range = (log?.price_range ?? null) as { low?: number; high?: number } | null;
  const confidence = typeof log?.confidence === "number" ? log.confidence : null;
  const band = confidence == null ? null : confidence >= 0.75 ? "high" : confidence >= 0.5 ? "medium" : "low";

  // Seller price override (issue #12): the persisted override wins over the
  // suggestion for EVERY consumer of the price; here it drives the displayed price.
  const suggested = log?.price != null ? Number(log.price) : null;
  const override = item.price_override != null ? Number(item.price_override) : null;
  const displayPrice =
    suggested != null ? effectivePrice(suggested, override) : override;

  // Disposition transparency (issue #12): a queued listing was confidence-gated
  // into the auto-post path; a draft is awaiting review — either because the
  // confidence fell short or because autopilot is off entirely.
  const queuedForAutopost = listing?.status === "queued";

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Review listing</h1>
        <Link
          href="/upload"
          className="text-sm text-zinc-500 underline hover:text-zinc-800"
        >
          New listing
        </Link>
      </header>

      {actionError ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {actionError}
        </p>
      ) : null}

      {listing ? (
        <section
          className={
            queuedForAutopost
              ? "rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3"
              : "rounded-md border border-amber-200 bg-amber-50 px-4 py-3"
          }
        >
          <p
            className={
              queuedForAutopost
                ? "text-sm font-medium text-emerald-800"
                : "text-sm font-medium text-amber-800"
            }
          >
            {queuedForAutopost
              ? "Queued for auto-posting"
              : "Queued for your review"}
          </p>
          <p
            className={
              queuedForAutopost
                ? "mt-0.5 text-xs text-emerald-700"
                : "mt-0.5 text-xs text-amber-700"
            }
          >
            {queuedForAutopost
              ? "High confidence and autopilot is on — this listing is eligible to post without manual approval."
              : autopilotEnabled
                ? "Confidence is below the autopilot threshold, so this listing waits for you."
                : "Autopilot is off — every listing waits for your approval."}
          </p>
        </section>
      ) : null}

      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL, not a static asset; next/image optimization isn't wanted here
        <img
          src={photoUrl}
          alt="Uploaded item"
          className="max-h-64 w-auto self-start rounded-md border border-zinc-200 object-contain"
        />
      ) : null}

      {identification ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
            What we think it is
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-lg font-semibold">{identification.label}</span>
            {identification.confident ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                identified
              </span>
            ) : (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                needs confirmation
              </span>
            )}
          </div>
          {!identification.confident && identification.reason ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {identification.reason} Please confirm or correct before pricing.
            </p>
          ) : null}
          {identification.candidates && identification.candidates.length > 0 ? (
            <p className="text-sm text-zinc-500">
              Possible matches: {identification.candidates.join(", ")}
            </p>
          ) : (
            <p className="text-xs text-zinc-400">
              Identification confidence: {(identification.evidence * 100).toFixed(0)}%
              of strong identifiers resolved
            </p>
          )}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
          Attributes
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {(["brand", "model", "category", "condition", "upc", "isbn"] as const).map(
            (k) => {
              const value = k === "condition" ? (item.condition ?? attrs[k]) : attrs[k];
              if (value == null) return null;
              return (
                <div key={k} className="contents">
                  <dt className="text-zinc-500 capitalize">{k}</dt>
                  <dd className="font-medium">{String(value)}</dd>
                </div>
              );
            },
          )}
        </dl>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
          Price{override != null ? " (your override)" : " recommendation"}
        </h2>
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-semibold">
            {displayPrice != null ? `$${displayPrice}` : "—"}
          </span>
          {override != null && suggested != null ? (
            <span className="text-sm text-zinc-400 line-through">
              suggested ${suggested}
            </span>
          ) : null}
          {range?.low != null && range?.high != null ? (
            <span className="text-sm text-zinc-500">
              range ${range.low}–${range.high}
            </span>
          ) : null}
        </div>
        <form
          action={overridePrice}
          className="mt-1 flex items-center gap-2"
        >
          <input type="hidden" name="itemId" value={itemId} />
          <input
            type="number"
            name="price"
            step="0.01"
            min="0.01"
            defaultValue={override ?? undefined}
            placeholder={suggested != null ? String(suggested) : "0.00"}
            aria-label="Override price (USD)"
            className="w-32 rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700"
          >
            {override != null ? "Update price" : "Set my price"}
          </button>
          {override != null ? (
            <span className="text-xs text-zinc-400">
              leave blank and save to use the suggestion again
            </span>
          ) : null}
        </form>
        <div className="flex items-center gap-2 text-sm">
          {band ? (
            <span
              className={
                band === "high"
                  ? "rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700"
                  : band === "medium"
                    ? "rounded-full bg-amber-100 px-2 py-0.5 text-amber-700"
                    : "rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-600"
              }
            >
              {band} confidence ({(confidence! * 100).toFixed(0)}%)
            </span>
          ) : null}
          {log?.tier_fired ? (
            <span className="text-zinc-400">tier: {log.tier_fired}</span>
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
          Generated listing{listing?.platform ? ` · ${listing.platform}` : ""}
        </h2>
        {listing ? (
          <article className="rounded-md border border-zinc-200 p-4">
            <h3 className="font-medium">{listing.title}</h3>
            <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-600">
              {listing.description}
            </p>
            <p className="mt-3 text-xs text-zinc-400">status: {listing.status}</p>
          </article>
        ) : (
          <p className="text-sm text-zinc-500">No listing generated.</p>
        )}
      </section>

      {log?.model ? (
        <p className="text-xs text-zinc-400">
          Logged for evaluation · model: {log.model}
        </p>
      ) : null}
    </main>
  );
}
