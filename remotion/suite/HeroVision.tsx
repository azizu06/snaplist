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
import { Cursor, arriveAndDwell, path, pressAt, typeProgress, Caret, LogoMark } from "../hero/primitives";
import {
  AttrField,
  Chip,
  Feed,
  OcrBox,
  PhotoFrame,
  Scene,
  Shell,
  StatusLine,
  Toast,
  streamProgress,
  type FeedEvent,
} from "./primitives";
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
 * Hero video v5 — the photo-to-listing showcase. Three products, one arc
 * each: photo arrives → the live feed narrates in plain seller language
 * (scan sweep, detection boxes over the *actual printed text* in the photo,
 * extracted details with how-sure chips) → the details assemble into a
 * listing draft before your eyes. Pricing appears only as a one-chip coda.
 *
 *   Act 1 · Polaroid Supercolor 645 CL — model name printed on the body; the
 *           only cursor act (click to add the photo).
 *   Act 2 · Game Boy Color — “GAME BOY COLOR” + “Nintendo” on-device.
 *   Act 3 · Casio G-Shock DW-5600 — “CASIO” + “G-SHOCK” on the case.
 *   End card → crossfade into the frozen Act 1 opening frame (seamless loop).
 *
 * Render:
 *   npx remotion render remotion/index.ts hero-demo public/hero-demo.mp4 \
 *     --crf 28 --muted
 */

export const ACT_LEN = 450;
export const END_LEN = 120;
export const HERO_VISION_LEN = ACT_LEN * 3 + END_LEN; // 1470 = 49s @30fps

/* ---------- layout ---------- */

const PHOTO: Rect = { x: 64, y: 112, w: 460, h: 345 };
const FEED_RECT: Rect = { x: 64, y: 502, w: 460, h: 164 };
const RX = 556;
const RW = 652;
const COL2 = RX + 334; // field grid col 2
const FIELD_W = 318;
const FIELD_H = 56;
const ROW_Y = [150, 216, 282];
const DRAFT: Rect = { x: RX, y: 360, w: RW, h: 302 };

/* ---------- shared act choreography (act-local frames) ---------- */

const PHOTO_IN = 60;
const SCAN_START = 80;
const SCAN_END = 140;
const STATUS_AT = 76;
const STATUS_DONE = 268;
const FIELD_AT = [204, 222, 240, 256, 270, 284];
const DRAFT_AT = 296;
const TITLE_AT = 308;
const TITLE_DUR = 40;
const CHIPS_AT = 352;
const DESC_AT = 364;
const DESC_DUR = 52;
const PRICE_AT = 408;
const READY_AT = 424;

/* ---------- act 1 cursor (the only clicking act) ---------- */

const DROP_C = center(PHOTO);
const ARRIVE_DROP = 40;
const CLICK_DROP = 54;
const DWELL_END = 70;

export const HERO_WAYPOINTS: Array<[number, number, number]> = [
  [0, 1150, 668],
  ...arriveAndDwell(ARRIVE_DROP, DWELL_END, DROP_C.x, DROP_C.y),
  [124, 706, 692],
];

export const heroCursorAt = (frame: number) => path(frame, HERO_WAYPOINTS);

export const HERO_CLICKS: ClickSpec[] = [
  {
    label: "hero act 1: click photo dropzone to add the Polaroid photo",
    frame: CLICK_DROP,
    target: PHOTO,
    arrive: ARRIVE_DROP,
    until: DWELL_END,
  },
];

/* ---------- per-act content ---------- */

interface ActConfig {
  img: string;
  objectPosition: string;
  fileName: string;
  arrival: "click" | "sync";
  step: string;
  statusDone: string;
  ocr: Array<{ at: number; box: Rect; label: string; labelSide?: "below" | "above" }>;
  fields: Array<{ label: string; value: string; conf: number }>;
  feed: FeedEvent[];
  title: string;
  specifics: string[];
  desc: string;
  price: number;
}

/*
 * OCR boxes are display coordinates inside the 460x345 photo frame, computed
 * from each source image's cover-crop (`objectFit: cover` + objectPosition)
 * so the green detection box sits over the *actual printed text*.
 */

const ACT_POLAROID: ActConfig = {
  img: "demo/polaroid.jpg",
  objectPosition: "50% 50%",
  fileName: "IMG_5102.jpg",
  arrival: "click",
  step: "1 of 3 · instant cameras",
  statusDone: "Found it · Polaroid Supercolor 645 CL",
  ocr: [
    { at: 158, box: { x: 152, y: 39, w: 64, h: 25 }, label: "brand mark · “Polaroid”" },
    {
      at: 184,
      box: { x: 146, y: 259, w: 163, h: 26 },
      label: "model · “Supercolor 645 CL”",
      labelSide: "above",
    },
  ],
  fields: [
    { label: "BRAND", value: "Polaroid", conf: 0.99 },
    { label: "MODEL", value: "Supercolor 645 CL", conf: 0.97 },
    { label: "CATEGORY", value: "Cameras & Photo", conf: 0.95 },
    { label: "CONDITION", value: "Good · light wear", conf: 0.87 },
    { label: "COLOR", value: "Red / black", conf: 0.98 },
    { label: "PRINTED ON IT", value: "SUPERCOLOR 645 CL", conf: 0.96 },
  ],
  feed: [
    { at: 84, done: 146, text: "Looking at your photo…" },
    {
      at: 152,
      done: 192,
      text: "Reading the printed text on the body…",
      sub: "Found “Supercolor 645 CL” and “Polaroid”",
      subAt: 196,
    },
    { at: 204, done: 264, text: "Double-checking every detail it found" },
    { at: 282, done: 392, text: "Writing your listing draft…" },
  ],
  title: "Polaroid Supercolor 645 CL instant camera",
  specifics: ["Brand · Polaroid", "Type · Instant camera", "Condition · Good"],
  desc: "Vintage Polaroid Supercolor 645 CL in good working order. Iconic red-and-black body with built-in flash. Light wear consistent with age.",
  price: 65,
};

const ACT_GAMEBOY: ActConfig = {
  img: "demo/gameboy.jpg",
  objectPosition: "50% 45%",
  fileName: "IMG_5147.jpg",
  arrival: "sync",
  step: "2 of 3 · video games",
  statusDone: "Found it · Nintendo Game Boy Color",
  ocr: [
    {
      at: 158,
      box: { x: 187, y: 137, w: 81, h: 19 },
      label: "model · “GAME BOY COLOR”",
      labelSide: "above",
    },
    { at: 184, box: { x: 208, y: 162, w: 43, h: 17 }, label: "brand · “Nintendo”" },
  ],
  fields: [
    { label: "BRAND", value: "Nintendo", conf: 0.99 },
    { label: "MODEL", value: "Game Boy Color", conf: 0.97 },
    { label: "CATEGORY", value: "Video Games & Consoles", conf: 0.96 },
    { label: "CONDITION", value: "Good · tested", conf: 0.85 },
    { label: "COLOR", value: "Dandelion yellow", conf: 0.98 },
    { label: "PRINTED ON IT", value: "GAME BOY COLOR", conf: 0.97 },
  ],
  feed: [
    { at: 84, done: 146, text: "Looking at your photo…" },
    {
      at: 152,
      done: 192,
      text: "Reading the name printed on it…",
      sub: "Found “GAME BOY COLOR” and “Nintendo”",
      subAt: 196,
    },
    { at: 204, done: 264, text: "Double-checking every detail it found" },
    { at: 282, done: 392, text: "Writing your listing draft…" },
  ],
  title: "Nintendo Game Boy Color, Dandelion",
  specifics: ["Brand · Nintendo", "Type · Handheld console", "Color · Dandelion"],
  desc: "Nintendo Game Boy Color in the Dandelion colorway. Good condition: clear screen, clicky buttons, everything works. A pocketful of the late 90s.",
  price: 95,
};

const ACT_GSHOCK: ActConfig = {
  img: "demo/gshock.jpg",
  objectPosition: "50% 50%",
  fileName: "IMG_5201.jpg",
  arrival: "sync",
  step: "3 of 3 · watches",
  statusDone: "Found it · Casio G-Shock DW-5600",
  ocr: [
    { at: 158, box: { x: 208, y: 57, w: 43, h: 16 }, label: "brand · “CASIO”" },
    { at: 184, box: { x: 185, y: 163, w: 88, h: 21 }, label: "line · “G-SHOCK”" },
  ],
  fields: [
    { label: "BRAND", value: "Casio", conf: 0.99 },
    { label: "MODEL", value: "G-Shock DW-5600", conf: 0.94 },
    { label: "CATEGORY", value: "Watches", conf: 0.97 },
    { label: "CONDITION", value: "Good", conf: 0.88 },
    { label: "COLOR", value: "Black", conf: 0.99 },
    { label: "PRINTED ON IT", value: "CASIO · G-SHOCK", conf: 0.95 },
  ],
  feed: [
    { at: 84, done: 146, text: "Looking at your photo…" },
    {
      at: 152,
      done: 192,
      text: "Reading the text on the case…",
      sub: "Found “CASIO” and “G-SHOCK”",
      subAt: 196,
    },
    { at: 204, done: 264, text: "Double-checking every detail it found" },
    { at: 282, done: 392, text: "Writing your listing draft…" },
  ],
  title: "Casio G-Shock DW-5600 digital watch",
  specifics: ["Brand · Casio", "Model · DW-5600", "Type · Digital watch"],
  desc: "Casio G-Shock DW-5600 in good condition. Tough, tested and keeping perfect time, the classic square case that survives everything.",
  price: 42,
};

/* ---------- the act ---------- */

function DraftPanel({ act }: { act: ActConfig }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < DRAFT_AT - 4) {
    return (
      <div
        style={{
          position: "absolute",
          left: DRAFT.x,
          top: DRAFT.y,
          width: DRAFT.w,
          height: DRAFT.h,
          borderRadius: 14,
          border: `1.5px dashed ${LINE}`,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.2, color: LINE }}>
          YOUR LISTING DRAFT
        </span>
      </div>
    );
  }
  const enter = spring({
    frame: frame - DRAFT_AT,
    fps,
    config: { damping: 15, stiffness: 130 },
    durationInFrames: 24,
  });
  const titleN = typeProgress(act.title, frame, TITLE_AT, TITLE_DUR);
  const titleTyping = frame >= TITLE_AT && frame <= TITLE_AT + TITLE_DUR + 14;
  const descN = streamProgress(act.desc, frame, DESC_AT, DESC_DUR);
  const descStreaming = frame >= DESC_AT && frame <= DESC_AT + DESC_DUR + 12;

  return (
    <div
      style={{
        position: "absolute",
        left: DRAFT.x,
        top: DRAFT.y,
        width: DRAFT.w,
        height: DRAFT.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: SURFACE,
        boxShadow: "0 12px 30px -14px rgba(19,30,58,0.18)",
        boxSizing: "border-box",
        padding: "14px 16px",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 14}px)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
          YOUR LISTING DRAFT
        </span>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: FAINT }}>
          written from the photo
        </span>
      </div>

      {/* title */}
      <div
        style={{
          marginTop: 12,
          height: 40,
          borderRadius: 10,
          border: `1px solid ${titleTyping ? "rgba(99,91,255,0.45)" : LINE}`,
          boxShadow: titleTyping ? "0 0 0 3px rgba(99,91,255,0.1)" : undefined,
          background: SLAB,
          display: "flex",
          alignItems: "center",
          padding: "0 13px",
          fontSize: 15.5,
          fontWeight: 700,
          color: INK,
          boxSizing: "border-box",
        }}
      >
        <span style={{ whiteSpace: "nowrap", overflow: "hidden" }}>
          {act.title.slice(0, titleN)}
        </span>
        <Caret visible={titleTyping && titleN > 0} />
      </div>

      {/* item specifics */}
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        {act.specifics.map((chip, i) => (
          <Chip key={chip} text={chip} at={CHIPS_AT} index={i} />
        ))}
      </div>

      {/* description */}
      <div
        style={{
          marginTop: 12,
          height: 96,
          borderRadius: 10,
          border: `1px solid ${descStreaming ? "rgba(99,91,255,0.45)" : LINE}`,
          boxShadow: descStreaming ? "0 0 0 3px rgba(99,91,255,0.1)" : undefined,
          background: SLAB,
          padding: "10px 13px",
          fontSize: 13.5,
          lineHeight: 1.55,
          color: DIM,
          boxSizing: "border-box",
        }}
      >
        {act.desc.slice(0, descN)}
        <Caret visible={descStreaming} height={13} />
      </div>

      {/* coda: price hint + ready pill */}
      <div
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          bottom: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {frame >= PRICE_AT ? (
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: VIOLET,
              background: VIOLET_SOFT,
              borderRadius: 99,
              padding: "5px 12px",
              fontVariantNumeric: "tabular-nums",
              opacity: spring({
                frame: frame - PRICE_AT,
                fps,
                config: { damping: 13 },
                durationInFrames: 20,
              }),
            }}
          >
            Suggested price · ${act.price} · from recent sales
          </span>
        ) : (
          <span />
        )}
        {frame >= READY_AT ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              fontWeight: 800,
              color: GREEN,
              background: GREEN_SOFT,
              borderRadius: 99,
              padding: "5px 12px",
              opacity: spring({
                frame: frame - READY_AT,
                fps,
                config: { damping: 11, stiffness: 160 },
                durationInFrames: 22,
              }),
            }}
          >
            ✓ Draft ready for review
          </span>
        ) : null}
      </div>
    </div>
  );
}

function VisionAct({ act, isFirst }: { act: ActConfig; isFirst?: boolean }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const photoIn = spring({
    frame: frame - PHOTO_IN,
    fps,
    config: { damping: 16, stiffness: 120 },
    durationInFrames: 28,
  });

  const fadeIn = isFirst
    ? 1
    : interpolate(frame, [0, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [ACT_LEN - 10, ACT_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const cursor = isFirst ? heroCursorAt(frame) : null;
  const press = isFirst ? pressAt(frame, CLICK_DROP) : 0;

  return (
    <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOut) }}>
      <Shell>
        <PhotoFrame
          rect={PHOTO}
          src={staticFile(act.img)}
          fileName={act.fileName}
          photoIn={photoIn}
          scanStart={SCAN_START}
          scanEnd={SCAN_END}
          objectPosition={act.objectPosition}
        >
          {act.ocr.map((o) => (
            <OcrBox key={o.label} at={o.at} box={o.box} label={o.label} labelSide={o.labelSide} />
          ))}
        </PhotoFrame>
        {act.arrival === "sync" ? (
          <Toast x={PHOTO.x + 110} y={PHOTO.y + 12} at={26} hold={56} icon="phone" text="Synced from iPhone" />
        ) : null}
        <StatusLine
          x={PHOTO.x}
          y={466}
          startAt={STATUS_AT}
          doneAt={STATUS_DONE}
          busyText="Reading your photo…"
          doneText={act.statusDone}
        />
        <Feed rect={FEED_RECT} events={act.feed} />

        {/* right column */}
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
          <span style={{ fontSize: 13, fontWeight: 600, color: FAINT }}>{act.step}</span>
        </div>
        {act.fields.map((f, i) => (
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
        <DraftPanel act={act} />
      </Shell>
      {cursor ? <Cursor x={cursor.x} y={cursor.y} press={press} /> : null}
    </AbsoluteFill>
  );
}

/* ---------- end card ---------- */

const END_ITEMS = [
  { img: "demo/polaroid.jpg", pos: "50% 50%", title: "Polaroid Supercolor 645 CL instant camera", price: 65 },
  { img: "demo/gameboy.jpg", pos: "50% 45%", title: "Nintendo Game Boy Color, Dandelion", price: 95 },
  { img: "demo/gshock.jpg", pos: "50% 50%", title: "Casio G-Shock DW-5600 digital watch", price: 42 },
];

function EndCard() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fadeIn = interpolate(frame, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(frame, [END_LEN - 18, END_LEN - 2], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const tagIn = spring({ frame: frame - 12, fps, config: { damping: 14 }, durationInFrames: 26 });

  return (
    <AbsoluteFill
      style={{
        opacity: Math.min(fadeIn, fadeOut),
        background: SLAB,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ opacity: tagIn, transform: `translateY(${(1 - tagIn) * 14}px)` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
          <LogoMark size={32} />
          <span style={{ fontSize: 20, fontWeight: 800, color: INK }}>SnapList</span>
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 31,
            fontWeight: 800,
            color: INK,
            textAlign: "center",
            letterSpacing: -0.5,
          }}
        >
          Point a camera at it.
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 31,
            fontWeight: 800,
            color: VIOLET,
            textAlign: "center",
            letterSpacing: -0.5,
          }}
        >
          The listing writes itself.
        </div>
      </div>

      <div style={{ marginTop: 36, display: "flex", flexDirection: "column", gap: 12 }}>
        {END_ITEMS.map((l, i) => {
          const s = spring({
            frame: frame - (22 + i * 8),
            fps,
            config: { damping: 13, stiffness: 130 },
            durationInFrames: 26,
          });
          return (
            <div
              key={l.title}
              style={{
                width: 520,
                display: "flex",
                alignItems: "center",
                gap: 14,
                background: SURFACE,
                border: `1px solid ${LINE}`,
                borderRadius: 14,
                padding: 11,
                boxShadow: "0 10px 24px -12px rgba(19,30,58,0.16)",
                opacity: s,
                transform: `translateY(${(1 - s) * 22}px)`,
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 10,
                  overflow: "hidden",
                  flexShrink: 0,
                  border: `1px solid ${LINE}`,
                }}
              >
                <Img
                  src={staticFile(l.img)}
                  style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: l.pos }}
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
                  {l.title}
                </div>
                <div style={{ fontSize: 12.5, color: FAINT, marginTop: 3 }}>
                  Identified and written from one photo
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 800,
                    color: INK,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  ${l.price}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    background: GREEN_SOFT,
                    borderRadius: 99,
                    padding: "2.5px 9px",
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: GREEN }} />
                  <span style={{ fontSize: 10, fontWeight: 800, color: GREEN }}>DRAFT READY</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

/* ---------- composition ---------- */

export const HeroVision: React.FC = () => {
  const act2From = ACT_LEN;
  const act3From = ACT_LEN * 2;
  const endFrom = ACT_LEN * 3;

  return (
    <Scene>
      <Sequence from={0} durationInFrames={ACT_LEN}>
        <VisionAct act={ACT_POLAROID} isFirst />
      </Sequence>
      <Sequence from={act2From} durationInFrames={ACT_LEN}>
        <VisionAct act={ACT_GAMEBOY} />
      </Sequence>
      <Sequence from={act3From} durationInFrames={ACT_LEN}>
        <VisionAct act={ACT_GSHOCK} />
      </Sequence>
      {/* loop seam: end card fades out over the frozen Act 1 opening frame */}
      <Sequence from={HERO_VISION_LEN - 18} durationInFrames={18}>
        <Freeze frame={0}>
          <VisionAct act={ACT_POLAROID} isFirst />
        </Freeze>
      </Sequence>
      <Sequence from={endFrom} durationInFrames={END_LEN}>
        <EndCard />
      </Sequence>
    </Scene>
  );
};
