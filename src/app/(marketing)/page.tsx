import Link from "next/link";
import BlurText from "@/components/bits/BlurText";
import ClickSpark from "@/components/bits/ClickSpark";
import GradientText from "@/components/bits/GradientText";
import MagicBento from "@/components/bits/MagicBento";
import Magnet from "@/components/bits/Magnet";
import RotatingText from "@/components/bits/RotatingText";
import ScrollFloat from "@/components/bits/ScrollFloat";
import ShinyText from "@/components/bits/ShinyText";
import SplitText from "@/components/bits/SplitText";
import SpotlightCard from "@/components/bits/SpotlightCard";
import {
  CtaThreads,
  HeroPrismRays,
} from "@/components/marketing/live-backgrounds";
import { MarketplaceLoop } from "@/components/marketing/marketplace-loop";
import { Reveal } from "@/components/marketing/reveal";
import { PlatformCardsVisual } from "@/components/marketing/visuals";

/**
 * Landing (react-bits bold pass, round 2): the demo video IS the hero — flat,
 * large, full-width under the headline, never interrupted. Persistent motion
 * comes from LightRays streaming through the prism slab, the marketplace
 * LogoLoop band, the MagicBento features grid, and Threads behind the final
 * CTA. Text animation (SplitText/BlurText/RotatingText) carries over.
 */

const ROTATING_CATEGORIES = [
  "film cameras",
  "textbooks",
  "sneakers",
  "vinyl records",
  "board games",
  "headphones",
  "game consoles",
  "watches",
] as const;

const STEPS = [
  {
    n: "01",
    title: "Snap it",
    body: "One photo — up to four if condition matters. Barcodes and ISBNs are read automatically.",
  },
  {
    n: "02",
    title: "We research it",
    body: "We identify brand, model and condition, then price against real comps — every number cites its sources.",
  },
  {
    n: "03",
    title: "You approve it",
    body: "A ready-to-post eBay listing, plus packs for Facebook and Mercari. Edit anything, or let autopilot publish.",
  },
] as const;

/** MagicBento cells: the four features + the two numbers worth bragging about. */
const BENTO_CARDS = [
  {
    label: "Pricing engine",
    title: "Prices that show their work",
    description:
      "No black-box numbers. Every suggestion comes as a price, a range, and the cited comps it was built from — ISBN lookups for books, live web research for the rest.",
    className: "lg:col-span-2",
  },
  {
    label: "Speed",
    title: "~30 seconds",
    description: "from photo to a priced, written draft listing.",
  },
  {
    label: "Receipts",
    title: "100% cited",
    description: "every price arrives with the sources behind it.",
  },
  {
    label: "Confidence gate",
    title: "Autopilot with a conscience",
    description:
      "Confidence is computed from real signals — which pricing tier fired, how tightly comps agree, how complete the identification is. High confidence can publish itself; anything murky waits for you.",
    className: "lg:col-span-2",
  },
  {
    label: "Generation",
    title: "Listings that sound native",
    description:
      "eBay item specifics, Facebook's casual tone, Mercari's hashtags — one item, three platform-fluent listings.",
  },
  {
    label: "Security",
    title: "Yours, privately",
    description:
      "Your own eBay account over OAuth with encrypted tokens, photos in private storage, every row isolated per account.",
  },
] as const;

export default function Landing() {
  return (
    <>
      {/* ====== 1 · hero — prism slab + LightRays, demo video centerpiece ====== */}
      <section className="relative overflow-hidden pb-20 pt-32 sm:pb-24 sm:pt-40">
        <div aria-hidden className="prism-gradient" />
        <div aria-hidden className="prism-grain" />
        <HeroPrismRays />
        <div className="relative mx-auto w-full max-w-6xl px-5 sm:px-8">
          <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/85 px-3.5 py-1.5 text-[12px] font-semibold text-flash shadow-xs backdrop-blur dark:border dark:border-white/10 dark:bg-white/10">
              <span className="size-1.5 rounded-full bg-iris" />
              AI-priced listings, live on eBay
            </span>
            <h1 className="mt-6 font-display text-[clamp(40px,6vw,68px)] font-bold leading-[1.02] tracking-tight text-flash">
              <SplitText
                text="Snap a photo."
                tag="span"
                className="block"
                textAlign="center"
                splitType="chars"
                delay={28}
                duration={0.9}
                from={{ opacity: 0, y: 44 }}
                to={{ opacity: 1, y: 0 }}
              />
              <SplitText
                text="Sell it properly."
                tag="span"
                className="block"
                textAlign="center"
                splitType="chars"
                delay={28}
                duration={0.9}
                from={{ opacity: 0, y: 44 }}
                to={{ opacity: 1, y: 0, delay: 0.3 }}
              />
            </h1>
            <BlurText
              text="SnapList identifies what you're selling, researches a fair used price with cited sources, and writes the listing — eBay, Facebook Marketplace, and Mercari, from one photo."
              animateBy="words"
              delay={18}
              stepDuration={0.3}
              className="mt-6 max-w-[52ch] justify-center text-[16.5px] font-medium leading-relaxed text-flash"
            />
            {/* rotating categories — fixed-width pill, no reflow as words cycle */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[14px] font-semibold text-flash/90">
              <span>Built for</span>
              <RotatingText
                texts={[...ROTATING_CATEGORIES]}
                mainClassName="overflow-hidden rounded-full bg-white/70 px-3 py-0.5 text-iris backdrop-blur dark:bg-white/10"
                staggerFrom="last"
                staggerDuration={0.02}
                rotationInterval={2200}
                initial={{ y: "100%", opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: "-120%", opacity: 0 }}
              />
              <span>and everything shelved beside them.</span>
            </div>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3.5">
              <Magnet padding={80} magnetStrength={18}>
                <ClickSpark
                  className="inline-block"
                  sparkColor="#6d4aff"
                  sparkSize={9}
                  sparkRadius={22}
                  sparkCount={8}
                  duration={450}
                >
                  <Link
                    href="/login"
                    className="group inline-flex items-center gap-2 rounded-full bg-flash px-6 py-3 text-[15px] font-semibold text-white transition-transform duration-200 hover:scale-[1.03] active:scale-[0.98] dark:text-night"
                  >
                    Start selling free
                    <span aria-hidden className="transition-transform group-hover:translate-x-1">
                      →
                    </span>
                  </Link>
                </ClickSpark>
              </Magnet>
              <Link
                href="/how-it-works"
                className="group inline-flex items-center gap-2 rounded-full border border-flash/20 bg-white/80 px-6 py-3 text-[15px] font-semibold text-flash shadow-xs backdrop-blur transition-all duration-200 hover:border-flash/35 hover:bg-white hover:shadow-sm dark:bg-white/10 dark:hover:bg-white/15"
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="size-3.5 text-iris transition-transform group-hover:scale-110"
                  fill="currentColor"
                >
                  <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l10.54-6.86a1.04 1.04 0 0 0 0-1.76L9.56 4.26A1.04 1.04 0 0 0 8 5.14Z" />
                </svg>
                See how it works
              </Link>
            </div>
            <p className="mt-6 text-[12.5px] font-medium text-flash/85">
              Free while in beta · no credit card · your eBay account, your
              sales
            </p>
          </div>

          {/* The demo video — flat, large, the unmistakable centerpiece.
              The footage itself is white-background; in dark mode the frame
              gets a stronger border + a soft violet halo so it reads as an
              intentional bright "screen", not a glaring white hole. */}
          <div className="mx-auto mt-12 w-full max-w-5xl sm:mt-16">
            <video
              src="/hero-demo.mp4"
              autoPlay
              muted
              loop
              playsInline
              className="block h-auto w-full rounded-2xl border border-line bg-white shadow-[0_24px_64px_-24px_rgba(19,30,58,0.35),0_4px_16px_-6px_rgba(19,30,58,0.12)] dark:border-2 dark:border-white/20 dark:shadow-[0_0_0_1px_rgba(126,95,255,0.25),0_0_60px_-10px_rgba(126,95,255,0.35),0_24px_64px_-24px_rgba(0,0,0,0.7)]"
              aria-label="Demo: a photo becomes a priced, published eBay listing"
            />
          </div>
        </div>
      </section>

      {/* ====== 1.5 · marketplace band — persistent LogoLoop marquee ====== */}
      <section className="border-b border-line bg-night py-8">
        <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
          <p className="text-center text-[11.5px] font-semibold uppercase tracking-[0.18em] text-flash-faint">
            One photo, listed on
          </p>
          <div className="mt-5">
            <MarketplaceLoop />
          </div>
        </div>
      </section>

      {/* ========================== 2 · how it works ========================== */}
      <section className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
        <Reveal>
          <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-iris">
            How it works
          </p>
          <h2 className="mt-3 max-w-2xl font-display text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-tight text-flash">
            From shelf to{" "}
            <em className="text-iris">sold</em> in
            three moves
          </h2>
        </Reveal>
        <Reveal stagger className="mt-14 grid gap-5 md:grid-cols-3">
          {STEPS.map(({ n, title, body }) => (
            <SpotlightCard
              key={n}
              className="p-7"
              spotlightColor="rgba(109, 74, 255, 0.12)"
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
            </SpotlightCard>
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

      {/* ============== 3 · features — the MagicBento wow block ============== */}
      <section className="border-t border-line bg-night-2">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
          <Reveal>
            <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-iris">
              Features
            </p>
            <h2 className="mt-3 max-w-2xl font-display text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-tight text-flash">
              Built like a marketplace pro,{" "}
              <em className="text-iris">
                honest like a friend
              </em>
            </h2>
          </Reveal>
          <div className="mt-14">
            <MagicBento
              cards={[...BENTO_CARDS]}
              glowColor="109, 74, 255"
              enableTilt
              enableMagnetism={false}
              clickEffect
              particleCount={8}
              spotlightRadius={340}
            />
          </div>
        </div>
      </section>

      {/* ============== 4 · one photo, three storefronts (tilted) ============ */}
      <section className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
        <Reveal>
          <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-iris">
            Multi-marketplace
          </p>
        </Reveal>
        <ScrollFloat
          containerClassName="mt-3 max-w-2xl"
          textClassName="font-display text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-tight text-flash"
          accentWords={["three", "storefronts"]}
          stagger={0.02}
        >
          One photo, three storefronts
        </ScrollFloat>
        <Reveal>
          <p className="mt-4 max-w-[54ch] text-[15px] leading-relaxed text-flash-dim">
            Every validated item renders platform-fluent copy for its
            marketplace — eBay publishes directly, Facebook and Mercari get
            clean copy-paste packs.
          </p>
        </Reveal>
        <Reveal delay={0.1} className="mt-12">
          <PlatformCardsVisual />
        </Reveal>
      </section>

      {/* ============================ 5 · final CTA ============================ */}
      <section className="aurora relative overflow-hidden border-t border-line">
        <CtaThreads />
        <div className="relative mx-auto w-full max-w-3xl px-5 py-28 text-center sm:px-8 sm:py-36">
          <Reveal>
            <h2 className="font-display text-[clamp(32px,5vw,52px)] font-bold leading-tight tracking-tight text-flash">
              That box in your closet is{" "}
              <GradientText
                colors={["#6d4aff", "#635bff", "#9f7aff", "#6d4aff"]}
                animationSpeed={5}
              >
                money
              </GradientText>
            </h2>
            <p className="mx-auto mt-5 max-w-[44ch] text-[16px] leading-relaxed text-flash-dim">
              Photograph it once. SnapList does the research, the writing, and
              the posting — you keep the control and the cash.
            </p>
            <Magnet padding={80} magnetStrength={18} wrapperClassName="mt-9">
              <ClickSpark
                className="inline-block"
                sparkColor="#6d4aff"
                sparkSize={9}
                sparkRadius={22}
                sparkCount={8}
                duration={450}
              >
                <Link
                  href="/login"
                  className="group inline-flex items-center gap-2 rounded-full bg-iris px-7 py-3.5 text-[15.5px] font-semibold text-iris-ink transition-transform duration-200 hover:scale-[1.03] active:scale-[0.98]"
                >
                  <ShinyText
                    text="Snap your first photo"
                    color="rgba(255, 255, 255, 0.85)"
                    shineColor="#ffffff"
                    speed={2.4}
                    delay={1.2}
                  />
                  <span aria-hidden className="transition-transform group-hover:translate-x-1">
                    →
                  </span>
                </Link>
              </ClickSpark>
            </Magnet>
          </Reveal>
        </div>
      </section>
    </>
  );
}
