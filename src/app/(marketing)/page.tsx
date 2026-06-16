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
import { CtaIridescence } from "@/components/marketing/live-backgrounds";
import {
  MarketplaceBadge,
  MarketplaceLoop,
} from "@/components/marketing/marketplace-loop";
import { Reveal } from "@/components/marketing/reveal";
import { ScanShowcase } from "@/components/marketing/scan-showcase";
import {
  DEMO_PRODUCTS_BY_SLUG,
  DEMO_SURFACE_ASSIGNMENTS,
} from "@/lib/demo-products";

/**
 * Landing (v3 pass): the live scanning showcase IS the hero — a scan beam
 * sweeps authentic seller photos and flips an output panel to each item's
 * real title, price, and condition, full-width under the headline. Atmosphere
 * comes from the green .prism-gradient slab behind the headline and an
 * iridescent green/teal field behind the final CTA; persistent product proof
 * comes from the finished-listings marquee and the MagicBento features grid.
 *
 * Affordance system: dash-accented small-caps eyebrows on sections, numbered
 * steps, duotone status-tinted icon chips on bento cards, and status-tinted
 * confidence chips on listing cards — no repeated pill chip.
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
    kicker: "Capture",
    title: "Snap it",
    body: "One photo, up to four if condition matters. Barcodes and ISBNs are read automatically.",
  },
  {
    n: "02",
    kicker: "Pricing",
    title: "We research it",
    body: "We work out the brand, model and condition, then price it against what similar items recently sold for. Every number shows where it came from.",
  },
  {
    n: "03",
    kicker: "Listing",
    title: "You approve it",
    body: "A ready-to-post eBay listing, plus packs for Facebook and Mercari. Edit anything, or let autopilot publish.",
  },
] as const;

/* ---------------------------------------------------------------------------
 * r6.1 — "From shelf to sold" step cards (Mobbin "how it works" reference:
 * the Hims / HODINKEE pattern of equal cards each led by one large image).
 * Every card opens with a media frame of the SAME dimensions (aspect-[4/3]);
 * the same used item (roller skates, exclusive to this surface) fills the top
 * of all three at the same size, with a step-specific detail panel docked inside
 * the frame — the listing card visibly growing stage by stage: captured →
 * priced → ready to post. Consistent imagery, no tiny boxed thumbnails. This
 * is the short teaser; /tour expands each stage into its full video step.
 * ------------------------------------------------------------------------- */

const STEP_PRODUCT =
  DEMO_PRODUCTS_BY_SLUG[DEMO_SURFACE_ASSIGNMENTS["landing-three-moves"][0]];

/** The media frame every step shares: a tall photo region + a fixed-height
 *  detail panel. Both dimensions are identical across all three cards, so the
 *  row is perfectly uniform (owner: "even throughout, not cramped"). */
function StepFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-hidden
      className="relative flex w-full flex-col overflow-hidden rounded-2xl border border-line bg-night-2"
    >
      {children}
    </div>
  );
}

/** The item photo region — same item, same fixed height in every frame
 *  (owner: keep it uniform/symmetric, give the photo room to breathe). Uses
 *  object-contain on the panel ground so the WHOLE item shows, never a zoomed
 *  crop (owner: "the image should convey the whole item" — same rule as the
 *  carousel). Height is fixed (not aspect-square) so the floating step chevron
 *  can stay pixel-anchored to the photo's vertical center. Overlays (the
 *  viewfinder) come in via children. */
function StepPhoto({ children }: { children?: React.ReactNode }) {
  return (
    <div className="relative h-72 w-full shrink-0 overflow-hidden bg-night-2">
      <Image
        src={STEP_PRODUCT.image}
        alt=""
        fill
        sizes="(max-width: 768px) 100vw, 440px"
        className="object-contain"
      />
      {children}
    </div>
  );
}

/** The detail panel docked beneath the photo — fixed height + generous padding
 *  so nothing (range labels, platform chips) crowds the frame edge. */
function StepPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-36 flex-col justify-center gap-2.5 border-t border-line bg-panel px-5 py-4">
      {children}
    </div>
  );
}

function StepEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-flash-faint">
      {children}
    </p>
  );
}

function CaptureFrame() {
  return (
    <StepFrame>
      <StepPhoto>
        {/* viewfinder brackets framing the whole photo */}
        <span className="absolute left-2.5 top-2.5 size-5 rounded-tl-[5px] border-l-2 border-t-2 border-iris" />
        <span className="absolute right-2.5 top-2.5 size-5 rounded-tr-[5px] border-r-2 border-t-2 border-iris" />
        <span className="absolute bottom-2.5 left-2.5 size-5 rounded-bl-[5px] border-b-2 border-l-2 border-iris" />
        <span className="absolute bottom-2.5 right-2.5 size-5 rounded-br-[5px] border-b-2 border-r-2 border-iris" />
      </StepPhoto>
      <StepPanel>
        <StepEyebrow>Captured</StepEyebrow>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[12.5px] text-flash-dim">IMG_2041.jpg</span>
          <span className="nums rounded-full border border-line bg-night-2 px-2 py-0.5 text-[11px] font-medium text-flash-dim">
            1 of 4
          </span>
        </div>
        <div className="flex gap-1">
          <span className="h-1 flex-1 rounded-full bg-iris" />
          <span className="h-1 flex-1 rounded-full bg-iris" />
          <span className="h-1 flex-1 rounded-full bg-line" />
          <span className="h-1 flex-1 rounded-full bg-line" />
        </div>
      </StepPanel>
    </StepFrame>
  );
}

function PriceFrame() {
  return (
    <StepFrame>
      <StepPhoto />
      <StepPanel>
        <StepEyebrow>Suggested price</StepEyebrow>
        <div className="flex items-baseline justify-between gap-2">
          <p className="nums font-display text-[30px] font-bold leading-none tracking-tight text-flash">
            ${STEP_PRODUCT.price}
          </p>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-night-2 px-2.5 py-1 text-[11px] font-medium text-flash-dim">
            <svg viewBox="0 0 10 10" className="size-2.5 text-success-soft-fg" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1.5 5.5l2.2 2.2L8.5 2.9" />
            </svg>
            3 sources
          </span>
        </div>
        <div>
          <div className="relative h-1.5 rounded-full bg-line">
            <span className="absolute inset-y-0 left-[8%] right-[8%] rounded-full bg-gradient-to-r from-[#1fb88c] via-[#008060] to-[#1fb88c] opacity-60" />
            <span className="absolute left-[42%] top-1/2 size-[13px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-panel bg-iris shadow-[0_0_0_3px_rgba(0, 128, 96,0.22)]" />
          </div>
          <div className="nums mt-1.5 flex justify-between text-[11px] font-medium text-flash-faint">
            <span>$170</span>
            <span>$240</span>
          </div>
        </div>
      </StepPanel>
    </StepFrame>
  );
}

const PLATFORMS = ["eBay", "Facebook", "Mercari"] as const;

function ListingFrame() {
  return (
    <StepFrame>
      <StepPhoto />
      <StepPanel>
        <div className="flex items-center justify-between gap-2">
          <StepEyebrow>Ready to post</StepEyebrow>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-[10.5px] font-semibold text-success-soft-fg">
            <span className="size-1.5 rounded-full bg-current" />
            Live-ready
          </span>
        </div>
        <p className="nums truncate text-[13.5px] font-semibold text-flash">
          {STEP_PRODUCT.title} · ${STEP_PRODUCT.price}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {PLATFORMS.map((p) => (
            <span
              key={p}
              className="rounded-md border border-line bg-night-2 px-2 py-0.5 text-[11px] font-medium text-flash-dim"
            >
              {p}
            </span>
          ))}
        </div>
      </StepPanel>
    </StepFrame>
  );
}

const STEP_FRAMES = [
  <CaptureFrame key="capture" />,
  <PriceFrame key="price" />,
  <ListingFrame key="listing" />,
];

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
      "No black-box numbers. Every suggestion comes with a price, a range, and the recent sale prices behind it. Books are matched by their ISBN, everything else is researched on the web.",
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
      "How sure we are isn't a guess. It comes from where the price was found, how closely recent sales agree, and how much we could pin down about the item. When we're sure, it can post on its own. When we're not, it waits for you.",
    icon: <BentoIcon d={[...ICONS.shieldCheck]} />,
    tint: "green" as const,
    className: "lg:col-span-2",
  },
  {
    label: "Generation",
    title: "Listings that sound native",
    description:
      "eBay gets its item specifics, Facebook gets a casual tone, Mercari gets hashtags. One item, written three ways so each one looks like it belongs there.",
    icon: <BentoIcon d={[...ICONS.sparkles]} />,
    tint: "violet" as const,
  },
  {
    label: "Security",
    title: "Yours, privately",
    description:
      "Listings post from your own eBay account, never ours. Your photos stay private, and your account's data is only ever yours.",
    icon: <BentoIcon d={[...ICONS.lock]} />,
    tint: "blue" as const,
  },
] as const;

/** Dash-accented small-caps section eyebrow — the non-pill affordance. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-3 text-[13.5px] font-semibold uppercase tracking-[0.18em] text-flash-dim">
      <span aria-hidden className="h-[2px] w-7 rounded-full bg-iris" />
      {children}
    </p>
  );
}

/* ---------------------------------------------------------------------------
 * "One photo, three storefronts" — the single instance of the motif on the
 * whole site. One verified catalog product (the Xbox 360 Kinect bundle —
 * reserved for this section, exclusive to it) rendered three platform-fluent
 * ways. Round 5 (owner): the photo goes full-width at its natural wide
 * aspect so the WHOLE item is visible (the old 400px column cropped it
 * to a sliver), and the three cards share one identical structural skeleton
 * — platform header row → listing title → price row → one platform-detail
 * line → one platform-flavored footer element — with only the CONTENT of
 * each slot changing per marketplace. Copy only restates attributes the
 * photo verifies. Hover lifts via whole-pixel translate — no scale / 3D
 * transforms on text-bearing layers; image zoom is allowed because the
 * photo carries no glyphs.
 * ------------------------------------------------------------------------- */

const STOREFRONT_PRODUCT =
  DEMO_PRODUCTS_BY_SLUG[DEMO_SURFACE_ASSIGNMENTS["landing-storefronts"][0]];

const STOREFRONT_CARD =
  "group/sf flex flex-col rounded-2xl border border-line bg-panel p-6 shadow-card transition-all duration-200 hover:-translate-y-1 hover:border-iris/40 hover:shadow-lg motion-reduce:transition-none motion-reduce:hover:translate-y-0";

function StorefrontHeader({
  platform,
  delivery,
}: {
  platform: "eBay" | "Facebook" | "Mercari";
  delivery: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <MarketplaceBadge marketplace={platform} className="text-[16px]" />
      <span className="rounded-full bg-iris/10 px-2.5 py-1 text-[11px] font-semibold text-iris">
        {delivery}
      </span>
    </div>
  );
}

/** The shared anatomy for all three storefront cards: every slot lives at
 *  the same position with the same spacing and type scale; only the slot
 *  CONTENT is platform-specific. min-heights on the title and price row
 *  keep the slots horizontally aligned across the three-up grid. */
function StorefrontListing({
  platform,
  delivery,
  title,
  price,
  detail,
  footer,
}: {
  platform: "eBay" | "Facebook" | "Mercari";
  delivery: string;
  title: string;
  price: React.ReactNode;
  detail: string;
  footer: React.ReactNode;
}) {
  return (
    <div className={STOREFRONT_CARD}>
      <StorefrontHeader platform={platform} delivery={delivery} />
      <p className="mt-4 text-[15.5px] font-semibold leading-snug text-flash lg:min-h-[3.75em]">
        {title}
      </p>
      <div className="mt-3 flex min-h-[34px] flex-wrap items-center gap-x-3 gap-y-2">
        {price}
      </div>
      <p className="mt-2.5 text-[14px] leading-relaxed text-flash-dim">
        {detail}
      </p>
      <div className="mt-auto flex min-h-[48px] items-center pt-4">{footer}</div>
    </div>
  );
}

export default function Landing() {
  return (
    <>
      {/* ====== 1 · hero — green gradient slab, scan-showcase centerpiece ====== */}
      {/* The WebGL rainbow <HeroPrism> was retired here: it is a spectrum shader
          (inherently contains violet) and can't be recolored via props. The green
          .prism-gradient CSS slab carries the hero until the hero redesign pass
          rebuilds this section. */}
      <section className="relative overflow-hidden pb-20 pt-32 sm:pb-24 sm:pt-40">
        <div aria-hidden className="prism-gradient" />
        <div aria-hidden className="prism-grain" />
        {/* Slab-matched veil so the now-full-presence prism behind the hero
            never washes out the centred headline + paragraph: opaque on the
            text column, transparent at the edges/top where the prism glows
            through. Sits above the canvas, below the text (same approach as
            CtaIridescence's center wash). */}
        <div
          aria-hidden
          className="hero-text-scrim pointer-events-none absolute inset-x-0 top-0 hidden h-[600px] sm:h-[740px] md:block"
        />
        <div className="relative mx-auto w-full max-w-6xl px-5 sm:px-8">
          <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
            {/* r6: the "AI-priced listings, live on eBay" status pill was cut
                (owner) — the headline carries the claim on its own. */}
            <h1 className="font-display text-[clamp(40px,6vw,68px)] font-bold leading-[1.02] tracking-tight text-flash">
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
              text="Take one photo. SnapList figures out what it is, finds a fair used price from what similar things actually sold for, and writes the listing for eBay, Facebook Marketplace, and Mercari."
              animateBy="words"
              delay={18}
              stepDuration={0.3}
              className="mt-6 max-w-[52ch] justify-center text-[16.5px] font-medium leading-relaxed text-flash"
            />
            {/* rotating categories — fixed-width pill, no reflow as words cycle */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[15px] font-semibold text-flash/90">
              <span>Built for</span>
              <RotatingText
                texts={[...ROTATING_CATEGORIES]}
                // Dark mode: the resting iris (#00a37a) is too dim on the navy
                // hero slab — lift the rotating word to the bright accent tint.
                mainClassName="overflow-hidden rounded-full bg-white/70 px-3 py-0.5 text-iris backdrop-blur dark:bg-white/10 dark:text-[color:var(--color-accent-soft-fg)]"
                staggerFrom="last"
                staggerDuration={0.02}
                rotationInterval={2200}
                // sync (not the default "wait"): the outgoing word rolls up as
                // the next rolls in, so the pill is never momentarily empty
                // between swaps.
                animatePresenceMode="sync"
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
                  sparkColor="#008060"
                  sparkSize={9}
                  sparkRadius={22}
                  sparkCount={8}
                  duration={450}
                >
                  <Link
                    href="/login"
                    className="group inline-flex items-center gap-2 rounded-full bg-flash px-6 py-3 text-[16px] font-semibold text-white transition-transform duration-200 hover:scale-[1.03] active:scale-[0.98] dark:text-night"
                  >
                    Start selling free
                  </Link>
                </ClickSpark>
              </Magnet>
              {/* Secondary = clean outline/ghost (owner): border + transparent
                  fill, with only a subtle ink-tint wash on hover — not a second
                  solid button competing with the primary. Keeps its ▶ play icon. */}
              <Link
                href="/tour"
                className="group inline-flex items-center gap-2 rounded-full border border-flash/25 bg-transparent px-6 py-3 text-[16px] font-semibold text-flash transition-all duration-200 hover:border-flash/45 hover:bg-flash/[0.06] active:bg-flash/10 dark:border-iris/30 dark:hover:border-iris/55 dark:hover:bg-iris/10"
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
          </div>

          {/* The headline, performed live: authentic seller photos cycle under
              a scanning beam and each finished scan flips the output panel to
              that item's real title, price, and condition — the product visual
              IS the photo-to-listing moment, not a pre-rendered clip. */}
          <div className="mx-auto mt-12 w-full max-w-5xl sm:mt-16">
            <ScanShowcase />
          </div>
        </div>
      </section>

      {/* ====== 1.5 · finished-listings band — what SnapList produces ====== */}
      <section className="border-b border-line bg-night py-10">
        <p className="px-5 text-center text-[13.5px] font-semibold uppercase tracking-[0.18em] text-flash-faint">
          From camera roll to cash
        </p>
        <div className="mt-6">
          <MarketplaceLoop />
        </div>
      </section>

      {/* ========================== 2 · how it works ========================== */}
      <section className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
        <Reveal className="max-w-2xl">
          <Eyebrow>How it works</Eyebrow>
          <h2 className="mt-4 font-display text-[clamp(28px,4vw,44px)] font-bold leading-[1.1] tracking-tight text-flash">
            From shelf to <em className="text-iris">sold</em> in three moves
          </h2>
          <p className="mt-4 text-[16px] leading-relaxed text-flash-dim">
            One real item, all the way through. You snap it, SnapList prices it
            against what it actually sold for, and you approve the listing it
            writes.
          </p>
        </Reveal>

        {/* Each card leads with one media frame of identical size (same item,
            same crop — uniform across all three), the listing visibly growing
            across the row. A chevron in each gap signals the next step. Equal
            height via h-full; the row stacks on mobile (chevrons hidden). */}
        <Reveal stagger className="mt-14 grid grid-cols-1 gap-12 md:grid-cols-3">
          {STEPS.map(({ n, kicker, title, body }, i) => (
            <div key={n} className="relative">
              <SpotlightCard
                className="flex h-full flex-col p-4"
                spotlightColor="rgba(0, 128, 96, 0.1)"
              >
                {STEP_FRAMES[i]}
                <div className="flex flex-1 flex-col px-2 pb-1 pt-6">
                  <div className="flex items-center gap-2.5">
                    <span className="nums grid size-7 shrink-0 place-items-center rounded-full bg-[rgba(0, 128, 96,0.13)] font-display text-[13px] font-bold text-iris">
                      {n}
                    </span>
                    <span className="text-[11.5px] font-semibold uppercase tracking-[0.16em] text-flash-faint">
                      {kicker}
                    </span>
                  </div>
                  <h3 className="mt-4 font-display text-[21px] font-semibold tracking-tight text-flash">
                    {title}
                  </h3>
                  <p className="mt-2.5 text-[15px] leading-relaxed text-flash-dim">
                    {body}
                  </p>
                </div>
              </SpotlightCard>
              {/* chevron floating in the gap — a glowing "next step" marker.
                  Centered in the gap-12 column (24px) and on the photo region
                  (card p-4 16px + photo h-72 288px / 2 = 160px). The glow pulse
                  is staggered per chevron so it reads left→right. Desktop only. */}
              {i < STEPS.length - 1 && (
                <span
                  aria-hidden
                  style={{ animationDelay: `${i * 0.9}s` }}
                  className="step-chevron absolute right-[-24px] top-[160px] z-[2] hidden size-9 -translate-y-1/2 translate-x-1/2 place-items-center rounded-full border border-line bg-panel text-iris md:grid"
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </span>
              )}
            </div>
          ))}
        </Reveal>
        <Reveal className="mt-10">
          <Link
            href="/tour"
            className="group inline-flex items-center gap-2 text-[15.5px] font-semibold text-iris"
          >
            See the whole thing end to end
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
              Does the pro work,{" "}
              <em className="text-iris">
                tells you the truth
              </em>
            </h2>
          </Reveal>
          <div className="mt-14">
            <MagicBento
              cards={[...BENTO_CARDS]}
              glowColor="0, 128, 96"
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
          {/* faint green pool so the framed panel reads intentional */}
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
            <p className="mt-4 max-w-[54ch] text-[16px] leading-relaxed text-flash-dim">
              Every item gets copy written for the marketplace it&apos;s going
              to. eBay posts directly. Facebook and Mercari come as clean
              copy-paste packs.
            </p>
          </Reveal>
          <Reveal delay={0.1} className="relative mt-12">
            {/* the one photo — a centered frame whose aspect EXACTLY matches
                the cropped master (1080×863), so the real photo fills it edge
                to edge: no zoom-crop (owner: the old 2.4:1 panorama sliced it
                down to the middle) and no fill bands (owner: the master had
                brown padding baked in — now cropped to the bare photo). Capped
                width keeps it tidy on desktop, full-width on mobile. Hover still
                zooms the IMAGE inside its clipped frame (never the caption). */}
            <figure className="group mx-auto max-w-[560px] overflow-hidden rounded-2xl border border-line bg-panel shadow-card transition-[border-color,box-shadow] duration-300 hover:border-iris/50 hover:shadow-[0_0_0_1px_rgba(0, 128, 96,0.22),0_8px_24px_-6px_rgba(0, 128, 96,0.30),0_20px_56px_-16px_rgba(0, 128, 96,0.28)]">
              <div className="relative aspect-[1080/863] overflow-hidden">
                <Image
                  src={STOREFRONT_PRODUCT.image}
                  alt={STOREFRONT_PRODUCT.alt}
                  fill
                  sizes="(max-width: 560px) 100vw, 560px"
                  className="object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                />
                <span className="absolute left-3.5 top-3.5 rounded-md bg-flash/80 px-2.5 py-1 text-[11.5px] font-semibold text-white backdrop-blur dark:bg-night/80 dark:text-flash">
                  The one photo
                </span>
              </div>
              <figcaption className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
                <span className="truncate text-[15px] font-semibold text-flash">
                  {STOREFRONT_PRODUCT.shortName}
                </span>
                <span className="nums shrink-0 text-[15px] font-semibold text-flash-dim">
                  ${STOREFRONT_PRODUCT.price} · {STOREFRONT_PRODUCT.condition}
                </span>
              </figcaption>
            </figure>

            {/* three platform renderings — identical skeleton (header →
                title → price row → detail line → footer), three-up so the
                matching slots line up shoulder to shoulder */}
            <div className="mt-6 grid gap-5 lg:grid-cols-3">
              {/* eBay — keyword title, condition chip, shipping detail, BIN */}
              <StorefrontListing
                platform="eBay"
                delivery="Publishes directly"
                title="Xbox 360 Console with Kinect Sensor, 2 Controllers & Game"
                price={
                  <>
                    <span className="nums text-[20px] font-bold leading-none text-flash">
                      $95.00
                    </span>
                    <span className="rounded-md border border-line bg-night-2 px-2.5 py-1 text-[13.5px] font-medium text-flash-dim">
                      Pre-owned · Good
                    </span>
                  </>
                }
                detail="Free shipping · 30-day returns"
                footer={
                  <span className="rounded-full bg-[#3665f3] px-5 py-2 text-[14px] font-semibold text-white">
                    Buy It Now
                  </span>
                }
              />

              {/* Facebook Marketplace — casual title, local-pickup detail,
                  the "Is this available?" opener with the drafted reply */}
              <StorefrontListing
                platform="Facebook"
                delivery="Copy-paste pack"
                title="Xbox 360 with Kinect, 2 controllers, comes with a game"
                price={
                  <>
                    <span className="nums text-[20px] font-bold leading-none text-flash">
                      $95
                    </span>
                    <span className="text-[14px] font-medium text-flash-dim">
                      Good condition
                    </span>
                  </>
                }
                detail="Listed today · Local pickup · Orlando, FL"
                footer={
                  <div className="flex w-full items-center justify-between gap-3 rounded-xl bg-night-2 px-3.5 py-2.5">
                    <span className="truncate text-[14px] font-medium text-flash-dim">
                      “Is this available?”
                    </span>
                    <span className="shrink-0 rounded-full bg-[#1877f2] px-3.5 py-1 text-[13.5px] font-semibold text-white">
                      Reply drafted
                    </span>
                  </div>
                }
              />

              {/* Mercari — short title, smart-pricing detail, hashtags */}
              <StorefrontListing
                platform="Mercari"
                delivery="Copy-paste pack"
                title="Xbox 360 Kinect bundle, 2 controllers + game"
                price={
                  <>
                    <span className="nums text-[15px] font-medium text-flash-faint line-through">
                      $110
                    </span>
                    <span className="nums text-[20px] font-bold leading-none text-flash">
                      $95
                    </span>
                  </>
                }
                detail="Smart pricing keeps it competitive, never below your $80 floor"
                footer={
                  <p className="text-[14px] font-medium text-iris">
                    #xbox360&ensp;#kinect&ensp;#gaming
                  </p>
                }
              />
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
                colors={["#008060", "#008060", "#3ec9a3", "#008060"]}
                animationSpeed={5}
              >
                money
              </GradientText>
            </h2>
            <p className="mx-auto mt-5 max-w-[44ch] text-[16px] leading-relaxed text-flash-dim">
              Photograph it once. SnapList handles the research, the writing,
              and the posting. You keep control, and you keep the cash.
            </p>
            <Magnet padding={80} magnetStrength={18} wrapperClassName="mt-9">
              <ClickSpark
                className="inline-block"
                sparkColor="#008060"
                sparkSize={9}
                sparkRadius={22}
                sparkCount={8}
                duration={450}
              >
                <Link
                  href="/login"
                  className="group inline-flex items-center gap-2 rounded-full bg-iris px-7 py-3.5 text-[16.5px] font-semibold text-iris-ink transition-transform duration-200 hover:scale-[1.03] active:scale-[0.98]"
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
