import Image from "next/image";
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
  CtaIridescence,
  HeroPrism,
} from "@/components/marketing/live-backgrounds";
import {
  MarketplaceBadge,
  MarketplaceLoop,
} from "@/components/marketing/marketplace-loop";
import { Reveal } from "@/components/marketing/reveal";
import { DEMO_PRODUCTS_BY_SLUG } from "@/lib/demo-products";

/**
 * Landing (v3 pass): the demo video IS the hero — flat, large, full-width
 * under the headline, never interrupted. Atmosphere comes from the Prism
 * shader behind the headline (the brand made literal) and an iridescent
 * violet field behind the final CTA; persistent product proof comes from
 * the finished-listings marquee and the MagicBento features grid.
 *
 * Affordance system (purple-pill fatigue fix): ONE glass pill in the hero
 * (status badge), dash-accented small-caps eyebrows on sections, numbered
 * steps, duotone status-tinted icon chips on bento cards, and status-tinted
 * confidence chips on listing cards. The identical violet pill never repeats.
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

const TRUST_POINTS = [
  "Free while in beta",
  "No credit card required",
  "Your eBay account, your sales",
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

/* ---------------------------------------------------------------------------
 * Small inline icons (lucide outlines) for the bento duotone chips + hero
 * trust strip. Kept local: they're presentation-only and page-specific.
 * ------------------------------------------------------------------------- */

function BentoIcon({ d }: { d: string[] }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {d.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

const ICONS = {
  tag: [
    "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z",
    "M7.5 7.5h.01",
  ],
  zap: [
    "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",
  ],
  fileText: [
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    "M14 2v4a2 2 0 0 0 2 2h4",
    "M10 9H8",
    "M16 13H8",
    "M16 17H8",
  ],
  shieldCheck: [
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "m9 12 2 2 4-4",
  ],
  sparkles: [
    "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
    "M20 3v4",
    "M22 5h-4",
  ],
  lock: [
    "M7 11V7a5 5 0 0 1 10 0v4",
    "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z",
  ],
} as const;

/** MagicBento cells: four features + the two numbers worth bragging about.
 *  Tints map to the status palette and never repeat on adjacent cards. */
const BENTO_CARDS = [
  {
    label: "Pricing engine",
    title: "Prices that show their work",
    description:
      "No black-box numbers. Every suggestion comes as a price, a range, and the cited comps it was built from — ISBN lookups for books, live web research for the rest.",
    icon: <BentoIcon d={[...ICONS.tag]} />,
    tint: "violet" as const,
    className: "lg:col-span-2",
  },
  {
    label: "Speed",
    title: "~30 seconds",
    description: "from photo to a priced, written draft listing.",
    icon: <BentoIcon d={[...ICONS.zap]} />,
    tint: "amber" as const,
  },
  {
    label: "Receipts",
    title: "100% cited",
    description: "every price arrives with the sources behind it.",
    icon: <BentoIcon d={[...ICONS.fileText]} />,
    tint: "blue" as const,
  },
  {
    label: "Confidence gate",
    title: "Autopilot with a conscience",
    description:
      "Confidence is computed from real signals — which pricing tier fired, how tightly comps agree, how complete the identification is. High confidence can publish itself; anything murky waits for you.",
    icon: <BentoIcon d={[...ICONS.shieldCheck]} />,
    tint: "green" as const,
    className: "lg:col-span-2",
  },
  {
    label: "Generation",
    title: "Listings that sound native",
    description:
      "eBay item specifics, Facebook's casual tone, Mercari's hashtags — one item, three platform-fluent listings.",
    icon: <BentoIcon d={[...ICONS.sparkles]} />,
    tint: "violet" as const,
  },
  {
    label: "Security",
    title: "Yours, privately",
    description:
      "Your own eBay account over OAuth with encrypted tokens, photos in private storage, every row isolated per account.",
    icon: <BentoIcon d={[...ICONS.lock]} />,
    tint: "blue" as const,
  },
] as const;

/** Dash-accented small-caps section eyebrow — the non-pill affordance. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-3 text-[12px] font-semibold uppercase tracking-[0.18em] text-flash-dim">
      <span aria-hidden className="h-[2px] w-7 rounded-full bg-iris" />
      {children}
    </p>
  );
}

/* ---------------------------------------------------------------------------
 * "One photo, three storefronts" — the single instance of the motif on the
 * whole site. One verified catalog product (the keyboard — reserved for this
 * section; the marquee runs the other five) rendered three platform-fluent
 * ways. Copy only restates attributes the photo verifies. Hover lifts via
 * whole-pixel translate — no scale / 3D transforms on text-bearing layers,
 * which is what blurred the old TiltedCard treatment.
 * ------------------------------------------------------------------------- */

const STOREFRONT_PRODUCT = DEMO_PRODUCTS_BY_SLUG.keyboard;

const STOREFRONTS = [
  {
    platform: "eBay",
    copy: "Custom 65% Mechanical Keyboard — Green & White Keycaps — Like New",
    note: "Item specifics · keyword title",
    delivery: "Publishes directly",
  },
  {
    platform: "Facebook",
    copy: "Custom mechanical keyboard, 65% layout with green & white keycaps. Like new — happy to demo at pickup.",
    note: "Casual · local pickup",
    delivery: "Copy-paste pack",
  },
  {
    platform: "Mercari",
    copy: "Custom 65% mech keyboard, green/white keycaps #mechkeyboard #65percent — ships next day",
    note: "Hashtags · shipping-first",
    delivery: "Copy-paste pack",
  },
] as const;

export default function Landing() {
  return (
    <>
      {/* ====== 1 · hero — Prism shader + gradient slab, demo video centerpiece ====== */}
      <section className="relative overflow-hidden pb-20 pt-32 sm:pb-24 sm:pt-40">
        <div aria-hidden className="prism-gradient" />
        <div aria-hidden className="prism-grain" />
        <HeroPrism />
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
            {/* Trust strip — glass surface so it stays legible over the
                gradient slab in both themes (it used to dissolve into it). */}
            <p className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 rounded-full border border-white/55 bg-white/70 px-5 py-2 text-[12.5px] font-semibold text-flash shadow-xs backdrop-blur dark:border-white/10 dark:bg-white/10">
              {TRUST_POINTS.map((point) => (
                <span key={point} className="flex items-center gap-1.5">
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden
                    className="size-3 text-iris"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  {point}
                </span>
              ))}
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

      {/* ====== 1.5 · finished-listings band — what SnapList produces ====== */}
      <section className="border-b border-line bg-night py-10">
        <p className="px-5 text-center text-[11.5px] font-semibold uppercase tracking-[0.18em] text-flash-faint">
          Snapped, priced, written — straight from the pipeline
        </p>
        <div className="mt-6">
          <MarketplaceLoop />
        </div>
      </section>

      {/* ========================== 2 · how it works ========================== */}
      <section className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
        <Reveal>
          <Eyebrow>How it works</Eyebrow>
          <h2 className="mt-4 max-w-2xl font-display text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-tight text-flash">
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
            <Eyebrow>Features</Eyebrow>
            <h2 className="mt-4 max-w-2xl font-display text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-tight text-flash">
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

      {/* ====== 4 · one photo, three storefronts — the motif's ONE home ====== */}
      <section className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
        <div className="relative overflow-hidden rounded-3xl border border-line bg-night-2 px-6 py-14 sm:px-10 sm:py-16">
          {/* faint violet pool so the framed panel reads intentional */}
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-iris/10 blur-3xl"
          />
          <Reveal>
            <Eyebrow>Multi-marketplace</Eyebrow>
          </Reveal>
          <ScrollFloat
            containerClassName="mt-4 max-w-2xl"
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
          <Reveal delay={0.1} className="relative mt-12">
            <div className="grid gap-5 lg:grid-cols-[300px_1fr] lg:items-stretch">
              {/* the one photo */}
              <figure className="flex flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
                <div className="relative aspect-[4/3] lg:min-h-0 lg:flex-1">
                  <Image
                    src={STOREFRONT_PRODUCT.image}
                    alt={STOREFRONT_PRODUCT.alt}
                    fill
                    sizes="(max-width: 1024px) 100vw, 300px"
                    className="object-cover"
                  />
                  <span className="absolute left-3 top-3 rounded-md bg-flash/80 px-2 py-1 text-[10.5px] font-semibold text-white backdrop-blur dark:bg-night/80 dark:text-flash">
                    The one photo
                  </span>
                </div>
                <figcaption className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
                  <span className="truncate text-[12px] font-semibold text-flash">
                    {STOREFRONT_PRODUCT.shortName}
                  </span>
                  <span className="nums shrink-0 text-[12px] font-semibold text-flash-dim">
                    ${STOREFRONT_PRODUCT.price} · {STOREFRONT_PRODUCT.condition}
                  </span>
                </figcaption>
              </figure>
              {/* three platform renderings — hover lifts whole-pixel, text never scales */}
              <div className="grid gap-4 sm:grid-cols-3">
                {STOREFRONTS.map(({ platform, copy, note, delivery }) => (
                  <div
                    key={platform}
                    className="flex h-full flex-col rounded-2xl border border-line bg-panel p-5 shadow-card transition-all duration-200 hover:-translate-y-1 hover:border-iris/40 hover:shadow-lg"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <MarketplaceBadge
                        marketplace={platform}
                        className="text-[13px]"
                      />
                      <span className="nums text-[13px] font-bold text-flash">
                        ${STOREFRONT_PRODUCT.price}
                      </span>
                    </div>
                    <p className="mt-3 text-[12.5px] leading-relaxed text-flash-dim">
                      {copy}
                    </p>
                    <p className="mt-auto pt-4 text-[10.5px] font-medium text-flash-faint">
                      {note} · {delivery}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ============================ 5 · final CTA ============================ */}
      <section className="aurora relative overflow-hidden border-t border-line">
        <CtaIridescence />
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
