"use client";

import MagicBento, { type BentoCardData } from "@/components/bits/MagicBento";
import { MARKETING_BENTO_CARDS } from "@/lib/marketing/site";

const cards: BentoCardData[] = MARKETING_BENTO_CARDS.map((card) => ({
  ...card,
  tint: "blue",
}));

/** Existing React Bits grid, restyled by the scoped v6 marketing tokens. */
export function MarketingBento() {
  return (
    <MagicBento
      className="mkt-bento"
      cards={cards}
      disableAnimations
      enableBorderGlow={false}
      enableSpotlight={false}
      enableStars={false}
      enableTilt={false}
      glowColor="54, 101, 243"
    />
  );
}
