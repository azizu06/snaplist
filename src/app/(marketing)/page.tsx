import Link from "next/link";
import BlurText from "@/components/bits/BlurText";
import CardSwap, { Card } from "@/components/bits/CardSwap";
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
import {
  ConfidenceGaugeVisual,
  PlatformCardsVisual,
  PriceModuleVisual,
} from "@/components/marketing/visuals";

/**
 * Landing (react-bits bold pass): the page is visibly alive, not just
 * entrance-animated. Persistent on-page motion comes from five layers —
 * LightRays streaming through the prism slab, a CardSwap deck cycling the
 * product story in the hero, the marketplace LogoLoop band, the MagicBento
 * features grid (spotlight + border glow + hover particles), and Threads
 * behind the final CTA. Text animation (SplitText/BlurText/RotatingText)
 * carries over from the first react-bits pass.
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
      {/* ====== 1 · hero — prism slab + LightRays, CardSwap product deck ====== */}
      <section className="relative overflow-hidden pb-20 pt-32 sm:pb-28 sm:pt-40">
        <div aria-hidden className="prism-gradient" />
        <div aria-hidden className="prism-grain" />
        <HeroPrismRays />
        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-white/85 px-3.5 py-1.5 text-[12px] font-semibold text-flash shadow-xs backdrop-blur">
              <span className="size-1.5 rounded-full bg-iris" />
              AI-priced listings, live on eBay
            </span>
            <h1 className="mt-6 font-display text-[clamp(40px,6vw,68px)] font-bold leading-[1.02] tracking-tight text-flash">
              <SplitText
                text="Snap a photo."
                tag="span"
                className="block"
                textAlign="left"
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
                textAlign="left"
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
              className="mt-6 max-w-[46ch] text-[16.5px] font-medium leading-relaxed text-flash"
            />
            {/* rotating categories — this line replaced the old marquee section */}
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] font-semibold text-flash/90">
              <span>Built for</span>
              <RotatingText
                texts={[...ROTATING_CATEGORIES]}
                mainClassName="overflow-hidden rounded-full bg-white/70 px-3 py-0.5 text-iris backdrop-blur"
                staggerFrom="last"
                staggerDuration={0.02}
                rotationInterval={2200}
                initial={{ y: "100%", opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: "-120%", opacity: 0 }}
              />
              <span>and everything shelved beside them.</span>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-3.5">
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
                    className="group inline-flex items-center gap-2 rounded-full bg-flash px-6 py-3 text-[15px] font-semibold text-white transition-transform duration-200 hover:scale-[1.03] active:scale-[0.98]"
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
                className="inline-flex items-center gap-2 rounded-full bg-white/70 px-6 py-3 text-[15px] font-semibold text-flash backdrop-blur transition-colors hover:bg-white"
              >
                See how it works
              </Link>
            </div>
            <p className="mt-6 text-[12.5px] font-medium text-flash/85">
              Free while in beta · no credit card · your eBay account, your
              sales
            </p>
          </div>

          {/* Desktop: a CardSwap deck cycling demo → price research → confidence.
              Mobile/tablet: the plain demo video (no 3D deck on small screens). */}
          <div className="relative hidden h-[460px] lg:block">
            <div className="absolute inset-0 -translate-y-20">
            <CardSwap
              width={470}
              height={400}
              cardDistance={56}
              verticalDistance={64}
              delay={4600}
              skewAmount={5}
              easing="elastic"
              pauseOnHover
            >
              <Card aria-label="Demo: a photo becomes a priced, published eBay listing">
                <div className="flex h-full flex-col">
                  <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                    <span className="size-2 rounded-full bg-iris" />
                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-flash-dim">
                      Live demo
                    </span>
                  </div>
                  <video
                    src="/hero-demo.mp4"
                    autoPlay
                    muted
                    loop
                    playsInline
                    className="h-full w-full flex-1 object-cover"
                  />
                </div>
              </Card>
              <Card aria-label="The price module: suggested price, range, and cited sources">
                <div className="flex h-full flex-col">
                  <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                    <span className="size-2 rounded-full bg-iris" />
                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-flash-dim">
                      Priced with receipts
                    </span>
                  </div>
                  <div className="flex-1 overflow-hidden [&>div]:border-0 [&>div]:shadow-none">
                    <PriceModuleVisual />
                  </div>
                </div>
              </Card>
              <Card aria-label="The confidence gauge and the signals feeding it">
                <div className="flex h-full flex-col">
                  <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                    <span className="size-2 rounded-full bg-iris" />
                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-flash-dim">
                      Confidence-gated
                    </span>
                  </div>
                  <div className="flex-1 overflow-hidden [&>div]:border-0 [&>div]:shadow-none">
                    <ConfidenceGaugeVisual />
                  </div>
                </div>
              </Card>
            </CardSwap>
            </div>
          </div>
          <div className="flex justify-center lg:hidden">
            <div className="glass-panel w-full max-w-[560px] overflow-hidden rounded-2xl">
              <video
                src="/hero-demo.mp4"
                autoPlay
                muted
                loop
                playsInline
                className="block h-auto w-full"
                aria-label="Demo: a photo becomes a priced, published eBay listing"
              />
            </div>
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
            The same validated item renders platform-fluent copy for each
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
