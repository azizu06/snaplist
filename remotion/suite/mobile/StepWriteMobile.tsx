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
import { FAINT, INK, LINE, SLAB, SURFACE, VIOLET, type Rect } from "../theme";
import { M_LOGICAL_W, MobileScene } from "./StepSnapMobile";

/**
 * Step 4 · Write (portrait mobile) — one item, written three ways. The seller
 * taps through eBay / Facebook / Mercari tabs and each pane shows that
 * marketplace's native copy (search-friendly eBay title + item specifics,
 * casual local Facebook text, short Mercari title + hashtags). Same copy as the
 * desktop StepWrite (Acer Predator). See [[snaplist-mobile-polish-pr70]].
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

const EBAY_TITLE = "Acer Predator Helios 300 Gaming Laptop i7 RTX 144Hz 16GB 512GB SSD";
const EBAY_SPECS = ["Brand: Acer", "Model: Predator Helios 300", "CPU: Intel Core i7"];
const EBAY_DESC =
  "Acer Predator Helios 300 gaming laptop — Intel Core i7, GeForce RTX, 144Hz display, 16GB RAM, 512GB SSD. RGB backlit keyboard. Cosmetically good with light wear; powers on and runs in the photos.";
const FB_DESC =
  "Acer Predator Helios 300 gaming laptop — Core i7, RTX graphics, 144Hz screen, 16GB RAM, 512GB SSD. RGB keyboard, light wear, runs well. Pickup this week, $550 OBO.";
const MC_TITLE = "Acer Predator Helios 300 Gaming Laptop";
const MC_DESC =
  "Acer Predator Helios 300 gaming laptop — Core i7, GeForce RTX, 144Hz, 16GB/512GB. RGB keyboard, light wear, runs clean.";
const MC_TAGS = ["#AcerPredator", "#gaminglaptop", "#RTX", "#144Hz"];

const CARD: Rect = { x: PAD, y: 172, w: INNER, h: 408 };

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, color: FAINT }}>{children}</div>;
}

function Chip({
  children,
  accent,
  size = 13.5,
}: {
  children: React.ReactNode;
  accent?: boolean;
  size?: number;
}) {
  return (
    <span
      style={{
        fontSize: size,
        fontWeight: 700,
        color: accent ? VIOLET : INK,
        background: accent ? "var(--sl-violet-soft, rgba(0,128,96,0.1))" : SLAB,
        border: `1px solid ${accent ? "var(--sl-violet-border, rgba(0,128,96,0.3))" : LINE}`,
        borderRadius: 10,
        padding: "7px 13px",
      }}
    >
      {children}
    </span>
  );
}

/** Consistent footer pinned to the bottom of every tab's card so no
 *  marketplace pane reads as a half-empty box — the leftover space becomes a
 *  deliberate "ready to copy" footer instead of a void. */
function CopyBar({ market }: { market: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderTop: `1px solid ${LINE}`,
        paddingTop: 16,
        marginTop: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <CheckIcon size={15} color="var(--sl-green, #16a34a)" />
        <span style={{ fontSize: 14, fontWeight: 700, color: FAINT }}>
          Copy-paste ready · {market}
        </span>
      </div>
      <span
        style={{
          fontSize: 13.5,
          fontWeight: 800,
          color: VIOLET,
          background: "var(--sl-violet-soft, rgba(0,128,96,0.1))",
          border: `1px solid var(--sl-violet-border, rgba(0,128,96,0.3))`,
          borderRadius: 99,
          padding: "6px 15px",
        }}
      >
        Copy
      </span>
    </div>
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
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 18 }}>
        <Chip>Orlando, FL</Chip>
        <Chip>Local pickup</Chip>
        <Chip accent>$550 OBO</Chip>
      </div>
    </>
  );
}

function MercariPane() {
  return (
    <>
      <Label>SHORT TITLE · HASHTAGS</Label>
      <div style={{ fontSize: 20, fontWeight: 800, color: INK, lineHeight: 1.35, marginTop: 10 }}>{MC_TITLE}</div>
      <div style={{ fontSize: 15.5, lineHeight: 1.55, color: FAINT, marginTop: 12 }}>{MC_DESC}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 9, marginTop: 16 }}>
        {MC_TAGS.map((t) => (
          <Chip key={t} accent size={15}>
            {t}
          </Chip>
        ))}
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
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, color: VIOLET, background: "var(--sl-violet-soft, rgba(0,128,96,0.1))", borderRadius: 99, padding: "6px 12px" }}>
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
                boxShadow: i === active ? "0 6px 16px -8px rgba(0,128,96,0.6)" : "none",
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
            padding: "24px 24px 20px",
            display: "flex",
            flexDirection: "column",
            opacity: paneIn,
            transform: `translateY(${(1 - paneIn) * 10}px)`,
          }}
        >
          <div style={{ flex: 1, minHeight: 0 }}>
            {active === 0 ? <EbayPane /> : active === 1 ? <FacebookPane /> : <MercariPane />}
          </div>
          <CopyBar market={TABS[active]} />
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
