"use client";

/**
 * The persistent band under the hero — react-bits LogoLoop, repurposed from
 * a wordmark marquee into a stream of *finished listings*: what SnapList
 * actually produces. Each card pairs a verified catalog photo with its real
 * title and price (src/lib/demo-products — never relabel), plus the
 * marketplace it ships to and the confidence chip the pipeline would show.
 * Confidence tints come from the status palette (emerald = autopilot-high,
 * blue = solid recent-sales data, amber = queued for review) so the chips MEAN the same
 * thing here as in the app.
 *
 * Text stays crisp because LogoLoop snaps its track transform to whole CSS
 * pixels (the LogoLoop fix); nothing inside a card transforms on hover, and
 * the drift never pauses (owner r6: it should just keep scrolling).
 *
 * Product pool note (r6): the card list is DERIVED from the
 * "landing-carousel" assignment in demo-products.ts (single source of truth),
 * tilted hard toward VISIBLY USED items — secondhand is the product's whole
 * point, so the band should look like a real closet, not a showroom. The list
 * is kept disjoint from the video clips and the scan montage so no image
 * repeats across surfaces. To add/remove a card, edit that one array; the
 * marketplace + confidence chip below are computed from each product so
 * nothing has to be hand-kept in sync.
 */

import Image from "next/image";
import LogoLoop, { type LogoItem } from "@/components/bits/LogoLoop";
import { DEMO_PRODUCTS_BY_SLUG, DEMO_SURFACE_ASSIGNMENTS } from "@/lib/demo-products";

type Marketplace = "eBay" | "Facebook" | "Mercari";

type LoopListing = {
  slug: string;
  marketplace: Marketplace;
  /** Confidence chip in plain seller language (owner round 4: "92 comps"
   *  meant nothing to anyone) — still truthful to the product's
   *  pricingStory: barcode → ISBN match, comps → recent sales,
   *  depreciation → held for review. */
  confidence: string;
  tone: "high" | "solid" | "review";
};

const MARKETPLACES: Marketplace[] = ["eBay", "Facebook", "Mercari"];

/** Stable per-slug number so a card's marketplace + confidence don't change
 *  between renders (no Math.random) but still vary product to product. */
function stableHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h + slug.charCodeAt(i) * (i + 1)) % 997;
  return h;
}

/** Derive a card's marketplace + confidence chip from the product itself, so
 *  the chip stays truthful to how the price was found (pricingStory) without
 *  any hand-maintained per-card table. */
function deriveListing(slug: string, index: number): LoopListing {
  const { pricingStory } = DEMO_PRODUCTS_BY_SLUG[slug];
  const h = stableHash(slug);
  const marketplace = MARKETPLACES[index % MARKETPLACES.length];
  if (pricingStory === "barcode") {
    return { slug, marketplace, confidence: `ISBN match · ${96 + (h % 3)}% sure`, tone: "high" };
  }
  if (pricingStory === "depreciation") {
    return {
      slug,
      marketplace,
      confidence: `Estimated from condition · ${70 + (h % 9)}% sure`,
      tone: "review",
    };
  }
  const conf = 82 + (h % 12); // comps
  return {
    slug,
    marketplace,
    confidence: `Priced from recent sales · ${conf}% sure`,
    tone: conf >= 89 ? "high" : "solid",
  };
}

const LISTINGS: LoopListing[] =
  DEMO_SURFACE_ASSIGNMENTS["landing-carousel"].map(deriveListing);

const TONE_CLASSES: Record<LoopListing["tone"], string> = {
  high: "bg-success-soft text-success-soft-fg",
  solid: "bg-info-soft text-info-soft-fg",
  review: "bg-warning-soft text-warning-soft-fg",
};

/** Brand-colored lowercase wordmark — shared by the loop cards and the
 *  storefront trio so both surfaces speak one marketplace language. */
export function MarketplaceBadge({
  marketplace,
  className = "text-[12px]",
}: {
  marketplace: Marketplace;
  className?: string;
}) {
  if (marketplace === "eBay") {
    return (
      <span className={`font-bold leading-none ${className}`}>
        <span style={{ color: "#e53238" }}>e</span>
        <span style={{ color: "#0064d2" }}>b</span>
        <span style={{ color: "#f5af02" }}>a</span>
        <span style={{ color: "#86b817" }}>y</span>
      </span>
    );
  }
  if (marketplace === "Facebook") {
    return (
      <span className={`font-bold leading-none ${className}`} style={{ color: "#1877f2" }}>
        facebook
      </span>
    );
  }
  return (
    <span className={`font-bold leading-none ${className}`} style={{ color: "#ff0211" }}>
      mercari
    </span>
  );
}

/** Round-4 sizing: real listing-card proportions — a proper photo on top
 *  (was a 56px thumb nobody could read), 13px+ body text, fewer cards per
 *  view. Round 5: wider card so the confidence chip breathes (real padding,
 *  no cramped leading-none), and the marketplace wordmark reads at a glance
 *  (15px, was 12px). Nothing inside transforms on hover. */
function ListingCard({ listing }: { listing: LoopListing }) {
  const product = DEMO_PRODUCTS_BY_SLUG[listing.slug];
  return (
    <article className="w-[324px] overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
      <div className="relative h-[176px] border-b border-line">
        <Image
          src={product.image}
          alt={product.alt}
          fill
          sizes="324px"
          className="object-cover"
        />
        <span className="absolute right-2.5 top-2.5 rounded-md bg-night/85 px-2 py-1 text-[11px] font-semibold text-flash backdrop-blur">
          {product.condition}
        </span>
      </div>
      <div className="p-4">
        <p className="truncate text-[15px] font-semibold leading-snug text-flash">
          {product.title}
        </p>
        <div className="mt-2.5 flex items-center gap-2.5">
          <span className="nums text-[17px] font-bold leading-none text-flash">
            ${product.price}
          </span>
          <span aria-hidden className="text-line-2">
            ·
          </span>
          <MarketplaceBadge marketplace={listing.marketplace} className="text-[16px]" />
        </div>
        <span
          className={`mt-3.5 inline-block max-w-full rounded-full px-3.5 py-1.5 text-[13.5px] font-semibold leading-snug ${TONE_CLASSES[listing.tone]}`}
        >
          {listing.confidence}
        </span>
      </div>
    </article>
  );
}

const LOOP_ITEMS: LogoItem[] = LISTINGS.map((listing) => ({
  node: <ListingCard listing={listing} />,
  title: DEMO_PRODUCTS_BY_SLUG[listing.slug].title,
  ariaLabel: `${DEMO_PRODUCTS_BY_SLUG[listing.slug].title}, $${
    DEMO_PRODUCTS_BY_SLUG[listing.slug].price
  } on ${listing.marketplace}`,
}));

export function MarketplaceLoop() {
  return (
    <LogoLoop
      // LogoLoop's root is overflow-x-hidden only, which computes overflow-y
      // to auto — clamp the cross axis so card shadows never spawn a stray
      // scrollbar nub. Breathing room for those shadows comes from py-2.
      className="overflow-y-hidden py-2"
      logos={LOOP_ITEMS}
      // r6: 32 → 44 px/s (owner: "a little bit" faster). NOTE: pauseOnHover
      // must be explicitly false — LogoLoop's effectiveHoverSpeed defaults
      // to 0 (pause) when the prop is merely omitted.
      speed={44}
      direction="left"
      logoHeight={14}
      gap={24}
      pauseOnHover={false}
      fadeOut
      // The fade gradient must match whatever the band sits on — the canvas
      // token, not a hardcoded white, so the dark theme flips it for free.
      fadeOutColor="var(--color-night)"
      ariaLabel="Listings SnapList produced from one photo each"
    />
  );
}
