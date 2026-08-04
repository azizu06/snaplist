"use client";

import MagicBento, { type BentoCardData } from "@/components/bits/MagicBento";
import { MARKETING_BENTO_CARDS } from "@/lib/marketing/site";

const cards: BentoCardData[] = MARKETING_BENTO_CARDS.map((card) => ({
  ...card,
  tint: "blue",
}));

/** Vendored React Bits grid, animated only when motion is allowed. */
export function MarketingBento() {
  return (
    <MagicBento
      className="mkt-bento"
      cards={cards}
      enableBorderGlow
      enableSpotlight
      enableStars={false}
      enableTilt
      clickEffect={false}
      enableMagnetism={false}
      glowColor="54, 101, 243"
    />
  );
}
