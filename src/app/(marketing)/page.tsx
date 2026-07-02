import Image from "next/image";
import Link from "next/link";
import ClickSpark from "@/components/bits/ClickSpark";
import GradientText from "@/components/bits/GradientText";
import MagicBento from "@/components/bits/MagicBento";
import RotatingText from "@/components/bits/RotatingText";
import ScrollFloat from "@/components/bits/ScrollFloat";
import ShinyText from "@/components/bits/ShinyText";
import SplitText from "@/components/bits/SplitText";
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
 * Affordance system: duotone status-tinted icon chips on bento cards and
 * status-tinted confidence chips on listing cards — no repeated pill chip, and
 * (owner) no per-section eyebrows or 01/02/03 numbered scaffolding: those read
 * as AI grammar, so each section heading stands on its own.
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
 *  Icon chips share ONE brand-green tint (owner: the blue/amber/green mix was
 *  too much color) — `violet` resolves to the brand accent-soft chip. */
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
    title: "Draft-ready in seconds",
    description:
      "About 30 seconds from photo to a priced, written draft. It identifies the item, checks what it actually sold for, and drafts the copy in one pass, so all you do is glance it over and approve.",
    icon: <BentoIcon d={[...ICONS.zap]} />,
    tint: "violet" as const,
  },
  {
    label: "Receipts",
    title: "Every price is sourced",
    description:
      "Each one links the real sold listings it came from, so you can open the sources and check the number yourself before you trust it. Nothing is a black box you have to take on faith.",
    icon: <BentoIcon d={[...ICONS.fileText]} />,
    tint: "violet" as const,
  },
  {
    label: "Confidence gate",
    title: "Autopilot with a conscience",
    description:
      "How sure we are isn't a guess. It comes from where the price was found, how closely recent sales agree, and how much we could pin down about the item. When we're sure, it can post on its own. When we're not, it waits for you.",
    icon: <BentoIcon d={[...ICONS.shieldCheck]} />,
    tint: "violet" as const,
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
    tint: "violet" as const,
  },
] as const;

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
        {/* The desktop-only `.hero-text-scrim` veil was removed (owner): it
            darkened a radial "void" behind the headline ≥md while mobile had
            none, so the two broke consistency. The bare prism gradient now
            flows uniformly behind the headline at every width (the big bold
            headline reads cleanly over it without a scrim, as mobile already
            proved). */}
        <div className="relative mx-auto w-full max-w-6xl px-5 sm:px-8">
          <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
            {/* One headline carries the whole pitch (owner, Cursor-style): what
                SnapList IS and DOES, now in TWO tight rows — the action then the
                outcome — so the old three-line wrap (too much vertical air)
                collapses to two. Each row is its own word-split block so the
                sentence break is deterministic (text-balance only re-evens a row
                if it wraps on narrow mobile); the `max-w-[26ch]` cap sits one char
                past the longer row so row 2 never wraps on desktop. The explainer
                paragraph stays dropped; the rotating "Built for …" line below
                carries who it's for. */}
            <h1 className="mx-auto max-w-[26ch] text-balance font-display text-[clamp(38px,5.4vw,54px)] font-bold leading-[1.06] tracking-tight text-flash">
              <SplitText
                text="Snap a photo."
                tag="span"
                className="block"
                textAlign="center"
                splitType="words"
                delay={40}
                duration={0.8}
                from={{ opacity: 0, y: 32 }}
                to={{ opacity: 1, y: 0 }}
              />
              <SplitText
                text="Get it priced and listed."
                tag="span"
                className="block"
                textAlign="center"
                splitType="words"
                delay={40}
                duration={0.8}
                from={{ opacity: 0, y: 32 }}
                to={{ opacity: 1, y: 0 }}
              />
            </h1>
            {/* rotating categories — fixed-width pill, no reflow as words cycle */}
            <div className="mt-7 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[15px] font-semibold text-flash/90">
              <span>Built for</span>
              <RotatingText
                texts={[...ROTATING_CATEGORIES]}
                // The pill sits on the green hero slab, so green text on it
                // barely read. Light: a near-solid white pill with near-black
                // ink so the rotating word pops off the green. Dark: the resting
                // iris is too dim on the deep slab — lift to the bright accent
                // tint on a translucent dark pill.
                mainClassName="overflow-hidden rounded-full bg-white/90 px-3 py-0.5 font-semibold text-flash shadow-sm backdrop-blur dark:bg-white/10 dark:text-[color:var(--color-accent-soft-fg)]"
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
            {/* CTAs (owner, Cursor-style): two compact pills side by side, each
                with a → that nudges on hover — a near-solid primary + a quiet
                neutral-outline secondary (no green border, so it doesn't compete
                with the primary). Adaptive via tokens: `flash` is near-black ink
                in light, near-white in dark, so both pills read on the green slab
                in either theme. ClickSpark burst on the primary stays. */}
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
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
                  className="group inline-flex items-center gap-1.5 rounded-full bg-flash px-5 py-2.5 text-[15px] font-semibold text-white transition-transform duration-200 hover:scale-[1.03] active:scale-[0.98] dark:text-night"
                >
                  Start selling free
                  <span
                    aria-hidden
                    className="transition-transform duration-200 group-hover:translate-x-0.5"
                  >
                    →
                  </span>
                </Link>
              </ClickSpark>
              <Link
                href="/tour"
                className="group inline-flex items-center gap-1.5 rounded-full border border-flash/25 bg-transparent px-5 py-2.5 text-[15px] font-semibold text-flash transition-all duration-200 hover:border-flash/45 hover:bg-flash/[0.06] active:scale-[0.98] dark:border-flash/25 dark:hover:border-flash/45 dark:hover:bg-flash/[0.08]"
              >
                See how it works
                <span
                  aria-hidden
                  className="transition-transform duration-200 group-hover:translate-x-0.5"
                >
                  →
                </span>
              </Link>
            </div>
          </div>

          {/* The headline, performed live: authentic seller photos cycle under
              a scanning beam and each finished scan flips the output panel to
              that item's real title, price, and condition — the product visual
              IS the photo-to-listing moment, not a pre-rendered clip. */}
          <div className="mx-auto mt-16 w-full max-w-5xl sm:mt-24">
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

      {/* ================= 2 · features — the MagicBento wow block =================
          (The standalone "how it works" 3-step strip was removed — owner: it
          duplicated the detailed /tour guide the hero CTA already links to, the
          live ScanShowcase already demonstrates the flow, and it carried the
          01/02/03 numbered scaffolding that reads as AI grammar.) */}
      <section className="border-t border-line bg-night-2">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
          <Reveal>
            <h2 className="max-w-2xl font-display text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-tight text-flash">
              Does the work,{" "}
              <em className="text-iris">shows its receipts</em>
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
          <ScrollFloat
            containerClassName="max-w-2xl"
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
            {/* Magnet removed here too, to match the hero CTA (owner: the
                magnetic pull was distracting). The mt-9 it carried moves onto
                the ClickSpark wrapper. */}
            <ClickSpark
              className="mt-9 inline-block"
              sparkColor="#008060"
              sparkSize={9}
              sparkRadius={22}
              sparkCount={8}
              duration={450}
            >
              <Link
                href="/login"
                className="group inline-flex items-center justify-center rounded-full bg-iris px-7 py-3.5 text-[16.5px] font-semibold text-iris-ink transition-transform duration-200 hover:scale-[1.03] active:scale-[0.98]"
              >
                <ShinyText
                  text="Snap your first photo"
                  color="rgba(255, 255, 255, 0.85)"
                  shineColor="#ffffff"
                  speed={2.4}
                  delay={1.2}
                />
              </Link>
            </ClickSpark>
          </Reveal>
        </div>
      </section>
    </>
  );
}
