import Link from "next/link";
import { Logo } from "@/components/logo";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { href: "/how-it-works", label: "How it works" },
      { href: "/features", label: "Features" },
      { href: "/pricing", label: "Pricing" },
    ],
  },
  {
    heading: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/about#faq", label: "FAQ" },
    ],
  },
  {
    heading: "Get started",
    links: [
      { href: "/login", label: "Log in" },
      { href: "/login", label: "Create account" },
    ],
  },
] as const;

/**
 * Marketing footer (issue #49) — oversized wordmark as the closing visual,
 * Mercury-style link columns above it.
 */
export function MarketingFooter() {
  return (
    <footer className="relative overflow-hidden border-t border-line/60 bg-night">
      <div className="mx-auto w-full max-w-6xl px-5 pb-10 pt-16 sm:px-8">
        <div className="flex flex-col justify-between gap-12 sm:flex-row">
          <div className="max-w-xs">
            <Logo className="text-flash" markClassName="size-7" />
            <p className="mt-3 text-[13.5px] leading-relaxed text-flash-faint">
              Snap a photo of something you want to sell. We identify it, price
              it with sources, and write the listing.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
            {COLUMNS.map(({ heading, links }) => (
              <div key={heading}>
                <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-flash-faint">
                  {heading}
                </p>
                <ul className="mt-3.5 space-y-2.5">
                  {links.map(({ href, label }) => (
                    <li key={`${href}-${label}`}>
                      <Link
                        href={href}
                        className="text-[13.5px] text-flash-dim transition-colors hover:text-flash"
                      >
                        {label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-14 flex items-center justify-between border-t border-line/60 pt-6 text-[12.5px] text-flash-faint">
          <p>© {new Date().getFullYear()} SnapList</p>
          <p>Built as a production-real AI engineering showcase</p>
        </div>
      </div>

      {/* oversized clipped wordmark */}
      <div
        aria-hidden
        className="pointer-events-none select-none overflow-hidden"
      >
        <p className="-mb-[0.23em] bg-gradient-to-b from-panel-2 to-night bg-clip-text text-center font-display text-[clamp(96px,18vw,260px)] font-bold leading-none tracking-tight text-transparent">
          SnapList
        </p>
      </div>
    </footer>
  );
}
