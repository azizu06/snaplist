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
import { Chip, LivePulse, PrimaryButton, Scene, Shell } from "./primitives";
import {
  AMBER,
  FAINT,
  GREEN,
  GREEN_SOFT,
  INK,
  LINE,
  SLAB,
  VIOLET,
  center,
  type ClickSpec,
  type Rect,
} from "./theme";

/**
 * Step 5 · Publish — the review screen in full: checklist ticks, the
 * autopilot gate explains *why* this one waits for a human (only 74% sure),
 * then a cursor-accurate Publish click → posting state → live confirmation
 * card with the listing id.
 * Product: Custom 65% mechanical keyboard, green & white keycaps
 * (demo/keyboard.jpg) — estimated pricing, hence the honest mid confidence.
 *
 * Render: npx remotion render remotion/index.ts step-publish public/demo/steps/publish.mp4 --crf 26 --muted
 */

export const STEP_PUBLISH_LEN = 480;
const SEAM = 16;

/* ---------- layout ---------- */

const PHOTO: Rect = { x: 64, y: 112, w: 420, h: 300 };
const CHECKLIST: Rect = { x: 64, y: 486, w: 420, h: 176 };
const RX = 516;
const RW = 692;
const TITLE_FIELD: Rect = { x: RX, y: 150, w: RW, h: 44 };
const PRICE_MOD: Rect = { x: RX, y: 258, w: RW, h: 140 };
const GATE: Rect = { x: RX, y: 414, w: RW, h: 48 };
const PUBLISH: Rect = { x: RX, y: 480, w: RW, h: 52 };
const CONFIRM: Rect = { x: RX, y: 552, w: RW, h: 110 };

/* ---------- choreography ---------- */

const TICKS_AT = [64, 82, 100, 118];
const GATE_AT = 148;
const ARRIVE_PUB = 196;
const CLICK_PUB = 210;
const POSTING_AT = 212;
const LIVE_AT = 294;
const CONFIRM_AT = 304;

const PUB_C = center(PUBLISH);

export const PUBLISH_WAYPOINTS: Array<[number, number, number]> = [
  [0, 1240, 706],
  [150, 1240, 706],
  ...arriveAndDwell(ARRIVE_PUB, CLICK_PUB + 10, PUB_C.x, PUB_C.y),
  [268, 1080, 660],
  [320, 1150, 700],
];

export const publishCursorAt = (frame: number) => path(frame, PUBLISH_WAYPOINTS);

export const PUBLISH_CLICKS: ClickSpec[] = [
  {
    label: "publish: click “Publish to eBay”",
    frame: CLICK_PUB,
    target: PUBLISH,
    arrive: ARRIVE_PUB,
    until: CLICK_PUB + 10,
  },
];

const CHECKS = [
  "3 photos · cover photo set",
  "Title fits eBay's 80-character limit",
  "Item details complete",
  "Price set · $120 (range $95–$150)",
];

/* ---------- pieces ---------- */

function PhotoCard() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 6, fps, config: { damping: 15 }, durationInFrames: 22 });
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: PHOTO.x,
          top: PHOTO.y,
          width: PHOTO.w,
          height: PHOTO.h,
          borderRadius: 14,
          overflow: "hidden",
          border: `1px solid ${LINE}`,
          opacity: enter,
        }}
      >
        <Img
          src={staticFile("demo/keyboard.jpg")}
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 42%" }}
        />
        <div
          style={{
            position: "absolute",
            left: 10,
            bottom: 10,
            background: "rgba(19,30,58,0.72)",
            color: "white",
            borderRadius: 8,
            padding: "4px 10px",
            fontSize: 11.5,
            fontWeight: 600,
          }}
        >
          cover photo · 1 of 3
        </div>
      </div>
      <div style={{ position: "absolute", left: PHOTO.x, top: 428, display: "flex", gap: 8 }}>
        <Chip text="Good condition" at={14} index={0} tone="plain" />
        <Chip text="Computers & Accessories" at={14} index={1} tone="plain" />
        <Chip text="Estimated price" at={14} index={2} />
      </div>
    </>
  );
}

function Checklist() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        position: "absolute",
        left: CHECKLIST.x,
        top: CHECKLIST.y,
        width: CHECKLIST.w,
        height: CHECKLIST.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: "white",
        boxSizing: "border-box",
        padding: "14px 16px",
      }}
    >
      <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
        REVIEW CHECKLIST
      </span>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 9 }}>
        {CHECKS.map((c, i) => {
          const ticked = frame >= TICKS_AT[i];
          const s = spring({
            frame: frame - TICKS_AT[i],
            fps,
            config: { damping: 13, stiffness: 150 },
            durationInFrames: 20,
          });
          return (
            <div key={c} style={{ display: "flex", alignItems: "center", gap: 9 }}>
              {ticked ? (
                <span style={{ transform: `scale(${0.6 + s * 0.4})`, display: "flex" }}>
                  <CheckIcon size={13} />
                </span>
              ) : (
                <span
                  style={{
                    width: 13,
                    height: 13,
                    borderRadius: 99,
                    border: `1.5px solid ${LINE}`,
                    boxSizing: "border-box",
                  }}
                />
              )}
              <span
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: ticked ? INK : FAINT,
                }}
              >
                {c}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PriceModule() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 28, fps, config: { damping: 15 }, durationInFrames: 22 });
  const pct = interpolate(frame, [40, 96], [0, 74], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return (
    <div
      style={{
        position: "absolute",
        left: PRICE_MOD.x,
        top: PRICE_MOD.y,
        width: PRICE_MOD.w,
        height: PRICE_MOD.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: SLAB,
        boxSizing: "border-box",
        padding: "14px 18px",
        opacity: enter,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
          PRICE
        </span>
        <span style={{ fontSize: 13, color: FAINT }}>
          estimated from retail price + condition · range $95–$150
        </span>
      </div>
      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 18 }}>
        <span
          style={{
            fontSize: 30,
            fontWeight: 800,
            color: INK,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          $120
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
              HOW SURE
            </span>
            <span
              style={{
                fontSize: 16.5,
                fontWeight: 800,
                color: AMBER,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {Math.round(pct)}%
            </span>
          </div>
          <div
            style={{
              marginTop: 6,
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
                background: "linear-gradient(90deg, #d97706, #f59e0b)",
              }}
            />
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: FAINT }}>
            no recent sales for a custom build, so this is an estimate, and you can change it
          </div>
        </div>
      </div>
    </div>
  );
}

function GateBanner() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < GATE_AT) return null;
  const enter = spring({
    frame: frame - GATE_AT,
    fps,
    config: { damping: 14, stiffness: 140 },
    durationInFrames: 22,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: GATE.x,
        top: GATE.y,
        width: GATE.w,
        height: GATE.h,
        borderRadius: 12,
        background: "rgba(217,119,6,0.08)",
        border: "1px solid rgba(217,119,6,0.3)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 16px",
        boxSizing: "border-box",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 10}px)`,
      }}
    >
      <svg viewBox="0 0 24 24" width={15} fill="none" stroke={AMBER} strokeWidth="2" strokeLinecap="round">
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" strokeLinejoin="round" />
      </svg>
      <span style={{ fontSize: 13.5, fontWeight: 700, color: AMBER }}>
        Autopilot held this one: only 74% sure, so it waits for your OK before posting.
      </span>
    </div>
  );
}

function ConfirmCard() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < CONFIRM_AT) return null;
  const enter = spring({
    frame: frame - CONFIRM_AT,
    fps,
    config: { damping: 13, stiffness: 140 },
    durationInFrames: 24,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: CONFIRM.x,
        top: CONFIRM.y,
        width: CONFIRM.w,
        height: CONFIRM.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: "white",
        boxShadow: "0 14px 30px -14px rgba(19,30,58,0.2)",
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "0 16px",
        boxSizing: "border-box",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 16}px)`,
      }}
    >
      <div
        style={{
          width: 70,
          height: 70,
          borderRadius: 10,
          overflow: "hidden",
          flexShrink: 0,
          border: `1px solid ${LINE}`,
        }}
      >
        <Img
          src={staticFile("demo/keyboard.jpg")}
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 42%" }}
        />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 14.5,
            fontWeight: 700,
            color: INK,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          Custom 65% mechanical keyboard, green & white keycaps
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: FAINT,
            marginTop: 4,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          eBay item #110558203341 · listed just now
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: VIOLET, marginTop: 4 }}>
          View on eBay →
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: INK, fontVariantNumeric: "tabular-nums" }}>
          $120
        </div>
        <div
          style={{
            marginTop: 5,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: GREEN_SOFT,
            borderRadius: 99,
            padding: "3px 10px",
          }}
        >
          <LivePulse since={CONFIRM_AT} />
          <span style={{ fontSize: 10.5, fontWeight: 800, color: GREEN }}>LIVE</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- the act ---------- */

function PublishAct() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cursor = publishCursorAt(frame);
  const press = pressAt(frame, CLICK_PUB);
  const fadeOut = interpolate(frame, [STEP_PUBLISH_LEN - SEAM, STEP_PUBLISH_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const titleIn = spring({ frame: frame - 18, fps, config: { damping: 15 }, durationInFrames: 22 });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <Shell badge="STEP 5 · PUBLISH">
        <PhotoCard />
        <Checklist />

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
          <span style={{ fontSize: 20, fontWeight: 800, color: INK }}>Review & publish</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: FAINT }}>
            everything is editable until you post
          </span>
        </div>

        <div
          style={{
            position: "absolute",
            left: TITLE_FIELD.x,
            top: TITLE_FIELD.y,
            width: TITLE_FIELD.w,
            height: TITLE_FIELD.h,
            borderRadius: 10,
            border: `1px solid ${LINE}`,
            background: SLAB,
            display: "flex",
            alignItems: "center",
            padding: "0 14px",
            fontSize: 15.5,
            fontWeight: 700,
            color: INK,
            boxSizing: "border-box",
            opacity: titleIn,
          }}
        >
          Custom 65% mechanical keyboard, green & white keycaps
        </div>
        <div style={{ position: "absolute", left: RX, top: 208, display: "flex", gap: 8 }}>
          <Chip text="Brand · Custom build" at={24} index={0} />
          <Chip text="Layout · 65%" at={24} index={1} />
          <Chip text="Keycaps · green & white" at={24} index={2} />
        </div>

        <PriceModule />
        <GateBanner />
        <PrimaryButton
          rect={PUBLISH}
          label="Publish to eBay"
          appearAt={GATE_AT + 14}
          pressFrame={CLICK_PUB}
          busyFrom={POSTING_AT}
          busyLabel="Publishing to eBay…"
          doneFrom={LIVE_AT}
          doneLabel="Live on eBay"
        />
        {frame >= POSTING_AT + 10 && frame < LIVE_AT ? (
          <div
            style={{
              position: "absolute",
              left: RX,
              top: PUBLISH.y + PUBLISH.h + 10,
              width: RW,
              textAlign: "center",
              fontSize: 12.5,
              fontWeight: 600,
              color: FAINT,
            }}
          >
            {frame < POSTING_AT + 45 ? "uploading your photos…" : "creating your eBay listing…"}
          </div>
        ) : null}
        <ConfirmCard />
      </Shell>
      <Cursor x={cursor.x} y={cursor.y} press={press} />
    </AbsoluteFill>
  );
}

export const StepPublish: React.FC = () => (
  <Scene>
    <Sequence from={STEP_PUBLISH_LEN - SEAM} durationInFrames={SEAM}>
      <Freeze frame={0}>
        <PublishAct />
      </Freeze>
    </Sequence>
    <PublishAct />
  </Scene>
);
