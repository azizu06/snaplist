import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { LogoMark } from "./primitives";
import { FAINT, GREEN, INK, LINE, VIOLET } from "./theme";

/**
 * End card — the three LIVE listings stacked + tagline, then a crossfade
 * back to the Act 1 opening state for a seamless loop.
 */

export const END_CARD_LEN = 130;

const LISTINGS: Array<{ img: string; pos: string; title: string; price: string }> = [
  {
    img: "demo/camera.jpg",
    pos: "50% 50%",
    title: "Canon EOS 80D DSLR Camera Body",
    price: "$418",
  },
  {
    img: "demo/book.jpg",
    pos: "62% 45%",
    title: "Python for Unix & Linux Sys. Administration",
    price: "$24",
  },
  {
    img: "demo/sneakers.jpg",
    pos: "50% 55%",
    title: "Nike Free RN Flyknit, Men's US 10",
    price: "$92",
  },
];

export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const fadeIn = interpolate(frame, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // fade fully out over the frozen Act 1 opening frame underneath → loop
  const fadeOut = interpolate(frame, [END_CARD_LEN - 18, END_CARD_LEN - 2], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const tagIn = spring({
    frame: frame - 16,
    fps,
    config: { damping: 14 },
    durationInFrames: 26,
  });

  return (
    <AbsoluteFill
      style={{
        opacity: Math.min(fadeIn, fadeOut),
        background: "#f6f6f7",
        alignItems: "center",
      }}
    >
      <div style={{ marginTop: 96, opacity: tagIn, transform: `translateY(${(1 - tagIn) * 14}px)` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
          <LogoMark size={34} />
          <span style={{ fontSize: 22, fontWeight: 800, color: INK }}>SnapList</span>
        </div>
        <div
          style={{
            marginTop: 22,
            fontSize: 34,
            fontWeight: 800,
            color: INK,
            textAlign: "center",
            letterSpacing: -0.5,
          }}
        >
          One photo per item.
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: 34,
            fontWeight: 800,
            color: VIOLET,
            textAlign: "center",
            letterSpacing: -0.5,
          }}
        >
          SnapList does the rest.
        </div>
      </div>

      <div style={{ marginTop: 44, display: "flex", flexDirection: "column", gap: 14 }}>
        {LISTINGS.map((l, i) => {
          const s = spring({
            frame: frame - (26 + i * 8),
            fps,
            config: { damping: 13, stiffness: 130 },
            durationInFrames: 26,
          });
          return (
            <div
              key={l.title}
              style={{
                width: 470,
                display: "flex",
                alignItems: "center",
                gap: 14,
                background: "white",
                border: `1px solid ${LINE}`,
                borderRadius: 14,
                padding: 12,
                boxShadow: "0 10px 24px -12px rgba(19,30,58,0.16)",
                opacity: s,
                transform: `translateY(${(1 - s) * 22}px)`,
              }}
            >
              <div
                style={{
                  width: 62,
                  height: 62,
                  borderRadius: 10,
                  overflow: "hidden",
                  flexShrink: 0,
                  border: `1px solid ${LINE}`,
                }}
              >
                <Img
                  src={staticFile(l.img)}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    objectPosition: l.pos,
                  }}
                />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: INK,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {l.title}
                </div>
                <div style={{ fontSize: 12, color: FAINT, marginTop: 3 }}>
                  Published to eBay
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 800,
                    color: INK,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {l.price}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    background: "rgba(22,163,74,0.1)",
                    borderRadius: 99,
                    padding: "2.5px 9px",
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: GREEN }} />
                  <span style={{ fontSize: 10.5, fontWeight: 800, color: GREEN }}>LIVE</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
