import type { Metadata } from "next";
import Link from "next/link";
import { Reveal } from "@/components/marketing/reveal";
import { DemoClip } from "@/components/marketing/demo-clip";
import { WaterfallExplorer } from "@/components/marketing/waterfall-explorer";
import { HIW_GLYPHS } from "@/components/marketing/hiw-glyphs";
import { ScanShowcase } from "@/components/marketing/scan-showcase";
import { Eyebrow, LensRings } from "@/components/marketing/visuals";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Photo → identification → researched price with sources → platform-native listings → publish. The SnapList pipeline, step by step.",
};

/**
 * /how-it-works (ui-r5-marketing) — the pipeline walkthrough at demo scale.
 * Owner round-5 feedback killed the repetition: HiwJourneyRail ("the short
 * version") and HiwPipelineNav ("the pipeline, up close") are gone — both
 * restated what the five step clips already show. In their place a single
 * plain heading block introduces the steps. Section order: hero (ScanShowcase)
 * → step-intro header → five step clips (/demo/steps/*.mp4, 1920×1080 loops
 * via DemoClip, near-content-width, alternating sides) → buyer-Q&A → pricing
 * waterfall LAST → CTA. The WaterfallExplorer mirrors the real
 * PricingProvider router tiers — keep in sync. The step clips embed their own
 * assigned items (see DEMO_SURFACE_ASSIGNMENTS).
 */

const STEPS = [
  {
    n: "01",
    id: "snap",
    title: "Snap",
    body: "One photo — or up to four if condition matters. Visible barcodes and ISBNs are read automatically, so books and boxed items start with an exact identity.",
    poster: "Four slots, thirty seconds of your time.",
  },
  {
    n: "02",
    id: "identify",
    title: "Identify",
    body: "SnapList reads your photo and pulls out the brand, model, category, condition, and key details. If it isn't sure what it's looking at, it tells you — it never quietly guesses.",
    poster: "It knows exactly what it's looking at.",
  },
  {
    n: "03",
    id: "price",
    title: "Price",
    body: "SnapList researches what similar items recently sold for, then suggests a price, a realistic range, and the exact sources it used — real sale prices, not wishful asking prices.",
    poster: "A defensible number, with its receipts.",
  },
  {
    n: "04",
    id: "write",
    title: "Write",
    body: "Your listing is written three ways, one per marketplace: eBay gets detailed item specifics and a search-friendly title, Facebook gets a casual local tone, Mercari gets hashtags and shipping details.",
    poster: "Three marketplaces, three native tongues.",
  },
  {
    n: "05",
    id: "publish",
    title: "Publish",
    body: "Review and edit anything, then publish to eBay under your own connected account. High-confidence items can go out on autopilot; the rest queue for you.",
    poster: "Live on eBay, under your name.",
  },
] as const;

export default function HowItWorks() {
  return (
    <>
      <section className="aurora grain relative overflow-hidden px-5 pb-16 pt-32 sm:px-8 sm:pt-40">
        <LensRings className="pointer-events-none absolute -right-40 -top-40 w-[560px] text-iris" />
        <div className="mx-auto w-full max-w-6xl">
          <Reveal className="mx-auto flex max-w-3xl flex-col items-center text-center">
            <Eyebrow>How it works</Eyebrow>
            <h1 className="mt-4 font-display text-[clamp(36px,5.2vw,60px)] font-bold leading-[1.05] tracking-tight text-flash">
              One photo in.
              <br />A <em className="text-iris">defensible</em> listing out.
            </h1>
            <p className="mt-5 max-w-[52ch] text-[17px] leading-relaxed text-flash-dim">
              SnapList is a pipeline, not a magic trick. Here is exactly what
              happens between your camera roll and a live eBay listing.
            </p>
          </Reveal>
          {/* The headline, performed: ten catalog photos cycle under a
              scanning beam; each completed scan flips the output panel to
              that product's real title / price / condition. */}
          <Reveal delay={0.15} className="mx-auto mt-12 w-full max-w-5xl sm:mt-14">
            <ScanShowcase />
          </Reveal>
        </div>
      </section>

      {/* one plain heading introduces the steps — no cards, no carousel
          (replaced the repetitive journey-rail + verb-card bands, ui-r5) */}
      <section className="mx-auto w-full max-w-7xl px-5 pt-20 sm:px-8 sm:pt-28">
        <Reveal className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <Eyebrow>The pipeline</Eyebrow>
          <h2 className="mt-4 font-display text-[clamp(30px,4vw,46px)] font-bold leading-tight tracking-tight text-flash">
            The pipeline, <em className="text-iris">step by step</em>
          </h2>
          <p className="mt-4 max-w-[54ch] text-[17px] leading-relaxed text-flash-dim">
            Five steps run every time you snap a photo. Here is each one doing
            its job — real screens, real items.
          </p>
        </Reveal>
      </section>

      {/* the five steps — demo clips at readable scale, alternating sides */}
      <section className="mx-auto w-full max-w-7xl px-5 pb-24 pt-16 sm:px-8 sm:pb-28 sm:pt-20">
        <div className="space-y-24 sm:space-y-32">
          {STEPS.map(({ n, id, title, body, poster }, i) => (
            <Reveal key={n} delay={0.05}>
              <div
                id={`step-${id}`}
                className={`grid scroll-mt-24 items-center gap-9 lg:gap-16 ${
                  i % 2 === 0
                    ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]"
                    : "lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]"
                }`}
              >
                <div className={i % 2 === 0 ? "" : "lg:order-2"}>
                  <Eyebrow n={n}>{`Step ${i + 1}`}</Eyebrow>
                  <h2 className="mt-4 font-display text-[clamp(28px,3.4vw,40px)] font-bold tracking-tight text-flash">
                    {title}
                  </h2>
                  <p className="mt-4 max-w-[48ch] text-[16px] leading-relaxed text-flash-dim">
                    {body}
                  </p>
                </div>
                <div className={i % 2 === 0 ? "" : "lg:order-1"}>
                  <DemoClip
                    src={`/demo/steps/${id}.mp4`}
                    label={`Demo clip — the ${title} step of the SnapList pipeline`}
                    n={n}
                    title={title}
                    caption={poster}
                    glyph={HIW_GLYPHS[id]}
                    className="rounded-3xl"
                  />
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* buyer messaging — same demo scale as the steps */}
      <section className="border-t border-line">
        <div className="mx-auto w-full max-w-7xl px-5 py-24 sm:px-8 sm:py-28">
        <Reveal>
          <div className="grid items-center gap-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)] lg:gap-16">
            <div>
              <Eyebrow n="06" tint="rose">
                After it&apos;s live
              </Eyebrow>
              <h2 className="mt-4 font-display text-[clamp(28px,3.4vw,40px)] font-bold tracking-tight text-flash">
                Buyer questions, pre-answered
              </h2>
              <p className="mt-4 max-w-[48ch] text-[16px] leading-relaxed text-flash-dim">
                Incoming messages land in a live inbox with a reply already
                drafted from the item&apos;s real details — edition, condition,
                what&apos;s included. You approve, edit, or rewrite; nothing
                sends without you.
              </p>
            </div>
            <DemoClip
              src="/demo/buyer-qa.mp4"
              label="Demo clip — a buyer question arrives and a grounded reply is drafted for approval"
              title="Buyer Q&A"
              caption="Drafted from attributes, sent by you."
              glyph={HIW_GLYPHS.chat}
              className="rounded-3xl"
            />
          </div>
        </Reveal>
        </div>
      </section>

      {/* interactive pricing waterfall — last stop before the CTA */}
      <section className="border-t border-line bg-night-2">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8 sm:py-28">
          <Reveal>
            <Eyebrow tint="cyan">Where the price comes from</Eyebrow>
            <h2 className="mt-4 max-w-2xl font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-tight tracking-tight text-flash">
              The best price source that exists for{" "}
              <em className="text-iris">your</em> item — honestly labeled
            </h2>
            <p className="mt-4 max-w-[58ch] text-[16px] leading-relaxed text-flash-dim">
              Not every item can be priced the same way. SnapList works down
              this list, uses the best source it can find for your item — and
              always shows you which one it used. Pick one to see how it works.
            </p>
          </Reveal>
          <Reveal className="mt-12">
            <WaterfallExplorer />
          </Reveal>
        </div>
      </section>

      <section className="border-t border-line px-5 py-24 text-center sm:px-8 sm:py-28">
        <Reveal>
          <h2 className="font-display text-[clamp(30px,4.2vw,46px)] font-bold tracking-tight text-flash">
            See it on your own shelf
          </h2>
          <p className="mx-auto mt-4 max-w-[44ch] text-[16px] leading-relaxed text-flash-dim">
            The whole pipeline you just read about, on your first photo —
            free while in beta.
          </p>
          <Link
            href="/login"
            className="group mt-9 inline-flex items-center gap-2 rounded-full bg-iris px-8 py-4 text-[15.5px] font-semibold text-iris-ink transition-transform hover:scale-[1.03]"
          >
            Try it free
            <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
          </Link>
        </Reveal>
      </section>
    </>
  );
}
