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
import { Caret, CheckIcon, Cursor, arriveAndDwell, path, pressAt, typeProgress } from "../hero/primitives";
import { Chip, Feed, Scene, Shell, streamProgress, type FeedEvent } from "./primitives";
import {
  DIM,
  FAINT,
  GREEN,
  INK,
  LINE,
  SLAB,
  VIOLET,
  VIOLET_SOFT,
  center,
  type ClickSpec,
  type Rect,
} from "./theme";

/**
 * Step 4 · Write — listing copy writes itself, then the seller flips through
 * the platform tabs: eBay (structured title + item specifics + description),
 * Facebook Marketplace (casual, local) and Mercari (short title, hashtags,
 * shipping). Both tab switches are cursor-accurate clicks.
 * Product: KitchenAid stand mixer — pink (demo/mixer.jpg).
 *
 * Render: npx remotion render remotion/index.ts step-write public/demo/steps/write.mp4 --crf 26 --muted
 */

export const STEP_WRITE_LEN = 560;
const SEAM = 16;

/* ---------- layout ---------- */

const ITEM: Rect = { x: 64, y: 112, w: 400, h: 330 };
const FEED_RECT: Rect = { x: 64, y: 466, w: 400, h: 196 };
const TAB_EBAY: Rect = { x: 496, y: 112, w: 120, h: 42 };
const TAB_FB: Rect = { x: 624, y: 112, w: 150, h: 42 };
const TAB_MERCARI: Rect = { x: 782, y: 112, w: 130, h: 42 };
const PANE: Rect = { x: 496, y: 170, w: 712, h: 492 };

/* ---------- choreography ---------- */

const EBAY_TITLE_AT = 36;
const EBAY_TITLE_DUR = 50;
const EBAY_SPEC_AT = 104;
const EBAY_DESC_AT = 150;
const EBAY_DESC_DUR = 110;

const ARRIVE_FB = 296;
const CLICK_FB = 310;
const FB_SWAP = 312;
const FB_TEXT_AT = 330;
const FB_TEXT_DUR = 78;
const FB_META_AT = 418;

const ARRIVE_MC = 444;
const CLICK_MC = 458;
const MC_SWAP = 460;
const MC_TITLE_AT = 476;
const MC_TAGS_AT = 500;
const MC_SHIP_AT = 514;
const READY_AT = 530;

const EBAY_TITLE = "KitchenAid Stand Mixer — Pink Tilt-Head, Tested & Working";
const EBAY_SPECS: Array<[string, string]> = [
  ["Brand", "KitchenAid"],
  ["Type", "Stand mixer"],
  ["Color", "Pink"],
  ["Condition", "Good — fully working"],
];
const EBAY_DESC =
  "Pink KitchenAid stand mixer in good working condition. The motor runs strong through every speed and the tilt-head locks tight. Whisk attachment included — comes from a smoke-free kitchen and is cleaned and ready to bake.";

const FB_TEXT =
  "Pink KitchenAid stand mixer, runs strong on every speed. Whisk included, smoke-free home. Pickup this week — $185 OBO.";

const MC_TITLE = "KitchenAid Stand Mixer Pink";
const MC_TAGS = ["#KitchenAid", "#standmixer", "#baking", "#kitchenfinds"];

const FEED: FeedEvent[] = [
  { at: 24, done: 88, tool: "rag.retrieve", text: "grounding on 12 similar sold listings" },
  { at: 96, done: 252, tool: "listing.write", text: "eBay rendering · keyword title + specifics" },
  { at: 318, done: 402, tool: "listing.write", text: "Facebook rendering · casual & local" },
  { at: 466, done: 520, tool: "listing.write", text: "Mercari rendering · hashtags + shipping" },
];

const FB_C = center(TAB_FB);
const MC_C = center(TAB_MERCARI);

export const WRITE_WAYPOINTS: Array<[number, number, number]> = [
  [0, 1240, 706],
  [240, 1240, 706],
  ...arriveAndDwell(ARRIVE_FB, CLICK_FB + 8, FB_C.x, FB_C.y),
  [352, 850, 330],
  [400, 850, 330],
  ...arriveAndDwell(ARRIVE_MC, CLICK_MC + 8, MC_C.x, MC_C.y),
  [506, 1000, 420],
  [540, 1150, 690],
];

export const writeCursorAt = (frame: number) => path(frame, WRITE_WAYPOINTS);

export const WRITE_CLICKS: ClickSpec[] = [
  {
    label: "write: click the Facebook platform tab",
    frame: CLICK_FB,
    target: TAB_FB,
    arrive: ARRIVE_FB,
    until: CLICK_FB + 8,
  },
  {
    label: "write: click the Mercari platform tab",
    frame: CLICK_MC,
    target: TAB_MERCARI,
    arrive: ARRIVE_MC,
    until: CLICK_MC + 8,
  },
];

/* ---------- pieces ---------- */

function ItemCard() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 6, fps, config: { damping: 15 }, durationInFrames: 22 });
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
        background: "white",
        boxSizing: "border-box",
        padding: 14,
        opacity: enter,
      }}
    >
      <div
        style={{
          width: "100%",
          height: 196,
          borderRadius: 10,
          overflow: "hidden",
          border: `1px solid ${LINE}`,
        }}
      >
        <Img
          src={staticFile("demo/mixer.jpg")}
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 26%" }}
        />
      </div>
      <div style={{ marginTop: 12, fontSize: 14.5, fontWeight: 700, color: INK }}>
        KitchenAid stand mixer — pink
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            color: INK,
            background: SLAB,
            border: `1px solid ${LINE}`,
            borderRadius: 99,
            padding: "4px 10px",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          $185
        </span>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: FAINT,
            background: SLAB,
            border: `1px solid ${LINE}`,
            borderRadius: 99,
            padding: "4px 10px",
          }}
        >
          Good condition
        </span>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: FAINT,
            background: SLAB,
            border: `1px solid ${LINE}`,
            borderRadius: 99,
            padding: "4px 10px",
          }}
        >
          Home & Kitchen
        </span>
      </div>
    </div>
  );
}

function Tab({ rect, label, active, doneAt }: { rect: Rect; label: string; active: boolean; doneAt?: number }) {
  const frame = useCurrentFrame();
  const done = doneAt !== undefined && frame >= doneAt;
  return (
    <div
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        borderRadius: 11,
        border: `1px solid ${active ? "rgba(99,91,255,0.45)" : LINE}`,
        background: active ? VIOLET_SOFT : "white",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        fontSize: 13,
        fontWeight: 700,
        color: active ? VIOLET : FAINT,
        boxSizing: "border-box",
      }}
    >
      {label}
      {done ? <CheckIcon size={12} /> : null}
    </div>
  );
}

function PaneFrame({ children, swapAt }: { children: React.ReactNode; swapAt: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame: frame - swapAt,
    fps,
    config: { damping: 16, stiffness: 140 },
    durationInFrames: 20,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: PANE.x,
        top: PANE.y,
        width: PANE.w,
        height: PANE.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: "white",
        boxSizing: "border-box",
        padding: "16px 18px",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 10}px)`,
      }}
    >
      {children}
    </div>
  );
}

function EbayPane() {
  const frame = useCurrentFrame();
  const titleN = typeProgress(EBAY_TITLE, frame, EBAY_TITLE_AT, EBAY_TITLE_DUR);
  const titleTyping = frame >= EBAY_TITLE_AT && frame <= EBAY_TITLE_AT + EBAY_TITLE_DUR + 14;
  const descN = streamProgress(EBAY_DESC, frame, EBAY_DESC_AT, EBAY_DESC_DUR);
  const descTyping = frame >= EBAY_DESC_AT && frame <= EBAY_DESC_AT + EBAY_DESC_DUR + 12;
  const { fps } = useVideoConfig();
  return (
    <PaneFrame swapAt={14}>
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
        TITLE · 80 CHARACTERS MAX
      </div>
      <div
        style={{
          marginTop: 8,
          height: 42,
          borderRadius: 10,
          border: `1px solid ${titleTyping ? "rgba(99,91,255,0.45)" : LINE}`,
          boxShadow: titleTyping ? "0 0 0 3px rgba(99,91,255,0.1)" : undefined,
          background: SLAB,
          display: "flex",
          alignItems: "center",
          padding: "0 13px",
          fontSize: 14,
          fontWeight: 700,
          color: INK,
          boxSizing: "border-box",
        }}
      >
        <span style={{ whiteSpace: "nowrap", overflow: "hidden" }}>
          {EBAY_TITLE.slice(0, titleN)}
        </span>
        <Caret visible={titleTyping && titleN > 0} />
      </div>

      <div style={{ marginTop: 16, fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
        ITEM SPECIFICS
      </div>
      <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {EBAY_SPECS.map(([k, v], i) => {
          const at = EBAY_SPEC_AT + i * 10;
          if (frame < at) return <div key={k} style={{ height: 38 }} />;
          const s = spring({
            frame: frame - at,
            fps,
            config: { damping: 13, stiffness: 150 },
            durationInFrames: 20,
          });
          return (
            <div
              key={k}
              style={{
                height: 38,
                borderRadius: 9,
                border: `1px solid ${LINE}`,
                background: SLAB,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 12px",
                boxSizing: "border-box",
                opacity: s,
                transform: `translateY(${(1 - s) * 8}px)`,
              }}
            >
              <span style={{ fontSize: 11.5, fontWeight: 700, color: FAINT }}>{k}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>{v}</span>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 16, fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
        DESCRIPTION
      </div>
      <div
        style={{
          marginTop: 8,
          height: 124,
          borderRadius: 10,
          border: `1px solid ${descTyping ? "rgba(99,91,255,0.45)" : LINE}`,
          boxShadow: descTyping ? "0 0 0 3px rgba(99,91,255,0.1)" : undefined,
          background: SLAB,
          padding: "11px 13px",
          fontSize: 12.5,
          lineHeight: 1.6,
          color: DIM,
          boxSizing: "border-box",
        }}
      >
        {EBAY_DESC.slice(0, descN)}
        <Caret visible={descTyping} height={12} />
      </div>
      {frame >= EBAY_DESC_AT + EBAY_DESC_DUR + 16 ? (
        <div
          style={{
            marginTop: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 11.5,
            fontWeight: 700,
            color: GREEN,
          }}
        >
          <CheckIcon size={12} /> Follows eBay conventions — keyword title, structured specifics
        </div>
      ) : null}
    </PaneFrame>
  );
}

function FacebookPane() {
  const frame = useCurrentFrame();
  const n = streamProgress(FB_TEXT, frame, FB_TEXT_AT, FB_TEXT_DUR);
  const typing = frame >= FB_TEXT_AT && frame <= FB_TEXT_AT + FB_TEXT_DUR + 12;
  return (
    <PaneFrame swapAt={FB_SWAP}>
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
        MARKETPLACE POST · CASUAL & LOCAL
      </div>
      <div
        style={{
          marginTop: 10,
          minHeight: 120,
          borderRadius: 10,
          border: `1px solid ${typing ? "rgba(99,91,255,0.45)" : LINE}`,
          boxShadow: typing ? "0 0 0 3px rgba(99,91,255,0.1)" : undefined,
          background: SLAB,
          padding: "13px 15px",
          fontSize: 14.5,
          lineHeight: 1.65,
          color: INK,
          fontWeight: 500,
          boxSizing: "border-box",
        }}
      >
        {FB_TEXT.slice(0, n)}
        <Caret visible={typing} height={14} />
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
        <Chip text="Local pickup" at={FB_META_AT} index={0} tone="plain" />
        <Chip text="Price: $185 · open to offers" at={FB_META_AT} index={1} tone="plain" />
        <Chip text="Category: Home goods" at={FB_META_AT} index={2} tone="plain" />
      </div>
      {frame >= FB_META_AT + 22 ? (
        <div
          style={{
            marginTop: 16,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 11.5,
            fontWeight: 700,
            color: GREEN,
          }}
        >
          <CheckIcon size={12} /> Shorter, friendlier — written for neighbors, not search engines
        </div>
      ) : null}
      <div style={{ position: "absolute", left: 18, bottom: 14, fontSize: 10.5, color: FAINT }}>
        Copy-paste export pack — Facebook Marketplace has no posting API, so SnapList hands you the text.
      </div>
    </PaneFrame>
  );
}

function MercariPane() {
  const frame = useCurrentFrame();
  const n = typeProgress(MC_TITLE, frame, MC_TITLE_AT, 18);
  const typing = frame >= MC_TITLE_AT && frame <= MC_TITLE_AT + 30;
  return (
    <PaneFrame swapAt={MC_SWAP}>
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
        MERCARI LISTING · SHORT & SHIPPABLE
      </div>
      <div
        style={{
          marginTop: 10,
          height: 42,
          borderRadius: 10,
          border: `1px solid ${typing ? "rgba(99,91,255,0.45)" : LINE}`,
          background: SLAB,
          display: "flex",
          alignItems: "center",
          padding: "0 13px",
          fontSize: 14.5,
          fontWeight: 700,
          color: INK,
          boxSizing: "border-box",
        }}
      >
        {MC_TITLE.slice(0, n)}
        <Caret visible={typing && n > 0} />
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
        {MC_TAGS.map((t, i) => (
          <Chip key={t} text={t} at={MC_TAGS_AT} index={i} />
        ))}
      </div>
      {frame >= MC_SHIP_AT ? (
        <div
          style={{
            marginTop: 16,
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderRadius: 10,
            border: `1px solid ${LINE}`,
            background: SLAB,
            padding: "11px 14px",
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>$185</span>
          <span style={{ fontSize: 11.5, color: FAINT }}>
            + shipping · ships boxed in 1–2 days · weight ~12 lb
          </span>
        </div>
      ) : null}
      {frame >= READY_AT ? (
        <div
          style={{
            marginTop: 16,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 11.5,
            fontWeight: 700,
            color: GREEN,
          }}
        >
          <CheckIcon size={12} /> 3 platforms ready — one attribute core, three native renderings
        </div>
      ) : null}
    </PaneFrame>
  );
}

/* ---------- the act ---------- */

function WriteAct() {
  const frame = useCurrentFrame();
  const cursor = writeCursorAt(frame);
  const press = Math.min(1, pressAt(frame, CLICK_FB) + pressAt(frame, CLICK_MC));
  const active = frame >= MC_SWAP ? 2 : frame >= FB_SWAP ? 1 : 0;
  const fadeOut = interpolate(frame, [STEP_WRITE_LEN - SEAM, STEP_WRITE_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <Shell badge="STEP 4 · WRITE">
        <ItemCard />
        <Feed rect={FEED_RECT} events={FEED} agent="listing generator · grounded" />

        <Tab rect={TAB_EBAY} label="eBay" active={active === 0} doneAt={EBAY_DESC_AT + EBAY_DESC_DUR + 16} />
        <Tab rect={TAB_FB} label="Facebook" active={active === 1} doneAt={FB_META_AT + 22} />
        <Tab rect={TAB_MERCARI} label="Mercari" active={active === 2} doneAt={READY_AT} />

        {active === 0 ? <EbayPane /> : active === 1 ? <FacebookPane /> : <MercariPane />}
      </Shell>
      <Cursor x={cursor.x} y={cursor.y} press={press} />
    </AbsoluteFill>
  );
}

export const StepWrite: React.FC = () => (
  <Scene>
    <Sequence from={STEP_WRITE_LEN - SEAM} durationInFrames={SEAM}>
      <Freeze frame={0}>
        <WriteAct />
      </Freeze>
    </Sequence>
    <WriteAct />
  </Scene>
);
