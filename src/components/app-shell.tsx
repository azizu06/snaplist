import Link from "next/link";
import ClickSpark from "./bits/ClickSpark";
import { MobileNav } from "./nav-links";
import { AppSidebar } from "./app-sidebar";
import { ProfileMenu, type ProfileUser } from "./profile-menu";
import { CommandPalette, type PaletteHit } from "./command-palette";
import { LogoMark } from "./logo";

/**
 * AppShell — Shopify-admin shell on the neutral+green identity (issue #49; nav
 * mirror pass). Shopify's chrome: a FULL-WIDTH top bar spanning above
 * everything — logo top-left, the ⌘K search centered, the primary action +
 * account on the right — then a row of the collapsible left sidebar + the
 * content canvas beneath it. Mobile keeps the bottom tabs and a right-aligned
 * search icon.
 *
 * Signed-out: logo-only top bar, no nav. `searchFixtures` is dev-preview
 * only — it lets the palette search fixture rows without a session.
 */
export function AppShell({
  signedIn,
  user,
  searchFixtures,
  children,
}: {
  signedIn: boolean;
  user: ProfileUser | null;
  searchFixtures?: PaletteHit[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col">
      {/* ---- full-width top bar (Shopify): logo · centered search · actions ---- */}
      <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
        <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
          {/* brand — always top-left (the sidebar no longer carries it) */}
          <Link
            href={signedIn ? "/dashboard" : "/"}
            className="flex shrink-0 items-center gap-2 text-[15px] font-bold tracking-tight text-fg-strong"
          >
            <LogoMark className="size-6" />
            SnapList
          </Link>

          {signedIn ? (
            <>
              {/* centered search on desktop; right-aligned icon on mobile */}
              <div className="flex flex-1 justify-end sm:justify-center">
                <CommandPalette fixtures={searchFixtures} />
              </div>

              {/* gap-4: breathing room between the primary action and the avatar */}
              <div className="flex shrink-0 items-center gap-3 sm:gap-4">
                {/* react-bits ClickSpark: a small green burst on the primary
                    action. Hidden on mobile — the bottom dock owns "Sell". */}
                <ClickSpark
                  className="hidden sm:inline-block"
                  sparkColor="#008060"
                  sparkSize={7}
                  sparkRadius={16}
                  sparkCount={8}
                  duration={400}
                >
                  <Link
                    href="/upload"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[14px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover motion-safe:active:scale-[0.98]"
                  >
                    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    New listing
                  </Link>
                </ClickSpark>
                {user ? <ProfileMenu user={user} /> : null}
              </div>
            </>
          ) : null}
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
