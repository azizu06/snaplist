import Link from "next/link";
import BlurText from "@/components/bits/BlurText";
import ClickSpark from "@/components/bits/ClickSpark";
import CountUp from "@/components/bits/CountUp";
import GlareHover from "@/components/bits/GlareHover";
import GradientText from "@/components/bits/GradientText";
import Magnet from "@/components/bits/Magnet";
import RotatingText from "@/components/bits/RotatingText";
import ShinyText from "@/components/bits/ShinyText";
import SplitText from "@/components/bits/SplitText";
import SpotlightCard from "@/components/bits/SpotlightCard";
import { Reveal } from "@/components/marketing/reveal";
import { PlatformCardsVisual } from "@/components/marketing/visuals";

/**
 * Landing (react-bits pass): five sections, down from seven. The hero demo IS
 * the pitch — a photo becoming a priced, published listing on loop. The
 * rotating category line replaced the marquee; the stats row merged into the
 * storefronts section. Animated text uses the vendored react-bits components
 * (SplitText/BlurText/RotatingText) instead of Reveal — never both.
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

const FEATURES = [
  {
    title: "Prices that show their work",
    body: "No black-box numbers. Every suggestion comes as a price, a range, and the cited comps it was built from — ISBN lookups for books, live web research for the rest.",
    tag: "Pricing engine",
  },
  {
    title: "Autopilot with a conscience",
    body: "Confidence is computed from real signals — which pricing tier fired, how tightly comps agree, how complete the identification is. High confidence can publish itself; anything murky waits for you.",
    tag: "Confidence gate",
  },
  {
    title: "Listings that sound native",
    body: "eBay item specifics, Facebook's casual tone, Mercari's hashtags — one item, three platform-fluent listings.",
    tag: "Generation",
  },
  {
    title: "Yours, privately",
    body: "Your own eBay account over OAuth with encrypted tokens, photos in private storage, every row isolated per account. Listings publish under you and nothing leaks.",
    tag: "Security",
  },
] as const;

const STATS = [
  { prefix: "~", value: 30, suffix: "s", label: "from photo to draft listing" },
  { prefix: "", value: 3, suffix: "", label: "marketplaces from one photo" },
  { prefix: "", value: 100, suffix: "%", label: "of prices arrive with sources" },
] as const;

export default function Landing() {
  return (
    <>
      {/* ====== 1 · hero — Stripe rainbow slab, navy type, Remotion demo ====== */}
      <section className="relative overflow-hidden pb-20 pt-32 sm:pb-28 sm:pt-40">
        <div aria-hidden className="prism-gradient" />
        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-white/70 px-3.5 py-1.5 text-[12px] font-semibold text-flash backdrop-blur">
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
              className="mt-6 max-w-[46ch] text-[16.5px] font-medium leading-relaxed text-flash/90"
            />
            {/* rotating categories — this line replaced the old marquee section */}
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] font-semibold text-flash/80">
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
            <p className="mt-6 text-[12.5px] font-medium text-flash/70">
              Free while in beta · no credit card · your eBay account, your
              sales
            </p>
          </div>

          <div className="flex justify-center lg:justify-end">
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

      {/* ============================ 3 · features ============================ */}
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
          <Reveal stagger className="mt-14 grid gap-5 md:grid-cols-2">
            {FEATURES.map(({ title, body, tag }) => (
              <GlareHover
                key={title}
                className="rounded-2xl shadow-card"
                glareColor="#6d4aff"
                glareOpacity={0.09}
                glareAngle={-30}
                glareSize={300}
                transitionDuration={800}
              >
                <div className="p-7">
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
              </GlareHover>
            ))}
          </Reveal>
        </div>
      </section>

      {/* ============== 4 · one photo, three storefronts (+ stats) ============ */}
      <section className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
        <Reveal>
          <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-iris">
            Multi-marketplace
          </p>
          <h2 className="mt-3 max-w-2xl font-display text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-tight text-flash">
            One photo,{" "}
            <em className="text-iris">
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
        {/* compact stat row — absorbed the old standalone stats section */}
        <Reveal stagger className="mt-16 grid gap-10 border-t border-line pt-12 text-center sm:grid-cols-3">
          {STATS.map(({ prefix, value, suffix, label }) => (
            <div key={label}>
              <p className="nums font-display text-[clamp(34px,4.5vw,48px)] font-bold tracking-tight text-flash">
                {prefix}
                <CountUp to={value} duration={1.2} />
                {suffix}
              </p>
              <p className="mt-1.5 text-[14px] text-flash-faint">{label}</p>
            </div>
          ))}
        </Reveal>
      </section>

      {/* ============================ 5 · final CTA ============================ */}
      <section className="aurora relative overflow-hidden border-t border-line">
        <div className="mx-auto w-full max-w-3xl px-5 py-28 text-center sm:px-8 sm:py-36">
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
