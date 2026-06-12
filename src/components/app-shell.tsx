import Link from "next/link";
import { SidebarNav, MobileNav } from "./nav-links";
import { AppSignOutButton } from "./sign-out-button";

/**
 * AppShell — Shopify-admin chrome (issue #40 round 2, replicated from the
 * Mobbin Shopify admin references): a near-black top bar with the brand and a
 * persistent primary action, a light desktop SIDEBAR for navigation (active
 * item = white pill), content as white cards on a gray canvas. Mobile keeps
 * the Mercari/Depop bottom tab bar.
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
    <div className="flex min-h-full flex-col">
      {/* ---- top bar (Shopify: near-black, brand left, action right) ---- */}
      <header className="sticky top-0 z-30 bg-topbar">
        <div className="flex h-12 items-center justify-between gap-3 px-3 sm:px-4">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight text-topbar-fg"
          >
            <span
              aria-hidden
              className="flex size-6 items-center justify-center rounded-md bg-accent-solid text-accent-fg"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                <path d="m3.3 7 8.7 5 8.7-5" />
                <path d="M12 22V12" />
              </svg>
            </span>
            SnapList
          </Link>

          {signedIn ? (
            <Link
              href="/upload"
              className="inline-flex items-center gap-1.5 rounded-lg bg-topbar-pill px-3 py-1.5 text-xs font-medium text-topbar-fg transition-colors hover:opacity-80"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New listing
            </Link>
          ) : null}
        </div>
      </header>

      {/* ---- body: sidebar (desktop) + content ---- */}
      <div className="flex flex-1">
        {signedIn ? (
          <aside className="sticky top-12 hidden h-[calc(100vh-3rem)] w-56 shrink-0 flex-col justify-between border-r border-border bg-bg px-3 py-4 sm:flex">
            <SidebarNav />
            <AppSignOutButton className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-surface-3/60 hover:text-fg">
              <svg viewBox="0 0 24 24" className="size-4 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="m16 17 5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
              Sign out
            </AppSignOutButton>
          </aside>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col pb-16 sm:pb-0">{children}</div>
      </div>

      {signedIn ? <MobileNav /> : null}
    </div>
  );
}
