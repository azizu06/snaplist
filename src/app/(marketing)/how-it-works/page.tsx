import type { Metadata } from "next";
import Link from "next/link";
import { Reveal } from "@/components/marketing/reveal";
import { DemoClip } from "@/components/marketing/demo-clip";
import { WaterfallExplorer } from "@/components/marketing/waterfall-explorer";
import { HiwJourneyRail } from "@/components/marketing/hiw-journey-rail";
import { HiwPipelineNav } from "@/components/marketing/hiw-pipeline-nav";
import { HIW_GLYPHS } from "@/components/marketing/hiw-glyphs";
import {
  Eyebrow,
  LensRings,
  SnapIdentityCard,
} from "@/components/marketing/visuals";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Photo → identification → researched price with sources → platform-native listings → publish. The SnapList pipeline, step by step.",
};

/**
 * /how-it-works (ui-r4-hiw) — the pipeline walkthrough at demo scale.
 * Owner round-4 feedback drove this layout: the five step clips
 * (/demo/steps/*.mp4, 1920×1080 loops via DemoClip — lazy-mounted, designed
 * slate fallback) now run near-content-width (~63% of a max-w-7xl row,
 * alternating sides) so the UI inside each recording is actually readable;
 * the buyer-Q&A clip gets the same treatment. The old ScrollVelocity verb
 * marquee is replaced by HiwPipelineNav (rich verb cards with hover clip
 * previews that deep-link to #step-{id}), and HiwJourneyRail is the premium
 * three-moves overview (connected rail, one item travelling it). The
 * WaterfallExplorer mirrors the real PricingProvider router tiers — keep in
 * sync. Products: gameboy (hero + rail); the step clips embed their own
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
    body: "A vision model extracts brand, model, category, condition, and key specs into a strict schema. Ambiguous items get flagged, never silently guessed.",
    poster: "Pixels in, validated attributes out.",
  },
  {
    n: "03",
    id: "price",
    title: "Price",
    body: "A research agent works the waterfall below and synthesizes a suggested price, a realistic range, and the sources it used — sold signals over asking prices.",
    poster: "A defensible number, with its receipts.",
  },
  {
    n: "04",
    id: "write",
    title: "Write",
    body: "One validated core renders platform-fluent copy: eBay item specifics and keyword titles, Facebook's casual local tone, Mercari's hashtags and shipping framing.",
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
        <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[1fr_380px]">
          <Reveal>
            <Eyebrow>How it works</Eyebrow>
            <h1 className="mt-4 max-w-3xl font-display text-[clamp(36px,5.2vw,60px)] font-bold leading-[1.05] tracking-tight text-flash">
              One photo in.
              <br />A <em className="text-iris">defensible</em> listing out.
            </h1>
            <p className="mt-5 max-w-[52ch] text-[17px] leading-relaxed text-flash-dim">
              SnapList is a pipeline, not a magic trick. Here is exactly what
              happens between your camera roll and a live eBay listing.
            </p>
          </Reveal>
          <Reveal delay={0.15} className="hidden lg:block">
            <SnapIdentityCard />
          </Reveal>
        </div>
      </section>

      {/* the whole journey, three moves — connected rail, one item travelling it */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <Reveal>
          <Eyebrow>The short version</Eyebrow>
          <h2 className="mt-4 max-w-2xl font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-tight tracking-tight text-flash">
            Three moves. <em className="text-iris">That&apos;s the whole job.</em>
          </h2>
          <p className="mt-4 max-w-[56ch] text-[16px] leading-relaxed text-flash-dim">
            Watch one Game Boy make the trip: photographed, researched, live —
            the only part that&apos;s yours is the approval.
          </p>
        </Reveal>
        <div className="mt-14">
          <HiwJourneyRail />
        </div>
      </section>

      {/* the pipeline verbs as navigation — hover previews, click to jump */}
      <section className="border-y border-line bg-night-2 py-12 sm:py-14">
        <div className="mx-auto mb-8 flex w-full max-w-7xl flex-wrap items-end justify-between gap-3 px-5 sm:px-8">
          <Eyebrow tint="indigo">The pipeline, up close</Eyebrow>
          <p className="text-[13px] font-medium text-flash-faint">
            Pick a step to jump straight to it
          </p>
        </div>
        <HiwPipelineNav />
      </section>

      {/* the five steps — demo clips at readable scale, alternating sides */}
      <section className="mx-auto w-full max-w-7xl px-5 py-24 sm:px-8 sm:py-28">
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

      {/* interactive pricing waterfall */}
      <section className="border-t border-line bg-night-2">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8 sm:py-28">
          <Reveal>
            <Eyebrow tint="cyan">The pricing waterfall</Eyebrow>
            <h2 className="mt-4 max-w-2xl font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-tight tracking-tight text-flash">
              The best source that exists for <em className="text-iris">your</em>{" "}
              item — honestly labeled
            </h2>
            <p className="mt-4 max-w-[58ch] text-[16px] leading-relaxed text-flash-dim">
              Not every item can be priced with the same rigor. Pick a tier to
              see what it actually does — the confidence score always tells
              you which one fired.
            </p>
          </Reveal>
          <Reveal className="mt-12">
            <WaterfallExplorer />
          </Reveal>
        </div>
      </section>

      {/* buyer messaging — same demo scale as the steps */}
      <section className="mx-auto w-full max-w-7xl px-5 py-24 sm:px-8 sm:py-28">
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
                drafted from the item&apos;s real attributes — edition,
                condition, what&apos;s included. You approve, edit, or rewrite;
                nothing sends without you.
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
      </section>

      <section className="border-t border-line bg-night-2 px-5 py-24 text-center sm:px-8 sm:py-28">
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
