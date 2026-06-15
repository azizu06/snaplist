import React from "react";
import {
  AbsoluteFill,
  Freeze,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CheckIcon } from "../../hero/primitives";
import { FAINT, GREEN, INK, LINE, SURFACE, VIOLET } from "../theme";
import { M_LOGICAL_W, MobileScene } from "./StepSnapMobile";

/**
 * Step 2 · Identify (portrait mobile) — a scan beam sweeps the Acer Predator photo,
 * then the identified label + a "how sure" composite reveal, and the extracted
 * attributes fill a 2-up grid. Same item + same values as the desktop
 * StepIdentify (brand Acer, model Predator Helios 300, Computers & Accessories, good · light wear,
 * Core i7, GeForce RTX, 94% composite). See [[snaplist-mobile-polish-pr70]].
 *
 * Render:
 *   npx remotion render remotion/index.ts step-identify-mobile public/demo/steps/identify-mobile.mp4 --crf 26 --muted
 *   ... identify-mobile-dark.mp4 ... --props '{"theme":"dark"}'
 */

export const STEP_IDENTIFY_MOBILE_LEN = 360;
const SEAM = 16;
const PAD = 28;

const IMG = "demo/acer-hero.jpg";
const PHOTO = { x: PAD, y: 104, w: M_LOGICAL_W - PAD * 2, h: 206 };

const SCAN_FROM = 18;
const SCAN_TO = 92;
const FOUND_AT = 104;

const ATTRS: Array<{ label: string; value: string; at: number }> = [
  { label: "BRAND", value: "Acer", at: 128 },
  { label: "MODEL", value: "Predator Helios 300", at: 144 },
  { label: "CPU", value: "Intel Core i7", at: 160 },
  { label: "CATEGORY", value: "Computers & Accessories", at: 176 },
  { label: "CONDITION", value: "Good · light wear", at: 192 },
  { label: "GPU", value: "GeForce RTX", at: 208 },
];
const CELL_W = 234;
const CELL_H = 70;
const cell = (i: number) => ({
  x: PAD + (i % 2) * (CELL_W + 16),
  y: 392 + Math.floor(i / 2) * (CELL_H + 14),
});

function AttrCell({ a, i }: { a: (typeof ATTRS)[number]; i: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = cell(i);
  if (frame < a.at) return null;
  const s = spring({ frame: frame - a.at, fps, config: { damping: 16, stiffness: 160 }, durationInFrames: 18 });
  return (
    <div
      style={{
        position: "absolute",
        left: p.x,
        top: p.y,
        width: CELL_W,
        height: CELL_H,
        borderRadius: 14,
        border: `1.5px solid ${LINE}`,
        background: SURFACE,
        boxSizing: "border-box",
        padding: "11px 14px",
        opacity: s,
        transform: `translateY(${(1 - s) * 8}px)`,
      }}
    >
      <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 1, color: FAINT }}>{a.label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: INK, marginTop: 3 }}>{a.value}</div>
    </div>
  );
}

function IdentifyMobileAct() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scanY = interpolate(frame, [SCAN_FROM, SCAN_TO], [0, PHOTO.h], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scanning = frame >= SCAN_FROM && frame <= SCAN_TO;

  const foundIn = spring({ frame: frame - FOUND_AT, fps, config: { damping: 15 }, durationInFrames: 20 });
  const pct = Math.round(
    interpolate(frame, [FOUND_AT, FOUND_AT + 40], [0, 94], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );

  const fadeOut = interpolate(frame, [STEP_IDENTIFY_MOBILE_LEN - SEAM, STEP_IDENTIFY_MOBILE_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <div style={{ position: "absolute", inset: 0, background: SURFACE }}>
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
          <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.4, color: INK }}>Identify</span>
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
            STEP 2 · IDENTIFY
          </span>
        </div>

        {/* photo + scan beam */}
        <div
          style={{
            position: "absolute",
            left: PHOTO.x,
            top: PHOTO.y,
            width: PHOTO.w,
            height: PHOTO.h,
            borderRadius: 20,
            overflow: "hidden",
            border: `1.5px solid ${LINE}`,
            background: "#000",
          }}
        >
          <Img src={staticFile(IMG)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 48%" }} />
          {scanning ? (
            <>
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: scanY - 2,
                  height: 4,
                  background: VIOLET,
                  boxShadow: `0 0 24px 6px var(--sl-violet, #635bff)`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: 0,
                  height: scanY,
                  background: "var(--sl-violet-soft, rgba(99,91,255,0.14))",
                }}
              />
            </>
          ) : null}
          {frame >= FOUND_AT ? (
            <div
              style={{
                position: "absolute",
                left: 14,
                bottom: 14,
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "rgba(19,30,58,0.78)",
                borderRadius: 99,
                padding: "7px 13px",
                opacity: foundIn,
                transform: `translateY(${(1 - foundIn) * 8}px)`,
              }}
            >
              <CheckIcon size={15} color="#34d399" />
              <span style={{ fontSize: 15, fontWeight: 800, color: "white" }}>Found it · Acer Predator</span>
            </div>
          ) : null}
        </div>

        {/* identified label + confidence */}
        {frame >= FOUND_AT ? (
          <div
            style={{
              position: "absolute",
              left: PAD,
              top: 330,
              right: PAD,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              opacity: foundIn,
            }}
          >
            <span style={{ fontSize: 21, fontWeight: 800, color: INK }}>Acer Predator</span>
            <span
              style={{
                fontSize: 15,
                fontWeight: 800,
                color: GREEN,
                background: "var(--sl-green-soft, rgba(22,163,74,0.1))",
                borderRadius: 99,
                padding: "6px 14px",
              }}
            >
              {pct}% sure
            </span>
          </div>
        ) : null}

        {/* extracted attributes grid */}
        {ATTRS.map((a, i) => (
          <AttrCell key={a.label} a={a} i={i} />
        ))}
      </div>
    </AbsoluteFill>
  );
}

export const StepIdentifyMobile: React.FC = () => (
  <MobileScene>
    <Sequence from={STEP_IDENTIFY_MOBILE_LEN - SEAM} durationInFrames={SEAM}>
      <Freeze frame={0}>
        <IdentifyMobileAct />
      </Freeze>
    </Sequence>
    <IdentifyMobileAct />
  </MobileScene>
);
