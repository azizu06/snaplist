import type { Metadata } from "next";
import Link from "next/link";
import { Reveal } from "@/components/marketing/reveal";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Photo → identification → researched price with sources → platform-native listings → publish. The SnapList pipeline, step by step.",
};

/**
 * /how-it-works (issue #49) — the pipeline walkthrough. The pricing waterfall
 * section mirrors the real PricingProvider router tiers; keep them in sync.
 */

const STAGES = [
  {
    n: "01",
    title: "Snap",
    body: "Take one photo — or up to four if condition matters. SnapList reads visible barcodes and ISBNs automatically, so books and boxed items start with an exact identity.",
    chips: ["1–4 photos", "barcode & ISBN detection", "30 seconds of your time"],
  },
  {
    n: "02",
    title: "Identify",
    body: "A vision model extracts structured attributes — brand, model, category, condition, key specs — and validates them against a strict schema. Ambiguous items get flagged, never silently guessed.",
    chips: ["brand & model", "condition assessment", "ambiguity flagging"],
  },
  {
    n: "03",
    title: "Price",
    body: "A research agent works the pricing waterfall below and synthesizes a suggested price, a realistic range, and the sources it used. Asking prices are down-weighted against sold signals.",
    chips: ["cited sources", "used value, not retail", "editable always"],
  },
  {
    n: "04",
    title: "Write",
    body: "One validated attribute core renders into platform-fluent listings: eBay item specifics and keyword titles, Facebook's casual local tone, Mercari's hashtags and shipping framing.",
    chips: ["eBay", "Facebook Marketplace", "Mercari"],
  },
  {
    n: "05",
    title: "Publish",
    body: "Review and edit anything, then publish to eBay under your own connected account. High-confidence items can go out on autopilot; everything else queues for your approval.",
    chips: ["your eBay account", "confidence-gated autopilot", "status tracking"],
  },
] as const;

const TIERS = [
  {
    name: "ISBN lookup",
    when: "Books & media with a readable ISBN",
    confidence: "Highest",
    width: "w-[96%]",
  },
  {
    name: "Web comps research",
    when: "Branded, recognizable items",
    confidence: "High",
    width: "w-[78%]",
  },
  {
    name: "Depreciation model",
    when: "Generic items where only retail exists",
    confidence: "Medium",
    width: "w-[52%]",
  },
  {
    name: "Model estimate",
    when: "Last resort — clearly labeled",
    confidence: "Low",
    width: "w-[30%]",
  },
] as const;

export default function HowItWorks() {
  return (
    <>
      <section className="aurora dotgrid relative overflow-hidden px-5 pb-16 pt-32 sm:px-8 sm:pt-40">
        <div className="mx-auto w-full max-w-6xl">
          <Reveal>
            <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-volt">
              How it works
            </p>
            <h1 className="mt-3 max-w-3xl font-display text-[clamp(34px,5vw,56px)] font-bold leading-[1.05] tracking-tight text-flash">
              One photo in.
              <br />A{" "}
              <em className="font-serif-accent font-normal italic text-volt">
                defensible
              </em>{" "}
              listing out.
            </h1>
            <p className="mt-5 max-w-[52ch] text-[16px] leading-relaxed text-flash-dim">
              SnapList is a pipeline, not a magic trick. Here is exactly what
              happens between your camera roll and a live eBay listing.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 pb-24 sm:px-8">
        <div className="space-y-5">
          {STAGES.map(({ n, title, body, chips }, i) => (
            <Reveal key={n} delay={0.05}>
              <div className="grid items-start gap-6 rounded-2xl border border-line/70 bg-panel/50 p-7 transition-colors hover:border-line-2 hover:bg-panel sm:grid-cols-[140px_1fr] sm:p-9">
                <div className="flex items-baseline gap-3 sm:block">
                  <span className="nums font-display text-[13px] font-bold text-volt">
                    {n}
                  </span>
                  <h2 className="font-display text-[24px] font-bold tracking-tight text-flash sm:mt-1.5">
                    {title}
                  </h2>
                </div>
                <div>
                  <p className="max-w-[64ch] text-[15px] leading-relaxed text-flash-dim">
                    {body}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {chips.map((chip) => (
                      <span
                        key={chip}
                        className="rounded-full border border-volt/25 bg-volt/8 px-3 py-1 text-[11.5px] font-medium text-volt"
                      >
                        {chip}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              {i < STAGES.length - 1 ? (
                <div aria-hidden className="mx-auto h-5 w-px bg-gradient-to-b from-line-2 to-transparent" />
              ) : null}
            </Reveal>
          ))}
        </div>
      </section>

      {/* pricing waterfall */}
      <section className="border-t border-line/60 bg-night-2/40">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <Reveal>
            <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-volt">
              The pricing waterfall
            </p>
            <h2 className="mt-3 max-w-2xl font-display text-[clamp(26px,3.6vw,40px)] font-bold leading-tight tracking-tight text-flash">
              The best source that exists for{" "}
              <em className="font-serif-accent font-normal italic">your</em>{" "}
              item — honestly labeled
            </h2>
            <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-flash-dim">
              Not every item can be priced with the same rigor. SnapList routes
              each one to the strongest available strategy and tells you which
              tier fired — confidence reflects it.
            </p>
          </Reveal>
          <Reveal stagger className="mt-12 space-y-4">
            {TIERS.map(({ name, when, confidence, width }) => (
              <div
                key={name}
                className="rounded-2xl border border-line/70 bg-panel/50 p-6"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-display text-[17px] font-semibold text-flash">
                    {name}
                  </h3>
                  <span className="text-[12px] font-semibold text-volt">
                    {confidence} confidence
                  </span>
                </div>
                <p className="mt-1 text-[13.5px] text-flash-faint">{when}</p>
                <div className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-panel-2">
                  <div
                    className={`h-full ${width} rounded-full bg-gradient-to-r from-volt-deep to-volt`}
                  />
                </div>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      <section className="mx-auto w-full max-w-3xl px-5 py-24 text-center sm:px-8">
        <Reveal>
          <h2 className="font-display text-[clamp(28px,4vw,42px)] font-bold tracking-tight text-flash">
            See it on your own shelf
          </h2>
          <Link
            href="/login"
            className="group mt-8 inline-flex items-center gap-2 rounded-full bg-volt px-7 py-3.5 text-[15px] font-semibold text-volt-ink shadow-[0_0_40px_-8px] shadow-volt/50 transition-transform hover:scale-[1.03]"
          >
            Try it free
            <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
          </Link>
        </Reveal>
      </section>
    </>
  );
}
