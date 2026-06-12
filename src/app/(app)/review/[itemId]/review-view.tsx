import Link from "next/link";
import { StatusBadge } from "@/components/ui/badge";
import { Banner, type BannerVariant } from "@/components/ui/banner";
import { PendingButton } from "@/components/ui/button";
import {
  confidenceLabel,
  lifecycleLabel,
  tierLabel,
} from "@/lib/ui/status";

/**
 * Review — Shopify product-detail replica (issue #40 round 2; Mobbin Shopify
 * admin product-form references): back-arrow header with the item title and an
 * inline status chip, header actions (Export secondary · Publish primary),
 * then a two-column card layout — main column: Listing (title/description as
 * field-styled blocks), Media, Pricing (the override form styled as the price
 * field, with Suggested/Range/Confidence as the Cost/Profit/Margin triple);
 * sidebar: Status, Identification ("Insights" slot), Item details
 * ("Product organization" slot).
 *
 * Pure presentation — the page (and the dev preview harness) feed the data.
 */

export interface ReviewData {
  itemId: string;
  photoUrls: string[];
  identification: {
    label: string;
    confident: boolean;
    reason: string | null;
    candidates: string[];
    evidence: number;
  } | null;
  attrs: Array<{ key: string; value: string | null }>;
  listing: {
    id: string;
    platform: string;
    title: string;
    description: string;
    status: string | null;
  } | null;
  suggested: number | null;
  override: number | null;
  displayPrice: number | null;
  range: { low?: number; high?: number } | null;
  confidence: number | null;
  tier: string | null;
  banner: { variant: BannerVariant; title: string; detail: string } | null;
  actionError: string | null;
}

function FieldShell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-fg">{label}</span>
      {children}
    </label>
  );
}

export function ReviewView({
  data,
  overrideAction,
}: {
  data: ReviewData;
  overrideAction: (formData: FormData) => Promise<void>;
}) {
  const statusChip = lifecycleLabel(data.listing?.status ?? null);
  const confidenceChip = confidenceLabel(data.confidence);
  const tier = tierLabel(data.tier);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {/* ---- header: back + title + chip, actions right (Shopify) ---- */}
      <header className="flex flex-wrap items-center gap-3">
        <Link
          href="/dashboard"
          aria-label="Back to listings"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted shadow-xs transition-colors hover:text-fg"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>
        <h1 className="min-w-0 flex-1 truncate font-display text-[22px] font-bold tracking-tight text-fg-strong">
          {data.listing?.title ?? data.identification?.label ?? "Review listing"}
        </h1>
        {statusChip ? (
          <StatusBadge label={statusChip.label} tone={statusChip.tone} dot={false} />
        ) : null}
        <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
          <Link
            href={`/export/${data.itemId}`}
            className="inline-flex items-center rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-[13px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2"
          >
            Export pack
          </Link>
          {data.listing ? (
            <Link
              href={`/listings/${data.listing.id}`}
              className="inline-flex items-center rounded-lg bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover"
            >
              {data.listing.status === "published"
                ? "View on eBay"
                : "Publish to eBay"}
            </Link>
          ) : null}
        </div>
      </header>

      {data.actionError ? (
        <Banner variant="error" title="Couldn’t save that">
          {data.actionError}
        </Banner>
      ) : null}
      {data.banner ? (
        <Banner variant={data.banner.variant} title={data.banner.title}>
          {data.banner.detail}
        </Banner>
      ) : null}
      {data.identification && !data.identification.confident ? (
        <Banner variant="warning" title="Is this identification right?">
          {data.identification.reason ??
            "We couldn't identify this with certainty."}{" "}
          Check the details and price before publishing — the research is only
          as good as the identification.
        </Banner>
      ) : null}

      {/* ---- two-column card layout (Shopify product form) ---- */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_310px]">
        {/* ===== main column ===== */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* Listing card: title + description as field-styled blocks */}
          <section className="rounded-xl border border-border bg-surface p-4 shadow-xs sm:p-5">
            <div className="flex flex-col gap-4">
              <FieldShell label="Title">
                <div className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-fg">
                  {data.listing?.title ?? "—"}
                </div>
              </FieldShell>
              <FieldShell label="Description">
                <div className="min-h-28 whitespace-pre-wrap rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm leading-relaxed text-fg">
                  {data.listing?.description ?? "No listing generated."}
                </div>
              </FieldShell>
              <p className="text-xs text-faint">
                Written by SnapList from your verified item details
                {data.listing?.platform ? ` · ${data.listing.platform} format` : ""}.
              </p>
            </div>
          </section>

          {/* Media card */}
          <section className="rounded-xl border border-border bg-surface p-4 shadow-xs sm:p-5">
            <h2 className="mb-3 text-[13px] font-semibold text-fg-strong">Media</h2>
            {data.photoUrls.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {data.photoUrls.map((url, i) => (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URLs
                  <img
                    key={url}
                    src={url}
                    alt={`Item photo ${i + 1}`}
                    className={
                      i === 0
                        ? "size-36 rounded-lg border border-border object-cover"
                        : "size-[4.25rem] rounded-lg border border-border object-cover"
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">No photos.</p>
            )}
          </section>

          {/* Pricing card */}
          <section className="rounded-xl border border-border bg-surface p-4 shadow-xs sm:p-5">
            <h2 className="mb-3 text-[13px] font-semibold text-fg-strong">Pricing</h2>
            <form action={overrideAction} className="flex flex-col gap-4">
              <input type="hidden" name="itemId" value={data.itemId} />
              <div className="flex flex-wrap items-end gap-3">
                <FieldShell label={data.override != null ? "Your price" : "Price"}>
                  <div className="flex items-center rounded-lg border border-border-strong bg-surface focus-within:border-accent">
                    <span className="pl-3 text-sm text-muted">$</span>
                    <input
                      type="number"
                      name="price"
                      step="0.01"
                      min="0.01"
                      defaultValue={data.displayPrice ?? undefined}
                      placeholder={
                        data.suggested != null ? String(data.suggested) : "0.00"
                      }
                      aria-label="Price (USD)"
                      className="w-32 rounded-lg bg-transparent px-2 py-2 text-sm text-fg outline-none"
                      data-nums
                    />
                  </div>
                </FieldShell>
                <PendingButton pendingLabel="Saving…" variant="secondary" size="sm">
                  Save price
                </PendingButton>
                {data.override != null && data.suggested != null ? (
                  <span className="pb-2 text-xs text-faint" data-nums>
                    suggested ${data.suggested} — clear the field and save to
                    use it again
                  </span>
                ) : null}
              </div>

              {/* Suggested / Range / Confidence — Shopify's Cost/Profit/Margin row */}
              <div className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border bg-surface-2/60">
                <div className="px-3 py-2.5">
                  <p className="text-xs text-muted">Suggested</p>
                  <p className="mt-0.5 text-sm font-semibold text-fg-strong" data-nums>
                    {data.suggested != null ? `$${data.suggested}` : "—"}
                  </p>
                </div>
                <div className="px-3 py-2.5">
                  <p className="text-xs text-muted">Typical range</p>
                  <p className="mt-0.5 text-sm font-semibold text-fg-strong" data-nums>
                    {data.range?.low != null && data.range?.high != null
                      ? `$${data.range.low}–$${data.range.high}`
                      : "—"}
                  </p>
                </div>
                <div className="px-3 py-2.5">
                  <p className="text-xs text-muted">Confidence</p>
                  <p className="mt-0.5 text-sm font-semibold text-fg-strong" data-nums>
                    {data.confidence != null
                      ? `${Math.round(data.confidence * 100)}%`
                      : "—"}
                  </p>
                </div>
              </div>

              {confidenceChip ? (
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    label={confidenceChip.label}
                    tone={confidenceChip.tone}
                    dot={false}
                  />
                  <span className="text-xs text-muted">
                    {confidenceChip.detail}
                    {tier ? ` · based on: ${tier}` : ""}
                  </span>
                </div>
              ) : null}
            </form>
          </section>
        </div>

        {/* ===== sidebar ===== */}
        <div className="flex flex-col gap-4">
          {/* Status card */}
          <section className="rounded-xl border border-border bg-surface p-4 shadow-xs">
            <h2 className="mb-2 text-[13px] font-semibold text-fg-strong">Status</h2>
            {statusChip ? (
              <StatusBadge label={statusChip.label} tone={statusChip.tone} dot={false} />
            ) : (
              <p className="text-sm text-muted">No sale listing yet.</p>
            )}
            {data.banner ? (
              <p className="mt-2 text-xs leading-relaxed text-muted">
                {data.banner.detail}
              </p>
            ) : null}
          </section>

          {/* Identification card (the "Insights" slot) */}
          {data.identification ? (
            <section className="rounded-xl border border-border bg-surface p-4 shadow-xs">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-[13px] font-semibold text-fg-strong">
                  Identification
                </h2>
                {data.identification.confident ? (
                  <StatusBadge label="Identified" tone="success" dot={false} />
                ) : (
                  <StatusBadge label="Needs confirmation" tone="warning" dot={false} />
                )}
              </div>
              <p className="text-sm font-medium text-fg">{data.identification.label}</p>
              {data.identification.candidates.length > 0 ? (
                <p className="mt-1.5 text-xs text-muted">
                  Possible matches: {data.identification.candidates.join(", ")}
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-faint">
                  {(data.identification.evidence * 100).toFixed(0)}% of strong
                  identifiers resolved
                </p>
              )}
            </section>
          ) : null}

          {/* Item details card (the "Product organization" slot) */}
          <section className="rounded-xl border border-border bg-surface p-4 shadow-xs">
            <h2 className="mb-3 text-[13px] font-semibold text-fg-strong">
              Item details
            </h2>
            <dl className="flex flex-col gap-2.5">
              {data.attrs.map(({ key, value }) => (
                <div key={key}>
                  <dt className="text-xs capitalize text-muted">{key}</dt>
                  <dd className="mt-0.5 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-[13px] text-fg">
                    {value ?? <span className="text-faint">— not detected</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </main>
  );
}
