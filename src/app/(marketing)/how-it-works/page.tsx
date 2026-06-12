import type { Metadata } from "next";
import Link from "next/link";
import ScrollVelocity from "@/components/bits/ScrollVelocity";
import { Reveal } from "@/components/marketing/reveal";
import { DemoClip } from "@/components/marketing/demo-clip";
import { WaterfallExplorer } from "@/components/marketing/waterfall-explorer";
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
 * /how-it-works (subpages v3) — the pipeline walkthrough rebuilt around the
 * five step clips (/demo/steps/*.mp4, 1920×1080 loops; DemoClip lazy-loads
 * them and falls back to a designed slate while a render is missing), an
 * interactive pricing-waterfall explorer that mirrors the real
 * PricingProvider router tiers (keep in sync), and the buyer-Q&A clip.
 * Products are the how-it-works pool: gameboy (hero), guitar (waterfall);
 * the mixer headlines /about.
 */

const STEP_GLYPHS: Record<string, React.ReactNode> = {
  snap: (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  ),
  identify: (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  price: (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" x2="12" y1="2" y2="22" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  write: (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </svg>
  ),
  publish: (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  ),
};

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
            <h1 className="mt-4 max-w-3xl font-display text-[clamp(34px,5vw,56px)] font-bold leading-[1.05] tracking-tight text-flash">
              One photo in.
              <br />A <em className="text-iris">defensible</em> listing out.
            </h1>
            <p className="mt-5 max-w-[52ch] text-[16px] leading-relaxed text-flash-dim">
              SnapList is a pipeline, not a magic trick. Here is exactly what
              happens between your camera roll and a live eBay listing.
            </p>
          </Reveal>
          <Reveal delay={0.15} className="hidden lg:block">
            <SnapIdentityCard />
          </Reveal>
        </div>
      </section>

      {/* react-bits ScrollVelocity — the pipeline as a scroll-reactive marquee */}
      <section className="overflow-hidden border-y border-line bg-night-2 py-8 sm:py-10">
        <ScrollVelocity
          velocity={55}
          numCopies={8}
          texts={[
            <span key="pipeline" className="text-flash">
              Snap <span className="text-iris">·</span> Identify{" "}
              <span className="text-iris">·</span> Price{" "}
              <span className="text-iris">·</span> Write{" "}
              <span className="text-iris">·</span> Publish{" "}
              <span className="text-iris">·</span>
            </span>,
            <span key="marketplaces" className="text-flash-faint/45">
              eBay <span className="text-iris/50">·</span> Facebook
              Marketplace <span className="text-iris/50">·</span> Mercari{" "}
              <span className="text-iris/50">·</span>
            </span>,
          ]}
        />
      </section>

      {/* the five steps, each with its rendered demo clip */}
      <section className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
        <div className="space-y-16 sm:space-y-20">
          {STEPS.map(({ n, id, title, body, poster }, i) => (
            <Reveal key={n} delay={0.05}>
              <div
                className={`grid items-center gap-8 lg:gap-14 ${
                  i % 2 === 0 ? "lg:grid-cols-[1fr_460px]" : "lg:grid-cols-[460px_1fr]"
                }`}
              >
                <div className={i % 2 === 0 ? "" : "lg:order-2"}>
                  <Eyebrow n={n}>{`Step ${i + 1}`}</Eyebrow>
                  <h2 className="mt-3.5 font-display text-[clamp(24px,3vw,32px)] font-bold tracking-tight text-flash">
                    {title}
                  </h2>
                  <p className="mt-3.5 max-w-[56ch] text-[15px] leading-relaxed text-flash-dim">
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
                    glyph={STEP_GLYPHS[id]}
                  />
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* interactive pricing waterfall */}
      <section className="border-t border-line bg-night-2">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <Reveal>
            <Eyebrow tint="cyan">The pricing waterfall</Eyebrow>
            <h2 className="mt-4 max-w-2xl font-display text-[clamp(26px,3.6vw,40px)] font-bold leading-tight tracking-tight text-flash">
              The best source that exists for <em className="text-iris">your</em>{" "}
              item — honestly labeled
            </h2>
            <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-flash-dim">
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

      {/* buyer messaging */}
      <section className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
        <Reveal>
          <div className="grid items-center gap-8 lg:grid-cols-[1fr_460px] lg:gap-14">
            <div>
              <Eyebrow n="06" tint="rose">
                After it&apos;s live
              </Eyebrow>
              <h2 className="mt-3.5 font-display text-[clamp(24px,3vw,32px)] font-bold tracking-tight text-flash">
                Buyer questions, pre-answered
              </h2>
              <p className="mt-3.5 max-w-[56ch] text-[15px] leading-relaxed text-flash-dim">
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
              glyph={STEP_GLYPHS.chat}
            />
          </div>
        </Reveal>
      </section>

      <section className="border-t border-line bg-night-2 px-5 py-24 text-center sm:px-8">
        <Reveal>
          <h2 className="font-display text-[clamp(28px,4vw,42px)] font-bold tracking-tight text-flash">
            See it on your own shelf
          </h2>
          <Link
            href="/login"
            className="group mt-8 inline-flex items-center gap-2 rounded-full bg-iris px-7 py-3.5 text-[15px] font-semibold text-iris-ink transition-transform hover:scale-[1.03]"
          >
            Try it free
            <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
          </Link>
        </Reveal>
      </section>
    </>
  );
}
