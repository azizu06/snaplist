import type { Metadata } from "next";
import Link from "next/link";
import { Reveal } from "@/components/marketing/reveal";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "SnapList is free while in beta — every feature, no credit card. Paid tiers arrive later with honest limits.",
};

/** /pricing (issue #49) — single live tier (beta), ghost tiers signposted. */

const INCLUDED = [
  "Unlimited photo identifications",
  "AI pricing with cited sources",
  "eBay publishing via your own account",
  "Facebook & Mercari export packs",
  "Confidence-gated autopilot",
  "Drafted buyer replies",
  "Private photo storage",
] as const;

const GHOSTS = [
  {
    name: "Seller",
    note: "For steady decluttering",
    teaser: "Volume autopilot, bulk uploads, listing analytics",
  },
  {
    name: "Power",
    note: "For flippers & resellers",
    teaser: "Multi-account, priority research, API access",
  },
] as const;

export default function Pricing() {
  return (
    <>
      <section className="aurora dotgrid relative overflow-hidden px-5 pb-16 pt-32 sm:px-8 sm:pt-40">
        <div className="mx-auto w-full max-w-6xl text-center">
          <Reveal>
            <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-volt">
              Pricing
            </p>
            <h1 className="mx-auto mt-3 max-w-2xl font-display text-[clamp(34px,5vw,56px)] font-bold leading-[1.05] tracking-tight text-flash">
              Free while we&apos;re in{" "}
              <em className="font-serif-accent font-normal italic text-volt">
                beta
              </em>
            </h1>
            <p className="mx-auto mt-5 max-w-[48ch] text-[16px] leading-relaxed text-flash-dim">
              All of it. No credit card, no listing caps, no surprise
              paywall mid-flow. You sell, we learn.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-5 pb-28 sm:px-8">
        <Reveal stagger className="grid gap-5 lg:grid-cols-[1.2fr_0.9fr_0.9fr]">
          {/* live tier */}
          <div className="relative overflow-hidden rounded-3xl border border-volt/40 bg-panel p-8 shadow-[0_0_60px_-20px] shadow-volt/30">
            <span className="absolute right-6 top-6 rounded-full bg-volt px-3 py-1 text-[10.5px] font-bold uppercase tracking-[0.1em] text-volt-ink">
              Live now
            </span>
            <h2 className="font-display text-[22px] font-bold text-flash">Beta</h2>
            <p className="mt-1 text-[13.5px] text-flash-faint">
              Everything SnapList can do today
            </p>
            <p className="nums mt-6 font-display text-[52px] font-bold leading-none tracking-tight text-flash">
              $0
              <span className="ml-1.5 text-[15px] font-medium text-flash-faint">
                / forever-while-beta
              </span>
            </p>
            <ul className="mt-7 space-y-3">
              {INCLUDED.map((line) => (
                <li key={line} className="flex items-start gap-2.5 text-[14px] text-flash-dim">
                  <svg viewBox="0 0 24 24" className="mt-0.5 size-4 shrink-0 text-volt" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  {line}
                </li>
              ))}
            </ul>
            <Link
              href="/login"
              className="group mt-8 inline-flex w-full items-center justify-center gap-2 rounded-full bg-volt px-6 py-3 text-[15px] font-semibold text-volt-ink transition-transform hover:scale-[1.02]"
            >
              Start selling free
              <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
            </Link>
          </div>

          {/* ghost tiers */}
          {GHOSTS.map(({ name, note, teaser }) => (
            <div
              key={name}
              className="flex flex-col justify-between rounded-3xl border border-dashed border-line-2/70 bg-panel/30 p-8"
            >
              <div>
                <h2 className="font-display text-[20px] font-bold text-flash-dim">
                  {name}
                </h2>
                <p className="mt-1 text-[13px] text-flash-faint">{note}</p>
                <p className="nums mt-6 font-display text-[36px] font-bold leading-none text-flash-faint">
                  —
                </p>
                <p className="mt-6 text-[13.5px] leading-relaxed text-flash-faint">
                  {teaser}
                </p>
              </div>
              <p className="mt-8 rounded-full border border-line px-4 py-2.5 text-center text-[12.5px] font-medium text-flash-faint">
                After beta — beta users keep early-bird pricing
              </p>
            </div>
          ))}
        </Reveal>

        <Reveal className="mt-14 rounded-2xl border border-line/70 bg-night-2/60 p-7 text-center">
          <p className="mx-auto max-w-[62ch] text-[14px] leading-relaxed text-flash-dim">
            The honest part: SnapList is a production-real AI engineering
            showcase. Beta is genuinely free because your usage is what makes
            the pricing engine smarter — when paid tiers land, nothing you
            already listed gets held hostage.
          </p>
        </Reveal>
      </section>
    </>
  );
}
