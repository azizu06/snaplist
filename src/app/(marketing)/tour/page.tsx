import type { Metadata } from "next";
import { Reveal } from "@/components/marketing/reveal";
import { DemoClip } from "@/components/marketing/demo-clip";
import { FaqAccordion } from "@/components/marketing/faq-accordion";
import { HIW_GLYPHS } from "@/components/marketing/hiw-glyphs";
import { MANUAL_PUBLISH_SENTENCE } from "@/lib/ui/publish-eligibility";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "SnapList identifies your item and prices it with sold comps or cited web and depreciation evidence when available. Its lowest-confidence LLM-only estimate may be uncited; you choose when to publish.",
};

/**
 * /how-it-works (ui-r6-remotion) — the pipeline walkthrough at demo scale.
 * Owner round-6 feedback: the step clips were too small ("the user shouldn't
 * have to squint"). The pipeline section breaks out of the content column
 * (max-w-[1720px]) and the clip takes ~3/4 of each row. Section
 * order: hero (headline only) → step-intro header → FIVE step clips
 * (/demo/steps/*.mp4 via DemoClip: 16:9 desktop context
 * and 6:5 action-focused mobile crops,
 * alternating sides) → seller FAQ LAST → CTA.

 * The buyer-Q&A band was removed with the inbox (#599); buyer messaging is out
 * of scope for the lean MVP (PRD "Out of Scope", ADR-0008). The FAQ (#faq anchor) was
 * relocated here when the About page was retired. The step clips embed their
 * own assigned items (see DEMO_SURFACE_ASSIGNMENTS). The live scanning
 * showcase now headlines the landing hero instead.
 */

const STEPS = [
  {
    n: "1",
    src: "/demo/steps/snap.mp4",
    // Portrait mobile render exists for this step (public/demo/steps/snap-mobile.mp4
    // + -dark). Under 768px /tour swaps to it so the in-clip UI is legible.
    mobile: true,
    glyph: "snap",
    title: "Snap",
    body: "One photo, or up to four if condition matters. Visible barcodes and ISBNs are read automatically, so books and boxed items start with an exact identity.",
    poster: "Four slots, thirty seconds of your time.",
    label: "Demo clip: the Snap step of SnapList",
  },
  {
    n: "2",
    src: "/demo/steps/identify.mp4",
    mobile: true,
    glyph: "identify",
    title: "Identify",
    body: "SnapList reads your photo and pulls out the brand, model, category, condition, and the details that matter. If it isn't sure what it's looking at, it says so instead of quietly guessing.",
    poster: "It knows exactly what it's looking at.",
    label: "Demo clip: the Identify step of SnapList",
  },
  {
    n: "3",
    src: "/demo/steps/price.mp4",
    mobile: true,
    glyph: "price",
    title: "Price",
    body: "SnapList prefers relevant recent sold listings, then suggests a price and a realistic range. Evidence-bearing ISBN, sold-comp, and web tiers show the exact sources behind the suggestion. The terminal LLM-only fallback is clearly labeled, lowest-confidence, and may be uncited.",
    poster: "A defensible number, with its receipts.",
    label: "Demo clip: the Price step of SnapList",
  },
  {
    n: "4",
    src: "/demo/steps/write.mp4",
    mobile: true,
    glyph: "write",
    title: "Write",
    body: "Your listing gets written once for each marketplace. eBay gets full item details and a title built for search. Facebook stays casual and local. Mercari leans on hashtags and shipping details.",
    poster: "Three marketplaces, three native tongues.",
    label: "Demo clip: the Write step of SnapList",
  },
  {
    n: "5",
    src: "/demo/steps/publish.mp4",
    mobile: true,
    glyph: "publish",
    title: "Publish",
    body: `Review and edit anything, then choose Publish to eBay under your own connected account. High-confidence items are marked ready; the rest wait for review. ${MANUAL_PUBLISH_SENTENCE}`,
    poster: "Live on eBay, under your name.",
    label: "Demo clip: the Publish step of SnapList",
  },
] as const;

/**
 * Seller FAQ — relocated from the retired About page. Replaces the old
 * "Where the price comes from" waterfall section: the five step clips above
 * already walk the pipeline, so this page closes on the questions sellers
 * actually ask (marketplaces, accuracy, privacy, publishing, cost, eBay).
 */
const FAQ = [
  {
    q: "Which marketplaces does SnapList support?",
    a: "eBay is fully connected, so listings publish straight to your own eBay account. Facebook Marketplace and Mercari don't allow direct posting, so for those you get clean copy-paste packs. SnapList reads public eBay sold and completed pages for price research, but never scrapes to post. Transactional publishing only happens through the eBay adapter after you explicitly choose Publish.",
  },
  {
    q: "How accurate is the pricing?",
    a: "It depends on the item. Books and media with an ISBN are the strongest, relevant sold comps lead when available, and the web tier provides cited fallback research. Those evidence-bearing tiers show their exact sources. If none can price the item, the terminal LLM-only fallback is clearly labeled, lowest-confidence, and may be uncited. Every price is yours to edit.",
  },
  {
    q: "Is my data private?",
    a: "Yes. Your photos are private, and only you can reach them. Your account's data is walled off from everyone else's, and your eBay connection is stored encrypted. If you ask eBay to remove your account, that request is honored end to end.",
  },
  {
    q: "Does publish eligibility post things without asking me?",
    a: `No. The preference only marks high-confidence listings Ready to publish. That confidence comes from how the price was found, how closely recent sales agree, and how well SnapList identified the item, never the AI grading its own work. ${MANUAL_PUBLISH_SENTENCE}`,
  },
  {
    q: "What does it cost?",
    a: "The Free plan covers every core feature for up to 15 items a day. Seller Pro is $10 a month and lifts that to 200 items a day with priority research and bulk uploads. eBay's own selling fees still apply when something sells.",
  },
  {
    q: "Do I need my own eBay account?",
    a: "Yes, and that's a feature. Listings publish under your own identity and reputation. You connect your account once, and SnapList never sees your eBay password.",
  },
] as const;

export default function HowItWorks() {
  return (
    <>
      <section className="aurora grain relative overflow-hidden px-5 pb-16 pt-32 sm:px-8 sm:pt-40">
        {/* The "How it works" eyebrow + the top-right LensRings dashed circle
            were removed: the nav active-indicator already says you're on the
            guide, and the rings were a guide-only flourish that broke
            consistency with /pricing. Both marketing heroes now share the plain
            `aurora grain` background so the glow flow matches across pages. */}
        <div className="mx-auto w-full max-w-6xl">
          <Reveal className="mx-auto flex max-w-3xl flex-col items-center text-center">
            <h1 className="font-display text-[clamp(36px,5.2vw,60px)] font-bold leading-[1.05] tracking-tight text-flash">
              One photo in.
              <br />A <em className="text-iris">defensible</em> listing out.
            </h1>
            <p className="mt-5 max-w-[52ch] text-[17px] leading-relaxed text-flash-dim">
              No magic, no hand-waving. Here&apos;s exactly what happens
              between your camera roll and a live eBay listing, step by step.
            </p>
          </Reveal>
        </div>
      </section>

      {/* the six steps — demo clips at full demo scale, alternating sides.
          ui-r6: this section deliberately breaks out of the page's content
          column (max-w-[1720px]) and gives the clip ~3/4 of the row so the
          in-video UI is readable without squinting. */}
      <section className="mx-auto w-full max-w-[1720px] px-5 pb-24 pt-6 sm:px-8 sm:pb-28 sm:pt-10">
        <div className="space-y-16 sm:space-y-24 lg:space-y-32">
          {STEPS.map((step, i) => {
            const { n, src, glyph, title, body, poster, label } = step;
            // Only steps with a portrait render set `mobile`; under 768px the
            // clip swaps to "<name>-mobile.mp4" (see DemoClip/SeamlessThemeVideo).
            const mobileSrc =
              "mobile" in step && step.mobile
                ? src.replace(/\.mp4$/, "-mobile.mp4")
                : undefined;
            return (
            <Reveal key={n} delay={0.05}>
              <div
                id={`step-${glyph}`}
                className={`grid scroll-mt-24 items-center gap-5 sm:gap-8 lg:gap-12 ${
                  i % 2 === 0
                    ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,2.9fr)]"
                    : "lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,2.9fr)_minmax(0,1fr)]"
                }`}
              >
                <div className={i % 2 === 0 ? "" : "lg:order-2"}>
                  {/* The per-step "Step N" eyebrow was removed (owner: an
                      eyebrow on every row reads as AI grammar, and it
                      double-numbered the step — the numeral already rides the
                      clip badge via DemoClip n={n}). The title leads now. */}
                  <h2 className="font-display text-[clamp(23px,3.4vw,40px)] font-bold tracking-tight text-flash">
                    {title}
                  </h2>
                  <p className="mt-3 hidden max-w-[48ch] text-[15px] leading-relaxed text-flash-dim sm:mt-4 sm:text-[16px] lg:block">
                    {body}
                  </p>
                </div>
                {/* Mobile: the clip follows the step title immediately and goes
                    full-bleed edge-to-edge
                    (escaping the section's px-5). Under 768px it swaps to the
                    action-cropped 6:5 `-mobile` render — a legible SnapList
                    screen with large, legible in-frame UI — so the step reads
                    clearly instead of squinting at a shrunk desktop window.
                    Desktop keeps the framed 16:9 rounded panel. */}
                <div
                  className={`-mx-5 sm:mx-0 ${i % 2 === 0 ? "" : "lg:order-1"}`}
                >
                  <DemoClip
                    src={src}
                    mobileSrc={mobileSrc}
                    label={label}
                    n={n}
                    title={title}
                    caption={poster}
                    glyph={HIW_GLYPHS[glyph]}
                    className="!rounded-none border-x-0 sm:!rounded-3xl sm:border-x"
                  />
                </div>
                <p className="max-w-[48ch] text-[15px] leading-relaxed text-flash-dim sm:text-[16px] lg:hidden">
                  {body}
                </p>
              </div>
            </Reveal>
            );
          })}
        </div>
      </section>

      {/* seller FAQ — relocated from the retired About page; last stop before
          the CTA. One clean centered question list on the animated accordion. */}
      <section id="faq" className="scroll-mt-24 border-t border-line bg-night-2">
        <div className="mx-auto w-full max-w-3xl px-5 py-24 sm:px-8 sm:py-28">
          <Reveal className="flex flex-col items-center text-center">
            <h2 className="font-display text-[clamp(28px,3.6vw,42px)] font-bold tracking-tight text-flash">
              The questions everyone asks
            </h2>
            <p className="mt-4 max-w-[52ch] text-[16.5px] leading-relaxed text-flash-dim">
              Marketplaces, accuracy, privacy, and how publishing works
              do without you, answered straight.
            </p>
          </Reveal>
          <Reveal delay={0.1} className="mt-12">
            <FaqAccordion items={FAQ} />
          </Reveal>
        </div>
      </section>
    </>
  );
}
