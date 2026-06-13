import Link from "next/link";
import { Logo } from "@/components/logo";
import { WordmarkGlow } from "@/components/marketing/wordmark-glow";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { href: "/tour", label: "Tour" },
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
 * Marketing footer (issue #49, subpages v3) — oversized wordmark as the
 * closing visual, Mercury-style link columns above it. Column links carry an
 * animated accent underline (.link-underline: scale-x from the left) plus an
 * ink shift on hover; the iris token keeps it correct in both themes.
 */
export function MarketingFooter() {
  return (
    <footer className="relative overflow-hidden border-t border-line bg-night">
      <div className="mx-auto w-full max-w-6xl px-5 pb-10 pt-16 sm:px-8">
        <div className="flex flex-col justify-between gap-12 sm:flex-row">
          <div className="max-w-xs">
            <Logo className="footer-logo-glow text-flash" markClassName="size-7" />
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
                        className="link-underline inline-block text-[13.5px] text-flash-dim transition-colors hover:text-flash"
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

        <div className="mt-14 flex items-center justify-between border-t border-line pt-6 text-[12.5px] text-flash-faint">
          <p>© {new Date().getFullYear()} SnapList</p>
          <p>Built as a production-real AI engineering showcase</p>
        </div>
      </div>

      {/* oversized clipped wordmark — the cursor acts as a flashlight,
          lighting up the letters under it (rAF-lerped mask; see
          wordmark-glow.tsx + .wordmark-flashlight in globals.css).
          Decorative/aria-hidden, but pointer events stay on so the
          flashlight can land. */}
      <WordmarkGlow />
    </footer>
  );
}
