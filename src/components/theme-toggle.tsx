"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

/**
 * ThemeIconToggle — sun/moon icon button (marketing nav), the one remaining
 * face of next-themes state after #598 retired the web app route group that
 * hosted the app ProfileMenu and settings → Appearance surfaces.
 *
 * Waits for the client mount before reading the theme (next-themes can't
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
