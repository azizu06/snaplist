import React from "react";
import {
  AbsoluteFill,
  Easing,
  Freeze,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CheckIcon, Cursor, arriveAndDwell, path, pressAt } from "../hero/primitives";
import { Feed, PrimaryButton, Scene, Shell, type FeedEvent } from "./primitives";
import {
  DIM,
  FAINT,
  GREEN,
  GREEN_SOFT,
  INK,
  LINE,
  SLAB,
  VIOLET,
  VIOLET_SOFT,
  center,
  type ClickSpec,
  type Rect,
  SURFACE,
} from "./theme";

/**
 * Step 3 · Price — the price research made visible: searches fire in the
 * live feed, recent sales land with sources and prices, a range forms around
 * the suggested price on a real axis, the why-trust-it panel fills in, then
 * the seller applies the suggestion (cursor-accurate click). Plain seller
 * language only (ui-r6) — "recent sales", never "comps".
 * Product: Acer Predator Helios 300 gaming laptop (demo/acer-hero.jpg) —
 * the same item the whole how-it-works pipeline follows.
 *
 * Render: npx remotion render remotion/index.ts step-price public/demo/steps/price.mp4 --crf 26 --muted
 */

export const STEP_PRICE_LEN = 540;
const SEAM = 16;

/* ---------- layout ---------- */

const ITEM: Rect = { x: 64, y: 112, w: 460, h: 96 };
const FEED_RECT: Rect = { x: 64, y: 232, w: 460, h: 200 };
const SIGNALS: Rect = { x: 64, y: 456, w: 460, h: 206 };
const RX = 556;
const RW = 652;
const COMP_Y = 152;
const COMP_H = 44;
const COMP_GAP = 4;
const RANGE: Rect = { x: RX, y: 452, w: RW, h: 124 };
const APPLY: Rect = { x: RX, y: 596, w: RW, h: 46 };

/* ---------- choreography ---------- */

const COMPS: Array<{ at: number; source: string; note: string; price: number; asking?: boolean }> = [
  { at: 104, source: "eBay", note: "sold 5 days ago", price: 565 },
  { at: 118, source: "eBay", note: "sold 12 days ago", price: 530 },
  { at: 132, source: "Mercari", note: "sold 2 weeks ago", price: 510 },
  { at: 146, source: "eBay", note: "sold 3 weeks ago", price: 595 },
  { at: 188, source: "eBay", note: "sold 1 month ago", price: 540 },
  { at: 202, source: "Best Buy", note: "asking price · counts less", price: 680, asking: true },
];

const RANGE_AT = 248;
const DOTS_AT = 258;
const BAND_AT = 290;
const MARKER_AT = 318;
const SIGNAL_ROWS_AT = [344, 360, 376];
const COMPOSITE_AT = 392;
const NOTE_AT = 430;

const ARRIVE_APPLY = 450;
const CLICK_APPLY = 464;
const APPLIED_AT = 472;
const PRICE_CHIP_AT = 480;

const FEED: FeedEvent[] = [
  {
    at: 36,
    done: 96,
    text: "Searching “acer predator helios 300 used sold”",
    sub: "4 recent sales found",
    subAt: 100,
  },
  {
    at: 116,
    done: 180,
    text: "Searching “predator helios i7 rtx laptop sold”",
    sub: "3 more found · 7 total",
    subAt: 184,
  },
  { at: 212, done: 242, text: "Comparing prices · setting odd ones aside" },
  { at: 250, text: "Range $480–$620 · suggesting $550" },
];

const SIGNAL_ROWS = [
  { label: "Where the price comes from", value: "real sold listings" },
  { label: "Do the sale prices agree?", value: "yes, tightly grouped" },
  { label: "Is the item a sure match?", value: "brand + model found" },
];

/* range axis: $420 → $720 across the inner width */
const AXIS_MIN = 420;
const AXIS_MAX = 720;
const RANGE_LOW = 480;
const RANGE_HIGH = 620;
const SUGGESTED = 550;

const APPLY_C = center(APPLY);

export const PRICE_WAYPOINTS: Array<[number, number, number]> = [
  [0, 1240, 706],
  [392, 1240, 706],
  ...arriveAndDwell(ARRIVE_APPLY, CLICK_APPLY + 8, APPLY_C.x, APPLY_C.y),
  [516, 1140, 700],
];

export const priceCursorAt = (frame: number) => path(frame, PRICE_WAYPOINTS);

export const PRICE_CLICKS: ClickSpec[] = [
  {
    label: "price: click “Apply suggested price · $550”",
    frame: CLICK_APPLY,
    target: APPLY,
    arrive: ARRIVE_APPLY,
    until: CLICK_APPLY + 8,
  },
];

/* ---------- pieces ---------- */

function ItemCard() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 8, fps, config: { damping: 15 }, durationInFrames: 22 });
  const chipIn = spring({
    frame: frame - PRICE_CHIP_AT,
    fps,
    config: { damping: 11, stiffness: 160 },
    durationInFrames: 22,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: ITEM.x,
        top: ITEM.y,
        width: ITEM.w,
        height: ITEM.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: SURFACE,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "0 14px",
        boxSizing: "border-box",
        opacity: enter,
      }}
    >
      <div
        style={{
          width: 68,
          height: 68,
          borderRadius: 10,
          overflow: "hidden",
          flexShrink: 0,
          border: `1px solid ${LINE}`,
        }}
      >
        <Img
          src={staticFile("demo/acer-hero.jpg")}
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 50%" }}
        />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: INK,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          Acer Predator Helios 300 gaming laptop · i7 / RTX
        </div>
        <div style={{ fontSize: 12.5, color: FAINT, marginTop: 4 }}>
          Good condition · 94% sure of the match
        </div>
      </div>
      {frame >= PRICE_CHIP_AT ? (
        <span
          style={{
            flexShrink: 0,
            fontSize: 15,
            fontWeight: 800,
            color: GREEN,
            background: GREEN_SOFT,
            borderRadius: 10,
            padding: "7px 13px",
            fontVariantNumeric: "tabular-nums",
            opacity: chipIn,
            transform: `scale(${0.8 + chipIn * 0.2})`,
          }}
        >
          $550
        </span>
      ) : null}
    </div>
  );
}

function CompRow({ comp, index }: { comp: (typeof COMPS)[number]; index: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < comp.at) return null;
  const s = spring({
    frame: frame - comp.at,
    fps,
    config: { damping: 14, stiffness: 150 },
    durationInFrames: 22,
  });
  const y = COMP_Y + index * (COMP_H + COMP_GAP);
  return (
    <div
      style={{
        position: "absolute",
        left: RX,
        top: y,
        width: RW,
        height: COMP_H,
        borderRadius: 10,
        border: `1px solid ${LINE}`,
        background: comp.asking ? SLAB : SURFACE,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 14px",
        boxSizing: "border-box",
        opacity: s * (comp.asking ? 0.75 : 1),
        transform: `translateY(${(1 - s) * 10}px)`,
      }}
    >
      <span
        style={{
          fontSize: 11.5,
          fontWeight: 800,
          color: VIOLET,
          background: VIOLET_SOFT,
          borderRadius: 6,
          padding: "2.5px 9px",
          flexShrink: 0,
          minWidth: 62,
          textAlign: "center",
        }}
      >
        {comp.source}
      </span>
      <span style={{ fontSize: 13.5, color: DIM, flex: 1 }}>
        Acer Predator Helios 300 · {comp.note}
      </span>
      <span
        style={{
          fontSize: 16,
          fontWeight: 800,
          color: comp.asking ? FAINT : INK,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        ${comp.price}
      </span>
    </div>
  );
}

function RangeModule() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < RANGE_AT - 4) {
    return (
      <div
        style={{
          position: "absolute",
          left: RANGE.x,
          top: RANGE.y,
          width: RANGE.w,
          height: RANGE.h,
          borderRadius: 14,
          border: `1.5px dashed ${LINE}`,
          boxSizing: "border-box",
        }}
      />
    );
  }
  const enter = spring({
    frame: frame - RANGE_AT,
    fps,
    config: { damping: 15, stiffness: 130 },
    durationInFrames: 22,
  });
  const pad = 24;
  const axisW = RANGE.w - pad * 2;
  const toX = (price: number) => pad + ((price - AXIS_MIN) / (AXIS_MAX - AXIS_MIN)) * axisW;
  const bandT = interpolate(frame, [BAND_AT, BAND_AT + 26], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const bandMid = toX(SUGGESTED);
  const bandL = bandMid + (toX(RANGE_LOW) - bandMid) * bandT;
  const bandR = bandMid + (toX(RANGE_HIGH) - bandMid) * bandT;
  const markerIn = spring({
    frame: frame - MARKER_AT,
    fps,
    config: { damping: 11, stiffness: 160 },
    durationInFrames: 22,
  });

  return (
    <div
      style={{
        position: "absolute",
        left: RANGE.x,
        top: RANGE.y,
        width: RANGE.w,
        height: RANGE.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: SLAB,
        boxSizing: "border-box",
        padding: "13px 0 0",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 12}px)`,
      }}
    >
      <div
        style={{
          padding: "0 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
          PRICE RANGE
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: FAINT }}>
          from 7 recent sales · sold prices count most
        </span>
      </div>

      {/* axis */}
      <div style={{ position: "relative", height: 64, marginTop: 14 }}>
        <div
          style={{
            position: "absolute",
            left: pad,
            right: pad,
            top: 30,
            height: 2,
            background: LINE,
            borderRadius: 99,
          }}
        />
        {/* band */}
        {frame >= BAND_AT ? (
          <div
            style={{
              position: "absolute",
              left: bandL,
              width: Math.max(0, bandR - bandL),
              top: 22,
              height: 18,
              borderRadius: 9,
              background: "rgba(99,91,255,0.18)",
              border: `1px solid rgba(99,91,255,0.35)`,
              boxSizing: "border-box",
            }}
          />
        ) : null}
        {/* comp dots */}
        {COMPS.map((c, i) => {
          const at = DOTS_AT + i * 5;
          if (frame < at) return null;
          const s = spring({
            frame: frame - at,
            fps,
            config: { damping: 10, stiffness: 180 },
            durationInFrames: 18,
          });
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: toX(c.price) - 5,
                top: 26,
                width: 10,
                height: 10,
                borderRadius: 99,
                background: c.asking ? SURFACE : VIOLET,
                border: `2px solid ${c.asking ? FAINT : VIOLET}`,
                boxSizing: "border-box",
                transform: `scale(${s})`,
              }}
            />
          );
        })}
        {/* suggested marker */}
        {frame >= MARKER_AT ? (
          <div
            style={{
              position: "absolute",
              left: toX(SUGGESTED) - 1.5,
              top: 12,
              width: 3,
              height: 38,
              borderRadius: 99,
              background: GREEN,
              opacity: markerIn,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: -22,
                transform: `translateX(-50%) scale(${0.8 + markerIn * 0.2})`,
                background: GREEN,
                color: "white",
                fontSize: 13,
                fontWeight: 800,
                borderRadius: 7,
                padding: "3px 10px",
                whiteSpace: "nowrap",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              $550 suggested
            </div>
          </div>
        ) : null}
        {/* range labels */}
        {frame >= BAND_AT + 18 ? (
          <>
            <span
              style={{
                position: "absolute",
                left: toX(RANGE_LOW) - 12,
                top: 46,
                fontSize: 12,
                fontWeight: 700,
                color: FAINT,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              $480
            </span>
            <span
              style={{
                position: "absolute",
                left: toX(RANGE_HIGH) - 12,
                top: 46,
                fontSize: 12,
                fontWeight: 700,
                color: FAINT,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              $620
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function SignalsPanel() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < SIGNAL_ROWS_AT[0] - 8) {
    return (
      <div
        style={{
          position: "absolute",
          left: SIGNALS.x,
          top: SIGNALS.y,
          width: SIGNALS.w,
          height: SIGNALS.h,
          borderRadius: 14,
          border: `1.5px dashed ${LINE}`,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.2, color: LINE }}>
          WHY TRUST THIS PRICE
        </span>
      </div>
    );
  }
  const enter = spring({
    frame: frame - (SIGNAL_ROWS_AT[0] - 8),
    fps,
    config: { damping: 15, stiffness: 130 },
    durationInFrames: 22,
  });
  const pct = interpolate(frame, [COMPOSITE_AT, COMPOSITE_AT + 40], [0, 84], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return (
    <div
      style={{
        position: "absolute",
        left: SIGNALS.x,
        top: SIGNALS.y,
        width: SIGNALS.w,
        height: SIGNALS.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: SURFACE,
        padding: "14px 16px",
        boxSizing: "border-box",
        opacity: enter,
      }}
    >
      <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
        WHY TRUST THIS PRICE
      </span>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {SIGNAL_ROWS.map((row, i) => {
          if (frame < SIGNAL_ROWS_AT[i]) return null;
          const sIn = spring({
            frame: frame - SIGNAL_ROWS_AT[i],
            fps,
            config: { damping: 13, stiffness: 150 },
            durationInFrames: 20,
          });
          return (
            <div
              key={row.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                opacity: sIn,
                transform: `translateX(${(1 - sIn) * -8}px)`,
              }}
            >
              <CheckIcon size={13} />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>{row.label}</span>
              <span style={{ fontSize: 12.5, color: FAINT, marginLeft: "auto" }}>{row.value}</span>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 14, display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
          HOW SURE OVERALL
        </span>
        <span style={{ fontSize: 21, fontWeight: 800, color: INK, fontVariantNumeric: "tabular-nums" }}>
          {Math.round(pct)}%
        </span>
      </div>
      <div
        style={{
          marginTop: 6,
          height: 7,
          borderRadius: 99,
          background: SLAB,
          border: `1px solid ${LINE}`,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "linear-gradient(90deg, #5147f5, #635bff)",
          }}
        />
      </div>
      {frame >= NOTE_AT ? (
        <div style={{ marginTop: 9, fontSize: 12, fontWeight: 700, color: VIOLET }}>
          Sure enough that autopilot could post this one for you
        </div>
      ) : null}
    </div>
  );
}

/* ---------- the act ---------- */

function PriceAct() {
  const frame = useCurrentFrame();
  const cursor = priceCursorAt(frame);
  const press = pressAt(frame, CLICK_APPLY);
  const fadeOut = interpolate(frame, [STEP_PRICE_LEN - SEAM, STEP_PRICE_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <Shell badge="STEP 3 · PRICE">
        <ItemCard />
        <Feed rect={FEED_RECT} events={FEED} />
        <SignalsPanel />

        <div
          style={{
            position: "absolute",
            left: RX,
            top: 110,
            width: RW,
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 20, fontWeight: 800, color: INK }}>What similar laptops sold for</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: FAINT }}>
            {frame >= 184 ? "7 found · 6 sold, 1 asking" : frame >= 100 ? "4 found" : "searching…"}
          </span>
        </div>
        {COMPS.map((c, i) => (
          <CompRow key={i} comp={c} index={i} />
        ))}
        <RangeModule />
        <PrimaryButton
          rect={APPLY}
          label="Apply suggested price · $550"
          appearAt={MARKER_AT + 10}
          pressFrame={CLICK_APPLY}
          doneFrom={APPLIED_AT}
          doneLabel="Price set · $550 · added to the listing"
        />
      </Shell>
      <Cursor x={cursor.x} y={cursor.y} press={press} />
    </AbsoluteFill>
  );
}

export const StepPrice: React.FC = () => (
  <Scene>
    <Sequence from={STEP_PRICE_LEN - SEAM} durationInFrames={SEAM}>
      <Freeze frame={0}>
        <PriceAct />
      </Freeze>
    </Sequence>
    <PriceAct />
  </Scene>
);
