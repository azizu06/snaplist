"use client";

import Image from "next/image";
import LogoLoop, { type LogoItem } from "@/components/bits/LogoLoop";
import { DEMO_PRODUCTS_BY_SLUG, DEMO_SURFACE_ASSIGNMENTS } from "@/lib/demo-products";

const LISTINGS = DEMO_SURFACE_ASSIGNMENTS["landing-carousel"].map(
  (slug) => DEMO_PRODUCTS_BY_SLUG[slug],
);

/**
 * Existing React Bits carousel, now scoped to the v6 landing system.
 * It demonstrates the editable-draft flow without inventing prices, evidence
 * counts, marketplace publication, or a completed sale.
 */
function ListingCard({ slug }: { slug: string }) {
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
        <span>Editable draft</span>
      </div>
    </article>
  );
}

const LOOP_ITEMS: LogoItem[] = LISTINGS.map((product) => ({
  node: <ListingCard slug={product.slug} />,
  title: product.title,
  ariaLabel: `${product.title}, editable draft example`,
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
