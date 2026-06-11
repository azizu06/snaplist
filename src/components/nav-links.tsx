"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Nav with active-location state (audit S-5). Client-only because active state
 * needs the pathname; the shell around it stays a server component.
 */

const LINKS = [
  { href: "/", label: "Dashboard", match: (p: string) => p === "/" },
  {
    href: "/inbox",
    label: "Inbox",
    match: (p: string) => p.startsWith("/inbox"),
  },
  {
    href: "/settings",
    label: "Settings",
    match: (p: string) => p.startsWith("/settings"),
  },
] as const;

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1" aria-label="Primary">
      {LINKS.map(({ href, label, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "rounded-md bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-fg-strong sm:text-sm"
                : "rounded-md px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg sm:text-sm"
            }
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

const MOBILE_LINKS = [
  { href: "/", label: "Dashboard", match: (p: string) => p === "/" },
  { href: "/upload", label: "New", match: (p: string) => p.startsWith("/upload") },
  { href: "/inbox", label: "Inbox", match: (p: string) => p.startsWith("/inbox") },
  {
    href: "/settings",
    label: "Settings",
    match: (p: string) => p.startsWith("/settings"),
  },
] as const;

const MOBILE_ICONS: Record<string, React.ReactNode> = {
  Dashboard: (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </svg>
  ),
  New: (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  ),
  Inbox: (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),
  Settings: (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
};

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur sm:hidden"
    >
      <div className="mx-auto grid max-w-md grid-cols-4">
        {MOBILE_LINKS.map(({ href, label, match }) => {
          const active = match(pathname);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${
                active ? "text-accent-soft-fg" : "text-muted"
              }`}
            >
              {MOBILE_ICONS[label]}
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
