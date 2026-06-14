import React from "react";
import {
  AbsoluteFill,
  Freeze,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CheckIcon, Cursor, arriveAndDwell, path, pressAt } from "../../hero/primitives";
import { FAINT, GREEN, INK, LINE, SURFACE, VIOLET, center, type Rect } from "../theme";
import { M_LOGICAL_W, MobileScene } from "./StepSnapMobile";

/**
 * Step 3 · Price (portrait mobile) — the suggested price + range reveal on a
 * mini axis, recent SOLD comps land with their sources, a "prices agree" trust
 * line confirms the spread is tight, and the seller taps "Apply $165". Same
 * values as the desktop StepPrice ($165 suggested, $140–$195, the same comps).
 * See [[snaplist-mobile-polish-pr70]].
 *
 * Render:
 *   npx remotion render remotion/index.ts step-price-mobile public/demo/steps/price-mobile.mp4 --crf 26 --muted
 *   ... price-mobile-dark.mp4 ... --props '{"theme":"dark"}'
 */

export const STEP_PRICE_MOBILE_LEN = 360;
const SEAM = 16;
const PAD = 28;

const RANGE_LOW = 140;
const RANGE_HIGH = 195;
const SUGGESTED = 165;

const COMPS: Array<{ source: string; note: string; price: number; at: number }> = [
  { source: "eBay", note: "sold 5 days ago", price: 172, at: 96 },
  { source: "eBay", note: "sold 12 days ago", price: 158, at: 112 },
  { source: "Mercari", note: "sold 2 weeks ago", price: 150, at: 128 },
  { source: "eBay", note: "sold 3 weeks ago", price: 185, at: 144 },
];

const TRUST_AT = 196;
const APPLY: Rect = { x: PAD, y: 560, w: M_LOGICAL_W - PAD * 2, h: 66 };
const TAP_APPLY = 268;

const ROW_Y = 322;
const ROW_H = 48;

function CompRow({ c, i }: { c: (typeof COMPS)[number]; i: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < c.at) return null;
  const s = spring({ frame: frame - c.at, fps, config: { damping: 16, stiffness: 170 }, durationInFrames: 16 });
  return (
    <div
      style={{
        position: "absolute",
        left: PAD,
        top: ROW_Y + i * ROW_H,
        width: M_LOGICAL_W - PAD * 2,
        height: ROW_H - 8,
        display: "flex",
        alignItems: "center",
        gap: 10,
        opacity: s,
        transform: `translateX(${(1 - s) * 16}px)`,
      }}
    >
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 800,
          color: VIOLET,
          background: "var(--sl-violet-soft, rgba(99,91,255,0.1))",
          borderRadius: 8,
          padding: "4px 9px",
        }}
      >
        {c.source}
      </span>
      <span style={{ fontSize: 14.5, color: FAINT }}>{c.note}</span>
      <span style={{ marginLeft: "auto", fontSize: 17, fontWeight: 800, color: INK }}>${c.price}</span>
    </div>
  );
}

function PriceMobileAct() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const dollars = Math.round(
    interpolate(frame, [16, 64], [0, SUGGESTED], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
  );
  const barT = interpolate(frame, [40, 96], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const markerPct = ((SUGGESTED - RANGE_LOW) / (RANGE_HIGH - RANGE_LOW)) * 100;

  const trustIn = spring({ frame: frame - TRUST_AT, fps, config: { damping: 15 }, durationInFrames: 20 });
  const cursor = path(frame, [
    [0, 470, 650],
    ...arriveAndDwell(244, TAP_APPLY + 8, center(APPLY).x, center(APPLY).y),
    [320, center(APPLY).x, center(APPLY).y],
  ]);
  const press = pressAt(frame, TAP_APPLY);
  const applied = frame >= TAP_APPLY;

  const fadeOut = interpolate(frame, [STEP_PRICE_MOBILE_LEN - SEAM, STEP_PRICE_MOBILE_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <div style={{ position: "absolute", inset: 0, background: SURFACE }}>
        {/* header */}
        <div style={{ position: "absolute", left: PAD, top: 30, right: PAD, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.4, color: INK }}>Price</span>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, color: VIOLET, background: "var(--sl-violet-soft, rgba(99,91,255,0.1))", borderRadius: 99, padding: "6px 12px" }}>
            STEP 3 · PRICE
          </span>
        </div>

        {/* suggested price card */}
        <div
          style={{
            position: "absolute",
            left: PAD,
            top: 100,
            width: M_LOGICAL_W - PAD * 2,
            height: 176,
            borderRadius: 22,
            border: `1.5px solid ${LINE}`,
            background: SURFACE,
            boxSizing: "border-box",
            padding: "20px 24px",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 1, color: FAINT }}>SUGGESTED PRICE</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 4 }}>
            <span style={{ fontSize: 52, fontWeight: 800, letterSpacing: -1, color: INK, lineHeight: 1 }}>${dollars}</span>
            <span style={{ fontSize: 16, fontWeight: 600, color: FAINT }}>from recent sold listings</span>
          </div>
          {/* mini range axis */}
          <div style={{ marginTop: 26, position: "relative", height: 8, borderRadius: 99, background: "var(--sl-slab, #f4f6fb)", border: `1px solid ${LINE}` }}>
            <div style={{ position: "absolute", left: "8%", right: "8%", top: 0, bottom: 0, borderRadius: 99, background: "linear-gradient(90deg,#7a73ff,#635bff,#a960ee)", opacity: 0.55, transform: `scaleX(${barT})`, transformOrigin: "center" }} />
            <div style={{ position: "absolute", left: `${markerPct}%`, top: "50%", width: 18, height: 18, borderRadius: 99, background: VIOLET, border: `3px solid ${SURFACE}`, boxShadow: "0 0 0 3px rgba(99,91,255,0.25)", transform: "translate(-50%,-50%)", opacity: barT }} />
          </div>
          <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", fontSize: 14, fontWeight: 700, color: FAINT }}>
            <span>${RANGE_LOW}</span>
            <span>${RANGE_HIGH}</span>
          </div>
        </div>

        {/* recent sold comps */}
        <div style={{ position: "absolute", left: PAD, top: 290, fontSize: 13, fontWeight: 800, letterSpacing: 1, color: FAINT }}>
          RECENT SOLD · SOURCES
        </div>
        {COMPS.map((c, i) => (
          <CompRow key={i} c={c} i={i} />
        ))}

        {/* trust line */}
        {frame >= TRUST_AT ? (
          <div style={{ position: "absolute", left: PAD, top: 516, display: "flex", alignItems: "center", gap: 9, opacity: trustIn }}>
            <CheckIcon size={17} />
            <span style={{ fontSize: 16, fontWeight: 700, color: GREEN }}>Sale prices agree · tightly grouped</span>
          </div>
        ) : null}

        {/* apply CTA */}
        <div
          style={{
            position: "absolute",
            left: APPLY.x,
            top: APPLY.y,
            width: APPLY.w,
            height: APPLY.h,
            borderRadius: 18,
            background: VIOLET,
            color: "white",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            fontSize: 20,
            fontWeight: 800,
            transform: `scale(${1 - press * 0.03})`,
            boxShadow: "0 12px 26px -10px rgba(99,91,255,0.6)",
          }}
        >
          {applied ? "Price applied · $165" : "Apply $165"}
          <span aria-hidden>{applied ? "✓" : "→"}</span>
        </div>
      </div>

      <Cursor x={cursor.x} y={cursor.y} press={press} />
    </AbsoluteFill>
  );
}

export const StepPriceMobile: React.FC = () => (
  <MobileScene>
    <Sequence from={STEP_PRICE_MOBILE_LEN - SEAM} durationInFrames={SEAM}>
      <Freeze frame={0}>
        <PriceMobileAct />
      </Freeze>
    </Sequence>
    <PriceMobileAct />
  </MobileScene>
);
