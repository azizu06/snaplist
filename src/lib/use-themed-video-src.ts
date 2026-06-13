"use client";

import { useTheme } from "next-themes";

/**
 * Swap a light demo clip (`/foo.mp4`) for its dark sibling (`/foo-dark.mp4`)
 * once the resolved theme is known, so the Remotion videos follow the app's
 * light/dark toggle instead of always showing the light render.
 *
 * The dark variants are rendered from the same compositions with
 * `--props '{"theme":"dark"}'` (see remotion/suite/theme.ts). `resolvedTheme`
 * is undefined on the server and on the first client render (next-themes
 * resolves it after mount), so SSR and hydration both return the light src —
 * no mismatch. It then upgrades to the dark file; the embeds are lazy + muted,
 * so the swap is invisible, and the embedding component reloads the element.
 */
export function useThemedVideoSrc(lightSrc: string): string {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === "dark"
    ? lightSrc.replace(/\.mp4$/, "-dark.mp4")
    : lightSrc;
}
