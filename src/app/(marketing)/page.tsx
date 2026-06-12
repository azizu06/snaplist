import Link from "next/link";
import { HeroDemo } from "@/components/marketing/hero-demo";
import { Reveal } from "@/components/marketing/reveal";
import { LensRings, PlatformCardsVisual } from "@/components/marketing/visuals";

/**
 * Landing (issue #49, Darkroom identity). The hero demo IS the pitch — a
 * photo becoming a priced, published listing on loop. Everything below it
 * reinforces the same three beats: identify, price with sources, publish.
 */

const MARQUEE_ITEMS = [
  "film cameras",
  "textbooks",
  "sneakers",
  "vinyl records",
  "board games",
  "headphones",
  "game consoles",
  "graphing calculators",
  "lenses",
  "keyboards",
  "watches",
  "jackets",
] as const;

const STEPS = [
  {
    n: "01",
    title: "Snap it",
    body: "One photo is enough — up to four if the condition matters. Barcodes and ISBNs are read automatically.",
  },
  {
    n: "02",
    title: "We research it",
    body: "The pipeline identifies brand, model and condition, then prices it against real comps — every number arrives with its sources.",
  },
  {
    n: "03",
    title: "You approve it",
    body: "A ready-to-post listing for eBay, plus copy-paste packs for Facebook Marketplace and Mercari. Edit anything, or let autopilot publish the confident ones.",
  },
] as const;

const FEATURES = [
  {
    big: true,
    title: "Prices that show their work",
    body: "No black-box numbers. Every suggestion comes as a price, a range, and the cited comps it was built from — ISBN lookups for books, live web research for the rest.",
    tag: "Pricing engine",
  },
  {
    big: true,
    title: "Autopilot with a conscience",
    body: "Confidence is computed from real signals — which pricing tier fired, how tightly comps agree, how complete the identification is. High confidence can publish itself; anything murky waits for you.",
    tag: "Confidence gate",
  },
  {
    big: false,
    title: "Listings that sound native",
    body: "eBay item specifics, Facebook's casual tone, Mercari's hashtags — one item, three platform-fluent listings.",
    tag: "Generation",
  },
  {
    big: false,
    title: "Buyer replies, drafted",
    body: "Incoming questions get grounded draft answers from your item's actual attributes. You approve before anything sends.",
    tag: "Inbox",
  },
  {
    big: false,
    title: "Your eBay, your identity",
    body: "Connect your own eBay account over OAuth — listings publish under you, tokens stay encrypted.",
    tag: "Integration",
  },
  {
    big: false,
    title: "Private by default",
    body: "Photos in private storage, every row isolated per account, deletion honored end-to-end.",
    tag: "Security",
  },
] as const;

export default function Landing() {
  return (
    <>
      {/* ================================ hero ================================ */}
      <section className="aurora grain relative overflow-hidden pb-20 pt-32 sm:pb-28 sm:pt-40">
        <LensRings className="pointer-events-none absolute -right-48 top-1/2 w-[640px] -translate-y-1/2 text-iris" />
        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <Reveal>
              <span className="inline-flex items-center gap-2 rounded-full border border-line bg-panel/60 px-3.5 py-1.5 text-[12px] font-medium text-flash-dim">
                <span className="size-1.5 rounded-full bg-iris" />
                AI-priced listings, live on eBay
              </span>
              <h1 className="mt-6 font-display text-[clamp(40px,6vw,68px)] font-bold leading-[1.02] tracking-tight text-flash">
                Snap a photo.
                <br />
                Sell it{" "}
                <em className="font-serif-accent font-normal italic text-iris">
                  properly
                </em>
                .
              </h1>
              <p className="mt-6 max-w-[46ch] text-[16.5px] leading-relaxed text-flash-dim">
                SnapList identifies what you&apos;re selling, researches a fair
                used price with cited sources, and writes the listing — eBay,
                Facebook Marketplace, and Mercari, from one photo.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3.5">
                <Link
                  href="/login"
                  className="group inline-flex items-center gap-2 rounded-full bg-iris px-6 py-3 text-[15px] font-semibold text-iris-ink shadow-[0_0_36px_-8px] shadow-iris/50 transition-transform hover:scale-[1.03] active:scale-[0.98]"
                >
                  Start selling free
                  <span aria-hidden className="transition-transform group-hover:translate-x-1">
                    →
                  </span>
                </Link>
                <Link
                  href="/how-it-works"
                  className="inline-flex items-center gap-2 rounded-full border border-line-2 px-6 py-3 text-[15px] font-medium text-flash transition-colors hover:bg-panel"
                >
                  See how it works
                </Link>
              </div>
              <p className="mt-6 text-[12.5px] text-flash-faint">
                Free while in beta · no credit card · your eBay account, your
                sales
              </p>
            </Reveal>
          </div>

          <div className="flex justify-center lg:justify-end">
            <HeroDemo />
          </div>
        </div>
      </section>

      {/* ============================== marquee ============================== */}
      <section
        aria-label="Things people sell with SnapList"
        className="border-y border-line/60 bg-night-2/60 py-5"
      >
        <div className="relative overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]">
          <div className="marquee-track flex w-max gap-3">
            {[...MARQUEE_ITEMS, ...MARQUEE_ITEMS].map((item, i) => (
              <span
                key={`${item}-${i}`}
                className="whitespace-nowrap rounded-full border border-line/70 px-4 py-1.5 text-[13px] font-medium text-flash-faint"
              >
                {item}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ============================ how it works ============================ */}
      <section className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
        <Reveal>
          <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-iris">
            How it works
          </p>
          <h2 className="mt-3 max-w-2xl font-display text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-tight text-flash">
            From shelf to{" "}
            <em className="font-serif-accent font-normal italic">sold</em> in
            three moves
          </h2>
        </Reveal>
        <Reveal stagger className="mt-14 grid gap-5 md:grid-cols-3">
          {STEPS.map(({ n, title, body }) => (
            <div
              key={n}
              className="group relative overflow-hidden rounded-2xl border border-line/70 bg-panel/50 p-7 transition-colors hover:border-line-2 hover:bg-panel"
            >
              <span className="nums font-display text-[13px] font-bold text-iris">
                {n}
              </span>
              <h3 className="mt-4 font-display text-[20px] font-semibold text-flash">
                {title}
              </h3>
              <p className="mt-2.5 text-[14px] leading-relaxed text-flash-dim">
                {body}
              </p>
              <span
                aria-hidden
                className="pointer-events-none absolute -bottom-12 -right-12 size-32 rounded-full bg-iris/0 blur-2xl transition-colors duration-500 group-hover:bg-iris/10"
              />
            </div>
          ))}
        </Reveal>
        <Reveal className="mt-10">
          <Link
            href="/how-it-works"
            className="group inline-flex items-center gap-2 text-[14.5px] font-semibold text-iris"
          >
            Walk through the whole pipeline
            <span aria-hidden className="transition-transform group-hover:translate-x-1">
              →
            </span>
          </Link>
        </Reveal>
      </section>

      {/* ============================= feature bento ========================== */}
      <section className="border-t border-line/60 bg-night-2/40">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
          <Reveal>
            <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-iris">
              Features
            </p>
            <h2 className="mt-3 max-w-2xl font-display text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-tight text-flash">
              Built like a marketplace pro,{" "}
              <em className="font-serif-accent font-normal italic">
                honest like a friend
              </em>
            </h2>
          </Reveal>
          <Reveal stagger className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ big, title, body, tag }) => (
              <div
                key={title}
                className={`group relative overflow-hidden rounded-2xl border border-line/70 bg-panel/50 p-7 transition-colors hover:border-line-2 hover:bg-panel ${
                  big ? "lg:col-span-1 lg:row-span-2" : ""
                }`}
              >
                <span className="rounded-full bg-iris/10 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.1em] text-iris">
                  {tag}
                </span>
                <h3 className="mt-4 font-display text-[19px] font-semibold leading-snug text-flash">
                  {title}
                </h3>
                <p className="mt-2.5 text-[14px] leading-relaxed text-flash-dim">
                  {body}
                </p>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      {/* ===================== one photo, three storefronts =================== */}
      <section className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
        <Reveal>
          <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-iris">
            Multi-marketplace
          </p>
          <h2 className="mt-3 max-w-2xl font-display text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-tight text-flash">
            One photo,{" "}
            <em className="font-serif-accent font-normal italic">
              three storefronts
            </em>
          </h2>
          <p className="mt-4 max-w-[54ch] text-[15px] leading-relaxed text-flash-dim">
            The same validated item renders platform-fluent copy for each
            marketplace — eBay publishes directly, Facebook and Mercari get
            clean copy-paste packs.
          </p>
        </Reveal>
        <Reveal delay={0.1} className="mt-12">
          <PlatformCardsVisual />
        </Reveal>
      </section>

      {/* =============================== stats ================================ */}
      <section className="mx-auto w-full max-w-6xl border-t border-line/60 px-5 py-24 sm:px-8">
        <Reveal stagger className="grid gap-10 text-center sm:grid-cols-3">
          {[
            ["~30s", "from photo to draft listing"],
            ["3", "marketplaces from one photo"],
            ["100%", "of prices arrive with sources"],
          ].map(([stat, label]) => (
            <div key={label}>
              <p className="nums font-display text-[clamp(40px,5vw,56px)] font-bold tracking-tight text-flash">
                {stat}
              </p>
              <p className="mt-1.5 text-[14px] text-flash-faint">{label}</p>
            </div>
          ))}
        </Reveal>
      </section>

      {/* ============================== final CTA ============================= */}
      <section className="aurora relative overflow-hidden border-t border-line/60">
        <div className="mx-auto w-full max-w-3xl px-5 py-28 text-center sm:px-8 sm:py-36">
          <Reveal>
            <h2 className="font-display text-[clamp(32px,5vw,52px)] font-bold leading-tight tracking-tight text-flash">
              That box in your closet is{" "}
              <em className="font-serif-accent font-normal italic text-iris">
                money
              </em>
            </h2>
            <p className="mx-auto mt-5 max-w-[44ch] text-[16px] leading-relaxed text-flash-dim">
              Photograph it once. SnapList does the research, the writing, and
              the posting — you keep the control and the cash.
            </p>
            <Link
              href="/login"
              className="group mt-9 inline-flex items-center gap-2 rounded-full bg-iris px-7 py-3.5 text-[15.5px] font-semibold text-iris-ink shadow-[0_0_44px_-8px] shadow-iris/50 transition-transform hover:scale-[1.03] active:scale-[0.98]"
            >
              Snap your first photo
              <span aria-hidden className="transition-transform group-hover:translate-x-1">
                →
              </span>
            </Link>
          </Reveal>
        </div>
      </section>
    </>
  );
}
