import Link from "next/link";
import { Banner } from "@/components/ui/banner";
import type { DepopPackView, ExportPacksView } from "@/lib/export";
import { CopyButton } from "./copy-button";

/**
 * Export — Shopify section-card composition (redesign/export, neutral + green).
 *
 * There's no exact Shopify analog for "copy-paste blocks", so the screen borrows
 * two patterns from the reference set and fuses them:
 *   - the product/collection EDIT cards (`Shopify web Jan 2024/325` + `331`):
 *     each pack is a quiet white section card — hairline border, one soft
 *     shadow, a titled header row with the section identity on the LEFT and the
 *     primary action top-RIGHT (where Shopify parks Edit/Save). Here that action
 *     is Copy, so the satisfying affordance sits exactly where the eye expects
 *     the verb.
 *   - the receipt/summary block (`Shopify web Jan 2024/600`): the paste preview
 *     is a calm inset "what lands on the clipboard" panel — a boxed title (the
 *     receipt's emphasized TOTAL) over the body, byte-for-byte from `copyBlock`,
 *     newlines preserved. Mercari's hashtags surface as discreet chips.
 *
 * Palette is the locked neutral + green (ui-design-principles + minimalist-ui):
 * NO raw platform brand hex (the old #1877f2 / #e0312f marks violated the
 * token-only rule and pulled two loud colours onto a calm screen). Platform
 * identity now reads through the NAME + a neutral monogram mark; the green
 * accent is reserved for the Copy affordance and the numbered steps, so it never
 * competes with the emerald "Live" status. 4-pt spacing, one radius scale, no
 * gradients/glows. Panels are plain (no cursor-spotlight), matching the review
 * sibling, and the CopyButton micro-interaction stays.
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
  /** Neutral monogram mark glyph (single letter). */
  glyph: string;
  steps: string[];
  /**
   * Does this platform have a TITLE field? When false the paste preview drops
   * the emphasized title band and renders the block as one body — showing a
   * title band for a form with no title field would tell the seller to fill in
   * something that isn't there (issue #378, Depop).
   */
  titled: boolean;
}

const FACEBOOK: PlatformConfig = {
  name: "Facebook Marketplace",
  note: "Casual and short, framed for local pickup.",
  glyph: "f",
  steps: [
    "Copy the pack below.",
    "In the Facebook app: Marketplace → Sell → Item.",
    "Add your photos from your camera roll (photos can't ride the clipboard).",
    "Paste — the first line is the title, the rest is the description — then set the price.",
  ],
  titled: true,
};

const MERCARI: PlatformConfig = {
  name: "Mercari",
  note: "Short title, shipping-oriented description, hashtags.",
  glyph: "m",
  steps: [
    "Copy the pack below.",
    "In the Mercari app: Sell → take or add your photos.",
    "Paste the title and description, then set the price and shipping.",
  ],
  titled: true,
};

const DEPOP: PlatformConfig = {
  name: "Depop",
  // Depop's form has no title field at all, and its search weights the opening
  // words of the description — so the pack leads with the item name and ends
  // with hashtags (issue #378).
  note: "No title field — description leads with the item name, then hashtags.",
  glyph: "d",
  steps: [
    "Copy the pack below.",
    "In the Depop app: Sell → add your photos.",
    "Paste the whole block into Description — Depop has no separate title.",
    "Set the price, condition, and category yourself.",
  ],
  titled: false,
};

/** Quiet Shopify panel chrome: hairline border, surface fill, one soft shadow. */
const APP_CARD_CHROME = "rounded-xl border border-border bg-surface shadow-xs";

/**
 * Plain content panel (replaced the react-bits SpotlightCard — the cursor glow
 * read as distracting). Same chrome, no hover effect.
 */
function Card({
  chromeClassName = APP_CARD_CHROME,
  className,
  children,
}: {
  chromeClassName?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={`${chromeClassName} ${className ?? ""}`}>{children}</div>;
}

/** Dash-accented small-caps eyebrow — the marketing surfaces' non-pill label. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-faint">
      <span aria-hidden className="h-[2px] w-6 rounded-full bg-accent" />
      {children}
    </span>
  );
}

/** Neutral monogram mark — platform identity without a loud brand colour. */
function PlatformMark({ config }: { config: PlatformConfig }) {
  return (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-surface-2 font-display text-[17px] font-bold lowercase text-fg-strong"
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
  /**
   * `DepopPackView` is the structural subset (no `title`), so this accepts a
   * titled platform's view too — the card only ever reads `copyBlock` and
   * `hashtags`.
   */
  pack: DepopPackView;
}) {
  // The on-screen preview IS the clipboard payload. On a titled platform it
  // splits for hierarchy — first line = title, the rest = body — but on an
  // untitled one the whole block IS the description, so it renders as one body
  // and no title band is drawn.
  const [firstLine, ...rest] = pack.copyBlock.split("\n");
  const titleLine = config.titled ? firstLine : null;
  const body = config.titled
    ? rest.join("\n").replace(/^\n+/, "").trimEnd()
    : pack.copyBlock.trimEnd();
  const labelId = `pack-${config.glyph}`;

  return (
    <Card
      className="flex flex-col"
      chromeClassName={`overflow-hidden ${APP_CARD_CHROME}`}
    >
      {/* platform identity header — neutral mark + name on the left, the Copy
          action top-right (Shopify Edit/Save placement, 325/331). On mobile the
          inline Copy hides in favour of the full-width foot button. */}
      <header
        aria-labelledby={labelId}
        className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <PlatformMark config={config} />
          <div className="min-w-0">
            <p id={labelId} className="truncate text-[14.5px] font-semibold leading-tight text-fg-strong">
              {config.name}
            </p>
            <p className="truncate text-[12px] text-muted">{config.note}</p>
          </div>
        </div>
        <div className="hidden sm:block">
          <CopyButton text={pack.copyBlock} label={`Copy the ${config.name} pack`} />
        </div>
      </header>

      {/* body: receipt-style paste preview (faithful to clipboard) + steps */}
      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,210px)] sm:p-5">
        <div className="rounded-xl border border-border bg-surface-2/60">
          {/* boxed title — the receipt's emphasized TOTAL band (600). Omitted
              entirely on a platform with no title field. */}
          {titleLine !== null ? (
            <p className="border-b border-border px-4 py-3 text-[15.5px] font-semibold leading-snug text-fg-strong break-words">
              {titleLine}
            </p>
          ) : null}
          {body ? (
            <p className="whitespace-pre-wrap break-words px-4 py-3 text-[14.5px] leading-relaxed text-fg">
              {body}
            </p>
          ) : null}
          {pack.hashtags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-3">
              {pack.hashtags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md bg-brand-soft px-2 py-0.5 text-[12px] font-medium text-accent-soft-fg"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <ol className="flex flex-col gap-2.5">
          {config.steps.map((step, i) => (
            <li key={step} className="flex items-start gap-2.5">
              <span
                aria-hidden
                className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-soft-fg"
                data-nums
              >
                {i + 1}
              </span>
              <span className="text-[13px] leading-relaxed text-muted">{step}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* full-width Copy for thumb reach — the satisfying affordance on mobile */}
      <div className="border-t border-border p-4 sm:hidden">
        <CopyButton
          text={pack.copyBlock}
          label={`Copy the ${config.name} pack`}
          fullWidth
        />
      </div>
    </Card>
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
        Facebook Marketplace, Mercari, and Depop don&apos;t allow apps to post
        for you, so SnapList prepares a ready-to-paste pack for each, written in
        that platform&apos;s style, using only your verified item details
        {data.price != null ? " and your stored price" : ""}.
      </p>

      {data.error ? (
        <Banner variant="error" title="Couldn’t prepare the export packs">
          {data.error}. Reload the page to try again.
        </Banner>
      ) : data.packs ? (
        <>
          {/* item strip — what you're cross-posting, at a glance */}
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-xs">
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
          <PackCard config={DEPOP} pack={data.packs.depop} />
        </>
      ) : null}
    </main>
  );
}
