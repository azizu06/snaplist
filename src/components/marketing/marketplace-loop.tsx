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
  /** Short confidence chip copy, truthful to the product's pricingStory. */
  confidence: string;
  tone: "high" | "solid" | "review";
};

/** barcode → ISBN-grade confidence; comps → solid; depreciation → review. */
const LISTINGS: LoopListing[] = [
  { slug: "camera", marketplace: "eBay", confidence: "92% · comps", tone: "high" },
  { slug: "book", marketplace: "eBay", confidence: "97% · ISBN", tone: "high" },
  { slug: "sneakers", marketplace: "Mercari", confidence: "87% · comps", tone: "solid" },
  { slug: "chess", marketplace: "Facebook", confidence: "72% · review", tone: "review" },
  { slug: "headphones", marketplace: "Mercari", confidence: "89% · comps", tone: "solid" },
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

function ListingCard({ listing }: { listing: LoopListing }) {
  const product = DEMO_PRODUCTS_BY_SLUG[listing.slug];
  return (
    <article className="flex w-[320px] items-center gap-3 rounded-xl border border-line bg-panel p-3 shadow-card">
      <div className="relative size-14 shrink-0 overflow-hidden rounded-lg border border-line">
        <Image
          src={product.image}
          alt={product.alt}
          fill
          sizes="56px"
          className="object-cover"
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-semibold leading-snug text-flash">
          {product.title}
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="nums text-[13px] font-bold leading-none text-flash">
            ${product.price}
          </span>
          <span aria-hidden className="text-line-2">
            ·
          </span>
          <MarketplaceBadge marketplace={listing.marketplace} />
          <span
            className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none ${TONE_CLASSES[listing.tone]}`}
          >
            {listing.confidence}
          </span>
        </div>
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
      speed={30}
      direction="left"
      logoHeight={14}
      gap={20}
      pauseOnHover
      fadeOut
      // The fade gradient must match whatever the band sits on — the canvas
      // token, not a hardcoded white, so the dark theme flips it for free.
      fadeOutColor="var(--color-night)"
      ariaLabel="Listings SnapList produced from one photo each"
    />
  );
}
