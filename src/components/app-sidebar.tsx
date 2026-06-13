"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SidebarNav } from "./nav-links";
import { LogoMark } from "./logo";

/**
 * AppSidebar — the desktop sidebar, now collapsible (dashboard v2). Expanded
 * is the Stripe-style 218px rail; collapsed is a 64px icon rail. The width
 * animates; labels fade. Toggle via the bottom button or the `[` key (ignored
 * while typing). Preference persists in localStorage — read after mount so
 * SSR markup stays deterministic; the first paint is always expanded.
 */

const STORAGE_KEY = "snaplist.sidebar-collapsed";

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable
  );
}

export function AppSidebar() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // Deferred a frame: SSR can't know the stored preference, so the first
    // client paint is always expanded and the stored "collapsed" applies
    // right after (also keeps setState out of the effect body per
    // react-hooks/set-state-in-effect).
    const id = requestAnimationFrame(() => {
      try {
        if (localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
      } catch {
        // storage blocked — session-only state is fine
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((v) => {
      try {
        localStorage.setItem(STORAGE_KEY, v ? "0" : "1");
      } catch {
        // storage blocked — session-only state is fine
      }
      return !v;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "[" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isTypingTarget(e.target)
      ) {
        e.preventDefault();
        toggle();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  return (
    <aside
      data-collapsed={collapsed || undefined}
      className={`relative sticky top-0 z-40 hidden h-screen shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none sm:flex ${
        collapsed ? "w-16" : "w-[218px]"
      }`}
    >
      {/* Floating edge toggle — straddles the sidebar border, aligned with
          the brand row. z-40 on the aside keeps the overhanging half above
          the z-30 topbar. */}
      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={`${collapsed ? "Expand" : "Collapse"} sidebar · [`}
        className="absolute -right-3 top-[22px] flex size-6 items-center justify-center rounded-full border border-border bg-surface text-faint shadow-xs transition-all hover:border-border-strong hover:text-fg motion-safe:active:scale-95"
      >
        <svg
          viewBox="0 0 24 24"
          className={`size-3.5 transition-transform duration-300 motion-reduce:transition-none ${
            collapsed ? "rotate-180" : ""
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <Link
        href="/dashboard"
        className={`flex items-center gap-2.5 pb-4 pt-5 text-[15px] font-bold tracking-tight text-fg-strong ${
          collapsed ? "justify-center px-0" : "px-5"
        }`}
      >
        <LogoMark className="size-7 shrink-0" />
        <span
          className={`overflow-hidden whitespace-nowrap transition-opacity duration-200 ${
            collapsed ? "w-0 opacity-0" : "opacity-100"
          }`}
        >
          SnapList
        </span>
      </Link>

      <div className={`flex-1 overflow-y-auto ${collapsed ? "px-2.5" : "px-3"}`}>
        <SidebarNav collapsed={collapsed} />
      </div>

    </aside>
  );
}
