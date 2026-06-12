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
 * Stage clip 1 — "Snap & identify" (issue #49). A close-up of the identify
 * surface: the camera photo lands in its slot, a scan beam sweeps it, then
 * attribute chips cascade in and a green "Identified" tick confirms.
 * Render: `npx remotion render remotion/index.ts stage-identify public/stage-identify.mp4`
 */

const FAINT = "#5f6b88";
const LINE = "#dfe4ee";
const SLAB = "#f4f6fb";
const VIOLET = "#6d4aff";
const GREEN = "#16a34a";

const font =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const CARD_SHADOW = "0 4px 12px rgba(19,30,58,0.08)";

const CHIPS = [
  "Canon EOS 80D",
  "DSLR camera",
  "Good condition",
  "EF-S 18-55mm lens",
];

export const StageIdentify: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // ---------- choreography (30fps) ----------
  const PHOTO_IN = 8; // photo lands in the slot
  const SCAN = 36; // beam sweep starts
  const SCAN_END = SCAN + 46;
  const CHIPS_AT = 88; // chips cascade
  const DONE_AT = 128; // green "Identified" tick

  const photoIn = spring({
    frame: frame - PHOTO_IN,
    fps,
    config: { damping: 16, stiffness: 120 },
    durationInFrames: 26,
  });
  const scanT = interpolate(frame, [SCAN, SCAN_END - 4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.ease),
  });
  const scanVisible = frame >= SCAN && frame <= SCAN_END;
  const analyzing = frame >= SCAN - 4 && frame < CHIPS_AT;

  const chipSprings = CHIPS.map((_, i) =>
    spring({
      frame: frame - (CHIPS_AT + i * 8),
      fps,
      config: { damping: 13, stiffness: 150 },
      durationInFrames: 26,
    }),
  );
  const doneIn = spring({
    frame: frame - DONE_AT,
    fps,
    config: { damping: 11, stiffness: 170 },
    durationInFrames: 24,
  });

  // fade only the inner surface so the loop restarts on calm slab, not black
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 14, durationInFrames - 2],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ backgroundColor: SLAB, fontFamily: font }}>
      <div style={{ position: "absolute", inset: 0, opacity: fadeOut }}>
        {/* ---------- app-surface card ---------- */}
        <div
          style={{
            position: "absolute",
            inset: 36,
            background: "white",
            borderRadius: 16,
            border: `1px solid ${LINE}`,
            boxShadow: CARD_SHADOW,
            display: "flex",
            gap: 24,
            padding: 26,
          }}
        >
          {/* left — photo slot */}
          <div style={{ width: 330, display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, color: FAINT }}>
              PHOTO 1 OF 1
            </div>
            <div
              style={{
                marginTop: 12,
                flex: 1,
                borderRadius: 12,
                border: photoIn > 0.05 ? `1px solid ${LINE}` : `2px dashed ${LINE}`,
                background: photoIn > 0.05 ? "white" : SLAB,
                overflow: "hidden",
                position: "relative",
              }}
            >
              <Img
                src={staticFile("demo/camera.jpg")}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  transform: `scale(${1.07 - photoIn * 0.07})`,
                  opacity: photoIn,
                }}
              />
              {/* scan shimmer */}
              {scanVisible ? (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: `${scanT * 100}%`,
                    height: 70,
                    transform: "translateY(-50%)",
                    background:
                      "linear-gradient(180deg, transparent, rgba(109,74,255,0.22), rgba(255,255,255,0.34), rgba(109,74,255,0.22), transparent)",
                  }}
                />
              ) : null}
              {/* viewfinder corners while analyzing */}
              {analyzing && photoIn > 0.5
                ? [
                    { left: 10, top: 10, bt: true, bb: false, bl: true, br: false },
                    { right: 10, top: 10, bt: true, bb: false, bl: false, br: true },
                    { left: 10, bottom: 10, bt: false, bb: true, bl: true, br: false },
                    { right: 10, bottom: 10, bt: false, bb: true, bl: false, br: true },
                  ].map((c, i) => (
                    <div
                      key={i}
                      style={{
                        position: "absolute",
                        width: 22,
                        height: 22,
                        left: c.left,
                        right: c.right,
                        top: c.top,
                        bottom: c.bottom,
                        borderTop: c.bt ? "3px solid white" : undefined,
                        borderBottom: c.bb ? "3px solid white" : undefined,
                        borderLeft: c.bl ? "3px solid white" : undefined,
                        borderRight: c.br ? "3px solid white" : undefined,
                        borderRadius: 4,
                        filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.4))",
                      }}
                    />
                  ))
                : null}
              {photoIn > 0.4 ? (
                <div
                  style={{
                    position: "absolute",
                    left: 10,
                    bottom: 10,
                    background: "rgba(19,30,58,0.72)",
                    color: "white",
                    borderRadius: 8,
                    padding: "4px 9px",
                    fontSize: 11,
                    fontWeight: 600,
                    opacity: photoIn,
                  }}
                >
                  IMG_4032.jpg
                </div>
              ) : null}
            </div>
          </div>

          {/* right — extracted attributes */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, color: FAINT }}>
              ITEM DETAILS
            </div>

            {/* analyzing / identified pill */}
            <div style={{ marginTop: 14, height: 38 }}>
              {analyzing ? (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 9,
                    background: "rgba(109,74,255,0.1)",
                    borderRadius: 99,
                    padding: "8px 15px",
                  }}
                >
                  <div
                    style={{
                      width: 13,
                      height: 13,
                      borderRadius: 99,
                      border: "2px solid rgba(109,74,255,0.25)",
                      borderTopColor: VIOLET,
                      transform: `rotate(${frame * 14}deg)`,
                    }}
                  />
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: VIOLET }}>
                    Identifying your item…
                  </span>
                </div>
              ) : frame >= CHIPS_AT ? (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    background: "rgba(109,74,255,0.1)",
                    borderRadius: 99,
                    padding: "8px 15px",
                  }}
                >
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: VIOLET }}>
                    Attributes extracted
                  </span>
                </div>
              ) : null}
            </div>

            {/* chips */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                marginTop: 14,
                minHeight: 130,
                alignContent: "flex-start",
              }}
            >
              {CHIPS.map((chip, i) => (
                <div
                  key={chip}
                  style={{
                    opacity: chipSprings[i],
                    transform: `translateY(${(1 - chipSprings[i]) * 12}px) scale(${0.8 + chipSprings[i] * 0.2})`,
                    border: "1px solid rgba(109,74,255,0.3)",
                    background: "rgba(109,74,255,0.08)",
                    color: VIOLET,
                    borderRadius: 99,
                    padding: "9px 16px",
                    fontSize: 14.5,
                    fontWeight: 600,
                    height: "fit-content",
                  }}
                >
                  {chip}
                </div>
              ))}
            </div>

            {/* identified tick */}
            <div style={{ marginTop: "auto" }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 9,
                  background: "rgba(22,163,74,0.1)",
                  border: "1px solid rgba(22,163,74,0.35)",
                  borderRadius: 99,
                  padding: "9px 17px",
                  opacity: doneIn,
                  transform: `scale(${0.85 + doneIn * 0.15})`,
                  transformOrigin: "left center",
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  fill="none"
                  stroke={GREEN}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span style={{ fontSize: 14.5, fontWeight: 800, color: GREEN }}>
                  Identified — 92% confidence
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* faint stage label echoing the app chrome */}
        <div
          style={{
            position: "absolute",
            left: 36,
            top: 12,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1.2,
            color: FAINT,
            opacity: 0.8 * Math.min(1, photoIn + 0.4),
          }}
        >
          SNAP &amp; IDENTIFY
        </div>
      </div>
    </AbsoluteFill>
  );
};
