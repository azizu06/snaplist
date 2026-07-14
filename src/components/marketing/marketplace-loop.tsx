"use client";

/**
 * The persistent band under the hero — react-bits LogoLoop, repurposed from
 * a wordmark marquee into a stream of *finished listings*: what SnapList
 * actually produces. Each card pairs a verified catalog photo with its real
 * title and price (src/lib/demo-products — never relabel), plus the
 * marketplace it ships to and one uniform price-confidence chip. Owner round 7:
 * the old per-card pricing-method chips (varied wording, three colors) read as
 * confusing, so every card now shows the same chip in one color. Owner round 8:
 * a bare "{n}% match" gave no context for what was matched — the chip now reads
 * "{n}% price confidence" so it's self-explanatory while staying brief.
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
  /** A single, uniform price-confidence chip (owner: the old per-card
   *  pricing-method wording in mixed colors read as confusing, and a bare
   *  "{n}% match" gave no context). Every card now shows the same
   *  "{n}% price confidence" chip in one shared color. */
  confidence: string;
};

const MARKETPLACES: Marketplace[] = ["eBay", "Facebook", "Mercari"];

/** Stable per-slug number so a card's marketplace + confidence don't change
 *  between renders (no Math.random) but still vary product to product. */
function stableHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h + slug.charCodeAt(i) * (i + 1)) % 997;
  return h;
}

/** Derive a card's marketplace + a single uniform price-confidence chip. The
 *  percentage still varies product to product (stable per slug, no Math.random)
 *  but the wording and color are identical on every card. The label spells out
 *  "price confidence" so the number isn't a contextless "% match". */
function deriveListing(slug: string, index: number): LoopListing {
  const h = stableHash(slug);
  const marketplace = MARKETPLACES[index % MARKETPLACES.length];
  const conf = 86 + (h % 12); // 86–97% — a calm, consistent band
  return { slug, marketplace, confidence: `${conf}% price confidence` };
}

const LISTINGS: LoopListing[] =
  DEMO_SURFACE_ASSIGNMENTS["landing-carousel"].map(deriveListing);

/** One shared chip style for every card (uniform color + format). */
const CHIP_CLASS = "bg-info-soft text-info-soft-fg";

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

/** #136: phone widths intentionally show almost two cards at once. The old
 * fixed 324px card consumed nearly the whole 390px viewport and turned the
 * inventory stream into a one-card carousel. Desktop keeps the richer scale;
 * mobile trims type and spacing without losing any listing facts. */
function ListingCard({ listing }: { listing: LoopListing }) {
  const product = DEMO_PRODUCTS_BY_SLUG[listing.slug];
  return (
    <article className="w-[184px] overflow-hidden rounded-xl border border-line bg-panel shadow-card sm:w-[244px] sm:rounded-2xl lg:w-[300px]">
      {/* Square frame matches the 1:1 authentic masters, so each item shows
          in full with no over-crop (owner: the old 1.84:1 box cut items off). */}
      <div className="relative aspect-square border-b border-line">
        <Image
          src={product.image}
          alt={product.alt}
          fill
          sizes="(max-width: 639px) 184px, (max-width: 1023px) 244px, 300px"
          className="object-cover"
        />
        <span className="absolute right-2 top-2 rounded-md bg-night/85 px-1.5 py-0.5 text-[9.5px] font-semibold text-flash backdrop-blur sm:right-2.5 sm:top-2.5 sm:px-2 sm:py-1 sm:text-[11px]">
          {product.condition}
        </span>
      </div>
      <div className="p-3 sm:p-4">
        <p className="truncate text-[12.5px] font-semibold leading-snug text-flash sm:text-[14px] lg:text-[15px]">
          {product.title}
        </p>
        <div className="mt-2 flex items-center gap-1.5 sm:mt-2.5 sm:gap-2.5">
          <span className="nums text-[15px] font-bold leading-none text-flash sm:text-[17px]">
            ${product.price}
          </span>
          <span aria-hidden className="text-line-2">
            ·
          </span>
          <MarketplaceBadge marketplace={listing.marketplace} className="text-[12px] sm:text-[15px]" />
        </div>
        <span
          className={`mt-2.5 inline-block max-w-full rounded-full px-2.5 py-1 text-[10.5px] font-semibold leading-snug sm:mt-3.5 sm:px-3.5 sm:py-1.5 sm:text-[12.5px] ${CHIP_CLASS}`}
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
