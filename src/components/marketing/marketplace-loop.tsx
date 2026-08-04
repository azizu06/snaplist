"use client";

import Image from "next/image";
import LogoLoop, { type LogoItem } from "@/components/bits/LogoLoop";
import { DEMO_PRODUCTS_BY_SLUG, DEMO_SURFACE_ASSIGNMENTS } from "@/lib/demo-products";

const LISTINGS = DEMO_SURFACE_ASSIGNMENTS["landing-carousel"].map(
  (slug) => DEMO_PRODUCTS_BY_SLUG[slug],
);

const MARKETPLACES = [
  { name: "eBay", asset: "/marketplaces/ebay.svg" },
  { name: "Facebook Marketplace", asset: "/marketplaces/facebook-marketplace.svg" },
  { name: "Mercari", asset: "/marketplaces/mercari.svg" },
  { name: "Depop", asset: "/marketplaces/depop.svg" },
] as const;

/**
 * Existing React Bits carousel, now scoped to the v6 landing system.
 * It demonstrates the editable-draft flow without inventing prices, evidence
 * counts, marketplace publication, or a completed sale.
 */
function ListingCard({ slug, marketplace }: { slug: string; marketplace: (typeof MARKETPLACES)[number] }) {
  const product = DEMO_PRODUCTS_BY_SLUG[slug];

  return (
    <article className="mkt-loop-card">
      <div className="mkt-loop-card__image">
        <Image
          src={product.image}
          alt={product.alt}
          fill
          sizes="(max-width: 639px) 176px, 252px"
        />
      </div>
      <div className="mkt-loop-card__body">
        <p>{product.title}</p>
        <Image
          className="mkt-loop-card__marketplace-logo"
          src={marketplace.asset}
          alt={marketplace.name}
          width={88}
          height={24}
        />
      </div>
    </article>
  );
}

const LOOP_ITEMS: LogoItem[] = LISTINGS.map((product, index) => ({
  node: <ListingCard slug={product.slug} marketplace={MARKETPLACES[index % MARKETPLACES.length]} />,
  title: product.title,
  ariaLabel: `${product.title}, ${MARKETPLACES[index % MARKETPLACES.length].name} handoff example`,
}));

export function MarketplaceLoop() {
  return (
    <LogoLoop
      className="mkt-loop"
      logos={LOOP_ITEMS}
      speed={32}
      direction="left"
      logoHeight={14}
      gap={20}
      pauseOnHover={false}
      fadeOut
      fadeOutColor="#ffffff"
      ariaLabel="Examples of photos becoming editable SnapList drafts"
    />
  );
}
