import Link from "next/link";

/**
 * (auth) group layout (issue #49) — minimal night chrome around the themed
 * Clerk card: brand top-left escaping back to the landing, aurora glow, no
 * nav/footer noise.
 */
export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="aurora dotgrid relative flex min-h-screen flex-col overflow-hidden bg-night text-flash">
      <header className="relative z-10 px-5 py-5 sm:px-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2.5 font-display text-[17px] font-semibold tracking-tight text-flash"
        >
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-lg bg-volt text-volt-ink"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
          </span>
          SnapList
        </Link>
      </header>
      <div className="relative z-10 flex flex-1 flex-col">{children}</div>
    </div>
  );
}
