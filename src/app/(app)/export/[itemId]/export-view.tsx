import Link from "next/link";
import { Banner } from "@/components/ui/banner";
import type { ExportPacksView, ExportPackView } from "@/lib/export";
import { CopyButton } from "./copy-button";

/**
 * Export — "the item is the hero" pass (ui-lifecycle-revamp). Extracted from
 * the server page into a presentational view (matching review/publish/dashboard)
 * so it renders in the dev preview harness too. The screen now leads with a
 * compact item strip (you can see WHAT you're cross-posting), and each platform
 * gets real identity — a brand-coloured mark + a tinted header — instead of two
 * identical violet pills. The paste preview is split into title + body straight
 * from `copyBlock`, so what you see is byte-for-byte what lands on the clipboard,
 * and the how-to steps become a tinted numbered checklist beside it.
 *
 * The internal model/provenance footer is intentionally NOT rendered — it stays
 * persisted server-side for the eval harness, but it's developer jargon, not
 * something a seller should see.
 */

export interface ExportData {
  itemId: string;
  /** Composed product name (brand + model, or category) for the item strip. */
  itemName: string;
  /** Signed thumbnail URL, or null when no photo is available. */
  itemThumb: string | null;
  condition: string | null;
  price: number | null;
  packs: ExportPacksView | null;
  error: string | null;
}

interface PlatformConfig {
  name: string;
  note: string;
  /** Brand mark glyph (single letter). */
  glyph: string;
  /** Brand hex — the mark background + step-number ink. */
  accent: string;
  /** Soft brand wash for the header band + step-number background. */
  soft: string;
  steps: string[];
}

const FACEBOOK: PlatformConfig = {
  name: "Facebook Marketplace",
  note: "Casual and short, framed for local pickup.",
  glyph: "f",
  accent: "#1877f2",
  soft: "rgba(24, 119, 242, 0.10)",
  steps: [
    "Copy the pack below.",
    "In the Facebook app: Marketplace → Sell → Item.",
    "Add your photos from your camera roll (photos can't ride the clipboard).",
    "Paste (first line is the title, the rest is the description) and set the price.",
  ],
};

const MERCARI: PlatformConfig = {
  name: "Mercari",
  note: "Short title, shipping-oriented description, hashtags.",
  glyph: "m",
  accent: "#e0312f",
  soft: "rgba(224, 49, 47, 0.10)",
  steps: [
    "Copy the pack below.",
    "In the Mercari app: Sell → take or add your photos.",
    "Paste the title and description, then set the price and shipping.",
  ],
};

/** Dash-accented small-caps eyebrow — the marketing surfaces' non-pill label. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-faint">
      <span aria-hidden className="h-[2px] w-6 rounded-full bg-accent" />
      {children}
    </span>
  );
}

function PlatformMark({ config }: { config: PlatformConfig }) {
  return (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-xl font-display text-[17px] font-bold lowercase text-white"
      style={{ backgroundColor: config.accent }}
    >
      {config.glyph}
    </span>
  );
}

function PackCard({
  config,
  pack,
}: {
  config: PlatformConfig;
  pack: ExportPackView;
}) {
  // The on-screen preview IS the clipboard payload, split for hierarchy:
  // first line = title, the rest = body (kept verbatim, newlines preserved).
  const [titleLine, ...rest] = pack.copyBlock.split("\n");
  const body = rest.join("\n").replace(/^\n+/, "").trimEnd();

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-xs">
      {/* platform identity header — brand-washed band, brand mark, copy CTA */}
      <header
        className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5"
        style={{ backgroundColor: config.soft }}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <PlatformMark config={config} />
          <div className="min-w-0">
            <p className="truncate text-[14.5px] font-semibold leading-tight text-fg-strong">
              {config.name}
            </p>
            <p className="truncate text-[12px] text-muted">{config.note}</p>
          </div>
        </div>
        <CopyButton text={pack.copyBlock} label={`Copy the ${config.name} pack`} />
      </header>

      {/* body: paste preview (faithful to clipboard) + tinted step checklist */}
      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,210px)] sm:p-5">
        <div className="rounded-xl border border-border bg-surface-2/50 p-4">
          <p className="text-[15.5px] font-semibold leading-snug text-fg-strong break-words">
            {titleLine}
          </p>
          {body ? (
            <p className="mt-2.5 whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-fg">
              {body}
            </p>
          ) : null}
        </div>

        <ol className="flex flex-col gap-2.5">
          {config.steps.map((step, i) => (
            <li key={step} className="flex items-start gap-2.5">
              <span
                aria-hidden
                className="mt-px grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold"
                style={{ backgroundColor: config.soft, color: config.accent }}
                data-nums
              >
                {i + 1}
              </span>
              <span className="text-[13px] leading-relaxed text-muted">{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function ExportView({ data }: { data: ExportData }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <header className="flex items-center gap-3">
        <Link
          href={`/review/${data.itemId}`}
          aria-label="Back to review"
          className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted shadow-xs transition-colors hover:text-fg sm:size-9"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>
        <h1 className="min-w-0 flex-1 truncate font-display text-[22px] font-bold tracking-tight text-fg-strong">
          Cross-post your listing
        </h1>
      </header>

      <p className="text-[14px] leading-relaxed text-muted">
        Facebook Marketplace and Mercari don&apos;t allow apps to post for you,
        so SnapList prepares a ready-to-paste pack for each, written in that
        platform&apos;s style, using only your verified item details
        {data.price != null ? " and your stored price" : ""}.
      </p>

      {data.error ? (
        <Banner variant="error" title="Couldn’t prepare the export packs">
          {data.error}. Reload the page to try again.
        </Banner>
      ) : data.packs ? (
        <>
          {/* item strip — what you're cross-posting, at a glance */}
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3 shadow-xs">
            {data.itemThumb ? (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL
              <img
                src={data.itemThumb}
                alt={data.itemName}
                className="size-14 shrink-0 rounded-xl border border-border object-cover"
              />
            ) : (
              <span
                aria-hidden
                className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2 text-faint"
              >
                <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
                </svg>
              </span>
            )}
            <div className="min-w-0 flex-1">
              <Eyebrow>Cross-posting</Eyebrow>
              <p className="mt-1 truncate text-[15.5px] font-bold text-fg-strong">
                {data.itemName}
              </p>
              {data.condition || data.price != null ? (
                <p className="text-[13px] text-muted" data-nums>
                  {data.condition ?? ""}
                  {data.condition && data.price != null ? " · " : ""}
                  {data.price != null ? `$${data.price}` : ""}
                </p>
              ) : null}
            </div>
          </div>

          <PackCard config={FACEBOOK} pack={data.packs.facebook} />
          <PackCard config={MERCARI} pack={data.packs.mercari} />
        </>
      ) : null}
    </main>
  );
}
