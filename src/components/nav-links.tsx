"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navigation (issue #40 round 2). Desktop: Shopify-style sidebar items — 13px,
 * icon + label, active item is a white pill with a hairline shadow. Mobile:
 * Mercari/Depop bottom tab bar. Client-only for pathname-driven active state.
 */

const ICONS: Record<string, React.ReactNode> = {
  home: (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
};

const LINKS = [
  {
    href: "/dashboard",
    label: "Home",
    icon: "home",
    match: (p: string) => p.startsWith("/dashboard"),
  },
  {
    href: "/upload",
    label: "New listing",
    icon: "plus",
    match: (p: string) => p.startsWith("/upload"),
  },
  {
    href: "/inbox",
    label: "Inbox",
    icon: "inbox",
    match: (p: string) => p.startsWith("/inbox"),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: "settings",
    match: (p: string) => p.startsWith("/settings"),
  },
] as const;

export function SidebarNav({ collapsed = false }: { collapsed?: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5">
      {LINKS.map(({ href, label, icon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            title={collapsed ? label : undefined}
            className={`flex items-center gap-2.5 rounded-lg py-2 text-[13px] ${
              collapsed ? "justify-center px-0" : "px-2.5"
            } ${
              active
                ? "bg-accent-soft font-semibold text-accent-soft-fg"
                : "font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg-strong"
            }`}
          >
            <span className={active ? "text-accent-soft-fg" : "text-faint"}>
              {ICONS[icon]}
            </span>
            <span
              className={`overflow-hidden whitespace-nowrap transition-[opacity,width] duration-200 ${
                collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
              }`}
            >
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur sm:hidden"
    >
      <div className="mx-auto grid max-w-md grid-cols-4">
        {LINKS.map(({ href, label, icon, match }) => {
          const active = match(pathname);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${
                active ? "text-fg-strong" : "text-faint"
              }`}
            >
              <span className="[&>svg]:size-5">{ICONS[icon]}</span>
              {label === "New listing" ? "Sell" : label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
