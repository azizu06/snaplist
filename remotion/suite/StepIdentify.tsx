import React from "react";
import {
  AbsoluteFill,
  Easing,
  Freeze,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CheckIcon } from "../hero/primitives";
import { AttrField, Feed, OcrBox, PhotoFrame, Scene, Shell, StatusLine, type FeedEvent } from "./primitives";
import { DIM, FAINT, GREEN, GREEN_SOFT, INK, LINE, SLAB, SURFACE, type ClickSpec, type Rect } from "./theme";

/**
 * Step 2 · Identify — the photo-reading moment in full: sweep + detection
 * boxes over the laptop's printed badges (“Predator”, “Helios 300”), the
 * extracted details with per-field certainty, the how-sure composite, and a
 * plain-language item summary (ui-r6: the dark JSON “structured output”
 * panel is gone — sellers, not engineers). No cursor, no clicks.
 * Product: Acer Predator Helios 300 gaming laptop (demo/acer-hero.jpg) —
 * the same item the whole how-it-works pipeline follows.
 *
 * Render: npx remotion render remotion/index.ts step-identify public/demo/steps/identify.mp4 --crf 26 --muted
 */

export const STEP_IDENTIFY_LEN = 450;
const SEAM = 16;

export const IDENTIFY_CLICKS: ClickSpec[] = []; // intentionally cursor-free

/* ---------- layout ---------- */

const PHOTO: Rect = { x: 64, y: 112, w: 460, h: 345 };
const FEED_RECT: Rect = { x: 64, y: 502, w: 460, h: 164 };
const RX = 556;
const RW = 652;
const COL2 = RX + 334;
const FIELD_W = 318;
const FIELD_H = 56;
const ROW_Y = [150, 216, 282];
const CONF: Rect = { x: RX, y: 360, w: RW, h: 142 };
const SUMMARY_PANEL: Rect = { x: RX, y: 518, w: RW, h: 148 };

/* ---------- choreography ---------- */

const PHOTO_IN = 10;
const SCAN_START = 30;
const SCAN_END = 95;
const FIELD_AT = [165, 182, 199, 214, 229, 244];
const CONF_AT = 260;
const SIGNAL_AT = [272, 286, 300];
const SUMMARY_AT = 318;
const SUMMARY_TYPE = 330;
const CONFIRMED_AT = 412;

const FEED: FeedEvent[] = [
  { at: 34, done: 100, text: "Looking at your photo…" },
  {
    at: 108,
    done: 150,
    text: "Reading the printed text on the body…",
    sub: "Found “Predator” and “Core i7”",
    subAt: 154,
  },
  { at: 162, done: 248, text: "Pulling out the details" },
  { at: 258, done: 322, text: "Working out how sure it is" },
];

const FIELDS = [
  { label: "BRAND", value: "Acer", conf: 0.99 },
  { label: "MODEL", value: "Predator Helios 300", conf: 0.95 },
  { label: "CATEGORY", value: "Computers & Accessories", conf: 0.96 },
  { label: "CONDITION", value: "Good · light wear", conf: 0.86 },
  { label: "CPU", value: "Intel Core i7", conf: 0.92 },
  { label: "GRAPHICS", value: "GeForce RTX · 144Hz", conf: 0.9 },
];

const SIGNALS = [
  "Brand and model read straight from the photo",
  "Printed badges came through cleanly",
  "Category is clear-cut",
];

const SUMMARY_TEXT =
  "Acer Predator Helios 300 gaming laptop — Intel Core i7, GeForce RTX, 144Hz display. Good condition, RGB keyboard works. Ready to price under Computers & Accessories.";

/* ---------- pieces ---------- */

function ConfidenceModule() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < CONF_AT - 4) {
    return (
      <div
        style={{
          position: "absolute",
          left: CONF.x,
          top: CONF.y,
          width: CONF.w,
          height: CONF.h,
          borderRadius: 14,
          border: `1.5px dashed ${LINE}`,
          boxSizing: "border-box",
        }}
      />
    );
  }
  const enter = spring({
    frame: frame - CONF_AT,
    fps,
    config: { damping: 15, stiffness: 130 },
    durationInFrames: 24,
  });
  const pct = interpolate(frame, [CONF_AT + 8, CONF_AT + 64], [0, 94], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return (
    <div
      style={{
        position: "absolute",
        left: CONF.x,
        top: CONF.y,
        width: CONF.w,
        height: CONF.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: SLAB,
        padding: "14px 16px",
        boxSizing: "border-box",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 12}px)`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
          HOW SURE IS THE MATCH
        </span>
        <span
          style={{
            fontSize: 24,
            fontWeight: 800,
            color: INK,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {Math.round(pct)}%
        </span>
      </div>
      <div
        style={{
          marginTop: 8,
          height: 7,
          borderRadius: 99,
          background: SURFACE,
          border: `1px solid ${LINE}`,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "linear-gradient(90deg, #006e52, #008060)",
          }}
        />
      </div>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 7 }}>
        {SIGNALS.map((s, i) => {
          if (frame < SIGNAL_AT[i]) return null;
          const sIn = spring({
            frame: frame - SIGNAL_AT[i],
            fps,
            config: { damping: 13, stiffness: 150 },
            durationInFrames: 20,
          });
          return (
            <div
              key={s}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                opacity: sIn,
                transform: `translateX(${(1 - sIn) * -8}px)`,
              }}
            >
              <CheckIcon size={13} />
              <span style={{ fontSize: 13, fontWeight: 600, color: DIM }}>{s}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** plain-language recap of what was found — the seller-facing "record" */
function ItemSummary() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < SUMMARY_AT) return null;
  const enter = spring({
    frame: frame - SUMMARY_AT,
    fps,
    config: { damping: 15, stiffness: 130 },
    durationInFrames: 22,
  });
  const n = Math.round(
    interpolate(frame, [SUMMARY_TYPE, SUMMARY_TYPE + 72], [0, SUMMARY_TEXT.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );
  return (
    <div
      style={{
        position: "absolute",
        left: SUMMARY_PANEL.x,
        top: SUMMARY_PANEL.y,
        width: SUMMARY_PANEL.w,
        height: SUMMARY_PANEL.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: SURFACE,
        boxShadow: "0 12px 30px -14px rgba(19,30,58,0.18)",
        padding: "14px 18px",
        boxSizing: "border-box",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 12}px)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
          WHAT IT FOUND, IN PLAIN WORDS
        </span>
        {frame >= CONFIRMED_AT ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11.5,
              fontWeight: 800,
              color: GREEN,
              background: GREEN_SOFT,
              borderRadius: 99,
              padding: "3px 10px",
            }}
          >
            ✓ every detail double-checked
          </span>
        ) : null}
      </div>
      <div
        style={{
          marginTop: 11,
          fontSize: 15,
          lineHeight: 1.6,
          fontWeight: 600,
          color: DIM,
        }}
      >
        {SUMMARY_TEXT.slice(0, n)}
        {n < SUMMARY_TEXT.length ? (
          <span
            style={{
              display: "inline-block",
              width: 1.6,
              height: 15,
              background: INK,
              verticalAlign: "text-bottom",
              marginLeft: 1,
              opacity: frame % 18 < 11 ? 1 : 0,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/* ---------- the act ---------- */

function IdentifyAct() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const photoIn = spring({
    frame: frame - PHOTO_IN,
    fps,
    config: { damping: 16, stiffness: 120 },
    durationInFrames: 26,
  });
  const fadeOut = interpolate(frame, [STEP_IDENTIFY_LEN - SEAM, STEP_IDENTIFY_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <Shell badge="STEP 2 · IDENTIFY">
        <PhotoFrame
          rect={PHOTO}
          src={staticFile("demo/acer-hero.jpg")}
          fileName="IMG_4032.jpg"
          photoIn={photoIn}
          scanStart={SCAN_START}
          scanEnd={SCAN_END}
          objectPosition="50% 50%"
          objectFit="contain"
        >
          {/* boxes sit over the Acer Predator's printed marks: the "PREDATOR"
              wordmark on the screen bezel and the "PREDATOR HELIOS 300" spec
              sticker on the lower-right deck. Coords are local to the 460×345
              photo frame. acer-hero.jpg is 1600×1200 = 4:3, same aspect as the
              frame → object-fit:contain fills it exactly with no letterbox, so
              1px frame = 1600/460 ≈ 3.48px source. The whole laptop now shows
              (it's centered on its own room background). Tuned against an actual
              render still — re-measure here if the hero crop changes. */}
          <OcrBox at={110} box={{ x: 194, y: 158, w: 62, h: 18 }} label="brand · “Predator”" labelSide="above" />
          <OcrBox
            at={135}
            box={{ x: 272, y: 247, w: 84, h: 17 }}
            label="model · “Helios 300”"
            labelSide="below"
          />
        </PhotoFrame>
        <StatusLine
          x={PHOTO.x}
          y={466}
          startAt={SCAN_START}
          doneAt={250}
          busyText="Reading your photo…"
          doneText="Found it · Acer Predator"
        />
        <Feed rect={FEED_RECT} events={FEED} />

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
          <span style={{ fontSize: 20, fontWeight: 800, color: INK }}>What SnapList sees</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: FAINT }}>
            every detail checked before it&apos;s used
          </span>
        </div>
        {FIELDS.map((f, i) => (
          <AttrField
            key={f.label}
            rect={{
              x: i % 2 === 0 ? RX : COL2,
              y: ROW_Y[Math.floor(i / 2)],
              w: FIELD_W,
              h: FIELD_H,
            }}
            label={f.label}
            value={f.value}
            conf={f.conf}
            at={FIELD_AT[i]}
          />
        ))}
        <ConfidenceModule />
        <ItemSummary />
      </Shell>
    </AbsoluteFill>
  );
}

export const StepIdentify: React.FC = () => (
  <Scene>
    <Sequence from={STEP_IDENTIFY_LEN - SEAM} durationInFrames={SEAM}>
      <Freeze frame={0}>
        <IdentifyAct />
      </Freeze>
    </Sequence>
    <IdentifyAct />
  </Scene>
);
