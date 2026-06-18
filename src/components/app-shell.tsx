import Link from "next/link";
import { MobileNav } from "./nav-links";
import { AppSidebar } from "./app-sidebar";
import { ProfileMenu, type ProfileUser } from "./profile-menu";
import { CommandPalette, type PaletteHit } from "./command-palette";
import { NotificationBell } from "./notification-bell";
import { ThemeTopbarToggle } from "./theme-toggle";
import type { NotificationView } from "@/lib/notifications";
import { LogoMark } from "./logo";

/**
 * AppShell — Shopify-admin shell on the neutral+green identity (issue #49; nav
 * mirror pass). Shopify's chrome: a FULL-WIDTH top bar spanning above
 * everything, laid out as three zones — logo (left) · search (TRULY centered
 * to the viewport via a 1fr middle column) · actions (right: notification bell,
 * theme toggle, account) — then a row of the collapsible left sidebar + the
 * content canvas beneath it. Mobile keeps the bottom tabs.
 *
 * Signed-out: logo-only top bar, no nav. `searchFixtures`/`notifications` are
 * dev-preview seeds so the chrome is screenshotable without a session.
 */
export function AppShell({
  signedIn,
  user,
  userId,
  notifications = [],
  searchFixtures,
  children,
}: {
  signedIn: boolean;
  user: ProfileUser | null;
  userId: string | null;
  notifications?: NotificationView[];
  searchFixtures?: PaletteHit[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col">
      {/* ---- full-width top bar (Shopify): logo · centered search · actions ---- */}
      {/* Solid (not bg-surface/95 + backdrop-blur): the backdrop-filter promoted
          the whole bar to a composited layer and rendered the tiny ⌘K pill
          blurry on retina displays. The bar was 95% opaque anyway, so going
          solid is a no-op visually and keeps small text crisp. */}
      <header className="sticky top-0 z-40 border-b border-border bg-surface">
        {/* 1fr · auto · 1fr → the middle (search) cell sits dead-center between
            two equal flanks, so it's centered to the FULL-WIDTH bar = the
            viewport, and never shifts when the sidebar collapses. The center
            track is a clamped width on sm+ so the field is generously sized;
            on mobile it collapses to an auto-sized search icon. */}
        <div className="relative">
          {/* brand — pinned to the bar's true left (over the sidebar zone) so it
              stays put while the search re-centers over the content area. */}
          <Link
            href={signedIn ? "/dashboard" : "/"}
            aria-label="SnapList home"
            className="absolute left-4 top-1/2 z-10 flex -translate-y-1/2 items-center gap-2.5 text-[18px] font-bold tracking-tight text-fg-strong sm:left-6"
          >
            <LogoMark className="size-8" />
            {/* wordmark on every size — with the mobile global search dropped,
                there's room for the full brand again. */}
            <span>SnapList</span>
          </Link>

          {/* Content-area row: left-padded by the LIVE sidebar width (sm+) so the
              centered search is symmetric over the MAIN section and glides as the
              sidebar collapses/expands (--sidebar-w, published by AppSidebar).
              Transition matches the sidebar's width animation. */}
          <div className="grid h-14 grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-2 px-4 transition-[padding] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none sm:h-[72px] sm:grid-cols-[1fr_clamp(16rem,38vw,30rem)_1fr] sm:gap-4 sm:px-6 sm:pl-[var(--sidebar-w)]">
            <div aria-hidden />
            {/* center zone — content-centered search, sm+ ONLY. The mobile
                global search is dropped (sellers explore via each screen's own
                search/filter), so this cell stays empty on phones and the bar
                reads as logo · actions with room to breathe. The cell itself
                stays in flow so the grid columns hold; only the palette hides. */}
            <div className="flex min-w-0 justify-center">
              {signedIn ? (
                <div className="hidden w-full justify-center sm:flex">
                  <CommandPalette fixtures={searchFixtures} />
                </div>
              ) : null}
            </div>

            {/* right zone — bell · theme · (divider) · account. Tight, equal gaps
                between the ghost icon buttons, then a hairline before the avatar
                so the cluster reads evenly spaced rather than crowding the photo. */}
            {signedIn ? (
              <div className="flex items-center justify-end gap-1.5 sm:gap-1">
                <NotificationBell userId={userId} initial={notifications} />
                <ThemeTopbarToggle />
                {user ? (
                  <span aria-hidden className="mx-1 h-5 w-px bg-border sm:mx-1.5" />
                ) : null}
                {user ? <ProfileMenu user={user} /> : null}
              </div>
            ) : (
              <div />
            )}
          </div>
        </div>
      </header>

      {/* ---- body: sidebar + content canvas ---- */}
      <div className="flex min-h-0 flex-1">
        {signedIn ? <AppSidebar /> : null}
        {/* Bottom clearance for the fixed mobile dock — EXACTLY the dock's height
            (h-14 = 56px) + the safe-area inset, so the dock never overlaps
            content and there's no dead band above it (the old pb-20 over-reserved
            and left a gap on no-safe-area viewports). */}
        <div className="flex min-w-0 flex-1 flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:pb-0">{children}</div>
      </div>

      {signedIn ? <MobileNav /> : null}
    </div>
  );
}
