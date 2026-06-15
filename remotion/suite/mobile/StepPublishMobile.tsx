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
import { FAINT, GREEN, INK, LINE, SLAB, SURFACE, VIOLET, center, type Rect } from "../theme";
import { M_LOGICAL_W, MobileScene } from "./StepSnapMobile";

/**
 * Step 5 · Publish (portrait mobile) — the review screen: listing summary,
 * pre-flight checklist ticks, the autopilot gate confirms it cleared the bar
 * (91% sure), then a tap on "Publish to eBay" → posting → a live confirmation
 * card with the eBay item id. Same content as the desktop StepPublish (Acer
 * Predator, $550, item #110558203341). See [[snaplist-mobile-polish-pr70]].
 *
 * Render:
 *   npx remotion render remotion/index.ts step-publish-mobile public/demo/steps/publish-mobile.mp4 --crf 26 --muted
 *   ... publish-mobile-dark.mp4 ... --props '{"theme":"dark"}'
 */

export const STEP_PUBLISH_MOBILE_LEN = 360;
const SEAM = 16;
const PAD = 28;
const INNER = M_LOGICAL_W - PAD * 2;

const CHECKS = [
  { text: "Title fits eBay's 80-character limit", at: 44 },
  { text: "Price set · $550 (range $480–$620)", at: 60 },
  { text: "Photos and condition attached", at: 76 },
];
const GATE_AT = 100;
const PUBLISH: Rect = { x: PAD, y: 556, w: INNER, h: 66 };
const TAP_PUBLISH = 188;
const POSTING_TO = 226;

function CheckRow({ text, at }: { text: string; at: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at) return null;
  const s = spring({ frame: frame - at, fps, config: { damping: 16, stiffness: 170 }, durationInFrames: 14 });
  return (
    <div style={{ position: "absolute", left: PAD, top: 0, display: "flex", alignItems: "center", gap: 10, opacity: s, transform: `translateX(${(1 - s) * 12}px)` }}>
      <CheckIcon size={17} />
      <span style={{ fontSize: 16, fontWeight: 600, color: INK }}>{text}</span>
    </div>
  );
}

function PublishMobileAct() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const gateIn = spring({ frame: frame - GATE_AT, fps, config: { damping: 15 }, durationInFrames: 20 });
  const cursor = path(frame, [
    [0, 470, 650],
    ...arriveAndDwell(TAP_PUBLISH - 28, TAP_PUBLISH + 8, center(PUBLISH).x, center(PUBLISH).y),
    [300, center(PUBLISH).x, center(PUBLISH).y],
  ]);
  const press = pressAt(frame, TAP_PUBLISH);
  const posting = frame >= TAP_PUBLISH && frame < POSTING_TO;
  const live = frame >= POSTING_TO;
  const liveIn = spring({ frame: frame - POSTING_TO, fps, config: { damping: 16, stiffness: 140 }, durationInFrames: 22 });
  const pulse = 0.5 + 0.5 * Math.sin((frame - POSTING_TO) * 0.25);

  const fadeOut = interpolate(frame, [STEP_PUBLISH_MOBILE_LEN - SEAM, STEP_PUBLISH_MOBILE_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <div style={{ position: "absolute", inset: 0, background: SURFACE }}>
        {/* header */}
        <div style={{ position: "absolute", left: PAD, top: 30, right: PAD, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.4, color: INK }}>Publish</span>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, color: VIOLET, background: "var(--sl-violet-soft, rgba(99,91,255,0.1))", borderRadius: 99, padding: "6px 12px" }}>
            STEP 5 · PUBLISH
          </span>
        </div>

        {/* listing summary card */}
        <div style={{ position: "absolute", left: PAD, top: 100, width: INNER, height: 132, borderRadius: 20, border: `1.5px solid ${LINE}`, background: SURFACE, boxSizing: "border-box", padding: "18px 20px" }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: INK, lineHeight: 1.3 }}>Acer Predator Helios 300 gaming laptop</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
            <span style={{ fontSize: 28, fontWeight: 800, color: INK, lineHeight: 1 }}>$550</span>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: INK, background: SLAB, border: `1px solid ${LINE}`, borderRadius: 8, padding: "5px 10px" }}>Brand · Acer</span>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: INK, background: SLAB, border: `1px solid ${LINE}`, borderRadius: 8, padding: "5px 10px" }}>Model · Predator Helios 300</span>
          </div>
        </div>

        {/* checklist */}
        <div style={{ position: "absolute", left: PAD, top: 256, fontSize: 12, fontWeight: 800, letterSpacing: 1, color: FAINT }}>READY TO POST</div>
        {CHECKS.map((c, i) => (
          <div key={c.text} style={{ position: "absolute", left: 0, top: 288 + i * 38, width: "100%" }}>
            <CheckRow text={c.text} at={c.at} />
          </div>
        ))}

        {/* autopilot gate */}
        {frame >= GATE_AT ? (
          <div style={{ position: "absolute", left: PAD, top: 414, right: PAD, display: "flex", alignItems: "center", gap: 9, background: "var(--sl-green-soft, rgba(22,163,74,0.1))", borderRadius: 12, padding: "12px 14px", opacity: gateIn }}>
            <CheckIcon size={17} />
            <span style={{ fontSize: 15, fontWeight: 700, color: GREEN }}>Cleared autopilot · 91% sure</span>
          </div>
        ) : null}

        {/* publish button → posting → live confirmation */}
        {live ? (
          <div style={{ position: "absolute", left: PAD, top: 478, width: INNER, height: 144, borderRadius: 20, border: `1.5px solid var(--sl-green-soft, rgba(22,163,74,0.25))`, background: "var(--sl-green-soft, rgba(22,163,74,0.08))", boxSizing: "border-box", padding: "18px 20px", opacity: liveIn, transform: `translateY(${(1 - liveIn) * 10}px)` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 12, height: 12, borderRadius: 99, background: GREEN, boxShadow: `0 0 0 ${4 + pulse * 4}px var(--sl-green-soft, rgba(22,163,74,0.18))` }} />
              <span style={{ fontSize: 19, fontWeight: 800, color: GREEN }}>Live on eBay</span>
            </div>
            <div style={{ fontSize: 15, color: INK, marginTop: 12, fontWeight: 600 }}>eBay item #110558203341 · listed just now</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: VIOLET, marginTop: 10 }}>View on eBay →</div>
          </div>
        ) : (
          <div style={{ position: "absolute", left: PUBLISH.x, top: PUBLISH.y, width: PUBLISH.w, height: PUBLISH.h, borderRadius: 18, background: VIOLET, color: "white", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontSize: 20, fontWeight: 800, transform: `scale(${1 - press * 0.03})`, boxShadow: "0 12px 26px -10px rgba(99,91,255,0.6)" }}>
            {posting ? "Publishing…" : "Publish to eBay"}
            {!posting ? <span aria-hidden>→</span> : null}
          </div>
        )}
      </div>

      <Cursor x={cursor.x} y={cursor.y} press={press} />
    </AbsoluteFill>
  );
}

export const StepPublishMobile: React.FC = () => (
  <MobileScene>
    <Sequence from={STEP_PUBLISH_MOBILE_LEN - SEAM} durationInFrames={SEAM}>
      <Freeze frame={0}>
        <PublishMobileAct />
      </Freeze>
    </Sequence>
    <PublishMobileAct />
  </MobileScene>
);
