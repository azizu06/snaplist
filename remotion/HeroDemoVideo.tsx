import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";

/**
 * Hero demo video (issue #49 round 3) — the SnapList pipeline rendered as a
 * real video: photo → scan → attributes → price with sources → published
 * listing. Stripe-light styling. Rendered to public/hero-demo.mp4 and looped
 * in the landing hero (`pnpm demo:render`).
 */

const NAVY = "#0a2540";
const TEXT = "#425466";
const FAINT = "#6b7c93";
const LINE = "#e6ebf1";
const BLURPLE = "#635bff";
const GRAY = "#f6f9fc";

const font =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

function CameraArt({ color = TEXT, width = 200 }: { color?: string; width?: number }) {
  return (
    <svg
      viewBox="0 0 200 130"
      width={width}
      fill="none"
      stroke={color}
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="18" y="38" width="164" height="74" rx="10" />
      <path d="M18 52h54l10-14h36l10 14h54" />
      <path d="M78 38v-8a4 4 0 0 1 4-4h36a4 4 0 0 1 4 4v8" />
      <circle cx="100" cy="78" r="26" />
      <circle cx="100" cy="78" r="16" />
      <circle cx="100" cy="78" r="7" />
      <circle cx="44" cy="58" r="7" />
      <rect x="142" y="50" width="22" height="9" rx="3" />
      <path d="M18 70h-5M187 70h-5" />
    </svg>
  );
}

const CHIPS = [
  "Canon AE-1 Program",
  "35mm film camera",
  "Good · tested",
  "FD 50mm f/1.8",
];

export const HeroDemoVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // ---- timeline (30fps) ----
  const photoIn = spring({ frame, fps, config: { damping: 14 }, durationInFrames: 30 });
  const scanT = interpolate(frame, [40, 85], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.ease),
  });
  const scanOpacity = interpolate(frame, [38, 44, 80, 88], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const priceIn = spring({
    frame: frame - 120,
    fps,
    config: { damping: 16 },
    durationInFrames: 30,
  });
  const priceValue = Math.round(
    interpolate(frame, [125, 165], [0, 128], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }),
  );
  const rangeFill = interpolate(frame, [130, 170], [0, 0.72], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  // stage 1+2 exit, listing enters
  const exitT = interpolate(frame, [205, 225], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.ease),
  });
  const listingIn = spring({
    frame: frame - 222,
    fps,
    config: { damping: 15 },
    durationInFrames: 32,
  });
  const liveIn = spring({
    frame: frame - 258,
    fps,
    config: { damping: 9, stiffness: 180 },
    durationInFrames: 24,
  });
  // loop seam — everything fades near the end
  const fadeOut = interpolate(frame, [durationInFrames - 18, durationInFrames - 2], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const inputsOpacity = (1 - exitT) * fadeOut;

  return (
    <AbsoluteFill style={{ backgroundColor: "white", fontFamily: font }}>
      {/* window chrome */}
      <div
        style={{
          position: "absolute",
          top: 20,
          left: 24,
          right: 24,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", gap: 7 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: 11, height: 11, borderRadius: 6, background: LINE }} />
          ))}
        </div>
        <div
          style={{
            border: `1px solid ${LINE}`,
            borderRadius: 999,
            padding: "5px 12px",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.4,
            color: FAINT,
          }}
        >
          snaplist · live demo
        </div>
      </div>

      {/* ---- stage 1: photo card ---- */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 68,
          width: 290,
          transform: `translateX(-50%) translateY(${(1 - photoIn) * 40}px) rotate(${(1 - photoIn) * -3}deg)`,
          opacity: photoIn * inputsOpacity,
          background: `linear-gradient(135deg, ${GRAY}, #eef2f7)`,
          border: `1px solid ${LINE}`,
          borderRadius: 18,
          padding: 22,
          boxShadow: "0 13px 27px -5px rgba(50,50,93,0.18), 0 8px 16px -8px rgba(0,0,0,0.2)",
        }}
      >
        {/* viewfinder corners */}
        {[
          { left: 10, top: 10, borderLeft: true, borderTop: true },
          { right: 10, top: 10, borderRight: true, borderTop: true },
          { left: 10, bottom: 10, borderLeft: true, borderBottom: true },
          { right: 10, bottom: 10, borderRight: true, borderBottom: true },
        ].map((c, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              width: 16,
              height: 16,
              left: c.left,
              right: c.right,
              top: c.top,
              bottom: c.bottom,
              borderLeft: c.borderLeft ? `2.5px solid ${BLURPLE}` : undefined,
              borderRight: c.borderRight ? `2.5px solid ${BLURPLE}` : undefined,
              borderTop: c.borderTop ? `2.5px solid ${BLURPLE}` : undefined,
              borderBottom: c.borderBottom ? `2.5px solid ${BLURPLE}` : undefined,
              borderRadius: 3,
            }}
          />
        ))}
        <CameraArt width={246} />
        <div style={{ textAlign: "center", marginTop: 10, fontSize: 11.5, color: FAINT, fontWeight: 500 }}>
          IMG_4032.jpg
        </div>
        {/* scan beam */}
        <div
          style={{
            position: "absolute",
            left: 14,
            right: 14,
            top: `${8 + scanT * 84}%`,
            height: 3,
            borderRadius: 99,
            opacity: scanOpacity,
            background: `linear-gradient(90deg, transparent, ${BLURPLE}, transparent)`,
            boxShadow: `0 0 16px 2px rgba(99,91,255,0.45)`,
          }}
        />
      </div>

      {/* ---- stage 2: chips ---- */}
      <div
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          top: 392,
          display: "flex",
          flexWrap: "wrap",
          gap: 9,
          justifyContent: "center",
          opacity: inputsOpacity,
        }}
      >
        {CHIPS.map((chip, i) => {
          const s = spring({
            frame: frame - (86 + i * 6),
            fps,
            config: { damping: 11, stiffness: 160 },
            durationInFrames: 26,
          });
          return (
            <div
              key={chip}
              style={{
                transform: `scale(${0.6 + s * 0.4}) translateY(${(1 - s) * 12}px)`,
                opacity: s,
                border: "1px solid rgba(99,91,255,0.3)",
                background: "rgba(99,91,255,0.08)",
                color: BLURPLE,
                borderRadius: 999,
                padding: "7px 13px",
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              {chip}
            </div>
          );
        })}
      </div>

      {/* ---- stage 3: price ---- */}
      <div
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          bottom: 24,
          transform: `translateY(${(1 - priceIn) * 26}px)`,
          opacity: priceIn * inputsOpacity,
          background: "white",
          border: `1px solid ${LINE}`,
          borderRadius: 16,
          padding: "16px 18px",
          boxShadow: "0 8px 18px -8px rgba(50,50,93,0.18)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.4, color: FAINT }}>
              SUGGESTED PRICE
            </div>
            <div style={{ fontSize: 30, fontWeight: 800, color: NAVY, fontVariantNumeric: "tabular-nums" }}>
              ${priceValue}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                display: "inline-block",
                background: "rgba(99,91,255,0.12)",
                color: BLURPLE,
                borderRadius: 999,
                padding: "5px 11px",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              6 sources cited
            </div>
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 6 }}>range $98–$145</div>
          </div>
        </div>
        <div style={{ marginTop: 11, height: 6, borderRadius: 99, background: GRAY, overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${rangeFill * 100}%`,
              borderRadius: 99,
              background: `linear-gradient(90deg, #5851ea, ${BLURPLE})`,
            }}
          />
        </div>
      </div>

      {/* ---- stage 4: assembled listing ---- */}
      <div
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          top: 150,
          transform: `translateY(${(1 - listingIn) * 36}px) scale(${0.95 + listingIn * 0.05})`,
          opacity: listingIn * fadeOut,
          background: "white",
          border: `1px solid ${LINE}`,
          borderRadius: 18,
          padding: 18,
          boxShadow: "0 13px 27px -5px rgba(50,50,93,0.2), 0 8px 16px -8px rgba(0,0,0,0.2)",
        }}
      >
        <div style={{ display: "flex", gap: 14 }}>
          <div
            style={{
              width: 80,
              height: 80,
              flexShrink: 0,
              borderRadius: 12,
              border: `1px solid ${LINE}`,
              background: `linear-gradient(135deg, ${GRAY}, #eef2f7)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 8,
            }}
          >
            <CameraArt width={64} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: NAVY, lineHeight: 1.35 }}>
              Canon AE-1 Program 35mm Film Camera
            </div>
            <div style={{ fontSize: 12, color: FAINT, marginTop: 2 }}>
              w/ FD 50mm f/1.8 · good condition · tested
            </div>
            <div style={{ fontSize: 21, fontWeight: 800, color: NAVY, marginTop: 7 }}>$128</div>
          </div>
        </div>
        <div
          style={{
            marginTop: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div
            style={{
              background: "rgba(99,91,255,0.12)",
              color: BLURPLE,
              borderRadius: 999,
              padding: "5px 11px",
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            92% confident
          </div>
          <div
            style={{
              background: BLURPLE,
              color: "white",
              borderRadius: 999,
              padding: "8px 16px",
              fontSize: 12.5,
              fontWeight: 700,
            }}
          >
            Publish to eBay
          </div>
        </div>
        {/* LIVE badge */}
        <div
          style={{
            position: "absolute",
            top: -12,
            right: -10,
            transform: `scale(${liveIn})`,
            opacity: liveIn,
            background: "white",
            border: "1px solid rgba(99,91,255,0.4)",
            color: BLURPLE,
            borderRadius: 999,
            padding: "5px 12px",
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.6,
            display: "flex",
            alignItems: "center",
            gap: 6,
            boxShadow: "0 6px 16px -6px rgba(99,91,255,0.5)",
          }}
        >
          <div style={{ width: 7, height: 7, borderRadius: 99, background: "#21c87a" }} />
          LIVE ON EBAY
        </div>
      </div>
    </AbsoluteFill>
  );
};
