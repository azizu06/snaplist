import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";

/**
 * Stage clip 3 — "Approve & publish" (issue #49). A compact listing card with
 * the real photo, an animated macOS cursor that clicks the violet Publish
 * button (click ripple), a brief publishing spinner, then a pulsing green
 * "Live on eBay" pill.
 * Render: `npx remotion render remotion/index.ts stage-publish public/stage-publish.mp4`
 */

const INK = "#1a1a1a";
const DIM = "#404040";
const FAINT = "#6d7175";
const LINE = "#e1e3e5";
const SLAB = "#f6f6f7";
const VIOLET = "#008060";
const GREEN = "#16a34a";

const font =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const CARD_SHADOW = "0 4px 12px rgba(19,30,58,0.08)";

/** macOS-style cursor with click ripple (same pattern as HeroDemoVideo). */
function Cursor({ x, y, press }: { x: number; y: number; press: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        zIndex: 50,
        transform: `scale(${1 - press * 0.18})`,
        transformOrigin: "6px 4px",
        filter: "drop-shadow(0 2px 4px rgba(19,30,58,0.35))",
      }}
    >
      <svg width="22" height="26" viewBox="0 0 22 26">
        <path
          d="M3 2 L3 20 L7.6 16 L10.4 23 L13.6 21.6 L10.8 14.8 L17 14.4 Z"
          fill="white"
          stroke={INK}
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      {press > 0.05 ? (
        <div
          style={{
            position: "absolute",
            left: -9,
            top: -11,
            width: 40,
            height: 40,
            borderRadius: 99,
            border: `2px solid rgba(0,128,96,${0.55 * (1 - press)})`,
            transform: `scale(${0.5 + press * 1.1})`,
          }}
        />
      ) : null}
    </div>
  );
}

/** piecewise-linear motion through waypoints, eased per segment */
function path(
  frame: number,
  points: Array<[frame: number, x: number, y: number]>,
): { x: number; y: number } {
  if (frame <= points[0][0]) return { x: points[0][1], y: points[0][2] };
  for (let i = 0; i < points.length - 1; i++) {
    const [f0, x0, y0] = points[i];
    const [f1, x1, y1] = points[i + 1];
    if (frame <= f1) {
      const t = Easing.inOut(Easing.ease)((frame - f0) / (f1 - f0));
      return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
    }
  }
  const last = points[points.length - 1];
  return { x: last[1], y: last[2] };
}

/** brief press pulse around a frame */
function pressAt(frame: number, at: number): number {
  return interpolate(frame, [at - 2, at + 2, at + 9], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

export const StagePublish: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // ---------- choreography (30fps) ----------
  const CLICK = 58; // click Publish
  const SPIN_END = 100; // spinner runs CLICK+4 → SPIN_END
  const LIVE_AT = 102; // green pill lands

  const cardIn = spring({
    frame: frame - 4,
    fps,
    config: { damping: 16, stiffness: 120 },
    durationInFrames: 24,
  });

  // button center ≈ (400, 363): card top 170 + pad 24 + thumb row 124 + gap 22
  // + half button height ≈ 23
  const cursor = path(frame, [
    [10, 690, 540],
    [CLICK - 8, 392, 356],
    [CLICK + 16, 392, 356],
    [LIVE_AT + 30, 600, 470],
  ]);
  const press = pressAt(frame, CLICK);

  const buttonPressed = interpolate(
    frame,
    [CLICK - 1, CLICK + 3, CLICK + 10],
    [0, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const publishing = frame >= CLICK + 4 && frame < LIVE_AT;
  const liveIn = spring({
    frame: frame - LIVE_AT,
    fps,
    config: { damping: 10, stiffness: 170 },
    durationInFrames: 26,
  });

  const fadeOut = interpolate(
    frame,
    [durationInFrames - 14, durationInFrames - 2],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ backgroundColor: SLAB, fontFamily: font }}>
      <div style={{ position: "absolute", inset: 0, opacity: fadeOut }}>
        {/* ---------- listing card ---------- */}
        <div
          style={{
            position: "absolute",
            left: 110,
            right: 110,
            top: 170,
            background: "white",
            borderRadius: 16,
            border: `1px solid ${LINE}`,
            boxShadow: CARD_SHADOW,
            padding: 24,
            opacity: cardIn,
            transform: `translateY(${(1 - cardIn) * 16}px)`,
          }}
        >
          <div style={{ display: "flex", gap: 18 }}>
            {/* thumbnail */}
            <div
              style={{
                width: 124,
                height: 124,
                borderRadius: 12,
                border: `1px solid ${LINE}`,
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <Img
                src={staticFile("demo/camera.jpg")}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </div>
            {/* copy */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 800,
                  letterSpacing: 1.3,
                  color: FAINT,
                }}
              >
                READY TO PUBLISH · EBAY
              </div>
              <div
                style={{
                  marginTop: 7,
                  fontSize: 19,
                  fontWeight: 800,
                  color: INK,
                  lineHeight: 1.3,
                }}
              >
                Canon EOS 80D DSLR Camera Body, Tested
              </div>
              <div
                style={{
                  marginTop: 9,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <span
                  style={{
                    fontSize: 24,
                    fontWeight: 800,
                    color: INK,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  $589
                </span>
                <span
                  style={{
                    background: "rgba(0,128,96,0.12)",
                    color: VIOLET,
                    borderRadius: 99,
                    padding: "4px 11px",
                    fontSize: 11.5,
                    fontWeight: 700,
                  }}
                >
                  86% confidence
                </span>
                <span style={{ fontSize: 12.5, color: DIM }}>3 sources cited</span>
              </div>
            </div>
          </div>

          {/* publish button / live pill */}
          <div style={{ marginTop: 22 }}>
            {frame < LIVE_AT ? (
              <div
                style={{
                  background: VIOLET,
                  color: "white",
                  borderRadius: 12,
                  padding: "14px 0",
                  textAlign: "center",
                  fontSize: 15.5,
                  fontWeight: 700,
                  transform: `scale(${1 - buttonPressed * 0.04})`,
                  boxShadow: `0 ${8 - buttonPressed * 6}px ${20 - buttonPressed * 12}px -8px rgba(0,128,96,0.55)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                }}
              >
                {publishing ? (
                  <>
                    <div
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 99,
                        border: "2.5px solid rgba(255,255,255,0.35)",
                        borderTopColor: "white",
                        transform: `rotate(${frame * 16}deg)`,
                      }}
                    />
                    Publishing…
                  </>
                ) : (
                  "Publish to eBay"
                )}
              </div>
            ) : (
              <div
                style={{
                  background: "rgba(22,163,74,0.1)",
                  border: "1px solid rgba(22,163,74,0.35)",
                  color: GREEN,
                  borderRadius: 12,
                  padding: "14px 0",
                  textAlign: "center",
                  fontSize: 15.5,
                  fontWeight: 800,
                  transform: `scale(${0.94 + liveIn * 0.06})`,
                  opacity: liveIn,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                }}
              >
                <span style={{ position: "relative", width: 9, height: 9 }}>
                  <span
                    style={{
                      position: "absolute",
                      inset: 0,
                      borderRadius: 99,
                      background: GREEN,
                    }}
                  />
                  <span
                    style={{
                      position: "absolute",
                      inset: -4,
                      borderRadius: 99,
                      border: `2px solid rgba(22,163,74,${Math.max(0, 0.5 - ((frame - LIVE_AT) % 40) / 80)})`,
                      transform: `scale(${1 + ((frame - LIVE_AT) % 40) / 28})`,
                    }}
                  />
                </span>
                Live on eBay · view listing
              </div>
            )}
          </div>
        </div>

        {/* stage label */}
        <div
          style={{
            position: "absolute",
            left: 110,
            top: 144,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1.2,
            color: FAINT,
            opacity: 0.8 * cardIn,
          }}
        >
          APPROVE &amp; PUBLISH
        </div>

        <Cursor x={cursor.x} y={cursor.y} press={Math.min(1, press)} />
      </div>
    </AbsoluteFill>
  );
};
