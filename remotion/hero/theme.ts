/**
 * Shared palette + pixel-exact layout grid for the hero demo video.
 *
 * Every clickable target in the video is defined here as a rect; cursor
 * scripts derive their waypoints from `center(rect)` and the click ripple /
 * button press states key off the same frame constants — so a click can
 * never render anywhere the cursor isn't.
 */

/**
 * Themeable palette (r6): same CSS-var-with-light-fallback scheme as
 * remotion/suite/theme.ts. The shared chrome in hero/primitives.tsx is used
 * by the suite videos, so it must follow the same `--sl-*` variables the
 * suite Scene injects in dark mode. Light is unchanged (fallbacks = old hex).
 */
export const INK = "var(--sl-ink, #1a1a1a)";
export const DIM = "var(--sl-dim, #404040)";
export const FAINT = "var(--sl-faint, #6d7175)";
export const LINE = "var(--sl-line, #e1e3e5)";
export const SLAB = "var(--sl-slab, #f6f6f7)";
/** card / window / panel surface — replaces hardcoded "white" fills. */
export const SURFACE = "var(--sl-surface, #ffffff)";
export const VIOLET = "var(--sl-violet, #008060)";
export const GREEN = "var(--sl-green, #16a34a)";

export const font =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const center = (r: Rect): { x: number; y: number } => ({
  x: r.x + r.w / 2,
  y: r.y + r.h / 2,
});

/* ---------- canvas: 1120 x 840 ---------- */

/** app window */
export const WIN: Rect = { x: 28, y: 28, w: 1064, h: 784 };
export const TOPBAR_H = 58;

/* ---------- left column ---------- */

/** photo dropzone / photo — click target for "Add photos" */
export const PHOTO_BOX: Rect = { x: 50, y: 108, w: 400, h: 300 };
/** status pill row under the photo */
export const STATUS_Y = 420;
/** agent activity feed panel */
export const FEED_BOX: Rect = { x: 50, y: 462, w: 400, h: 328 };

/* ---------- right column ---------- */

export const RIGHT_X = 472;
export const RIGHT_W = 598;

export const HEAD_Y = 108;
export const TITLE_LABEL_Y = 152;
export const TITLE_FIELD: Rect = { x: RIGHT_X, y: 170, w: RIGHT_W, h: 44 };
export const CHIPS_Y = 228;
export const DESC_LABEL_Y = 272;
export const DESC_FIELD: Rect = { x: RIGHT_X, y: 290, w: RIGHT_W, h: 156 };
export const PRICE_MODULE: Rect = { x: RIGHT_X, y: 462, w: RIGHT_W, h: 186 };
/** the suggested-price value box inside the price module — click target for the Act 3 edit */
export const PRICE_INPUT: Rect = { x: RIGHT_X + 18, y: 510, w: 168, h: 48 };
/** primary CTA — click target for "Publish to eBay" */
export const PUBLISH_BTN: Rect = { x: RIGHT_X, y: 668, w: RIGHT_W, h: 52 };
export const LISTING_ID_Y = 732;
