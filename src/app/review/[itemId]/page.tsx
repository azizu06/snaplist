import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Review page — reads the persisted item + its listing + the prediction log back
 * through the USER-SCOPED server client (so RLS proves the row belongs to the
 * caller; another user's id 404s). Renders the stub pipeline's output: extracted
 * attributes, price recommendation (suggested + range + confidence band), and the
 * generated listing copy. Skeleton-level UI.
 *
 * This closes the loop the issue requires: "rendered on a review page".
 */
export default async function ReviewPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/review/${itemId}`);

  // RLS scopes these to the owner. A non-owner / missing id returns no row → 404.
  const { data: item } = await supabase
    .from("items")
    .select("id, photos, attributes, condition, created_at")
    .eq("id", itemId)
    .single();
  if (!item) notFound();

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
  const range = (log?.price_range ?? null) as { low?: number; high?: number } | null;
  const confidence = typeof log?.confidence === "number" ? log.confidence : null;
  const band = confidence == null ? null : confidence >= 0.75 ? "high" : confidence >= 0.5 ? "medium" : "low";

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

      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL, not a static asset; next/image optimization isn't wanted here
        <img
          src={photoUrl}
          alt="Uploaded item"
          className="max-h-64 w-auto self-start rounded-md border border-zinc-200 object-contain"
        />
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
          Price recommendation
        </h2>
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-semibold">
            {typeof log?.price === "number" ? `$${log.price}` : "—"}
          </span>
          {range?.low != null && range?.high != null ? (
            <span className="text-sm text-zinc-500">
              range ${range.low}–${range.high}
            </span>
          ) : null}
        </div>
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
