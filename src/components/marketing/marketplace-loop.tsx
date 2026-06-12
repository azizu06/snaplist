"use client";

/**
 * The persistent marketplace marquee under the hero — react-bits LogoLoop.
 * Companies only: the three destinations SnapList actually publishes to
 * (eBay / Facebook Marketplace / Mercari), each exactly once in the source
 * array — the loop itself handles repetition. Wordmarks are rendered at a
 * comfortable size with a generous gap so three items never feel cramped,
 * and LogoLoop snaps its transform to whole pixels so the text stays sharp.
 */

import LogoLoop, { type LogoItem } from "@/components/bits/LogoLoop";

/** Uniform wordmark treatment — same family, weight and size for all three;
 *  only the official brand colors differ. */
function Wordmark({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-display text-[26px] font-bold leading-none tracking-tight antialiased">
      {children}
    </span>
  );
}

const LOGOS: LogoItem[] = [
  {
    node: (
      <Wordmark>
        <span style={{ color: "#e53238" }}>e</span>
        <span style={{ color: "#0064d2" }}>b</span>
        <span style={{ color: "#f5af02" }}>a</span>
        <span style={{ color: "#86b817" }}>y</span>
      </Wordmark>
    ),
    title: "eBay",
    ariaLabel: "eBay",
  },
  {
    node: (
      <Wordmark>
        <span style={{ color: "#1877f2" }}>facebook</span>{" "}
        <span className="text-flash-dim">Marketplace</span>
      </Wordmark>
    ),
    title: "Facebook Marketplace",
    ariaLabel: "Facebook Marketplace",
  },
  {
    node: (
      <Wordmark>
        <span style={{ color: "#ff0211" }}>mercari</span>
      </Wordmark>
    ),
    title: "Mercari",
    ariaLabel: "Mercari",
  },
];

export function MarketplaceLoop() {
  return (
    <LogoLoop
      logos={LOGOS}
      speed={36}
      direction="left"
      logoHeight={26}
      gap={140}
      pauseOnHover
      fadeOut
      fadeOutColor="#ffffff"
      ariaLabel="Marketplaces SnapList publishes to"
    />
  );
}
