"use client";

/**
 * The persistent band under the hero — react-bits LogoLoop, repurposed from
 * a wordmark marquee into a stream of *finished listings*: what SnapList
 * actually produces. Each card pairs a verified catalog photo with its real
 * title and price (src/lib/demo-products — never relabel), plus the
 * marketplace it ships to and the confidence chip the pipeline would show.
 * Confidence tints come from the status palette (emerald = autopilot-high,
 * blue = solid comps, amber = queued for review) so the chips MEAN the same
 * thing here as in the app.
 *
 * Text stays crisp because LogoLoop snaps its track transform to whole CSS
 * pixels (the LogoLoop fix); nothing inside a card transforms on hover —
 * hovering only pauses the drift.
 *
 * Product pool note: the landing page owns camera/book/sneakers/keyboard/
 * chess/headphones. The keyboard headlines the "one photo, three
 * storefronts" section, so this loop runs the other five — no product
 * repeats anywhere on the page.
 */

import Image from "next/image";
import LogoLoop, { type LogoItem } from "@/components/bits/LogoLoop";
import { DEMO_PRODUCTS_BY_SLUG } from "@/lib/demo-products";

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

const LISTINGS: LoopListing[] = [
  {
    slug: "camera",
    marketplace: "eBay",
    confidence: "Priced from recent sales · 92% sure",
    tone: "high",
  },
  {
    slug: "book",
    marketplace: "eBay",
    confidence: "ISBN match · 97% sure",
    tone: "high",
  },
  {
    slug: "sneakers",
    marketplace: "Mercari",
    confidence: "Priced from recent sales · 87% sure",
    tone: "solid",
  },
  {
    slug: "chess",
    marketplace: "Facebook",
    confidence: "Waiting for your review",
    tone: "review",
  },
  {
    slug: "headphones",
    marketplace: "Mercari",
    confidence: "Priced from recent sales · 89% sure",
    tone: "solid",
  },
];

const TONE_CLASSES: Record<LoopListing["tone"], string> = {
  high: "bg-success-soft text-success-soft-fg",
  solid: "bg-info-soft text-info-soft-fg",
  review: "bg-warning-soft text-warning-soft-fg",
};

/** Brand-colored lowercase wordmark — shared by the loop cards and the
 *  storefront trio so both surfaces speak one marketplace language. */
export function MarketplaceBadge({
  marketplace,
  className = "text-[11px]",
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
 *  view. Nothing inside transforms on hover; the loop just pauses. */
function ListingCard({ listing }: { listing: LoopListing }) {
  const product = DEMO_PRODUCTS_BY_SLUG[listing.slug];
  return (
    <article className="w-[300px] overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
      <div className="relative h-[170px] border-b border-line">
        <Image
          src={product.image}
          alt={product.alt}
          fill
          sizes="300px"
          className="object-cover"
        />
        <span className="absolute right-2.5 top-2.5 rounded-md bg-night/85 px-2 py-1 text-[11px] font-semibold text-flash backdrop-blur">
          {product.condition}
        </span>
      </div>
      <div className="p-4">
        <p className="truncate text-[13.5px] font-semibold leading-snug text-flash">
          {product.title}
        </p>
        <div className="mt-2 flex items-center gap-2.5">
          <span className="nums text-[16px] font-bold leading-none text-flash">
            ${product.price}
          </span>
          <span aria-hidden className="text-line-2">
            ·
          </span>
          <MarketplaceBadge marketplace={listing.marketplace} className="text-[12px]" />
        </div>
        <span
          className={`mt-3 inline-block rounded-full px-2.5 py-1 text-[11.5px] font-semibold leading-none ${TONE_CLASSES[listing.tone]}`}
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
  ariaLabel: `${DEMO_PRODUCTS_BY_SLUG[listing.slug].title} — $${
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
      speed={32}
      direction="left"
      logoHeight={14}
      gap={24}
      pauseOnHover
      fadeOut
      // The fade gradient must match whatever the band sits on — the canvas
      // token, not a hardcoded white, so the dark theme flips it for free.
      fadeOutColor="var(--color-night)"
      ariaLabel="Listings SnapList produced from one photo each"
    />
  );
}
