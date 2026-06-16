"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navigation (issue #40; Shopify nav-mirror pass). Desktop sidebar follows
 * Shopify's grouped admin nav: a PRIMARY group (Home · New listing · Inbox), a
 * "Sales channels" group (eBay — the real post target), and Settings pinned to
 * the bottom (rendered by AppSidebar via `SidebarFooter`). Items are 14px,
 * icon + label; the active item is a soft-green pill. Collapsed → a 64px icon
 * rail (labels + group headers fade out). Mobile keeps the flush bottom tab bar
 * (Home · Sell · Inbox · Settings). Client-only for pathname-driven active state.
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
  tag: (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 3.5h7l9.5 9.5a2 2 0 0 1 0 2.83l-4.17 4.17a2 2 0 0 1-2.83 0L3.5 10.5z" />
      <circle cx="7.5" cy="7.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
};

interface NavLink {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  match: (p: string) => boolean;
}

/** PRIMARY nav — the seller's day-to-day. Also the mobile tab set (+ Settings). */
const PRIMARY_LINKS: readonly NavLink[] = [
  {
    href: "/dashboard",
    label: "Home",
    icon: "home",
    // The /dev/preview prefixes keep active states realistic in the dev-only
    // screenshot harness (the route 404s in production).
    match: (p) => p.startsWith("/dashboard") || p.startsWith("/dev/preview/dashboard"),
  },
  {
    href: "/upload",
    label: "New listing",
    icon: "plus",
    match: (p) => p.startsWith("/upload") || p.startsWith("/dev/preview/upload"),
  },
  {
    href: "/inbox",
    label: "Inbox",
    icon: "inbox",
    match: (p) => p.startsWith("/inbox"),
  },
];

/** Sales channels — where listings actually post (Shopify "Sales channels"). */
const CHANNEL_LINKS: readonly NavLink[] = [
  {
    href: "/settings",
    label: "eBay",
    icon: "tag",
    // No active state of its own — it points into Settings where the
    // connection is managed.
    match: () => false,
  },
];

const SETTINGS_LINK: NavLink = {
  href: "/settings",
  label: "Settings",
  icon: "settings",
  match: (p) => p.startsWith("/settings"),
};

function SidebarItem({
  link,
  collapsed,
}: {
  link: NavLink;
  collapsed: boolean;
}) {
  const pathname = usePathname();
  const active = link.match(pathname);
  return (
    <Link
      href={link.href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? link.label : undefined}
      className={`flex items-center gap-2.5 rounded-lg py-2 text-[14px] ${
        collapsed ? "justify-center px-0" : "px-2.5"
      } ${
        active
          ? "bg-accent-soft font-semibold text-accent-soft-fg"
          : "font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg-strong"
      }`}
    >
      <span className={active ? "text-accent-soft-fg" : "text-faint"}>
        {ICONS[link.icon]}
      </span>
      <span
        className={`overflow-hidden whitespace-nowrap transition-[opacity,width] duration-200 ${
          collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
        }`}
      >
        {link.label}
      </span>
    </Link>
  );
}

/** Small Shopify-style group header — fades out when the rail is collapsed. */
function GroupLabel({ children, collapsed }: { children: React.ReactNode; collapsed: boolean }) {
  return (
    <p
      className={`px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint transition-opacity duration-200 ${
        collapsed ? "h-0 overflow-hidden opacity-0" : "opacity-100"
      }`}
    >
      {children}
    </p>
  );
}

export function SidebarNav({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      <nav aria-label="Primary" className="flex flex-col gap-0.5">
        {PRIMARY_LINKS.map((link) => (
          <SidebarItem key={link.href} link={link} collapsed={collapsed} />
        ))}
      </nav>
      <div>
        <GroupLabel collapsed={collapsed}>Sales channels</GroupLabel>
        <nav aria-label="Sales channels" className="flex flex-col gap-0.5">
          {CHANNEL_LINKS.map((link) => (
            <SidebarItem key={`ch-${link.label}`} link={link} collapsed={collapsed} />
          ))}
        </nav>
      </div>
    </div>
  );
}

/** Settings, pinned to the bottom of the rail (Shopify's footer slot). */
export function SidebarFooter({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <nav aria-label="Account">
      <SidebarItem link={SETTINGS_LINK} collapsed={collapsed} />
    </nav>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const tabs = [...PRIMARY_LINKS, SETTINGS_LINK];
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
    >
      <ul className="flex items-stretch">
        {tabs.map(({ href, label, icon, match }) => {
          const active = match(pathname);
          const tabLabel = label === "New listing" ? "Sell" : label;
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors [&_svg]:size-5 ${
                  active
                    ? "text-accent-soft-fg"
                    : "text-faint hover:text-fg-strong"
                }`}
              >
                {ICONS[icon]}
                {tabLabel}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
