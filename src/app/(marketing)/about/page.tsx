import type { Metadata } from "next";
import Link from "next/link";
import SpotlightCard from "@/components/bits/SpotlightCard";
import { Reveal } from "@/components/marketing/reveal";
import { FaqAccordion } from "@/components/marketing/faq-accordion";
import { Eyebrow, LensRings } from "@/components/marketing/visuals";
import { LogoMark } from "@/components/logo";

export const metadata: Metadata = {
  title: "About & FAQ",
  description:
    "Why SnapList exists, what we promise sellers, and answers to the questions sellers ask most.",
};

/** /about (ui-r6-marketing) — a seller-facing story beside a short, signed
 * founder's note (no product demo: Home and Tour already show the product),
 * numbered principle cards (SpotlightCard), and a single clean centered FAQ
 * list. Copy is intentionally seller-voiced — no engineering/showcase framing,
 * which belongs in the README/resume, not in front of sellers. */

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
    body: "Autopilot is opt-in and only ever acts on items it's confident about. Nothing posts, replies, or changes a price without a rule you set.",
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
    a: "eBay is fully connected, so listings publish straight to your own eBay account. Facebook Marketplace and Mercari don't allow direct posting, so for those you get clean copy-paste packs. We never scrape anything.",
  },
  {
    q: "How accurate is the pricing?",
    a: "It depends on the item, and we always show you where the price came from. Books and media with an ISBN are the strongest, an exact lookup with no guessing. Branded items are priced from what similar ones recently sold for, which is solid. Everyday items get a rougher estimate marked down from the new price, and we label it as less certain. Every price is yours to edit.",
  },
  {
    q: "Is my data private?",
    a: "Yes. Your photos are private, and only you can reach them. Your account's data is walled off from everyone else's, and your eBay connection is stored encrypted. If you ask eBay to remove your account, that request is honored end to end.",
  },
  {
    q: "Does autopilot post things without asking me?",
    a: "Only if you turn it on, and only for items it's genuinely sure about. That confidence comes from how the price was found, how closely recent sales agree, and how well it pinned down the item, never the AI grading its own work. Everything else waits for your review, and you can keep autopilot off entirely.",
  },
  {
    q: "What does it cost?",
    a: "Nothing during beta. Every feature, no credit card. Paid tiers come later, and beta users keep early-bird pricing.",
  },
  {
    q: "Do I need my own eBay account?",
    a: "Yes, and that's a feature. Listings publish under your own identity and reputation. You connect your account once, and SnapList never sees your eBay password.",
  },
] as const;

/**
 * Founder's note for the About hero — a short, human "why I built this" in the
 * seller's voice (application-voice: no em dashes, concrete, plain words),
 * signed with the shared LogoMark so the monogram matches the nav exactly.
 * Replaces the old turntable price report, which only duplicated the product
 * demos already on Home and Tour.
 */
function AboutFounderNote() {
  return (
    <div className="glass-panel relative flex h-full flex-col justify-between gap-8 overflow-hidden rounded-3xl p-8 sm:p-10">
      <div>
        <span className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-iris">
          From the founder
        </span>
        <p className="mt-5 text-[18px] leading-relaxed text-flash-dim sm:text-[18.5px]">
          SnapList started with one frustration. Every item I sold cost the same
          half hour of price research and copywriting before it ever went live.
          So I built the tool that gives that time back. You snap the photo and
          approve what matters. SnapList does the rest.
        </p>
      </div>
      <div className="flex items-center gap-3.5">
        <LogoMark className="size-11 shrink-0" />
        <span className="flex flex-col leading-tight">
          <span className="font-display text-[16px] font-semibold text-flash">
            Aziz
          </span>
          <span className="text-[13px] text-flash-faint">Founder, SnapList</span>
        </span>
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
                Every item is the same half hour. You photograph it, then try to
                guess what it&apos;s worth used, which is harder than it sounds
                because real sold prices are tough to find. You write a listing
                that doesn&apos;t sound desperate, post it, and then answer the
                same three buyer questions.
              </p>
              <p>
                SnapList collapses that into a photo and a couple of approvals.
                It identifies the item and prices it from what similar things
                actually sold for, then writes the listing for you. You review
                what matters, and nothing goes live without you.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.15} className="h-full">
            <AboutFounderNote />
          </Reveal>
        </div>
      </section>

      <section className="relative mx-auto w-full max-w-6xl px-5 pb-20 sm:px-8">
        <Reveal>
          <Eyebrow n="01" tint="indigo">
            Principles
          </Eyebrow>
          <h2 className="mt-4 font-display text-[clamp(26px,3.4vw,38px)] font-bold tracking-tight text-flash">
            Principles we don&apos;t{" "}
            <em className="text-iris">bend</em>
          </h2>
          <p className="mt-4 max-w-[54ch] text-[16px] leading-relaxed text-flash-dim">
            Four rules we hold to, even when bending them would be easier. They
            shape every price and every listing you see.
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
                <span className="nums font-display text-[15px] font-bold text-iris/70">
                  0{i + 1}
                </span>
              </div>
              <h3 className="mt-5 font-display text-[20px] font-semibold text-flash">
                {title}
              </h3>
              <p className="mt-3 text-[16px] leading-relaxed text-flash-dim">
                {body}
              </p>
            </SpotlightCard>
          ))}
        </Reveal>
      </section>

      {/* one clean question list — no anchor card, no side column (ui-r5) */}
      <section id="faq" className="border-t border-line bg-night-2">
        <div className="mx-auto w-full max-w-3xl px-5 py-20 sm:px-8 sm:py-24">
          <Reveal className="flex flex-col items-center text-center">
            <Eyebrow n="02" tint="cyan">
              FAQ
            </Eyebrow>
            <h2 className="mt-4 font-display text-[clamp(28px,3.6vw,40px)] font-bold tracking-tight text-flash">
              The questions everyone asks
            </h2>
            <p className="mt-4 max-w-[52ch] text-[16.5px] leading-relaxed text-flash-dim">
              Marketplaces, accuracy, privacy, and what autopilot will never
              do without you, answered straight.
            </p>
          </Reveal>
          <Reveal delay={0.1} className="mt-12">
            <FaqAccordion items={FAQ} />
          </Reveal>
        </div>
      </section>

      <section className="mx-auto w-full max-w-3xl px-5 py-16 text-center sm:px-8 sm:py-20">
        <Reveal>
          <h2 className="font-display text-[clamp(28px,4vw,42px)] font-bold tracking-tight text-flash">
            Got something to sell?
          </h2>
          <Link
            href="/login"
            className="group mt-8 inline-flex items-center gap-2 rounded-full bg-iris px-7 py-3.5 text-[16.5px] font-semibold text-iris-ink transition-transform hover:scale-[1.03]"
          >
            Snap your first photo
            <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
          </Link>
        </Reveal>
      </section>
    </>
  );
}
