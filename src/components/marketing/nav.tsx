"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Logo } from "@/components/logo";
import { ThemeIconToggle } from "@/components/theme-toggle";

const LINKS = [
  { href: "/how-it-works", label: "How it works" },
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
          ? "border-b border-line bg-night/80 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link
          href="/"
          className="text-flash"
          onClick={() => setOpen(false)}
        >
          <Logo markClassName="size-8" />
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
          <ThemeIconToggle />
          {signedIn ? (
            <Link
              href="/dashboard"
              className="group inline-flex items-center gap-1.5 rounded-full bg-iris px-4.5 py-2 text-[13.5px] font-semibold text-iris-ink transition-transform hover:scale-[1.03] active:scale-[0.98]"
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
                className="group inline-flex items-center gap-1.5 rounded-full bg-iris px-4.5 py-2 text-[13.5px] font-semibold text-iris-ink transition-transform hover:scale-[1.03] active:scale-[0.98]"
              >
                Start selling
                <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
              </Link>
            </>
          )}
        </div>

        {/* mobile: theme toggle + menu burger */}
        <div className="flex items-center gap-1 md:hidden">
        <ThemeIconToggle />
        <button
          type="button"
          aria-expanded={open}
          aria-label="Toggle menu"
          onClick={() => setOpen((v) => !v)}
          className="flex size-9 items-center justify-center rounded-lg text-flash"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
        </div>
      </nav>

      {open ? (
        <div className="border-t border-line px-5 pb-5 pt-2 md:hidden">
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
            className="mt-3 inline-flex w-full items-center justify-center rounded-full bg-iris px-4 py-2.5 text-[14px] font-semibold text-iris-ink"
          >
            {signedIn ? "Open app →" : "Start selling →"}
          </Link>
        </div>
      ) : null}
    </header>
  );
}
