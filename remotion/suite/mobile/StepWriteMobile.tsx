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
import { Cursor, arriveAndDwell, path, pressAt } from "../../hero/primitives";
import { FAINT, INK, LINE, SLAB, SURFACE, VIOLET, type Rect } from "../theme";
import { M_LOGICAL_W, MobileScene } from "./StepSnapMobile";

/**
 * Step 4 · Write (portrait mobile) — one item, written three ways. The seller
 * taps through eBay / Facebook / Mercari tabs and each pane shows that
 * marketplace's native copy (search-friendly eBay title + item specifics,
 * casual local Facebook text, short Mercari title + hashtags). Same copy as the
 * desktop StepWrite (Canon AE-1). See [[snaplist-mobile-polish-pr70]].
 *
 * Render:
 *   npx remotion render remotion/index.ts step-write-mobile public/demo/steps/write-mobile.mp4 --crf 26 --muted
 *   ... write-mobile-dark.mp4 ... --props '{"theme":"dark"}'
 */

export const STEP_WRITE_MOBILE_LEN = 420;
const SEAM = 16;
const PAD = 28;
const INNER = M_LOGICAL_W - PAD * 2;

const TABS = ["eBay", "Facebook", "Mercari"] as const;
const TAB_BAR: Rect = { x: PAD, y: 100, w: INNER, h: 52 };
const SEG_W = INNER / 3;
const FB_AT = 160;
const MC_AT = 280;
const TAP_FB = 152;
const TAP_MC = 272;

const EBAY_TITLE = "Canon AE-1 35mm Film SLR Camera w/ FD 50mm f/1.8 Lens";
const EBAY_SPECS = ["Brand: Canon", "Model: AE-1", "Lens: FD 50mm f/1.8"];
const EBAY_DESC =
  "Canon AE-1 35mm film SLR with the FD 50mm f/1.8 lens, front cap, and original strap. Cosmetically good — light brassing from honest use, no dents or cracks visible in the photos.";
const FB_DESC =
  "Canon AE-1 film camera with the 50mm f/1.8 lens — strap and cap included. Body's in good shape, light brassing from age. Pickup this week, $165 OBO.";
const MC_TITLE = "Canon AE-1 35mm Film Camera";
const MC_TAGS = ["#CanonAE1", "#35mm", "#filmcamera", "#vintagecamera"];

const CARD: Rect = { x: PAD, y: 172, w: INNER, h: 430 };

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, color: FAINT }}>{children}</div>;
}

function Chip({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      style={{
        fontSize: 13.5,
        fontWeight: 700,
        color: accent ? VIOLET : INK,
        background: accent ? "var(--sl-violet-soft, rgba(99,91,255,0.1))" : SLAB,
        border: `1px solid ${LINE}`,
        borderRadius: 9,
        padding: "6px 11px",
      }}
    >
      {children}
    </span>
  );
}

function EbayPane() {
  return (
    <>
      <Label>ITEM TITLE · BUILT FOR SEARCH</Label>
      <div style={{ fontSize: 19, fontWeight: 800, color: INK, lineHeight: 1.3, marginTop: 8 }}>{EBAY_TITLE}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
        {EBAY_SPECS.map((s) => (
          <Chip key={s}>{s}</Chip>
        ))}
      </div>
      <div style={{ fontSize: 15.5, lineHeight: 1.55, color: FAINT, marginTop: 16 }}>{EBAY_DESC}</div>
    </>
  );
}

function FacebookPane() {
  return (
    <>
      <Label>CASUAL · LOCAL PICKUP</Label>
      <div style={{ fontSize: 18, fontWeight: 700, color: INK, lineHeight: 1.5, marginTop: 12 }}>{FB_DESC}</div>
      <div style={{ marginTop: 18 }}>
        <Chip accent>Copy-paste pack · Orlando, FL</Chip>
      </div>
    </>
  );
}

function MercariPane() {
  return (
    <>
      <Label>SHORT TITLE · HASHTAGS</Label>
      <div style={{ fontSize: 20, fontWeight: 800, color: INK, lineHeight: 1.35, marginTop: 10 }}>{MC_TITLE}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 18 }}>
        {MC_TAGS.map((t) => (
          <Chip key={t} accent>
            {t}
          </Chip>
        ))}
      </div>
      <div style={{ marginTop: 18 }}>
        <Chip>Copy-paste pack · ships small</Chip>
      </div>
    </>
  );
}

function WriteMobileAct() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const active = frame >= MC_AT ? 2 : frame >= FB_AT ? 1 : 0;
  const tabStart = active === 2 ? MC_AT : active === 1 ? FB_AT : 0;
  const paneIn = spring({ frame: frame - tabStart, fps, config: { damping: 18, stiffness: 150 }, durationInFrames: 18 });

  const segC = (i: number) => ({ x: TAB_BAR.x + i * SEG_W + SEG_W / 2, y: TAB_BAR.y + TAB_BAR.h / 2 });
  const cursor = path(frame, [
    [0, 470, 650],
    ...arriveAndDwell(TAP_FB - 24, TAP_FB + 8, segC(1).x, segC(1).y),
    ...arriveAndDwell(TAP_MC - 24, TAP_MC + 8, segC(2).x, segC(2).y),
    [340, segC(2).x, segC(2).y],
  ]);
  const press = Math.max(pressAt(frame, TAP_FB), pressAt(frame, TAP_MC));

  const fadeOut = interpolate(frame, [STEP_WRITE_MOBILE_LEN - SEAM, STEP_WRITE_MOBILE_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <div style={{ position: "absolute", inset: 0, background: SURFACE }}>
        {/* header */}
        <div style={{ position: "absolute", left: PAD, top: 30, right: PAD, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.4, color: INK }}>Write</span>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, color: VIOLET, background: "var(--sl-violet-soft, rgba(99,91,255,0.1))", borderRadius: 99, padding: "6px 12px" }}>
            STEP 4 · WRITE
          </span>
        </div>

        {/* marketplace tabs */}
        <div
          style={{
            position: "absolute",
            left: TAB_BAR.x,
            top: TAB_BAR.y,
            width: TAB_BAR.w,
            height: TAB_BAR.h,
            borderRadius: 14,
            background: SLAB,
            border: `1px solid ${LINE}`,
            display: "flex",
            padding: 4,
            boxSizing: "border-box",
          }}
        >
          {TABS.map((t, i) => (
            <div
              key={t}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 10,
                fontSize: 15.5,
                fontWeight: 800,
                color: i === active ? "white" : FAINT,
                background: i === active ? VIOLET : "transparent",
                boxShadow: i === active ? "0 6px 16px -8px rgba(99,91,255,0.6)" : "none",
              }}
            >
              {t}
            </div>
          ))}
        </div>

        {/* content card */}
        <div
          style={{
            position: "absolute",
            left: CARD.x,
            top: CARD.y,
            width: CARD.w,
            height: CARD.h,
            borderRadius: 20,
            border: `1.5px solid ${LINE}`,
            background: SURFACE,
            boxSizing: "border-box",
            padding: "24px 24px",
            opacity: paneIn,
            transform: `translateY(${(1 - paneIn) * 10}px)`,
          }}
        >
          {active === 0 ? <EbayPane /> : active === 1 ? <FacebookPane /> : <MercariPane />}
        </div>
      </div>

      <Cursor x={cursor.x} y={cursor.y} press={press} />
    </AbsoluteFill>
  );
}

export const StepWriteMobile: React.FC = () => (
  <MobileScene>
    <Sequence from={STEP_WRITE_MOBILE_LEN - SEAM} durationInFrames={SEAM}>
      <Freeze frame={0}>
        <WriteMobileAct />
      </Freeze>
    </Sequence>
    <WriteMobileAct />
  </MobileScene>
);
