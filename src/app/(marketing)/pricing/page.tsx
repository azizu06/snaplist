import type { Metadata } from "next";
import Link from "next/link";
import ElectricBorder from "@/components/bits/ElectricBorder";
import { Reveal } from "@/components/marketing/reveal";
import { FaqAccordion } from "@/components/marketing/faq-accordion";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Two plans, no surprises. Free covers 15 items a day; Seller Pro is $10 a month for 200 items a day, bulk capture, and priority pricing.",
};

/**
 * /pricing — Shopify-grade plan comparison. Two plans side by side (Free and
 * the recommended Seller Pro at $10/mo, hugged by ElectricBorder), then a
 * grouped feature-comparison table that makes the Free → Pro delta explicit
 * with checks / em-dashes per row. Numbers are grounded in the real app:
 * the daily item limits are the enforced quota defaults
 * (QUOTA_FREE_ITEMS_PER_DAY = 15, QUOTA_PAID_ITEMS_PER_DAY = 200; see
 * src/lib/abuse/config.ts), and every feature row maps to a shipped capability.
 */

const PRICING_FAQ = [
  {
    q: "What's the difference between Free and Seller Pro?",
    a: "Both plans get the full pipeline: identification, source-backed pricing when available with clearly labeled estimates otherwise, listing generation, eBay publishing, and export packs. Seller Pro raises the daily limit from 15 items to 200, adds bulk photo uploads, a priority research queue, listing and pricing analytics, and priority support. It's built for flippers and steady resellers.",
  },
  {
    q: "What does Seller Pro cost?",
    a: "$10 a month. No per-listing fees from SnapList, and you can cancel any time from your billing settings.",
  },
  {
    q: "Is the Free plan time-limited?",
    a: "No. Free is a real plan, not a trial. It covers every core feature for up to 15 items a day, with no card on file and no expiry timer.",
  },
  {
    q: "What counts toward the daily item limit?",
    a: "Each item you identify and price counts once against that day's allowance. Editing, re-pricing, or re-exporting an item you already processed doesn't spend another slot.",
  },
  {
    q: "Are there hidden per-listing fees?",
    a: "None from SnapList. eBay's own selling fees still apply when something sells; those go to eBay, exactly as if you'd listed by hand.",
  },
  {
    q: "Can I move between plans?",
    a: "Yes. Upgrade to Seller Pro when your volume outgrows the free limit, and downgrade whenever you like. Your items, listings, and history stay yours on either plan.",
  },
] as const;

/** Per-plan card summary. Limits use tabular-nums; CTAs bottom-align. */
const FREE_HIGHLIGHTS = [
  "Pricing research with labeled fallbacks",
  "eBay publishing from your own account",
  "Facebook & Mercari export packs",
  "High-confidence publish eligibility",
] as const;

const PRO_HIGHLIGHTS = [
  "Everything in Free",
  "Bulk photo uploads",
  "Priority pricing-research queue",
  "Listing & pricing analytics",
  "Priority support",
] as const;

/**
 * Grouped feature matrix. Each value is either a boolean (check / em-dash) or a
 * string (a concrete value like a daily limit). Free and Pro columns sit side
 * by side so the delta is obvious at a glance.
 */
type Cell = boolean | string;
type FeatureRow = { label: string; free: Cell; pro: Cell };
type FeatureGroup = { group: string; rows: readonly FeatureRow[] };

const FEATURE_MATRIX: readonly FeatureGroup[] = [
  {
    group: "Volume",
    rows: [
      { label: "Items identified & priced per day", free: "15", pro: "200" },
      { label: "Bulk photo uploads", free: false, pro: true },
      { label: "Priority research queue", free: false, pro: true },
    ],
  },
  {
    group: "Pricing & identification",
    rows: [
      { label: "Photo identification & attribute extraction", free: true, pro: true },
      { label: "Source-backed price range when available", free: true, pro: true },
      { label: "ISBN & barcode lookup", free: true, pro: true },
      { label: "Priority pricing-model quality", free: false, pro: true },
    ],
  },
  {
    group: "Listings & posting",
    rows: [
      { label: "Listing copy generated per marketplace", free: true, pro: true },
      { label: "eBay publishing from your own account", free: true, pro: true },
      { label: "Facebook & Mercari export packs", free: true, pro: true },
      { label: "High-confidence publish eligibility", free: true, pro: true },
      { label: "Manual eBay publish control", free: true, pro: true },
    ],
  },
  {
    group: "Insight",
    rows: [
      { label: "Listing & pricing analytics", free: false, pro: true },
    ],
  },
  {
    group: "Account & support",
    rows: [
      { label: "Private photo storage", free: true, pro: true },
      { label: "Per-account data isolation", free: true, pro: true },
      { label: "Priority support", free: false, pro: true },
    ],
  },
] as const;

/** A check (true) or muted em-dash (false) for boolean cells. */
function CellMark({ value }: { value: Cell }) {
  if (typeof value === "string") {
    return (
      <span className="nums text-[16px] font-semibold text-flash">{value}</span>
    );
  }
  if (value) {
    return (
      <>
        <span className="sr-only">Included</span>
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          className="size-5 text-iris"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </>
    );
  }
  return (
    <>
      <span className="sr-only">Not included</span>
      <span aria-hidden className="text-[18px] font-medium text-flash-faint">
        &mdash;
      </span>
    </>
  );
}

/** One plan card. `recommended` swaps the CTA to the solid accent treatment. */
function PlanHighlights({ items }: { items: readonly string[] }) {
  return (
    <ul className="mb-8 mt-7 space-y-3.5">
      {items.map((line) => (
        <li
          key={line}
          className="flex items-start gap-3 text-[16px] text-flash-dim"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden
            className="mt-0.5 size-[18px] shrink-0 text-iris"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
          {line}
        </li>
      ))}
    </ul>
  );
}

export default function Pricing() {
  return (
    <>
      <section className="aurora grain relative overflow-hidden px-5 pb-16 pt-32 sm:px-8 sm:pt-40">
        <div className="mx-auto w-full max-w-6xl text-center">
          <Reveal>
            {/* "PRICING" eyebrow removed — the nav's active-page indicator now
                says where you are, and a small eyebrow stacked over the big
                heading flipped the hierarchy. The heading leads on its own. */}
            <h1 className="mx-auto max-w-2xl font-display text-[clamp(34px,5vw,56px)] font-bold leading-[1.05] tracking-tight text-flash">
              Two plans, <em className="text-iris">no surprises</em>
            </h1>
            <p className="mx-auto mt-5 max-w-[48ch] text-[16px] leading-relaxed text-flash-dim">
              Start free with 15 items a day. Move up to Seller Pro when your
              volume outgrows it. No per-listing fees, no paywall sprung halfway
              through.
            </p>
          </Reveal>
        </div>
      </section>

      {/* the two plan cards — Free vs the recommended Seller Pro */}
      <section className="mx-auto w-full max-w-5xl px-5 pb-20 sm:px-8">
        {/* Generous gap on BOTH axes so the Seller Pro ElectricBorder glow has
            room to fall off before it reaches the Free card — the old lg:gap-6
            let the green halo bleed across the divider into the Free plan. */}
        <Reveal stagger className="grid items-stretch gap-10 lg:grid-cols-2 lg:gap-10">
          {/* Free — calm bordered card */}
          <div className="relative flex h-full flex-col overflow-hidden rounded-3xl border border-line bg-panel p-8 shadow-card sm:p-9">
            <h2 className="font-display text-[24px] font-bold text-flash">Free</h2>
            <p className="mt-1.5 text-[16px] text-flash-faint">
              Everything you need to start flipping
            </p>
            <p className="nums mt-6 font-display text-[58px] font-bold leading-none tracking-tight text-flash">
              $0
              <span className="ml-1.5 text-[16px] font-medium text-flash-faint">
                / month
              </span>
            </p>
            <p className="nums mt-3 text-[15px] font-medium text-flash-dim">
              Up to 15 items a day
            </p>
            <PlanHighlights items={FREE_HIGHLIGHTS} />
            <Link
              href="/login"
              className="group mt-auto inline-flex w-full items-center justify-center gap-2 rounded-full border border-flash/25 bg-transparent px-6 py-3.5 text-[16.5px] font-semibold text-flash transition-all hover:border-flash/45 hover:bg-flash/[0.06] active:bg-flash/10 dark:border-iris/30 dark:hover:border-iris/55 dark:hover:bg-iris/10"
            >
              Start selling free
              <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
            </Link>
            <p className="mt-3.5 text-center text-[14px] text-flash-faint">
              No credit card required
            </p>
          </div>

          {/* Seller Pro — recommended, hugged by a calm ElectricBorder */}
          <ElectricBorder
            color="#008060"
            speed={0.5}
            chaos={0.035}
            displacement={8}
            borderRadius={24}
            className="h-full"
          >
            <div className="relative flex h-full flex-col overflow-hidden rounded-3xl bg-panel p-8 sm:p-9">
              <span className="absolute right-6 top-6 rounded-full bg-iris px-3 py-1 text-[11.5px] font-bold uppercase tracking-[0.1em] text-iris-ink">
                Recommended
              </span>
              <h2 className="font-display text-[24px] font-bold text-flash">
                Seller Pro
              </h2>
              <p className="mt-1.5 text-[16px] text-flash-faint">
                For flippers, resellers & busy stores
              </p>
              <p className="nums mt-6 font-display text-[58px] font-bold leading-none tracking-tight text-flash">
                $10
                <span className="ml-1.5 text-[16px] font-medium text-flash-faint">
                  / month
                </span>
              </p>
              <p className="nums mt-3 text-[15px] font-medium text-flash-dim">
                Up to 200 items a day
              </p>
              <PlanHighlights items={PRO_HIGHLIGHTS} />
              <Link
                href="/login"
                className="group mt-auto inline-flex w-full items-center justify-center gap-2 rounded-full bg-iris px-6 py-3.5 text-[16.5px] font-semibold text-iris-ink transition-transform hover:scale-[1.02] active:scale-[0.99]"
              >
                Upgrade to Seller Pro
                <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
              </Link>
              <p className="mt-3.5 text-center text-[14px] text-flash-faint">
                $10 a month · cancel any time
              </p>
            </div>
          </ElectricBorder>
        </Reveal>
      </section>

      {/* feature comparison — grouped rows, checks vs em-dash, Free vs Pro */}
      <section className="border-t border-line bg-night-2">
        <div className="mx-auto w-full max-w-5xl px-5 py-24 sm:px-8 sm:py-28">
          <Reveal>
            <h2 className="font-display text-[clamp(24px,3.4vw,36px)] font-bold tracking-tight text-flash">
              What you get, line by line
            </h2>
            <p className="mt-4 max-w-[54ch] text-[16px] leading-relaxed text-flash-dim">
              Both plans run the full pipeline. Seller Pro adds the volume,
              speed, and insight that steady resellers lean on.
            </p>
          </Reveal>

          <Reveal className="mt-12 overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
            {/* sticky-feeling header row: feature | Free | Pro */}
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 border-b border-line bg-night-2 px-5 py-4 sm:gap-x-10 sm:px-7">
              <span className="text-[13.5px] font-semibold uppercase tracking-[0.12em] text-flash-faint">
                Feature
              </span>
              <span className="w-16 text-center text-[15px] font-semibold text-flash sm:w-20">
                Free
              </span>
              <span className="flex w-16 items-center justify-center gap-1.5 text-center text-[15px] font-semibold text-flash sm:w-20">
                Pro
                <span aria-hidden className="size-1.5 rounded-full bg-iris" />
              </span>
            </div>

            {FEATURE_MATRIX.map((group) => (
              <div key={group.group}>
                <p className="bg-panel px-5 pb-2.5 pt-6 text-[13px] font-semibold uppercase tracking-[0.14em] text-iris-deep sm:px-7">
                  {group.group}
                </p>
                {group.rows.map((row) => (
                  <div
                    key={row.label}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 border-t border-line px-5 py-4 sm:gap-x-10 sm:px-7"
                  >
                    <span className="text-[16px] leading-normal text-flash-dim">
                      {row.label}
                    </span>
                    <span className="flex w-16 items-center justify-center sm:w-20">
                      <CellMark value={row.free} />
                    </span>
                    <span className="flex w-16 items-center justify-center sm:w-20">
                      <CellMark value={row.pro} />
                    </span>
                  </div>
                ))}
              </div>
            ))}

            {/* bottom-aligned CTAs, one per column */}
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 border-t border-line bg-night-2 px-5 py-5 sm:gap-x-10 sm:px-7">
              <span className="text-[14px] font-medium text-flash-faint">
                Ready when you are
              </span>
              <Link
                href="/login"
                className="flex w-16 items-center justify-center rounded-full border border-flash/25 px-2 py-2 text-[13.5px] font-semibold text-flash transition-colors hover:border-flash/45 hover:bg-flash/[0.06] sm:w-20 dark:border-iris/30 dark:hover:border-iris/55 dark:hover:bg-iris/10"
              >
                Start
              </Link>
              <Link
                href="/login"
                className="flex w-16 items-center justify-center rounded-full bg-iris px-2 py-2 text-[13.5px] font-semibold text-iris-ink transition-transform hover:scale-[1.03] sm:w-20"
              >
                Upgrade
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* billing FAQ — animated accordion */}
      <section className="border-t border-line bg-night-2">
        <div className="mx-auto w-full max-w-3xl px-5 py-24 sm:px-8">
          <Reveal>
            <h2 className="font-display text-[clamp(24px,3.4vw,36px)] font-bold tracking-tight text-flash">
              Money questions, straight answers
            </h2>
          </Reveal>
          <Reveal className="mt-10">
            <FaqAccordion items={PRICING_FAQ} />
          </Reveal>
          <Reveal className="mt-10 text-center">
            <p className="text-[15.5px] text-flash-dim">
              Want the full walkthrough? See the{" "}
              <Link href="/tour" className="link-underline font-semibold text-iris">
                product guide
              </Link>
              .
            </p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
