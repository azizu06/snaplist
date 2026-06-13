"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AppSignOutButton } from "./sign-out-button";
import { ThemeMenuToggle } from "./theme-toggle";

/**
 * ProfileMenu — the topbar avatar opens an account dropdown (dashboard v2).
 * Server layout passes plain user fields (name/email/imageUrl from Clerk) so
 * this stays a dumb client component; sign-out reuses AppSignOutButton.
 * Standard menu behavior: click-outside and Escape close, aria-expanded on
 * the trigger, items are real links.
 */

export interface ProfileUser {
  name: string;
  email: string;
  imageUrl: string | null;
}

function MenuItem({
  href,
  onNavigate,
  icon,
  children,
}: {
  href: string;
  onNavigate: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onNavigate}
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2"
    >
      <span className="text-faint">{icon}</span>
      {children}
    </Link>
  );
}

export function ProfileMenu({ user }: { user: ProfileUser }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const initial = (user.name || user.email || "?").charAt(0).toUpperCase();
  const close = () => setOpen(false);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
        className={`flex size-8 items-center justify-center overflow-hidden rounded-full text-[12px] font-bold text-white ring-2 ring-offset-2 ring-offset-surface transition-shadow ${
          open ? "ring-accent" : "ring-border hover:ring-border-strong"
        }`}
      >
        {user.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external Clerk avatar
          <img src={user.imageUrl} alt="" className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center bg-gradient-to-br from-[#7a73ff] to-[#a960ee]">
            {initial}
          </span>
        )}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className="menu-pop absolute right-0 top-full z-40 mt-2 w-60 origin-top-right rounded-xl border border-border bg-surface p-1.5 shadow-lg"
        >
          <div className="border-b border-border px-2.5 pb-2.5 pt-1.5">
            <p className="truncate text-[13px] font-semibold text-fg-strong">
              {user.name}
            </p>
            <p className="truncate text-[12px] text-muted">{user.email}</p>
          </div>

          <div className="flex flex-col gap-0.5 py-1">
            {/* r6 (owner): proper gear glyph — the old icon was a sun, which
                reads as a theme control. "eBay connection" was removed: it
                pointed at the same /settings page Settings already opens. */}
            <MenuItem
              href="/settings"
              onNavigate={close}
              icon={
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              }
            >
              Settings
            </MenuItem>
            <MenuItem
              href="/tour"
              onNavigate={close}
              icon={
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <path d="M12 17h.01" />
                </svg>
              }
            >
              Tour
            </MenuItem>
            {/* Quick light/dark flip — full Light/Dark/System lives in
                Settings → Appearance. Doesn't close the menu: flipping is
                something you want to see happen. */}
            <ThemeMenuToggle />
          </div>

          <div className="border-t border-border pt-1">
            <AppSignOutButton className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg">
              <svg viewBox="0 0 24 24" className="size-4 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="m16 17 5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
              Sign out
            </AppSignOutButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}
