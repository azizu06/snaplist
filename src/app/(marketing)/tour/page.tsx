import type { Metadata } from "next";
import { Reveal } from "@/components/marketing/reveal";
import { DemoClip } from "@/components/marketing/demo-clip";
import { FaqAccordion } from "@/components/marketing/faq-accordion";
import { HIW_GLYPHS } from "@/components/marketing/hiw-glyphs";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Snap a photo and SnapList figures out what your item is, what it's worth with real sources, writes the listing, and posts it to eBay. Here's how each step works.",
};

/**
 * /how-it-works (ui-r6-remotion) — the pipeline walkthrough at demo scale.
 * Owner round-6 feedback: the step clips were too small ("the user shouldn't
 * have to squint") and the buyer-Q&A band duplicated the step format. Now the
 * pipeline section breaks out of the content column (max-w-[1720px]) and the
 * clip takes ~3/4 of each row; buyer Q&A joined the same section as step 6
 * ("After it's live") in the identical alternating text/video format. Section
 * order: hero (headline only) → step-intro header → SIX step clips
 * (/demo/steps/*.mp4 + /demo/buyer-qa.mp4, 1920×1080 loops via DemoClip,
 * alternating sides) → seller FAQ LAST → CTA. The FAQ (#faq anchor) was
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
    body: "SnapList researches what similar items recently sold for, then suggests a price, a realistic range, and the exact sources behind it. Real sale prices, not wishful asking prices.",
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
    body: "Review and edit anything, then publish to eBay under your own connected account. High-confidence items can go out on autopilot; the rest queue for you.",
    poster: "Live on eBay, under your name.",
    label: "Demo clip: the Publish step of SnapList",
  },
  {
    n: "6",
    src: "/demo/buyer-qa.mp4",
    mobile: true,
    glyph: "chat",
    title: "Answer",
    body: "Buyer questions, pre-answered. Incoming messages land in a live inbox with a reply already drafted from the item's real details, like edition, condition, and what's included. You approve, edit, or rewrite, and nothing sends without you.",
    poster: "Drafted from the item's real details, sent by you.",
    label: "Demo clip: a buyer question arrives and a reply drafted from the item's details awaits approval",
  },
] as const;

/**
 * Seller FAQ — relocated from the retired About page. Replaces the old
 * "Where the price comes from" waterfall section: the six step clips above
 * already walk the pipeline, so this page closes on the questions sellers
 * actually ask (marketplaces, accuracy, privacy, autopilot, cost, eBay).
 */
const FAQ = [
  {
    q: "Which marketplaces does SnapList support?",
    a: "eBay is fully connected, so listings publish straight to your own eBay account. Facebook Marketplace and Mercari don't allow direct posting, so for those you get clean copy-paste packs. We never scrape anything.",
  },
  {
    q: "How accurate is the pricing?",
    a: "It depends on the item, and we always show you where the price came from. Books and media with an ISBN are the strongest, an exact lookup with no guessing. Branded items are priced from what similar ones recently sold for, which is solid. Everyday items get a rougher estimate marked down from the new price, and we label it as less certain. Every price is yours to edit.",
  },
  {
    q: "Is my data private?",
    a: "Yes. Your photos are private, and only you can reach them. Your account's data is walled off from everyone else's, and your eBay connection is stored encrypted. If you ask eBay to remove your account, that request is honored end to end.",
  },
  {
    q: "Does autopilot post things without asking me?",
    a: "Only if you turn it on, and only for items it's genuinely sure about. That confidence comes from how the price was found, how closely recent sales agree, and how well it pinned down the item, never the AI grading its own work. Everything else waits for your review, and you can keep autopilot off entirely.",
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
        <div className="space-y-24 sm:space-y-32">
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
                id={`step-${glyph === "chat" ? "qa" : glyph}`}
                className={`grid scroll-mt-24 items-center gap-9 lg:gap-12 ${
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
                  <p className="mt-3 max-w-[48ch] text-[15px] leading-relaxed text-flash-dim sm:mt-4 sm:text-[16px]">
                    {body}
                  </p>
                </div>
                {/* Mobile: the clip frame goes full-bleed edge-to-edge
                    (escaping the section's px-5). Under 768px it swaps to the
                    portrait 4:5 `-mobile` render — a phone-native SnapList
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
              Marketplaces, accuracy, privacy, and what autopilot will never
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
