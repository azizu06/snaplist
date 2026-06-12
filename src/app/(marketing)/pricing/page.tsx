import type { Metadata } from "next";
import Link from "next/link";
import ElectricBorder from "@/components/bits/ElectricBorder";
import { Reveal } from "@/components/marketing/reveal";
import { FaqAccordion } from "@/components/marketing/faq-accordion";
import { Eyebrow } from "@/components/marketing/visuals";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "SnapList is free while in beta — every feature, no credit card. Paid tiers arrive later with honest limits.",
};

/** /pricing (subpages v3) — two uniform tier cards: the live Beta tier
 * (subtle ElectricBorder marks it) and a mocked-up "Seller Pro" coming-soon
 * tier with the same height and structure so the row reads balanced, plus a
 * billing FAQ on the animated accordion. */

const PRICING_FAQ = [
  {
    q: "What does the beta actually cost?",
    a: "Nothing. Every feature, no credit card, no listing caps, no trial timer. Beta is genuinely free because real usage is what makes the pricing engine smarter.",
  },
  {
    q: "What happens when the beta ends?",
    a: "Paid tiers arrive with honest limits, and beta users keep early-bird pricing. Nothing you already listed gets held hostage — your items, listings, and history stay yours.",
  },
  {
    q: "Will I be charged automatically when paid plans launch?",
    a: "No. There's no card on file to charge. When Seller Pro lands you'll get an explicit choice; until you pick a paid plan, you stay on the free tier that exists then.",
  },
  {
    q: "Are there hidden per-listing fees?",
    a: "None from SnapList. eBay's own selling fees still apply when something sells — those go to eBay, exactly as if you'd listed by hand.",
  },
  {
    q: "What will Seller Pro cost?",
    a: "Undecided — that's why the card says $—. It will be priced for flippers and steady resellers, and beta users will see the number before anyone else, with early-bird pricing locked in.",
  },
] as const;

const INCLUDED = [
  "Unlimited photo identifications",
  "AI pricing with cited sources",
  "eBay publishing via your own account",
  "Facebook & Mercari export packs",
  "Confidence-gated autopilot",
  "Drafted buyer replies",
  "Private photo storage",
] as const;

const PRO_INCLUDED = [
  "Everything in Beta",
  "Higher listing limits",
  "Autopilot publishing at volume",
  "Bulk photo uploads",
  "Listing & pricing analytics",
  "Priority research queue",
  "Priority support",
] as const;

export default function Pricing() {
  return (
    <>
      <section className="aurora grain relative overflow-hidden px-5 pb-16 pt-32 sm:px-8 sm:pt-40">
        <div className="mx-auto w-full max-w-6xl text-center">
          <Reveal>
            <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-iris">
              Pricing
            </p>
            <h1 className="mx-auto mt-4 max-w-2xl font-display text-[clamp(34px,5vw,56px)] font-bold leading-[1.05] tracking-tight text-flash">
              Free while we&apos;re in{" "}
              <em className="text-iris">
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
        <Reveal stagger className="grid items-stretch gap-6 lg:grid-cols-2">
          {/* live tier — a calm ElectricBorder hugs the recommended plan */}
          <ElectricBorder
            color="#6d4aff"
            speed={0.5}
            chaos={0.045}
            displacement={12}
            borderRadius={24}
            className="h-full"
          >
            <div className="relative flex h-full flex-col overflow-hidden rounded-3xl bg-panel p-8 sm:p-9">
              <span className="absolute right-6 top-6 rounded-full bg-iris px-3 py-1 text-[11.5px] font-bold uppercase tracking-[0.1em] text-iris-ink">
                Live now
              </span>
              <h2 className="font-display text-[24px] font-bold text-flash">Beta</h2>
              <p className="mt-1.5 text-[15px] text-flash-faint">
                Everything SnapList can do today
              </p>
              <p className="nums mt-6 font-display text-[58px] font-bold leading-none tracking-tight text-flash">
                $0
                <span className="ml-1.5 text-[16px] font-medium text-flash-faint">
                  / forever-while-beta
                </span>
              </p>
              <ul className="mb-8 mt-7 space-y-3.5">
                {INCLUDED.map((line) => (
                  <li key={line} className="flex items-start gap-3 text-[15px] text-flash-dim">
                    <svg viewBox="0 0 24 24" className="mt-0.5 size-[18px] shrink-0 text-iris" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    {line}
                  </li>
                ))}
              </ul>
              <Link
                href="/login"
                className="group mt-auto inline-flex w-full items-center justify-center gap-2 rounded-full bg-iris px-6 py-3.5 text-[15.5px] font-semibold text-iris-ink transition-transform hover:scale-[1.02]"
              >
                Start selling free
                <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
              </Link>
              <p className="mt-3.5 text-center text-[13px] text-flash-faint">
                No credit card · cancel nothing, there&apos;s nothing to cancel
              </p>
            </div>
          </ElectricBorder>

          {/* coming-soon tier — same skeleton as Beta so the row reads uniform */}
          <div className="relative flex h-full flex-col overflow-hidden rounded-3xl border border-line bg-panel p-8 shadow-card sm:p-9">
            <span className="absolute right-6 top-6 rounded-full border border-line bg-night-2 px-3 py-1 text-[11.5px] font-bold uppercase tracking-[0.1em] text-flash-faint">
              Coming soon
            </span>
            <h2 className="font-display text-[24px] font-bold text-flash">Seller Pro</h2>
            <p className="mt-1.5 text-[15px] text-flash-faint">
              For flippers, resellers & steady decluttering
            </p>
            <p className="nums mt-6 font-display text-[58px] font-bold leading-none tracking-tight text-flash-dim">
              $—
              <span className="ml-1.5 text-[16px] font-medium text-flash-faint">
                / month, after beta
              </span>
            </p>
            <ul className="mb-8 mt-7 space-y-3.5">
              {PRO_INCLUDED.map((line) => (
                <li key={line} className="flex items-start gap-3 text-[15px] text-flash-dim">
                  <svg viewBox="0 0 24 24" className="mt-0.5 size-[18px] shrink-0 text-flash-faint" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  {line}
                </li>
              ))}
            </ul>
            <p
              aria-disabled="true"
              className="mt-auto inline-flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-full border border-line bg-night-2 px-6 py-3.5 text-[15.5px] font-semibold text-flash-faint"
            >
              Notify me when it lands
            </p>
            <p className="mt-3.5 text-center text-[13px] text-flash-faint">
              Beta users keep early-bird pricing
            </p>
          </div>
        </Reveal>

        <Reveal className="mt-14 rounded-2xl border border-line bg-night-2 p-8 text-center">
          <p className="mx-auto max-w-[62ch] text-[15px] leading-relaxed text-flash-dim">
            The honest part: SnapList is a production-real AI engineering
            showcase. Beta is genuinely free because your usage is what makes
            the pricing engine smarter — when paid tiers land, nothing you
            already listed gets held hostage.
          </p>
        </Reveal>
      </section>

      {/* billing FAQ — animated accordion */}
      <section className="border-t border-line bg-night-2">
        <div className="mx-auto w-full max-w-3xl px-5 py-24 sm:px-8">
          <Reveal>
            <Eyebrow tint="cyan">Billing FAQ</Eyebrow>
            <h2 className="mt-4 font-display text-[clamp(24px,3.4vw,36px)] font-bold tracking-tight text-flash">
              Money questions, straight answers
            </h2>
          </Reveal>
          <Reveal className="mt-10">
            <FaqAccordion items={PRICING_FAQ} />
          </Reveal>
          <Reveal className="mt-10 text-center">
            <p className="text-[14.5px] text-flash-dim">
              Product questions live on the{" "}
              <Link href="/about#faq" className="link-underline font-semibold text-iris">
                general FAQ
              </Link>
              .
            </p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
