import React from "react";
import {
  AbsoluteFill,
  Freeze,
  Img,
  Sequence,
  getInputProps,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CheckIcon, Cursor, arriveAndDwell, path, pressAt } from "../../hero/primitives";
import {
  FAINT,
  GREEN,
  INK,
  LINE,
  SLAB,
  SURFACE,
  VIOLET,
  center,
  font,
  paletteVars,
  type Rect,
  type VideoTheme,
} from "../theme";

/**
 * Portrait mobile demos (ui-r7-mobile) — the how-it-works step clips, rebuilt
 * for phones. The desktop suite renders a 1280x720 desktop window; on a 390px
 * phone that UI shrinks to illegible. These render a PORTRAIT, mobile-native
 * SnapList screen (4:5, 1080x1350) with TAP choreography instead of desktop
 * drag-drop, so the in-clip UI is large and readable. /tour swaps to the
 * `-mobile` clip under 768px (see SeamlessThemeVideo / DemoClip).
 *
 * Step 1 · Snap — tap the camera to add photos of the Canon AE-1 one by one
 * (capture flash → photo lands in the cover + rail), ending on
 * "3 photos · ready to identify". Same item + same demo asset as the desktop
 * step so the pipeline still tells one coherent story.
 *
 * Render:
 *   npx remotion render remotion/index.ts step-snap-mobile public/demo/steps/snap-mobile.mp4 --crf 26 --muted
 *   npx remotion render remotion/index.ts step-snap-mobile public/demo/steps/snap-mobile-dark.mp4 --crf 26 --muted --props '{"theme":"dark"}'
 */

/* ---------- portrait canvas ---------- */
// Logical 540x675 (4:5) scaled x2 → 1080x1350. Uniform scale keeps the
// "cursor tip == tap-target center" invariant, exactly like the desktop Scene.
export const M_LOGICAL_W = 540;
export const M_LOGICAL_H = 675;
export const M_SCALE = 2;

/** Portrait composition root — paints the backdrop and scales the logical
 *  phone canvas, injecting the dark palette when rendered with theme:dark. */
export function MobileScene({ children }: { children: React.ReactNode }) {
  const theme: VideoTheme =
    (getInputProps() as { theme?: VideoTheme }).theme === "dark" ? "dark" : "light";
  return (
    <AbsoluteFill style={{ background: SLAB, fontFamily: font, ...paletteVars(theme) }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: M_LOGICAL_W,
          height: M_LOGICAL_H,
          transform: `scale(${M_SCALE})`,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
}

export const STEP_SNAP_MOBILE_LEN = 360;
const SEAM = 16;

/* ---------- layout (logical px) ---------- */
const PAD = 28;
const COVER: Rect = { x: PAD, y: 116, w: M_LOGICAL_W - PAD * 2, h: 246 };
const SLOT = 108;
const SLOT_GAP = 16;
const SLOT_Y = 380;
const slotRect = (i: number): Rect => ({
  x: PAD + i * (SLOT + SLOT_GAP),
  y: SLOT_Y,
  w: SLOT,
  h: SLOT,
});
const BTN: Rect = { x: PAD, y: 560, w: M_LOGICAL_W - PAD * 2, h: 70 };

const IMG = "demo/filmcamera.jpg";
/** three crops of the verified Canon AE-1 photo standing in for angles */
const ANGLES = ["50% 50%", "55% 60%", "32% 45%"];
const THUMB = [
  { origin: "50% 50%", zoom: 1.5 },
  { origin: "56% 58%", zoom: 2.0 },
  { origin: "33% 46%", zoom: 2.1 },
];

/* ---------- choreography ---------- */
const TAP_COVER = 40;
const PHOTO1_AT = 48;
const TAP_ADD1 = 116;
const PHOTO2_AT = 124;
const TAP_ADD2 = 184;
const PHOTO3_AT = 192;
const READY_AT = 224;
const TAP_BTN = 268;

const COVER_C = center(COVER);

/** The "+ Add" tile rides at the slot after the last landed photo. */
const addIndex = (count: number) => Math.min(count, 3);

const WAYPOINTS: Array<[number, number, number]> = [
  [0, 470, 650],
  ...arriveAndDwell(28, TAP_COVER + 8, COVER_C.x, COVER_C.y),
  ...arriveAndDwell(104, TAP_ADD1 + 8, center(slotRect(1)).x, center(slotRect(1)).y),
  ...arriveAndDwell(172, TAP_ADD2 + 8, center(slotRect(2)).x, center(slotRect(2)).y),
  ...arriveAndDwell(254, TAP_BTN + 8, center(BTN).x, center(BTN).y),
  [320, center(BTN).x, center(BTN).y],
];

/* ---------- pieces ---------- */

function Thumb({ index, at }: { index: number; at: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const r = slotRect(index);
  if (frame < at) {
    // empty slot placeholder
    return (
      <div
        style={{
          position: "absolute",
          left: r.x,
          top: r.y,
          width: r.w,
          height: r.h,
          borderRadius: 16,
          border: `1.5px solid ${LINE}`,
          background: SURFACE,
        }}
      />
    );
  }
  const s = spring({ frame: frame - at, fps, config: { damping: 12, stiffness: 150 }, durationInFrames: 20 });
  return (
    <div
      style={{
        position: "absolute",
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        borderRadius: 16,
        overflow: "hidden",
        border: `1.5px solid ${LINE}`,
        opacity: s,
        transform: `scale(${0.84 + s * 0.16})`,
      }}
    >
      <Img
        src={staticFile(IMG)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: ANGLES[index],
          transform: `scale(${THUMB[index].zoom})`,
          transformOrigin: THUMB[index].origin,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 8,
          top: 8,
          width: 22,
          height: 22,
          borderRadius: 99,
          background: "rgba(19,30,58,0.72)",
          color: "white",
          fontSize: 12,
          fontWeight: 800,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {index + 1}
      </div>
    </div>
  );
}

function AddTile({ count }: { count: number }) {
  const r = slotRect(addIndex(count));
  if (addIndex(count) > 2) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        borderRadius: 16,
        border: `2px dashed ${LINE}`,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        color: FAINT,
      }}
    >
      <span style={{ fontSize: 30, lineHeight: 1, color: VIOLET }}>+</span>
      <span style={{ fontSize: 13, fontWeight: 700 }}>Add</span>
    </div>
  );
}

function SnapMobileAct() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cursor = path(frame, WAYPOINTS);
  const press = Math.max(
    pressAt(frame, TAP_COVER),
    pressAt(frame, TAP_ADD1),
    pressAt(frame, TAP_ADD2),
    pressAt(frame, TAP_BTN),
  );

  const count = frame >= PHOTO3_AT ? 3 : frame >= PHOTO2_AT ? 2 : frame >= PHOTO1_AT ? 1 : 0;

  // capture flash on each photo add
  const flashAt = (at: number) =>
    interpolate(frame, [at - 2, at + 1, at + 12], [0, 0.55, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const flash = Math.max(flashAt(PHOTO1_AT), flashAt(PHOTO2_AT), flashAt(PHOTO3_AT));

  const coverIn = spring({
    frame: frame - PHOTO1_AT,
    fps,
    config: { damping: 16, stiffness: 120 },
    durationInFrames: 24,
  });

  const readyIn = spring({ frame: frame - READY_AT, fps, config: { damping: 15 }, durationInFrames: 20 });
  const btnLive = frame >= READY_AT;

  const fadeOut = interpolate(frame, [STEP_SNAP_MOBILE_LEN - SEAM, STEP_SNAP_MOBILE_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      {/* phone app screen */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: SURFACE,
        }}
      >
        {/* header */}
        <div
          style={{
            position: "absolute",
            left: PAD,
            top: 30,
            right: PAD,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.4, color: INK }}>
            New listing
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: 1,
              color: VIOLET,
              background: "var(--sl-violet-soft, rgba(99,91,255,0.1))",
              borderRadius: 99,
              padding: "6px 12px",
            }}
          >
            STEP 1 · SNAP
          </span>
        </div>

        {/* cover dropzone */}
        <div
          style={{
            position: "absolute",
            left: COVER.x,
            top: COVER.y,
            width: COVER.w,
            height: COVER.h,
            borderRadius: 22,
            overflow: "hidden",
            border: count > 0 ? `1.5px solid ${LINE}` : `2.5px dashed var(--sl-violet-border, rgba(99,91,255,0.3))`,
            background: count > 0 ? "#000" : "var(--sl-violet-soft, rgba(99,91,255,0.06))",
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
          }}
        >
          {count > 0 ? (
            <Img
              src={staticFile(IMG)}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                objectPosition: ANGLES[0],
                opacity: coverIn,
              }}
            />
          ) : (
            <>
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 99,
                  background: VIOLET,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
                  <circle cx="12" cy="13" r="3.5" />
                </svg>
              </div>
              <span style={{ fontSize: 21, fontWeight: 800, color: INK }}>Add your first photo</span>
              <span style={{ fontSize: 15, fontWeight: 500, color: FAINT }}>
                Tap to capture · up to 4
              </span>
            </>
          )}
          {flash > 0.01 ? (
            <div style={{ position: "absolute", inset: 0, background: "white", opacity: flash }} />
          ) : null}
        </div>

        {/* thumbnail rail */}
        <Thumb index={0} at={PHOTO1_AT} />
        <Thumb index={1} at={PHOTO2_AT} />
        <Thumb index={2} at={PHOTO3_AT} />
        <AddTile count={count} />

        {/* counter / ready line */}
        <div
          style={{ position: "absolute", left: PAD, top: 502, display: "flex", alignItems: "center", gap: 9 }}
        >
          {frame >= READY_AT ? (
            <>
              <CheckIcon size={17} />
              <span style={{ fontSize: 17, fontWeight: 700, color: GREEN }}>
                3 photos · ready to identify
              </span>
            </>
          ) : (
            <span style={{ fontSize: 17, fontWeight: 600, color: FAINT }}>
              {count > 0
                ? `${count} photo${count > 1 ? "s" : ""} · more angles help`
                : "1–4 photos · the first sets the cover"}
            </span>
          )}
        </div>

        {/* primary action */}
        <div
          style={{
            position: "absolute",
            left: BTN.x,
            top: BTN.y,
            width: BTN.w,
            height: BTN.h,
            borderRadius: 18,
            background: btnLive ? VIOLET : "var(--sl-violet-soft, rgba(99,91,255,0.12))",
            color: btnLive ? "white" : FAINT,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            fontSize: 20,
            fontWeight: 800,
            transform: `translateY(${(1 - (btnLive ? readyIn : 0)) * 6}px)`,
            boxShadow: btnLive ? "0 12px 26px -10px rgba(99,91,255,0.6)" : "none",
          }}
        >
          Identify item
          <span aria-hidden>→</span>
        </div>
      </div>

      <Cursor x={cursor.x} y={cursor.y} press={press} />
    </AbsoluteFill>
  );
}

export const StepSnapMobile: React.FC = () => (
  <MobileScene>
    <Sequence from={STEP_SNAP_MOBILE_LEN - SEAM} durationInFrames={SEAM}>
      <Freeze frame={0}>
        <SnapMobileAct />
      </Freeze>
    </Sequence>
    <SnapMobileAct />
  </MobileScene>
);
