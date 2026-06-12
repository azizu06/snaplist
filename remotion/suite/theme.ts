/**
 * Shared palette + canvas geometry for the 1080p demo-video suite.
 *
 * All seven suite videos render at 1920x1080 but are laid out on a 1280x720
 * logical grid scaled by 1.5 (see `Scene` in primitives.tsx) — rect math and
 * cursor choreography stay in logical pixels, and a uniform scale preserves
 * the "cursor tip == click target center" invariant exactly.
 *
 * Correctness pattern (inherited from remotion/hero): every clickable target
 * is a `Rect` constant; cursor paths terminate at `center(rect)`, dwell
 * 12–14 frames, and the click ripple keys off the same frame constant. Each
 * video exports a `CLICKS` spec consumed by `assert-clicks.ts`.
 */

export const INK = "#131e3a";
export const DIM = "#3d4a68";
export const FAINT = "#5f6b88";
export const LINE = "#dfe4ee";
export const SLAB = "#f4f6fb";
export const VIOLET = "#635bff";
export const GREEN = "#16a34a";
export const AMBER = "#b45309";

export const VIOLET_SOFT = "rgba(99,91,255,0.1)";
export const VIOLET_BORDER = "rgba(99,91,255,0.3)";
export const GREEN_SOFT = "rgba(22,163,74,0.1)";

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

/* logical canvas — scaled to 1920x1080 by Scene */
export const LOGICAL_W = 1280;
export const LOGICAL_H = 720;
export const SCALE = 1.5;

/** default app window used by most suite videos */
export const WIN: Rect = { x: 40, y: 30, w: 1200, h: 660 };
export const TOPBAR_H = 56;

/** one click moment, verified programmatically by assert-clicks.ts */
export interface ClickSpec {
  label: string;
  /** video-global frame of the click / press / release */
  frame: number;
  /** the rect the cursor must be centered on at `frame` */
  target: Rect;
  /** frame the cursor arrives at the target center */
  arrive: number;
  /** last frame of the dwell at the target center */
  until: number;
}
