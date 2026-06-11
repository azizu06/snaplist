import Link from "next/link";
import { NavLinks, MobileNav } from "./nav-links";

/**
 * AppShell (audit X-2/S-1): the persistent frame that stitches the 8 surfaces
 * into one product. Desktop: top bar with nav + sign-out. Mobile: slim top bar
 * + bottom tab bar (casual sellers are on phones, S-4).
 *
 * Signed-out (login / public landing): logo-only header, no nav — the shell
 * never advertises destinations that would bounce to login.
 */
export function AppShell({
  user,
  children,
}: {
  user: { email: string | null } | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 text-base font-semibold tracking-tight text-fg-strong"
          >
            <span
              aria-hidden
              className="flex size-7 items-center justify-center rounded-lg bg-accent-solid text-accent-fg"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                <path d="m3.3 7 8.7 5 8.7-5" />
                <path d="M12 22V12" />
              </svg>
            </span>
            SnapList
          </Link>

          {user ? (
            <div className="flex items-center gap-1 sm:gap-2">
              <div className="hidden sm:block">
                <NavLinks />
              </div>
              <Link
                href="/upload"
                className="inline-flex items-center gap-1.5 rounded-md bg-accent-solid px-3 py-1.5 text-xs font-medium text-accent-fg shadow-xs transition-colors hover:bg-accent-hover sm:text-sm"
              >
                New listing
              </Link>
              <form action="/auth/signout" method="post" className="hidden sm:block">
                <button
                  type="submit"
                  className="rounded-md px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                >
                  Sign out
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex flex-1 flex-col pb-16 sm:pb-0">{children}</div>

      {user ? <MobileNav /> : null}
    </div>
  );
}
