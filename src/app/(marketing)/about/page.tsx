import type { Metadata } from "next";
import Link from "next/link";
import { Reveal } from "@/components/marketing/reveal";

export const metadata: Metadata = {
  title: "About & FAQ",
  description:
    "Why SnapList exists, the engineering principles behind it, and answers to the questions everyone asks.",
};

/** /about (issue #49) — story, principles, FAQ (native <details> accordion). */

const PRINCIPLES = [
  {
    title: "Show the sources",
    body: "A price you can't trace is a guess wearing a suit. Every suggestion carries its receipts.",
  },
  {
    title: "Flag, don't fake",
    body: "When identification is ambiguous or comps are thin, the system says so. Low confidence is information, not failure.",
  },
  {
    title: "You own the send button",
    body: "Autopilot is opt-in and gated on computed confidence. Nothing posts, replies, or changes price without a rule you set.",
  },
  {
    title: "Honest ceilings",
    body: "Asking prices aren't sold prices. Generic items price worse than branded ones. We tell you which is which instead of pretending.",
  },
] as const;

const FAQ = [
  {
    q: "Which marketplaces does SnapList support?",
    a: "eBay is fully integrated — listings publish directly under your own connected eBay account. Facebook Marketplace and Mercari get formatted copy-paste export packs (neither offers a public listing API, and we don't scrape).",
  },
  {
    q: "How accurate is the pricing?",
    a: "It depends on the item, and we show you which tier fired. Books and media with ISBNs are strongest (exact lookups). Branded items priced from live web comps are solid. Generic items fall back to a depreciation model and are clearly labeled lower-confidence. Every price is editable.",
  },
  {
    q: "Is my data private?",
    a: "Yes. Photos live in private storage behind expiring signed URLs, every database row is isolated to your account and enforced at the database layer, and eBay tokens are encrypted at rest. eBay account-deletion requests are verified cryptographically and honored end-to-end.",
  },
  {
    q: "Does autopilot post things without asking me?",
    a: "Only if you turn it on, and only for items above the confidence bar — a score computed from real signals (pricing tier, comp agreement, identification completeness), not the model's self-assessment. Everything else queues for your review. You can keep autopilot off entirely.",
  },
  {
    q: "What does it cost?",
    a: "Nothing during beta — every feature, no credit card. Paid tiers come later; beta users keep early-bird pricing.",
  },
  {
    q: "Do I need my own eBay account?",
    a: "Yes — that's a feature. Listings publish under your identity and reputation via OAuth. SnapList never sees your eBay password.",
  },
] as const;

export default function About() {
  return (
    <>
      <section className="aurora dotgrid relative overflow-hidden px-5 pb-16 pt-32 sm:px-8 sm:pt-40">
        <div className="mx-auto w-full max-w-6xl">
          <Reveal>
            <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-volt">
              About
            </p>
            <h1 className="mt-3 max-w-3xl font-display text-[clamp(34px,5vw,56px)] font-bold leading-[1.05] tracking-tight text-flash">
              Selling used stuff is{" "}
              <em className="font-serif-accent font-normal italic text-volt">
                unpaid admin work
              </em>
            </h1>
            <div className="mt-6 max-w-[60ch] space-y-4 text-[16px] leading-relaxed text-flash-dim">
              <p>
                Every item is the same half hour: photograph it, guess what
                it&apos;s worth used (not retail — good luck finding real sold
                prices), write a listing that doesn&apos;t sound desperate,
                post it, then answer the same three buyer questions.
              </p>
              <p>
                SnapList collapses that into a photo and a couple of approvals.
                It was built as a production-real AI engineering showcase —
                which is exactly why it doesn&apos;t cut corners: real eBay
                integration, real multi-tenant security, real evaluation of its
                own accuracy.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 pb-24 sm:px-8">
        <Reveal>
          <h2 className="font-display text-[clamp(24px,3.4vw,36px)] font-bold tracking-tight text-flash">
            Principles we don&apos;t bend
          </h2>
        </Reveal>
        <Reveal stagger className="mt-10 grid gap-5 sm:grid-cols-2">
          {PRINCIPLES.map(({ title, body }) => (
            <div
              key={title}
              className="rounded-2xl border border-line/70 bg-panel/50 p-7"
            >
              <h3 className="font-display text-[18px] font-semibold text-flash">
                {title}
              </h3>
              <p className="mt-2.5 text-[14px] leading-relaxed text-flash-dim">
                {body}
              </p>
            </div>
          ))}
        </Reveal>
      </section>

      <section id="faq" className="border-t border-line/60 bg-night-2/40">
        <div className="mx-auto w-full max-w-3xl px-5 py-24 sm:px-8">
          <Reveal>
            <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-volt">
              FAQ
            </p>
            <h2 className="mt-3 font-display text-[clamp(24px,3.4vw,36px)] font-bold tracking-tight text-flash">
              The questions everyone asks
            </h2>
          </Reveal>
          <Reveal className="mt-10 space-y-3">
            {FAQ.map(({ q, a }) => (
              <details
                key={q}
                className="group rounded-2xl border border-line/70 bg-panel/50 transition-colors open:bg-panel hover:border-line-2"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 text-[15px] font-semibold text-flash [&::-webkit-details-marker]:hidden">
                  {q}
                  <svg
                    viewBox="0 0 24 24"
                    className="size-4 shrink-0 text-flash-faint transition-transform group-open:rotate-45"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </summary>
                <p className="px-6 pb-6 text-[14px] leading-relaxed text-flash-dim">
                  {a}
                </p>
              </details>
            ))}
          </Reveal>
        </div>
      </section>

      <section className="mx-auto w-full max-w-3xl px-5 py-24 text-center sm:px-8">
        <Reveal>
          <h2 className="font-display text-[clamp(28px,4vw,42px)] font-bold tracking-tight text-flash">
            Got something to sell?
          </h2>
          <Link
            href="/login"
            className="group mt-8 inline-flex items-center gap-2 rounded-full bg-volt px-7 py-3.5 text-[15px] font-semibold text-volt-ink shadow-[0_0_40px_-8px] shadow-volt/50 transition-transform hover:scale-[1.03]"
          >
            Snap your first photo
            <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
          </Link>
        </Reveal>
      </section>
    </>
  );
}
