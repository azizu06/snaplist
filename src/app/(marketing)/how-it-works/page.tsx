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
 * /how-it-works (ui-r6-remotion) — the pipeline walkthrough at demo scale.
 * Owner round-6 feedback: the step clips were too small ("the user shouldn't
 * have to squint") and the buyer-Q&A band duplicated the step format. Now the
 * pipeline section breaks out of the content column (max-w-[1720px]) and the
 * clip takes ~3/4 of each row; buyer Q&A joined the same section as step 06
 * ("After it's live") in the identical alternating text/video format. Section
 * order: hero (ScanShowcase) → step-intro header → SIX step clips
 * (/demo/steps/*.mp4 + /demo/buyer-qa.mp4, 1920×1080 loops via DemoClip,
 * alternating sides) → pricing waterfall LAST → CTA. The WaterfallExplorer
 * mirrors the real PricingProvider router tiers — keep in sync. The step
 * clips embed their own assigned items (see DEMO_SURFACE_ASSIGNMENTS).
 */

const STEPS = [
  {
    n: "01",
    eyebrow: "Step 1",
    tint: undefined,
    src: "/demo/steps/snap.mp4",
    glyph: "snap",
    title: "Snap",
    body: "One photo — or up to four if condition matters. Visible barcodes and ISBNs are read automatically, so books and boxed items start with an exact identity.",
    poster: "Four slots, thirty seconds of your time.",
    label: "Demo clip — the Snap step of the SnapList pipeline",
  },
  {
    n: "02",
    eyebrow: "Step 2",
    tint: undefined,
    src: "/demo/steps/identify.mp4",
    glyph: "identify",
    title: "Identify",
    body: "SnapList reads your photo and pulls out the brand, model, category, condition, and key details. If it isn't sure what it's looking at, it tells you — it never quietly guesses.",
    poster: "It knows exactly what it's looking at.",
    label: "Demo clip — the Identify step of the SnapList pipeline",
  },
  {
    n: "03",
    eyebrow: "Step 3",
    tint: undefined,
    src: "/demo/steps/price.mp4",
    glyph: "price",
    title: "Price",
    body: "SnapList researches what similar items recently sold for, then suggests a price, a realistic range, and the exact sources it used — real sale prices, not wishful asking prices.",
    poster: "A defensible number, with its receipts.",
    label: "Demo clip — the Price step of the SnapList pipeline",
  },
  {
    n: "04",
    eyebrow: "Step 4",
    tint: undefined,
    src: "/demo/steps/write.mp4",
    glyph: "write",
    title: "Write",
    body: "Your listing is written three ways, one per marketplace: eBay gets full item details and a search-friendly title, Facebook gets a casual local tone, Mercari gets hashtags and shipping details.",
    poster: "Three marketplaces, three native tongues.",
    label: "Demo clip — the Write step of the SnapList pipeline",
  },
  {
    n: "05",
    eyebrow: "Step 5",
    tint: undefined,
    src: "/demo/steps/publish.mp4",
    glyph: "publish",
    title: "Publish",
    body: "Review and edit anything, then publish to eBay under your own connected account. High-confidence items can go out on autopilot; the rest queue for you.",
    poster: "Live on eBay, under your name.",
    label: "Demo clip — the Publish step of the SnapList pipeline",
  },
  {
    n: "06",
    eyebrow: "After it's live",
    tint: "rose",
    src: "/demo/buyer-qa.mp4",
    glyph: "chat",
    title: "Answer",
    body: "Buyer questions, pre-answered. Incoming messages land in a live inbox with a reply already drafted from the item's real details — edition, condition, what's included. You approve, edit, or rewrite; nothing sends without you.",
    poster: "Drafted from the item's real details, sent by you.",
    label: "Demo clip — a buyer question arrives and a reply drafted from the item's details awaits approval",
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
            Six steps, one flow: five run every time you snap a photo, and the
            sixth keeps working after the listing is live. Here is each one
            doing its job — real screens, real items.
          </p>
        </Reveal>
      </section>

      {/* the six steps — demo clips at full demo scale, alternating sides.
          ui-r6: this section deliberately breaks out of the page's content
          column (max-w-[1720px]) and gives the clip ~3/4 of the row so the
          in-video UI is readable without squinting. */}
      <section className="mx-auto w-full max-w-[1720px] px-5 pb-24 pt-16 sm:px-8 sm:pb-28 sm:pt-20">
        <div className="space-y-24 sm:space-y-32">
          {STEPS.map(({ n, eyebrow, tint, src, glyph, title, body, poster, label }, i) => (
            <Reveal key={n} delay={0.05}>
              <div
                id={`step-${glyph === "chat" ? "qa" : glyph}`}
                className={`grid scroll-mt-24 items-center gap-9 lg:gap-12 ${
                  i % 2 === 0
                    ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,2.9fr)]"
                    : "lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,2.9fr)_minmax(0,1fr)]"
                }`}
              >
                <div className={i % 2 === 0 ? "" : "lg:order-2"}>
                  <Eyebrow n={n} tint={tint}>
                    {eyebrow}
                  </Eyebrow>
                  <h2 className="mt-4 font-display text-[clamp(28px,3.4vw,40px)] font-bold tracking-tight text-flash">
                    {title}
                  </h2>
                  <p className="mt-4 max-w-[48ch] text-[16px] leading-relaxed text-flash-dim">
                    {body}
                  </p>
                </div>
                <div className={i % 2 === 0 ? "" : "lg:order-1"}>
                  <DemoClip
                    src={src}
                    label={label}
                    n={n}
                    title={title}
                    caption={poster}
                    glyph={HIW_GLYPHS[glyph]}
                    className="rounded-3xl"
                  />
                </div>
              </div>
            </Reveal>
          ))}
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
