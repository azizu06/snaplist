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
import { DIM, FAINT, INK, LINE, SLAB, type ClickSpec, type Rect } from "./theme";

/**
 * Step 2 · Identify — the vision scan in full: sweep + OCR boxes over the
 * camera's actual printed text (“Canon”, “EOS 80D”), structured attributes
 * with per-field confidence, the ID-confidence composite, and the validated
 * structured output. Pure agent theater — no cursor, no clicks.
 * Product: Canon EOS 80D DSLR with 50mm lens (demo/camera.jpg).
 *
 * Render: npx remotion render remotion/index.ts step-identify public/demo/steps/identify.mp4 --crf 26 --muted
 */

export const STEP_IDENTIFY_LEN = 450;
const SEAM = 16;

export const IDENTIFY_CLICKS: ClickSpec[] = []; // intentionally cursor-free

/* ---------- layout ---------- */

const PHOTO: Rect = { x: 64, y: 112, w: 460, h: 345 };
const FEED_RECT: Rect = { x: 64, y: 506, w: 460, h: 156 };
const RX = 556;
const RW = 652;
const COL2 = RX + 334;
const FIELD_W = 318;
const FIELD_H = 56;
const ROW_Y = [150, 216, 282];
const CONF: Rect = { x: RX, y: 360, w: RW, h: 142 };
const JSON_PANEL: Rect = { x: RX, y: 518, w: RW, h: 144 };

/* ---------- choreography ---------- */

const PHOTO_IN = 10;
const SCAN_START = 30;
const SCAN_END = 95;
const FIELD_AT = [165, 182, 199, 214, 229, 244];
const CONF_AT = 260;
const SIGNAL_AT = [272, 286, 300];
const JSON_AT = 318;
const JSON_TYPE = 330;
const VALID_AT = 412;

const FEED: FeedEvent[] = [
  { at: 34, done: 100, tool: "vision.extract", text: "analyzing photo · 1 image" },
  {
    at: 108,
    done: 150,
    tool: "ocr.read",
    text: "reading printed text on the body…",
    sub: "“Canon” · “EOS 80D”",
    subAt: 154,
  },
  { at: 162, done: 248, tool: "attr.schema", text: "extracting structured attributes" },
  { at: 258, done: 322, tool: "confidence.compose", text: "composing ID confidence from signals" },
];

const FIELDS = [
  { label: "BRAND", value: "Canon", conf: 0.99 },
  { label: "MODEL", value: "EOS 80D", conf: 0.97 },
  { label: "CATEGORY", value: "Cameras & Photo", conf: 0.96 },
  { label: "CONDITION", value: "Good · light grip wear", conf: 0.86 },
  { label: "LENS", value: "50mm prime", conf: 0.91 },
  { label: "MOUNT", value: "EF-S", conf: 0.93 },
];

const SIGNALS = [
  "Brand + model resolved from the photo",
  "Printed text read cleanly",
  "Category unambiguous",
];

const JSON_TEXT = `{ "brand": "Canon", "model": "EOS 80D",
  "category": "Cameras & Photo", "condition": "good",
  "lens": "50mm prime", "text_read": ["Canon", "EOS 80D"] }`;

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
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
          ID CONFIDENCE
        </span>
        <span
          style={{
            fontSize: 22,
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
          background: "white",
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
              <CheckIcon size={12} />
              <span style={{ fontSize: 11.5, fontWeight: 600, color: DIM }}>{s}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StructuredOutput() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < JSON_AT) return null;
  const enter = spring({
    frame: frame - JSON_AT,
    fps,
    config: { damping: 15, stiffness: 130 },
    durationInFrames: 22,
  });
  const n = Math.round(
    interpolate(frame, [JSON_TYPE, JSON_TYPE + 72], [0, JSON_TEXT.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );
  return (
    <div
      style={{
        position: "absolute",
        left: JSON_PANEL.x,
        top: JSON_PANEL.y,
        width: JSON_PANEL.w,
        height: JSON_PANEL.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: "#0f172a",
        padding: "12px 16px",
        boxSizing: "border-box",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 12}px)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 1.2,
            color: "rgba(255,255,255,0.55)",
          }}
        >
          STRUCTURED OUTPUT
        </span>
        {frame >= VALID_AT ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 10,
              fontWeight: 800,
              color: "#4ade80",
              background: "rgba(74,222,128,0.12)",
              borderRadius: 99,
              padding: "3px 9px",
            }}
          >
            ✓ schema valid
          </span>
        ) : null}
      </div>
      <pre
        style={{
          margin: "10px 0 0",
          fontSize: 12,
          lineHeight: 1.65,
          color: "#a5b4fc",
          fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
          whiteSpace: "pre-wrap",
        }}
      >
        {JSON_TEXT.slice(0, n)}
        {n < JSON_TEXT.length ? (
          <span
            style={{
              display: "inline-block",
              width: 7,
              height: 13,
              background: "#a5b4fc",
              verticalAlign: "text-bottom",
              opacity: frame % 18 < 11 ? 1 : 0,
            }}
          />
        ) : null}
      </pre>
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
          src={staticFile("demo/camera.jpg")}
          fileName="IMG_4032.jpg"
          photoIn={photoIn}
          scanStart={SCAN_START}
          scanEnd={SCAN_END}
        >
          <OcrBox at={110} box={{ x: 219, y: 68, w: 61, h: 25 }} label="brand · “Canon”" />
          <OcrBox
            at={135}
            box={{ x: 305, y: 106, w: 38, h: 38 }}
            label="model · “EOS 80D”"
            labelSide="below"
          />
        </PhotoFrame>
        <StatusLine
          x={PHOTO.x}
          y={468}
          startAt={SCAN_START}
          doneAt={250}
          busyText="Vision model reading the photo…"
          doneText="Identified · Canon EOS 80D"
        />
        <Feed rect={FEED_RECT} events={FEED} agent="vision pipeline · live" />

        <div
          style={{
            position: "absolute",
            left: RX,
            top: 112,
            width: RW,
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 18, fontWeight: 800, color: INK }}>What the model sees</span>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: FAINT }}>
            structured extraction · Zod-validated
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
        <StructuredOutput />
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
