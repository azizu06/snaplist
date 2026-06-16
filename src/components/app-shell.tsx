import Link from "next/link";
import ClickSpark from "./bits/ClickSpark";
import { MobileNav } from "./nav-links";
import { AppSidebar } from "./app-sidebar";
import { ProfileMenu, type ProfileUser } from "./profile-menu";
import { CommandPalette, type PaletteHit } from "./command-palette";
import { LogoMark } from "./logo";

/**
 * AppShell — Stripe-Dashboard layout language on the Prism-light identity
 * (issue #49 round 4; dashboard v2 makes the chrome interactive): a
 * collapsible white left sidebar, a white top bar whose search pill opens the
 * real ⌘K palette, a violet primary action, and the account dropdown on the
 * avatar. Content sits on a cool-gray canvas; mobile keeps the bottom tabs.
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
    <div className="flex min-h-full">
      {signedIn ? <AppSidebar /> : null}

      {/* ---- main column: topbar + content ---- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            {/* brand on mobile / signed-out */}
            <Link
              href={signedIn ? "/dashboard" : "/"}
              className={`flex items-center gap-2 text-[15px] font-bold tracking-tight text-fg-strong ${
                signedIn ? "sm:hidden" : ""
              }`}
            >
              <LogoMark className="size-6" />
              SnapList
            </Link>

            {signedIn ? (
              <>
                <CommandPalette fixtures={searchFixtures} />

                {/* gap-4: breathing room between the primary action and the
                    avatar (round 5 — they sat nearly touching). */}
                <div className="ml-auto flex items-center gap-4">
                  {/* react-bits ClickSpark: a small green burst on the primary
                      action — subtle, product-dashboard scale. */}
                  <ClickSpark
                    className="inline-block"
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

        {/* pb-20: clearance for the floating mobile Dock (react-bits app pass) */}
        <div className="flex min-w-0 flex-1 flex-col pb-20 sm:pb-0">{children}</div>
      </div>

      {signedIn ? <MobileNav /> : null}
    </div>
  );
}
