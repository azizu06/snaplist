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
 * Stage clip 2 — "Research the price" (issue #49). The price module assembles
 * itself: cited source rows slide in, the suggested price counts up to $589,
 * the $520–$680 range bar draws underneath, and a violet confidence arc
 * sweeps to 86%.
 * Render: `npx remotion render remotion/index.ts stage-price public/stage-price.mp4`
 */

const INK = "#131e3a";
const DIM = "#3d4a68";
const FAINT = "#5f6b88";
const LINE = "#dfe4ee";
const SLAB = "#f4f6fb";
const VIOLET = "#6d4aff";
const DEEP = "#5a36f0";

const font =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const CARD_SHADOW = "0 4px 12px rgba(19,30,58,0.08)";

const SOURCES: Array<[label: string, price: string, dot: string]> = [
  ["eBay sold · EOS 80D body + kit lens", "$575", "#e53238"],
  ["Mercari · listed, good condition", "$610", "#5356ee"],
  ["KEH · used grade EX", "$589", "#0d9488"],
];

// semicircle arc r=54 → length ≈ 169.6
const ARC_LEN = 169.6;

export const StagePrice: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // ---------- choreography (30fps) ----------
  const ROWS_AT = 12; // source rows slide in
  const PRICE_AT = 62; // suggested price counts up
  const RANGE_AT = 74; // range bar draws
  const ARC_AT = 86; // confidence arc sweeps

  const cardIn = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 120 },
    durationInFrames: 22,
  });

  const rowSprings = SOURCES.map((_, i) =>
    spring({
      frame: frame - (ROWS_AT + i * 11),
      fps,
      config: { damping: 14, stiffness: 130 },
      durationInFrames: 26,
    }),
  );

  const searchingDone = frame >= PRICE_AT - 6;

  const priceVal = Math.round(
    interpolate(frame, [PRICE_AT, PRICE_AT + 38], [0, 589], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }),
  );
  const priceIn = spring({
    frame: frame - PRICE_AT + 4,
    fps,
    config: { damping: 16 },
    durationInFrames: 26,
  });
  const rangeFill = interpolate(frame, [RANGE_AT, RANGE_AT + 40], [0, 0.66], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const arcT = interpolate(frame, [ARC_AT, ARC_AT + 44], [0, 0.86], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const arcPct = Math.round(arcT * 100);

  const fadeOut = interpolate(
    frame,
    [durationInFrames - 14, durationInFrames - 2],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ backgroundColor: SLAB, fontFamily: font }}>
      <div style={{ position: "absolute", inset: 0, opacity: fadeOut }}>
        <div
          style={{
            position: "absolute",
            left: 36,
            right: 36,
            top: 92,
            background: "white",
            borderRadius: 16,
            border: `1px solid ${LINE}`,
            boxShadow: CARD_SHADOW,
            padding: 26,
            opacity: cardIn,
            transform: `translateY(${(1 - cardIn) * 14}px)`,
          }}
        >
          {/* header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, color: FAINT }}>
              PRICE RESEARCH
            </div>
            {searchingDone ? (
              <div
                style={{
                  background: "rgba(109,74,255,0.12)",
                  color: VIOLET,
                  borderRadius: 99,
                  padding: "5px 12px",
                  fontSize: 12,
                  fontWeight: 700,
                  opacity: priceIn,
                }}
              >
                3 sources cited
              </div>
            ) : (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 99,
                    border: "2px solid rgba(109,74,255,0.25)",
                    borderTopColor: VIOLET,
                    transform: `rotate(${frame * 14}deg)`,
                  }}
                />
                <span style={{ fontSize: 12.5, fontWeight: 700, color: VIOLET }}>
                  Searching comps…
                </span>
              </div>
            )}
          </div>

          {/* source rows */}
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 9 }}>
            {SOURCES.map(([label, price, dot], i) => (
              <div
                key={label}
                style={{
                  opacity: rowSprings[i],
                  transform: `translateX(${(1 - rowSprings[i]) * -26}px)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  background: "white",
                  border: `1px solid ${LINE}`,
                  borderRadius: 10,
                  padding: "11px 14px",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 99,
                      background: dot,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontSize: 13.5, color: DIM }}>{label}</span>
                </span>
                <span
                  style={{
                    fontSize: 13.5,
                    fontWeight: 700,
                    color: INK,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {price}
                </span>
              </div>
            ))}
          </div>

          {/* synthesized price + confidence arc */}
          <div
            style={{
              marginTop: 16,
              borderRadius: 12,
              background: SLAB,
              border: `1px solid ${LINE}`,
              padding: 18,
              display: "flex",
              gap: 22,
              alignItems: "center",
              opacity: priceIn,
              transform: `translateY(${(1 - priceIn) * 16}px)`,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.3, color: FAINT }}>
                SUGGESTED PRICE
              </div>
              <div
                style={{
                  fontSize: 44,
                  fontWeight: 800,
                  color: INK,
                  lineHeight: 1.15,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                ${priceVal}
              </div>
              {/* range bar */}
              <div
                style={{
                  marginTop: 10,
                  height: 7,
                  borderRadius: 99,
                  background: "white",
                  border: `1px solid ${LINE}`,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${rangeFill * 100}%`,
                    background: `linear-gradient(90deg, ${DEEP}, ${VIOLET})`,
                  }}
                />
              </div>
              <div
                style={{
                  marginTop: 6,
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                  color: FAINT,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <span>$520</span>
                <span>range</span>
                <span>$680</span>
              </div>
            </div>

            {/* confidence arc */}
            <div style={{ width: 150, textAlign: "center" }}>
              <svg viewBox="0 0 140 84" width="150" aria-hidden>
                <path
                  d="M 16 76 A 54 54 0 0 1 124 76"
                  fill="none"
                  stroke={LINE}
                  strokeWidth="10"
                  strokeLinecap="round"
                />
                <path
                  d="M 16 76 A 54 54 0 0 1 124 76"
                  fill="none"
                  stroke="url(#conf-grad)"
                  strokeWidth="10"
                  strokeLinecap="round"
                  strokeDasharray={`${arcT * ARC_LEN} ${ARC_LEN + 30}`}
                />
                <defs>
                  <linearGradient
                    id="conf-grad"
                    x1="16"
                    y1="76"
                    x2="124"
                    y2="76"
                    gradientUnits="userSpaceOnUse"
                  >
                    <stop offset="0" stopColor={DEEP} />
                    <stop offset="1" stopColor={VIOLET} />
                  </linearGradient>
                </defs>
                <text
                  x="70"
                  y="64"
                  textAnchor="middle"
                  fill={INK}
                  fontSize="24"
                  fontWeight="800"
                  fontFamily={font}
                >
                  {arcPct}%
                </text>
              </svg>
              <div style={{ fontSize: 11, fontWeight: 700, color: FAINT, letterSpacing: 0.6 }}>
                CONFIDENCE
              </div>
            </div>
          </div>
        </div>

        {/* stage label */}
        <div
          style={{
            position: "absolute",
            left: 36,
            top: 66,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1.2,
            color: FAINT,
            opacity: 0.8 * cardIn,
          }}
        >
          RESEARCH THE PRICE
        </div>
      </div>
    </AbsoluteFill>
  );
};
