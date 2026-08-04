"use client";

import { BrandLockup } from "@/components/marketing/brand-lockup";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppStoreButton } from "@/components/marketing/app-store-button";

const NAV_LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#why", label: "Why" },
  { href: "/#faq", label: "FAQ" },
] as const;

/** Scroll distance past which the header swaps to its opaque surface. */
const OPAQUE_AT = 32;

/**
 * Sticky marketing header.
 *
 * Two behaviors carry the v6 direction:
 *
 * 1. The surface is transparent at the top of the page and opaque after 32px of
 *    scroll. This is a boolean threshold read from a passive listener, not a
 *    scroll-linked animation, so it costs one class flip per crossing. Ink stays
 *    ink in both states, so contrast never depends on the surface resolving.
 * 2. The narrow menu is in flow and is not a focus trap: it pushes the page down
 *    and Tab continues into the document. Escape closes it and returns focus to
 *    the toggle.
 *
 * The desktop and narrow bars are chosen by CSS media query rather than by a
 * measured `window.innerWidth`, so the first server paint already matches the
 * viewport instead of flashing the desktop bar on a phone.
 */
export function SiteHeader() {
  const [opaque, setOpaque] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuMax, setMenuMax] = useState(0);
  const menuInner = useRef<HTMLElement | null>(null);
  const toggle = useRef<HTMLButtonElement | null>(null);
  const header = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onScroll = () => {
      setOpaque((window.scrollY || window.pageYOffset || 0) >= OPAQUE_AT);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const close = useCallback((returnFocus: boolean) => {
    setMenuOpen(false);
    if (returnFocus) toggle.current?.focus();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && !header.current?.contains(target)) close(false);
    };
    // Widening past the breakpoint hides the burger; a menu left open would keep
    // pushing the page down with no visible control to close it.
    const onResize = () => {
      if (window.innerWidth >= 768) close(false);
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen, close]);

  const openMenu = () => {
    // Measured rather than fixed: the panel animates max-height, and a guessed
    // value either clips the last link or leaves dead space below it.
    setMenuMax(menuInner.current?.scrollHeight ?? 0);
    setMenuOpen(true);
  };

  return (
    <header ref={header} className="mkt-header" data-opaque={opaque}>
      <div className="mkt-shell">
        <div className="mkt-header__bar">
          <a href="#top" className="mkt-lockup" style={{ justifySelf: "start" }}>
            <BrandLockup priority />
          </a>
          <nav aria-label="Primary" className="mkt-header__nav">
            <ul className="mkt-navlist">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <a className="mkt-navlink" href={link.href}>{link.label}</a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="mkt-header__actions">
            <AppStoreButton size="sm" />
            <button
              ref={toggle}
              type="button"
              className="mkt-burger"
              aria-label="Menu"
              aria-expanded={menuOpen}
              aria-controls="mkt-menu"
              onClick={() => (menuOpen ? close(false) : openMenu())}
            >
              <span aria-hidden="true" className="mkt-burger__box">
                <span className="mkt-burger__line" />
                <span className="mkt-burger__line" />
                <span className="mkt-burger__line" />
              </span>
            </button>
          </div>
        </div>
        <div
          id="mkt-menu"
          className="mkt-menu"
          data-open={menuOpen}
          style={{ ["--menu-max" as string]: `${menuMax}px` }}
        >
          <div className="mkt-menu__clip">
            <nav
              ref={menuInner}
              aria-label="Primary"
              className="mkt-menu__inner"
            >
              {NAV_LINKS.map((link) => (
                <a
                  key={link.href}
                  className="mkt-menu__link"
                  href={link.href}
                  onClick={() => close(false)}
                >
                  {link.label}
                </a>
              ))}
            </nav>
          </div>
        </div>
      </div>
    </header>
  );
}
