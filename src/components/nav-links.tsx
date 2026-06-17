"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Navigation (issue #40; Shopify nav-mirror pass). Desktop sidebar: the PRIMARY
 * group (Home · New listing · Inbox) with Settings pinned to the bottom
 * (rendered by AppSidebar via `SidebarFooter`). (The "Sales channels" group was
 * dropped — eBay connection lives in Settings, so a second entry was redundant.)
 * Items are 14px, icon + label; the active item is a soft-green pill. Collapsed
 * → a 64px icon rail (labels fade out). Mobile keeps the flush bottom tab bar
 * (Home · Sell · Inbox · Settings). Client-only for pathname-driven active state.
 */

const ICONS: Record<string, React.ReactNode> = {
  home: (
    <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
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
      // `gap-3` lives in the EXPANDED branch only: when collapsed the label span
      // is still a (zero-width) flex item, so a base gap would offset the
      // `justify-center` group and push the icon ~6px left of the active pill's
      // center. No gap collapsed → the icon sits dead-center for every item.
      className={`flex items-center rounded-lg py-2.5 text-[15px] ${
        collapsed ? "justify-center px-0" : "gap-3 px-3"
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

export function SidebarNav({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {PRIMARY_LINKS.map((link) => (
        <SidebarItem key={link.href} link={link} collapsed={collapsed} />
      ))}
    </nav>
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

/**
 * Hide-on-scroll for the mobile dock: it slides out of view while the user
 * scrolls DOWN (reading deeper), and slides back in the moment they scroll UP or
 * pause (so it's there when wanted). GPU-friendly (transform only) and disabled
 * under reduced-motion. Window scroll drives it — the list pages scroll the page.
 */
function useHideOnScrollDown() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    let idle: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      const y = window.scrollY;
      if (y > last && y > 72) setHidden(true); // descending, past the top bar
      else if (y < last) setHidden(false); // ascending → reveal
      last = y;
      clearTimeout(idle);
      idle = setTimeout(() => setHidden(false), 1200); // settled → reveal
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      clearTimeout(idle);
    };
  }, []);
  return hidden;
}

export function MobileNav() {
  const pathname = usePathname();
  const tabs = [...PRIMARY_LINKS, SETTINGS_LINK];
  const hidden = useHideOnScrollDown();
  return (
    <nav
      aria-label="Primary"
      className={`fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none sm:hidden ${
        hidden ? "translate-y-full" : "translate-y-0"
      }`}
    >
      <ul className="flex h-14 items-stretch">
        {tabs.map(({ href, label, icon, match }) => {
          const active = match(pathname);
          // Icon-only bar — the glyph carries the meaning, so the captions are
          // gone (the visible label moves to `aria-label` for screen readers).
          // Home keeps the house (reads as "dashboard"); New listing keeps the
          // plus — it's its own photo → AI-pipeline section, not a sub-action of
          // the listings table — and the desktop sidebar matches.
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className="flex h-full items-center justify-center"
              >
                <span
                  className={`flex size-10 items-center justify-center rounded-xl transition-colors [&_svg]:size-6 ${
                    active
                      ? "bg-accent-soft text-accent-soft-fg"
                      : "text-faint hover:text-fg-strong"
                  }`}
                >
                  {ICONS[icon]}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
