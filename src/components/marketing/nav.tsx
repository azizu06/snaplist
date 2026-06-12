"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const LINKS = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/about", label: "About" },
] as const;

/**
 * Marketing nav (issue #49). Transparent over the hero; gains a glass blur +
 * hairline once the page scrolls. Signed-in visitors get "Open app" instead
 * of the login/signup pair.
 */
export function MarketingNav({ signedIn }: { signedIn: boolean }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-[background-color,border-color,backdrop-filter] duration-300 ${
        scrolled || open
          ? "border-b border-line/70 bg-night/80 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link
          href="/"
          className="flex items-center gap-2.5 font-display text-[17px] font-semibold tracking-tight text-flash"
          onClick={() => setOpen(false)}
        >
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-lg bg-volt text-volt-ink shadow-[0_0_24px_-4px] shadow-volt/50"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
          </span>
          SnapList
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className="rounded-full px-3.5 py-2 text-[13.5px] font-medium text-flash-dim transition-colors hover:bg-panel-2/70 hover:text-flash"
            >
              {label}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-2.5 md:flex">
          {signedIn ? (
            <Link
              href="/dashboard"
              className="group inline-flex items-center gap-1.5 rounded-full bg-volt px-4.5 py-2 text-[13.5px] font-semibold text-volt-ink transition-transform hover:scale-[1.03] active:scale-[0.98]"
            >
              Open app
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-full px-3.5 py-2 text-[13.5px] font-medium text-flash-dim transition-colors hover:text-flash"
              >
                Log in
              </Link>
              <Link
                href="/login"
                className="group inline-flex items-center gap-1.5 rounded-full bg-volt px-4.5 py-2 text-[13.5px] font-semibold text-volt-ink shadow-[0_0_28px_-6px] shadow-volt/40 transition-transform hover:scale-[1.03] active:scale-[0.98]"
              >
                Start selling
                <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
              </Link>
            </>
          )}
        </div>

        {/* mobile toggle */}
        <button
          type="button"
          aria-expanded={open}
          aria-label="Toggle menu"
          onClick={() => setOpen((v) => !v)}
          className="flex size-9 items-center justify-center rounded-lg text-flash md:hidden"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </nav>

      {open ? (
        <div className="border-t border-line/60 px-5 pb-5 pt-2 md:hidden">
          {LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className="block rounded-lg px-2 py-2.5 text-[15px] font-medium text-flash-dim"
            >
              {label}
            </Link>
          ))}
          <Link
            href={signedIn ? "/dashboard" : "/login"}
            onClick={() => setOpen(false)}
            className="mt-3 inline-flex w-full items-center justify-center rounded-full bg-volt px-4 py-2.5 text-[14px] font-semibold text-volt-ink"
          >
            {signedIn ? "Open app →" : "Start selling →"}
          </Link>
        </div>
      ) : null}
    </header>
  );
}
