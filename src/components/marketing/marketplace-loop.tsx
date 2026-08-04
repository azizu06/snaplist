"use client";

import { useEffect, useState } from "react";
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
          width={104}
          height={22}
        />
      </div>
    </article>
  );
}

function useReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);

    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reducedMotion;
}

const LOOP_ITEMS: LogoItem[] = LISTINGS.map((product, index) => ({
  node: <ListingCard slug={product.slug} marketplace={MARKETPLACES[index % MARKETPLACES.length]} />,
  title: product.title,
  ariaLabel: `${product.title}, ${MARKETPLACES[index % MARKETPLACES.length].name} handoff example`,
}));

export function MarketplaceLoop() {
  const [paused, setPaused] = useState(false);
  const [focusPaused, setFocusPaused] = useState(false);
  const reducedMotion = useReducedMotion();

  if (reducedMotion) {
    return (
      <div className="mkt-loop mkt-loop--static" aria-label="Examples of photos becoming editable SnapList drafts">
        {LISTINGS.map((product, index) => (
          <ListingCard
            key={product.slug}
            slug={product.slug}
            marketplace={MARKETPLACES[index % MARKETPLACES.length]}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="mkt-loop__motion"
      onFocusCapture={() => setFocusPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusPaused(false);
      }}
    >
      <LogoLoop
        className="mkt-loop"
        logos={LOOP_ITEMS}
        speed={32}
        direction="left"
        logoHeight={14}
        gap={20}
        pauseOnHover
        pauseOnFocus
        paused={paused || focusPaused}
        fadeOut
        fadeOutColor="#ffffff"
        ariaLabel="Examples of photos becoming editable SnapList drafts"
      />
      <button
        className="mkt-loop__motion-control"
        type="button"
        aria-pressed={paused}
        onClick={() => setPaused((current) => !current)}
      >
        {paused ? "Play motion" : "Pause motion"}
      </button>
    </div>
  );
}
