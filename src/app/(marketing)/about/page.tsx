import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import SpotlightCard from "@/components/bits/SpotlightCard";
import { Reveal } from "@/components/marketing/reveal";
import { FaqAccordion } from "@/components/marketing/faq-accordion";
import { Eyebrow, LensRings } from "@/components/marketing/visuals";
import { DEMO_PRODUCTS_BY_SLUG } from "@/lib/demo-products";

export const metadata: Metadata = {
  title: "About & FAQ",
  description:
    "Why SnapList exists, the engineering principles behind it, and answers to the questions everyone asks.",
};

/** /about (ui-r5-marketing) — story beside a full-size price report (the
 * verified Victrola turntable: large legible product photo, suggested price,
 * a self-explaining sold-price range with labeled endpoints, confidence chip,
 * cited sources — a miniature of the real product experience), numbered
 * principle cards (SpotlightCard), and a single clean centered FAQ list (the
 * espresso anchor card is gone — owner round-5: "It should just be the list
 * of questions"). */

const PRINCIPLES = [
  {
    title: "Show the sources",
    body: "A price you can't trace is a guess wearing a suit. Every suggestion carries its receipts.",
    icon: (
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    ),
  },
  {
    title: "Flag, don't fake",
    body: "When the system isn't sure what your item is, or few similar items have sold recently, it says so. Low confidence is information, not failure.",
    icon: (
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <path d="M4 22v-7" />
      </svg>
    ),
  },
  {
    title: "You own the send button",
    body: "Autopilot is opt-in and gated on computed confidence. Nothing posts, replies, or changes price without a rule you set.",
    icon: (
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m22 2-7 20-4-9-9-4Z" />
        <path d="M22 2 11 13" />
      </svg>
    ),
  },
  {
    title: "Honest ceilings",
    body: "Asking prices aren't sold prices. Generic items price worse than branded ones. We tell you which is which instead of pretending.",
    icon: (
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m12 14 4-4" />
        <path d="M3.34 19a10 10 0 1 1 17.32 0" />
      </svg>
    ),
  },
] as const;

const FAQ = [
  {
    q: "Which marketplaces does SnapList support?",
    a: "eBay is fully integrated — listings publish directly under your own connected eBay account. Facebook Marketplace and Mercari get formatted copy-paste export packs (neither offers a public listing API, and we don't scrape).",
  },
  {
    q: "How accurate is the pricing?",
    a: "It depends on the item, and we always show you where the price came from. Books and media with an ISBN are strongest — an exact lookup, no guessing. Branded items are priced from what similar items recently sold for, which is solid. Everyday items get an estimate marked down from the new price, clearly labeled as less certain. Every price is editable.",
  },
  {
    q: "Is my data private?",
    a: "Yes. Photos live in private storage behind expiring signed URLs, every database row is isolated to your account and enforced at the database layer, and eBay tokens are encrypted at rest. eBay account-deletion requests are verified cryptographically and honored end-to-end.",
  },
  {
    q: "Does autopilot post things without asking me?",
    a: "Only if you turn it on, and only for items above the confidence bar — a score computed from real signals (how the price was found, how closely recent sales agree, and how completely the item was identified), never the AI grading its own work. Everything else queues for your review. You can keep autopilot off entirely.",
  },
  {
    q: "What does it cost?",
    a: "Nothing during beta — every feature, no credit card. Paid tiers come later; beta users keep early-bird pricing.",
  },
  {
    q: "Do I need my own eBay account?",
    a: "Yes — that's a feature. Listings publish under your identity and reputation via OAuth. SnapList never sees your eBay password.",
  },
] as const;

/**
 * Full-size price report for the About hero — the verified Victrola
 * turntable from the demo catalog, priced its honest way (recent sale
 * prices): large product photo, suggested price, a sold-price range with
 * labeled endpoints and a captioned suggested-price marker, confidence
 * chip, cited sources.
 */
function AboutPriceReport() {
  const p = DEMO_PRODUCTS_BY_SLUG.turntable;
  const sources = [
    ["Sold on eBay", "$64", "3 days ago"],
    ["Sold on Mercari", "$72", "5 days ago"],
    ["Facebook asking price — counted less", "$85", "last week"],
  ] as const;
  return (
    <div className="glass-panel overflow-hidden rounded-3xl">
      <div className="relative h-[230px]">
        <Image
          src={p.image}
          alt={p.alt}
          fill
          sizes="(min-width: 1024px) 440px, 100vw"
          className="object-cover"
        />
        <span className="absolute left-4 top-4 rounded-full bg-night/85 px-3 py-1.5 text-[12px] font-semibold text-flash backdrop-blur">
          {p.category}
        </span>
      </div>
      <div className="p-6">
        <p className="text-[15px] font-semibold leading-snug text-flash">
          {p.title}
        </p>
        <div className="mt-4 flex items-end justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-flash-faint">
              Suggested price
            </p>
            <p className="nums font-display text-[38px] font-bold leading-tight text-flash">
              ${p.price}
            </p>
          </div>
          <span className="mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-iris/12 px-3 py-1.5 text-[12px] font-semibold text-iris">
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6 9 17l-5-5" />
            </svg>
            82% confidence
          </span>
        </div>
        {/* what similar items sold for — labeled endpoints, suggested price
            marked and captioned, so the band explains itself at a glance */}
        <div className="mt-5">
          <p className="text-[12.5px] font-medium leading-snug text-flash-dim">
            Similar turntables sold from{" "}
            <span className="nums font-semibold text-flash">$55</span> to{" "}
            <span className="nums font-semibold text-flash">$85</span> recently
          </p>
          <div className="relative mt-9">
            <div className="absolute bottom-full left-[43%] flex -translate-x-1/2 flex-col items-center">
              <span className="nums whitespace-nowrap rounded-full bg-iris/12 px-2.5 py-1 text-[11.5px] font-semibold text-iris">
                ${p.price} suggested
              </span>
              <span aria-hidden className="h-2.5 w-px bg-iris/50" />
            </div>
            <div className="relative h-2">
              <div className="absolute inset-0 rounded-full bg-gradient-to-r from-iris-deep/70 to-iris" />
              <span className="absolute left-[43%] top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-night bg-iris shadow-sm" />
            </div>
            <div className="mt-1.5 flex justify-between text-[11.5px] text-flash-faint">
              <span>
                <span className="nums font-semibold">$55</span> — lowest sale
              </span>
              <span>
                <span className="nums font-semibold">$85</span> — highest sale
              </span>
            </div>
          </div>
        </div>
        <div className="mt-5 space-y-2.5 border-t border-line pt-4">
          {sources.map(([src, price, age]) => (
            <div key={src} className="flex items-center justify-between text-[13px]">
              <span className="flex items-center gap-2 text-flash-dim">
                <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-iris" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                {src}
              </span>
              <span className="nums font-semibold text-flash">
                {price} <span className="font-normal text-flash-faint">· {age}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function About() {
  return (
    <>
      <section className="aurora grain relative overflow-hidden px-5 pb-16 pt-32 sm:px-8 sm:pt-40">
        <LensRings className="pointer-events-none absolute -left-44 -top-44 w-[560px] text-iris" />
        <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[1fr_440px]">
          <Reveal>
            <Eyebrow>About</Eyebrow>
            <h1 className="mt-4 max-w-3xl font-display text-[clamp(34px,5vw,56px)] font-bold leading-[1.05] tracking-tight text-flash">
              Selling used stuff is{" "}
              <em className="text-iris">
                unpaid admin work
              </em>
            </h1>
            <div className="mt-6 max-w-[60ch] space-y-4 text-[16.5px] leading-relaxed text-flash-dim">
              <p>
                Every item is the same half hour: photograph it, guess what
                it&apos;s worth used (not retail — good luck finding real sold
                prices), write a listing that doesn&apos;t sound desperate,
                post it, then answer the same three buyer questions.
              </p>
              <p>
                SnapList collapses that into a photo and a couple of approvals.
                It was built as a production-real AI engineering showcase —
                which is exactly why it doesn&apos;t cut corners: real eBay
                integration, real multi-tenant security, real evaluation of its
                own accuracy.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.15} className="hidden lg:block">
            <AboutPriceReport />
          </Reveal>
        </div>
      </section>

      <section className="relative mx-auto w-full max-w-6xl px-5 pb-24 sm:px-8">
        <Reveal>
          <Eyebrow n="01" tint="indigo">
            Principles
          </Eyebrow>
          <h2 className="mt-4 font-display text-[clamp(26px,3.4vw,38px)] font-bold tracking-tight text-flash">
            Principles we don&apos;t{" "}
            <em className="text-iris">bend</em>
          </h2>
          <p className="mt-4 max-w-[54ch] text-[16px] leading-relaxed text-flash-dim">
            Four rules the pipeline is built around — they decide what ships
            and what gets cut.
          </p>
        </Reveal>
        <Reveal stagger className="mt-10 grid gap-5 sm:grid-cols-2">
          {PRINCIPLES.map(({ title, body, icon }, i) => (
            <SpotlightCard
              key={title}
              className="group p-8"
              spotlightColor="rgba(109, 74, 255, 0.12)"
            >
              <div className="flex items-center justify-between">
                <span className="flex size-11 items-center justify-center rounded-xl bg-iris/10 text-iris transition-colors duration-300 group-hover:bg-iris group-hover:text-iris-ink">
                  {icon}
                </span>
                <span className="nums font-display text-[14px] font-bold text-iris/70">
                  0{i + 1}
                </span>
              </div>
              <h3 className="mt-5 font-display text-[20px] font-semibold text-flash">
                {title}
              </h3>
              <p className="mt-3 text-[15px] leading-relaxed text-flash-dim">
                {body}
              </p>
            </SpotlightCard>
          ))}
        </Reveal>
      </section>

      {/* one clean question list — no anchor card, no side column (ui-r5) */}
      <section id="faq" className="border-t border-line bg-night-2">
        <div className="mx-auto w-full max-w-3xl px-5 py-24 sm:px-8 sm:py-28">
          <Reveal className="flex flex-col items-center text-center">
            <Eyebrow n="02" tint="cyan">
              FAQ
            </Eyebrow>
            <h2 className="mt-4 font-display text-[clamp(28px,3.6vw,40px)] font-bold tracking-tight text-flash">
              The questions everyone asks
            </h2>
            <p className="mt-4 max-w-[52ch] text-[16.5px] leading-relaxed text-flash-dim">
              Marketplaces, accuracy, privacy, and what autopilot will never
              do without you — answered straight.
            </p>
          </Reveal>
          <Reveal delay={0.1} className="mt-12">
            <FaqAccordion items={FAQ} />
          </Reveal>
        </div>
      </section>

      <section className="mx-auto w-full max-w-3xl px-5 py-24 text-center sm:px-8">
        <Reveal>
          <h2 className="font-display text-[clamp(28px,4vw,42px)] font-bold tracking-tight text-flash">
            Got something to sell?
          </h2>
          <Link
            href="/login"
            className="group mt-8 inline-flex items-center gap-2 rounded-full bg-iris px-7 py-3.5 text-[15.5px] font-semibold text-iris-ink transition-transform hover:scale-[1.03]"
          >
            Snap your first photo
            <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
          </Link>
        </Reveal>
      </section>
    </>
  );
}
