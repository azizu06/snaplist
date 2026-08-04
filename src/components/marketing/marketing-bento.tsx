"use client";

import type { ReactNode } from "react";
import MagicBento, { type BentoCardData } from "@/components/bits/MagicBento";
import { MARKETING_BENTO_CARDS } from "@/lib/marketing/site";

const cards: BentoCardData[] = MARKETING_BENTO_CARDS.map((card) => ({
  ...card,
  icon: <BentoIcon name={card.icon} />,
  tint: "green",
}));

type BentoIconName = (typeof MARKETING_BENTO_CARDS)[number]["icon"];

function BentoIcon({ name }: { name: BentoIconName }) {
  const shared = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
  };

  const paths: Record<BentoIconName, ReactNode> = {
    chart: <><path {...shared} d="M4 19V5m0 14h16" /><path {...shared} d="m8 15 3-3 3 2 5-6" /></>,
    mic: <><rect {...shared} x="9" y="3" width="6" height="11" rx="3" /><path {...shared} d="M6 11a6 6 0 0 0 12 0M12 17v4m-3 0h6" /></>,
    pencil: <><path {...shared} d="m14 5 5 5M5 19l3.8-.8L19 8a2.1 2.1 0 0 0-3-3L5.8 15.2z" /><path {...shared} d="M4 21h16" /></>,
    share: <><circle {...shared} cx="18" cy="5" r="2" /><circle {...shared} cx="6" cy="12" r="2" /><circle {...shared} cx="18" cy="19" r="2" /><path {...shared} d="m8 11 8-5m-8 7 8 5" /></>,
    check: <><circle {...shared} cx="12" cy="12" r="8" /><path {...shared} d="m8.5 12 2.4 2.5 4.8-5" /></>,
    trophy: <><path {...shared} d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5v1a3 3 0 0 0 3 3m8-4h3v1a3 3 0 0 1-3 3m-4 3v4m-4 2h8" /></>,
  };

  return <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">{paths[name]}</svg>;
}

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
