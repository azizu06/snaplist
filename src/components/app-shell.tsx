import Link from "next/link";
import { SidebarNav, MobileNav } from "./nav-links";
import { AppSignOutButton } from "./sign-out-button";
import { LogoMark } from "./logo";

/**
 * AppShell — Stripe-Dashboard layout language on the Prism-light identity
 * (issue #49 round 4, replicated from the Mobbin Stripe dashboard refs):
 * a white left sidebar (brand, grouped nav, sign-out pinned to the bottom),
 * a white top bar with a centered search field and a violet primary action,
 * content on a cool-gray canvas. Mobile keeps the bottom tab bar.
 *
 * Signed-out: logo-only top bar, no nav.
 */
export function AppShell({
  signedIn,
  children,
}: {
  signedIn: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full">
      {/* ---- sidebar (Stripe: white, grouped items, brand top) ---- */}
      {signedIn ? (
        <aside className="sticky top-0 hidden h-screen w-[218px] shrink-0 flex-col border-r border-border bg-surface sm:flex">
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 px-5 pb-4 pt-5 text-[15px] font-bold tracking-tight text-fg-strong"
          >
            <LogoMark className="size-7" />
            SnapList
          </Link>
          <div className="flex-1 overflow-y-auto px-3">
            <SidebarNav />
          </div>
          <div className="border-t border-border px-3 py-3">
            <AppSignOutButton className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg">
              <svg viewBox="0 0 24 24" className="size-4 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="m16 17 5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
              Sign out
            </AppSignOutButton>
          </div>
        </aside>
      ) : null}

      {/* ---- main column: topbar + content ---- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            {/* brand on mobile / signed-out */}
            <Link
              href={signedIn ? "/dashboard" : "/"}
              className={`flex items-center gap-2 text-sm font-bold tracking-tight text-fg-strong ${
                signedIn ? "sm:hidden" : ""
              }`}
            >
              <LogoMark className="size-6" />
              SnapList
            </Link>

            {signedIn ? (
              <>
                {/* search (Stripe: centered, pill, ⌘K) */}
                <div className="hidden max-w-md flex-1 items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-faint sm:flex">
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.3-4.3" />
                  </svg>
                  Search listings…
                  <kbd className="ml-auto rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-faint">
                    ⌘K
                  </kbd>
                </div>

                <div className="ml-auto flex items-center gap-2.5">
                  <Link
                    href="/upload"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover"
                  >
                    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    New listing
                  </Link>
                  <span
                    aria-hidden
                    className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-[#7a73ff] to-[#a960ee] text-[12px] font-bold text-white"
                  >
                    A
                  </span>
                </div>
              </>
            ) : null}
          </div>
        </header>

        <div className="flex min-w-0 flex-1 flex-col pb-16 sm:pb-0">{children}</div>
      </div>

      {signedIn ? <MobileNav /> : null}
    </div>
  );
}
