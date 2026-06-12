import type { Metadata } from "next";
import Link from "next/link";
import { Reveal } from "@/components/marketing/reveal";
import {
  LensRings,
  ScanChipsVisual,
  PriceModuleVisual,
  PlatformCardsVisual,
  ConfidenceGaugeVisual,
  InboxVisual,
  SecurityVisual,
} from "@/components/marketing/visuals";

export const metadata: Metadata = {
  title: "Features",
  description:
    "AI identification, pricing with cited sources, confidence-gated autopilot, platform-native listings, drafted buyer replies, and per-account security.",
};

/** /features (issue #49) — capability deep-dive grouped by pipeline area,
 * each group anchored by a product-mock visual (round 2: no text walls). */

const GROUP_VISUALS: Record<string, () => React.ReactNode> = {
  Identification: ScanChipsVisual,
  Pricing: PriceModuleVisual,
  Listings: PlatformCardsVisual,
  "Autopilot & trust": ConfidenceGaugeVisual,
  "Selling & inbox": InboxVisual,
  Security: SecurityVisual,
};

const GROUPS = [
  {
    heading: "Identification",
    blurb: "Knowing what you're selling is half the price.",
    items: [
      {
        title: "Structured vision extraction",
        body: "Brand, model, category, condition and key specs pulled from your photos into a validated schema — not a fuzzy caption.",
      },
      {
        title: "Barcode & ISBN reading",
        body: "A visible barcode upgrades the whole pipeline: books and media get exact-identity lookups instead of estimation.",
      },
      {
        title: "Honest ambiguity",
        body: "When the system isn't sure what it's looking at, it says so and asks — misidentification never flows silently into a price.",
      },
    ],
  },
  {
    heading: "Pricing",
    blurb: "A number you could defend to a buyer.",
    items: [
      {
        title: "Research with receipts",
        body: "A bounded web-research agent gathers comps and synthesizes a suggested price, a range, and the cited sources behind both.",
      },
      {
        title: "Used value, not retail",
        body: "Sold and resale signals are sought out; lonely retail prices get a condition-based depreciation model and a clearly lower confidence.",
      },
      {
        title: "You hold the pen",
        body: "Every suggestion is editable. Override the price and your number wins everywhere downstream.",
      },
    ],
  },
  {
    heading: "Listings",
    blurb: "Copy that reads like a power seller wrote it.",
    items: [
      {
        title: "Platform-native generation",
        body: "eBay item specifics and keyword-dense titles, Facebook's casual local tone, Mercari's hashtag conventions — from one attribute core.",
      },
      {
        title: "Export packs",
        body: "Clean copy-paste blocks for the platforms without write APIs. No retyping, no scraping, no ToS gray zones.",
      },
      {
        title: "Grounded few-shot",
        body: "Generation is steered by similar real listings retrieved from a reference corpus, so output stays concrete and idiomatic.",
      },
    ],
  },
  {
    heading: "Autopilot & trust",
    blurb: "Automation that earns its autonomy.",
    items: [
      {
        title: "Signal-based confidence",
        body: "Confidence is computed from which pricing tier fired, how tightly comps agree, and how complete identification is — never the model grading its own homework.",
      },
      {
        title: "Confidence-gated publishing",
        body: "Above the bar, listings can queue and publish themselves. Below it, they wait for you. The gate is yours to set — or switch off.",
      },
      {
        title: "Transparent reasoning",
        body: "Every queued or held listing shows why: the signals, the tier, the score. No mystery automation.",
      },
    ],
  },
  {
    heading: "Selling & inbox",
    blurb: "The after-the-listing work, handled.",
    items: [
      {
        title: "Your eBay identity",
        body: "Connect your own eBay account via OAuth. Listings publish under you; SnapList never sees your password and tokens are encrypted at rest.",
      },
      {
        title: "Drafted buyer replies",
        body: "Incoming questions arrive in a live inbox with answers pre-drafted from the item's actual attributes — approve, edit, or rewrite before anything sends.",
      },
      {
        title: "Status tracking",
        body: "Draft, queued, live, failed — every listing's state in one dashboard, with the full history kept.",
      },
    ],
  },
  {
    heading: "Security",
    blurb: "Multi-tenant from the first commit.",
    items: [
      {
        title: "Row-level isolation",
        body: "Every record is scoped to your account and enforced by the database itself — not by application code remembering to filter.",
      },
      {
        title: "Private photo storage",
        body: "Photos live in private buckets behind signed, expiring URLs. Nothing you upload is publicly addressable.",
      },
      {
        title: "Deletion honored",
        body: "eBay account-deletion notices are verified cryptographically and erase your connection data end-to-end.",
      },
    ],
  },
] as const;

export default function Features() {
  return (
    <>
      <section className="aurora grain relative overflow-hidden px-5 pb-16 pt-32 sm:px-8 sm:pt-40">
        <LensRings className="pointer-events-none absolute -right-40 -top-40 w-[560px] text-iris" />
        <div className="mx-auto w-full max-w-6xl">
          <Reveal>
            <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-iris">
              Features
            </p>
            <h1 className="mt-3 max-w-3xl font-display text-[clamp(34px,5vw,56px)] font-bold leading-[1.05] tracking-tight text-flash">
              Everything between{" "}
              <em className="font-serif-accent font-normal italic text-iris">
                photo
              </em>{" "}
              and{" "}
              <em className="font-serif-accent font-normal italic text-iris">
                paid
              </em>
            </h1>
          </Reveal>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl space-y-16 px-5 pb-28 sm:space-y-24 sm:px-8">
        {GROUPS.map(({ heading, blurb, items }, i) => {
          const Visual = GROUP_VISUALS[heading];
          return (
            <Reveal key={heading}>
              <div
                className={`grid items-center gap-8 lg:gap-14 ${
                  i % 2 === 0 ? "lg:grid-cols-[1fr_430px]" : "lg:grid-cols-[430px_1fr]"
                }`}
              >
                <div className={i % 2 === 0 ? "" : "lg:order-2"}>
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <h2 className="font-display text-[clamp(22px,3vw,30px)] font-bold tracking-tight text-flash">
                      {heading}
                    </h2>
                    <p className="font-serif-accent text-[16px] italic text-flash-faint">
                      {blurb}
                    </p>
                  </div>
                  <ul className="mt-6 space-y-4">
                    {items.map(({ title, body }) => (
                      <li key={title} className="flex gap-3">
                        <svg viewBox="0 0 24 24" className="mt-1 size-4 shrink-0 text-iris" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                        <div>
                          <h3 className="font-display text-[15.5px] font-semibold text-flash">
                            {title}
                          </h3>
                          <p className="mt-1 text-[13.5px] leading-relaxed text-flash-dim">
                            {body}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className={i % 2 === 0 ? "" : "lg:order-1"}>
                  {Visual ? <Visual /> : null}
                </div>
              </div>
            </Reveal>
          );
        })}
      </section>

      <section className="border-t border-line/60 bg-night-2/40 px-5 py-24 text-center sm:px-8">
        <Reveal>
          <h2 className="font-display text-[clamp(28px,4vw,42px)] font-bold tracking-tight text-flash">
            Stop reading about it
          </h2>
          <Link
            href="/login"
            className="group mt-8 inline-flex items-center gap-2 rounded-full bg-iris px-7 py-3.5 text-[15px] font-semibold text-iris-ink shadow-[0_0_40px_-8px] shadow-iris/50 transition-transform hover:scale-[1.03]"
          >
            List something free
            <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
          </Link>
        </Reveal>
      </section>
    </>
  );
}
