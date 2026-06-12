import type { Metadata } from "next";
import Link from "next/link";
import { Reveal } from "@/components/marketing/reveal";
import {
  AutopilotDemo,
  IdentifyDemo,
  ListingComposerDemo,
  PriceReportDemo,
} from "@/components/marketing/feature-demos";
import {
  BuyerReplyCard,
  Eyebrow,
  IsolationCard,
  LensRings,
  PointChip,
  type SpectrumTint,
} from "@/components/marketing/visuals";

export const metadata: Metadata = {
  title: "Features",
  description:
    "AI identification, pricing with cited sources, platform-native listings, confidence-gated autopilot, drafted buyer replies, and per-account security.",
};

/**
 * /features (subpages v3) — four interactive capability demos instead of
 * text columns. Each block: a numbered, spectrum-tinted eyebrow (the prism
 * splits light; each capability gets a band), one line of copy, three icon
 * point-chips, and a micro-demo you can actually poke. Products are the
 * features pool (polaroid / vinyl / gshock) from the verified catalog.
 */

const ICONS = {
  tag: (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  ),
  barcode: (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M3 5v14M8 5v14M12 5v14M17 5v14M21 5v14" />
    </svg>
  ),
  flag: (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <path d="M4 22v-7" />
    </svg>
  ),
  link: (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  scale: (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1ZM2 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="M7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
    </svg>
  ),
  pen: (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    </svg>
  ),
  storefront: (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" />
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" />
      <path d="M2 7h20M22 7v3a2 2 0 0 1-2 2 2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7" />
    </svg>
  ),
  clipboard: (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  ),
  sparkle: (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.2 2.2m8.4 8.4 2.2 2.2m0-12.8-2.2 2.2M7.8 16.2l-2.2 2.2" />
    </svg>
  ),
  gauge: (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  ),
  toggle: (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="20" height="12" x="2" y="6" rx="6" ry="6" />
      <circle cx="16" cy="12" r="2" />
    </svg>
  ),
} as const;

const BLOCKS: {
  n: string;
  tint: SpectrumTint;
  eyebrow: string;
  title: React.ReactNode;
  blurb: string;
  points: { icon: keyof typeof ICONS; text: string }[];
  demo: React.ComponentType;
}[] = [
  {
    n: "01",
    tint: "violet",
    eyebrow: "Identification",
    title: (
      <>
        It knows what it&apos;s <em className="text-iris">looking at</em>
      </>
    ),
    blurb:
      "Photos become a validated attribute schema — never a fuzzy caption.",
    points: [
      { icon: "tag", text: "Brand, model & condition extracted" },
      { icon: "barcode", text: "Barcodes & ISBNs read automatically" },
      { icon: "flag", text: "Ambiguity flagged, never guessed" },
    ],
    demo: IdentifyDemo,
  },
  {
    n: "02",
    tint: "cyan",
    eyebrow: "Pricing",
    title: (
      <>
        A number with <em className="text-iris">receipts</em>
      </>
    ),
    blurb:
      "Suggested price, realistic range, cited sources — used value, not retail.",
    points: [
      { icon: "scale", text: "Sold signals beat asking prices" },
      { icon: "link", text: "Every source cited" },
      { icon: "pen", text: "Your override always wins" },
    ],
    demo: PriceReportDemo,
  },
  {
    n: "03",
    tint: "rose",
    eyebrow: "Listings",
    title: (
      <>
        One item, three <em className="text-iris">native tongues</em>
      </>
    ),
    blurb:
      "One validated core renders platform-fluent copy for each marketplace.",
    points: [
      { icon: "storefront", text: "eBay specifics & keyword titles" },
      { icon: "clipboard", text: "Copy-paste packs for FB & Mercari" },
      { icon: "sparkle", text: "Grounded in real listings, not filler" },
    ],
    demo: ListingComposerDemo,
  },
  {
    n: "04",
    tint: "indigo",
    eyebrow: "Autopilot & trust",
    title: (
      <>
        Automation that <em className="text-iris">earns it</em>
      </>
    ),
    blurb:
      "Confidence comes from real signals. Set the gate yourself — try it.",
    points: [
      { icon: "gauge", text: "Signal-based score, never self-graded" },
      { icon: "send", text: "High confidence can publish itself" },
      { icon: "toggle", text: "One switch turns it all off" },
    ],
    demo: AutopilotDemo,
  },
];

export default function Features() {
  return (
    <>
      <section className="aurora grain relative overflow-hidden px-5 pb-16 pt-32 sm:px-8 sm:pt-40">
        <LensRings className="pointer-events-none absolute -right-40 -top-40 w-[560px] text-iris" />
        <div className="mx-auto w-full max-w-6xl">
          <Reveal>
            <Eyebrow>Features</Eyebrow>
            <h1 className="mt-4 max-w-3xl font-display text-[clamp(34px,5vw,56px)] font-bold leading-[1.05] tracking-tight text-flash">
              Everything between <em className="text-iris">photo</em> and{" "}
              <em className="text-iris">paid</em>
            </h1>
            <p className="mt-5 max-w-[46ch] text-[16px] leading-relaxed text-flash-dim">
              Less reading, more poking: every capability below is a working
              miniature of the real product.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl space-y-20 px-5 pb-28 sm:space-y-28 sm:px-8">
        {BLOCKS.map(({ n, tint, eyebrow, title, blurb, points, demo: Demo }, i) => (
          <Reveal key={n}>
            <div
              className={`grid items-center gap-8 lg:gap-16 ${
                i % 2 === 0 ? "lg:grid-cols-[1fr_460px]" : "lg:grid-cols-[460px_1fr]"
              }`}
            >
              <div className={i % 2 === 0 ? "" : "lg:order-2"}>
                <Eyebrow n={n} tint={tint}>
                  {eyebrow}
                </Eyebrow>
                <h2 className="mt-4 font-display text-[clamp(24px,3.4vw,34px)] font-bold tracking-tight text-flash">
                  {title}
                </h2>
                <p className="mt-3 max-w-[44ch] text-[15px] leading-relaxed text-flash-dim">
                  {blurb}
                </p>
                <div className="mt-6 flex flex-wrap gap-2.5">
                  {points.map(({ icon, text }) => (
                    <PointChip key={text} tint={tint} icon={ICONS[icon]}>
                      {text}
                    </PointChip>
                  ))}
                </div>
              </div>
              <div className={i % 2 === 0 ? "" : "lg:order-1"}>
                <Demo />
              </div>
            </div>
          </Reveal>
        ))}

        {/* after the listing: messaging + security, side by side */}
        <Reveal>
          <Eyebrow n="05" tint="violet">
            After the listing
          </Eyebrow>
          <h2 className="mt-4 max-w-2xl font-display text-[clamp(24px,3.4vw,34px)] font-bold tracking-tight text-flash">
            Sold is not the end of the <em className="text-iris">work</em>
          </h2>
          <div className="mt-8 grid gap-5 lg:grid-cols-2">
            <div>
              <BuyerReplyCard />
              <p className="mt-3 px-1 text-[13px] leading-relaxed text-flash-faint">
                Buyer questions arrive pre-answered from the item&apos;s real
                attributes — you approve, edit, or rewrite before anything
                sends.
              </p>
            </div>
            <div>
              <IsolationCard />
              <p className="mt-3 px-1 text-[13px] leading-relaxed text-flash-faint">
                Every row is isolated to your account by the database itself;
                photos live behind signed, expiring URLs.
              </p>
            </div>
          </div>
        </Reveal>
      </section>

      <section className="border-t border-line bg-night-2 px-5 py-24 text-center sm:px-8">
        <Reveal>
          <h2 className="font-display text-[clamp(28px,4vw,42px)] font-bold tracking-tight text-flash">
            Stop reading about it
          </h2>
          <Link
            href="/login"
            className="group mt-8 inline-flex items-center gap-2 rounded-full bg-iris px-7 py-3.5 text-[15px] font-semibold text-iris-ink transition-transform hover:scale-[1.03]"
          >
            List something free
            <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
          </Link>
        </Reveal>
      </section>
    </>
  );
}
