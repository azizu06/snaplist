"use client";

/**
 * The persistent marketplace marquee under the hero — react-bits LogoLoop.
 * Only three destinations exist (eBay / Facebook Marketplace / Mercari), so
 * the loop earns its length honestly: brand wordmarks interleaved with
 * violet capability chips (what each destination gets) and neutral category
 * chips (what people sell) — ~15 distinct items instead of 3 logos on repeat.
 */

import LogoLoop, { type LogoItem } from "@/components/bits/LogoLoop";

function Wordmark({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-display text-[22px] font-bold tracking-tight">
      {children}
    </span>
  );
}

function CapabilityChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-iris/25 bg-iris/8 px-3.5 py-1.5 text-[12px] font-semibold tracking-wide text-iris">
      {children}
    </span>
  );
}

function CategoryChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-line px-3.5 py-1.5 text-[12px] font-medium text-flash-faint">
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
  { node: <CapabilityChip>publishes directly</CapabilityChip> },
  { node: <CategoryChip>film cameras</CategoryChip> },
  { node: <CapabilityChip>cited prices</CapabilityChip> },
  {
    node: (
      <Wordmark>
        <span style={{ color: "#1877f2" }}>facebook</span>{" "}
        <span className="font-semibold text-flash-dim">Marketplace</span>
      </Wordmark>
    ),
    title: "Facebook Marketplace",
    ariaLabel: "Facebook Marketplace",
  },
  { node: <CapabilityChip>copy-paste pack</CapabilityChip> },
  { node: <CategoryChip>textbooks</CategoryChip> },
  { node: <CapabilityChip>~30s to a draft</CapabilityChip> },
  {
    node: (
      <Wordmark>
        <span style={{ color: "#ff0211" }}>mercari</span>
      </Wordmark>
    ),
    title: "Mercari",
    ariaLabel: "Mercari",
  },
  { node: <CapabilityChip>hashtag-ready copy</CapabilityChip> },
  { node: <CategoryChip>sneakers</CategoryChip> },
  { node: <CapabilityChip>autopilot publishing</CapabilityChip> },
  { node: <CategoryChip>vinyl records</CategoryChip> },
  { node: <CapabilityChip>barcode &amp; ISBN reads</CapabilityChip> },
  { node: <CategoryChip>board games</CategoryChip> },
];

export function MarketplaceLoop() {
  return (
    <LogoLoop
      logos={LOGOS}
      speed={48}
      direction="left"
      logoHeight={24}
      gap={56}
      pauseOnHover
      fadeOut
      fadeOutColor="#ffffff"
      ariaLabel="Marketplaces SnapList publishes to"
    />
  );
}
