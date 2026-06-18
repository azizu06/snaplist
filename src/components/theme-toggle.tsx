"use client";

import { useSyncExternalStore } from "react";
import { motion } from "motion/react";
import { useTheme } from "next-themes";

/**
 * Theme controls — the three faces of the same next-themes state:
 *  - ThemeIconToggle: sun/moon icon button (marketing nav)
 *  - ThemeMenuToggle: dropdown row (app ProfileMenu)
 *  - ThemeSegmented:  Light / Dark / System control (settings → Appearance)
 *
 * All wait for the client mount before reading the theme (next-themes can't
 * know it on the server). The mounted flag comes from useSyncExternalStore —
 * snapshot false on the server, true on the client — instead of the classic
 * setState-in-useEffect, which the react-hooks/set-state-in-effect lint rule
 * (rightly) rejects.
 */

const noopSubscribe = () => () => {};

function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

function SunIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function MonitorIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

/** Small round icon button — marketing nav. */
export function ThemeIconToggle({ className = "" }: { className?: string }) {
  const mounted = useMounted();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = mounted && resolvedTheme === "dark";

  return (
    <button
      type="button"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={`flex size-9 items-center justify-center rounded-full text-flash-dim transition-colors hover:bg-panel-2/70 hover:text-flash ${className}`}
    >
      {/* Render the sun until mounted — matches the light default, no flash. */}
      {isDark ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

/** Icon button tuned for the app's neutral top bar (next to the bell). */
export function ThemeTopbarToggle({ className = "" }: { className?: string }) {
  const mounted = useMounted();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = mounted && resolvedTheme === "dark";

  return (
    <button
      type="button"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={`flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg-strong motion-safe:active:scale-[0.96] ${className}`}
    >
      {/* size-[18px] to match the notification bell glyph next to it */}
      {isDark ? <MoonIcon className="size-[18px]" /> : <SunIcon className="size-[18px]" />}
    </button>
  );
}

/** Dropdown row — same chrome as ProfileMenu's MenuItem links. */
export function ThemeMenuToggle() {
  const mounted = useMounted();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = mounted && resolvedTheme === "dark";

  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] font-medium text-fg transition-colors hover:bg-surface-2"
    >
      <span className="text-faint">{isDark ? <SunIcon /> : <MoonIcon />}</span>
      {isDark ? "Light mode" : "Dark mode"}
    </button>
  );
}

const SEGMENTS = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
] as const;

/** Light / Dark / System segmented control — settings → Appearance. */
export function ThemeSegmented() {
  const mounted = useMounted();
  const { theme, setTheme } = useTheme();
  // Until mounted, render with nothing selected (theme unknown server-side).
  const active = mounted ? theme : undefined;

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5"
    >
      {SEGMENTS.map(({ value, label, Icon }) => {
        const selected = active === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(value)}
            className={`relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[14px] font-medium transition-colors ${
              selected ? "text-fg-strong" : "text-muted hover:text-fg"
            }`}
          >
            {/* Sliding highlight — the selected pill glides between segments
                (shared-layout motion) instead of hard-cutting. */}
            {selected ? (
              <motion.span
                layoutId="theme-segment-pill"
                aria-hidden
                className="absolute inset-0 rounded-md bg-surface shadow-xs"
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
              />
            ) : null}
            <Icon className="relative size-3.5" />
            <span className="relative">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
