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
      <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
        <div className="grid h-14 grid-cols-[auto_1fr_auto] items-center gap-3 px-4 sm:gap-4 sm:px-6">
          {/* brand — always top-left (the sidebar no longer carries it) */}
          <Link
            href={signedIn ? "/dashboard" : "/"}
            className="flex shrink-0 items-center gap-2 text-[15px] font-bold tracking-tight text-fg-strong"
          >
            <LogoMark className="size-6" />
            SnapList
          </Link>

          {/* center zone — screen-centered search (empty when signed out) */}
          <div className="flex min-w-0 justify-center">
            {signedIn ? <CommandPalette fixtures={searchFixtures} /> : null}
          </div>

          {/* right zone — bell · theme · account */}
          {signedIn ? (
            <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
              <NotificationBell userId={userId} initial={notifications} />
              <ThemeTopbarToggle className="hidden sm:flex" />
              {user ? <ProfileMenu user={user} /> : null}
            </div>
          ) : (
            <div />
          )}
        </div>
      </header>

      {/* ---- body: sidebar + content canvas ---- */}
      <div className="flex min-h-0 flex-1">
        {signedIn ? <AppSidebar /> : null}
        {/* pb-20: clearance for the floating mobile dock */}
        <div className="flex min-w-0 flex-1 flex-col pb-20 sm:pb-0">{children}</div>
      </div>

      {signedIn ? <MobileNav /> : null}
    </div>
  );
}
