import React from "react";
import { Easing, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import {
  CHIPS_Y,
  DESC_FIELD,
  DESC_LABEL_Y,
  DIM,
  FAINT,
  FEED_BOX,
  GREEN,
  HEAD_Y,
  INK,
  LINE,
  PHOTO_BOX,
  PRICE_INPUT,
  PRICE_MODULE,
  PUBLISH_BTN,
  RIGHT_W,
  RIGHT_X,
  SLAB,
  STATUS_Y,
  TITLE_FIELD,
  TITLE_LABEL_Y,
  TOPBAR_H,
  VIOLET,
  WIN,
  SURFACE,
} from "./theme";

/* ================= cursor ================= */

/**
 * macOS-style pointer whose *tip* sits exactly at (x, y) — the svg is offset
 * by the tip's position inside the viewBox, and the click ripple is centered
 * on the same point. Pass the same frame constants to the button press state
 * and the click can never desync from the cursor.
 */
export function Cursor({ x, y, press }: { x: number; y: number; press: number }) {
  return (
    <div style={{ position: "absolute", left: x, top: y, zIndex: 60 }}>
      {press > 0.04 ? (
        <div
          style={{
            position: "absolute",
            left: -19,
            top: -19,
            width: 38,
            height: 38,
            borderRadius: 99,
            border: `2.5px solid rgba(0,128,96,${0.6 * (1 - press)})`,
            transform: `scale(${0.4 + press * 1.25})`,
          }}
        />
      ) : null}
      <svg
        width="22"
        height="26"
        viewBox="0 0 22 26"
        style={{
          position: "absolute",
          left: -3,
          top: -2,
          transform: `scale(${1 - press * 0.16})`,
          transformOrigin: "3px 2px",
          filter: "drop-shadow(0 2px 4px rgba(19,30,58,0.35))",
        }}
      >
        <path
          d="M3 2 L3 20 L7.6 16 L10.4 23 L13.6 21.6 L10.8 14.8 L17 14.4 Z"
          fill="white"
          stroke={INK}
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/** piecewise motion through waypoints, eased per segment */
export function path(
  frame: number,
  points: Array<[frame: number, x: number, y: number]>,
): { x: number; y: number } {
  if (frame <= points[0][0]) return { x: points[0][1], y: points[0][2] };
  for (let i = 0; i < points.length - 1; i++) {
    const [f0, x0, y0] = points[i];
    const [f1, x1, y1] = points[i + 1];
    if (frame <= f1) {
      const t = Easing.inOut(Easing.ease)((frame - f0) / (f1 - f0));
      return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
    }
  }
  const last = points[points.length - 1];
  return { x: last[1], y: last[2] };
}

/** brief press pulse around a frame */
export function pressAt(frame: number, at: number): number {
  return interpolate(frame, [at - 2, at + 2, at + 9], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/**
 * Waypoints that arrive at `(x, y)` with a tiny settle (gentle overshoot)
 * and dwell there until `until`. The click frame must satisfy
 * `arrive + 8 <= click <= until` — assert with `clickWindow`.
 */
export function arriveAndDwell(
  arrive: number,
  until: number,
  x: number,
  y: number,
): Array<[number, number, number]> {
  return [
    [arrive - 5, x + 7, y + 5],
    [arrive, x, y],
    [until, x, y],
  ];
}

/* ================= typing ================= */

const pseudo = (i: number): number => {
  const v = Math.sin((i + 1) * 12.9898) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * Natural variable-speed typing: returns how many characters of `text` are
 * visible at `frame`, finishing exactly at `start + duration`.
 */
export function typeProgress(
  text: string,
  frame: number,
  start: number,
  duration: number,
): number {
  if (frame < start) return 0;
  const times: number[] = [];
  let t = 0;
  for (let i = 0; i < text.length; i++) {
    const prev = i > 0 ? text[i - 1] : "";
    let d = 0.55 + pseudo(i) * 1.1;
    if (text[i] === " ") d *= 0.6;
    if (".,—;:".includes(prev)) d += 2.2;
    t += d;
    times.push(t);
  }
  const scale = duration / t;
  const elapsed = frame - start;
  let n = 0;
  for (let i = 0; i < times.length; i++) {
    if (elapsed >= times[i] * scale) n = i + 1;
    else break;
  }
  return n;
}

export function Caret({ visible, height = 15 }: { visible: boolean; height?: number }) {
  const frame = useCurrentFrame();
  if (!visible || frame % 22 >= 13) return null;
  return (
    <span
      style={{
        display: "inline-block",
        width: 1.6,
        height,
        background: INK,
        verticalAlign: "text-bottom",
        marginLeft: 1,
      }}
    />
  );
}

/* ================= app chrome ================= */

/**
 * Exact replica of the site brand mark (src/components/logo.tsx): white
 * 800-weight "SL" initials on the iris-gradient tile. Same gradient stops,
 * corner radius, and letter-spacing so the videos match the page chrome.
 */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size}>
      <defs>
        <linearGradient
          id="iris-grad"
          x1="6"
          y1="4"
          x2="44"
          y2="46"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#1fb88c" />
          <stop offset="0.55" stopColor="#008060" />
          <stop offset="1" stopColor="#00604a" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#iris-grad)" />
      <text
        x="24"
        y="25"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
        fontWeight="800"
        fontSize="20.5"
        letterSpacing="-0.8"
        fill="#ffffff"
      >
        SL
      </text>
    </svg>
  );
}

/** white app window + top bar; children are positioned on the canvas grid */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: WIN.x,
          top: WIN.y,
          width: WIN.w,
          height: WIN.h,
          background: SURFACE,
          borderRadius: 16,
          border: `1px solid ${LINE}`,
          boxShadow: "0 18px 40px -12px rgba(19,30,58,0.18)",
        }}
      >
        <div
          style={{
            height: TOPBAR_H,
            borderBottom: `1px solid ${LINE}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 22px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <LogoMark />
            <span style={{ fontWeight: 700, fontSize: 15.5, color: INK }}>SnapList</span>
            <div style={{ display: "flex", gap: 4, marginLeft: 22 }}>
              {["Listings", "New listing", "Inbox", "Settings"].map((t, i) => (
                <span
                  key={t}
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    padding: "7px 13px",
                    borderRadius: 99,
                    color: i === 1 ? VIOLET : FAINT,
                    background: i === 1 ? "rgba(0,128,96,0.1)" : "transparent",
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 99,
              background: "linear-gradient(135deg, #1fb88c, #00604a)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            A
          </div>
        </div>
      </div>
      {children}
    </>
  );
}

/* ================= photo panel ================= */

export function Spinner({ size = 12, deg }: { size?: number; deg: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 99,
        border: "2px solid rgba(0,128,96,0.25)",
        borderTopColor: VIOLET,
        transform: `rotate(${deg}deg)`,
        flexShrink: 0,
      }}
    />
  );
}

export function CheckIcon({ size = 13, color = GREEN }: { size?: number; color?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={color}
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function PhotoPanel({
  src,
  fileName,
  photoIn,
  scanStart,
  scanEnd,
  objectPosition = "50% 50%",
  children,
}: {
  src: string;
  fileName: string;
  photoIn: number;
  scanStart: number;
  scanEnd: number;
  objectPosition?: string;
  children?: React.ReactNode;
}) {
  const frame = useCurrentFrame();
  const scanT = interpolate(frame, [scanStart, scanEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.ease),
  });
  const scanVisible = frame >= scanStart && frame <= scanEnd + 4;
  const analyzing = frame >= scanStart - 4 && frame <= scanEnd + 4;

  return (
    <div
      style={{
        position: "absolute",
        left: PHOTO_BOX.x,
        top: PHOTO_BOX.y,
        width: PHOTO_BOX.w,
        height: PHOTO_BOX.h,
        borderRadius: 14,
        border: photoIn > 0.05 ? `1px solid ${LINE}` : `2px dashed ${LINE}`,
        background: photoIn > 0.05 ? SURFACE : SLAB,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {photoIn <= 0.05 ? (
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: 99,
              background: "rgba(0,128,96,0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto",
            }}
          >
            <svg
              viewBox="0 0 24 24"
              width="22"
              fill="none"
              stroke={VIOLET}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: INK, marginTop: 10 }}>
            Add photos
          </div>
          <div style={{ fontSize: 11.5, color: FAINT, marginTop: 3 }}>
            drag & drop or click to browse
          </div>
        </div>
      ) : (
        <>
          <Img
            src={src}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition,
              transform: `scale(${1.06 - photoIn * 0.06})`,
              opacity: photoIn,
            }}
          />
          {scanVisible ? (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: `${scanT * 100}%`,
                height: 64,
                transform: "translateY(-50%)",
                background:
                  "linear-gradient(180deg, transparent, rgba(0,128,96,0.22), rgba(255,255,255,0.32), rgba(0,128,96,0.22), transparent)",
              }}
            />
          ) : null}
          {analyzing
            ? (
                [
                  { left: 10, top: 10, b: "t l" },
                  { right: 10, top: 10, b: "t r" },
                  { left: 10, bottom: 10, b: "b l" },
                  { right: 10, bottom: 10, b: "b r" },
                ] as Array<Record<string, number | string>>
              ).map((c, i) => (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    width: 22,
                    height: 22,
                    left: c.left as number | undefined,
                    right: c.right as number | undefined,
                    top: c.top as number | undefined,
                    bottom: c.bottom as number | undefined,
                    borderTop: String(c.b).includes("t") ? "3px solid white" : undefined,
                    borderBottom: String(c.b).includes("b") ? "3px solid white" : undefined,
                    borderLeft: String(c.b).includes("l") ? "3px solid white" : undefined,
                    borderRight: String(c.b).includes("r") ? "3px solid white" : undefined,
                    borderRadius: 4,
                    filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.4))",
                  }}
                />
              ))
            : null}
          <div
            style={{
              position: "absolute",
              left: 10,
              bottom: 10,
              background: "rgba(19,30,58,0.72)",
              color: "white",
              borderRadius: 8,
              padding: "4px 9px",
              fontSize: 10.5,
              fontWeight: 600,
            }}
          >
            {fileName}
          </div>
          {children}
        </>
      )}
    </div>
  );
}

/** analyzing → identified pill under the photo */
export function StatusPill({
  analyzeStart,
  doneAt,
  doneText,
}: {
  analyzeStart: number;
  doneAt: number;
  doneText: string;
}) {
  const frame = useCurrentFrame();
  if (frame < analyzeStart) return null;
  const analyzing = frame < doneAt;
  return (
    <div style={{ position: "absolute", left: PHOTO_BOX.x, top: STATUS_Y }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          background: analyzing ? "rgba(0,128,96,0.1)" : "rgba(22,163,74,0.1)",
          borderRadius: 99,
          padding: "7px 14px",
        }}
      >
        {analyzing ? <Spinner deg={frame * 14} /> : <CheckIcon />}
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: analyzing ? VIOLET : GREEN,
          }}
        >
          {analyzing ? "Identifying your item…" : doneText}
        </span>
      </div>
    </div>
  );
}

/* ================= agent activity feed ================= */

export interface FeedEvent {
  /** act-local frame the line appears */
  at: number;
  /** spinner flips to a check at this frame; omit for an instant check */
  done?: number;
  /** tool-call name rendered as a violet tag, e.g. "search.comps" */
  tool: string;
  text: string;
  /** result sub-line (emerald) */
  sub?: string;
  subAt?: number;
}

export function FeedPanel({ events, agent }: { events: FeedEvent[]; agent: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        position: "absolute",
        left: FEED_BOX.x,
        top: FEED_BOX.y,
        width: FEED_BOX.w,
        height: FEED_BOX.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: SURFACE,
        padding: "14px 16px",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 99,
            background: VIOLET,
            opacity: 0.55 + 0.45 * Math.sin(frame / 5),
          }}
        />
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
          AGENT ACTIVITY
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 600, color: FAINT }}>
          {agent}
        </span>
      </div>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 9 }}>
        {events.map((e, i) => {
          if (frame < e.at) return null;
          const enter = spring({
            frame: frame - e.at,
            fps,
            config: { damping: 14, stiffness: 160 },
            durationInFrames: 20,
          });
          const running = e.done !== undefined && frame < e.done;
          const showSub = e.sub !== undefined && frame >= (e.subAt ?? e.at);
          return (
            <div
              key={i}
              style={{
                opacity: enter,
                transform: `translateY(${(1 - enter) * 8}px)`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {running ? <Spinner deg={frame * 14} /> : <CheckIcon />}
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: VIOLET,
                    background: "rgba(0,128,96,0.08)",
                    border: "1px solid rgba(0,128,96,0.22)",
                    borderRadius: 6,
                    padding: "1.5px 6px",
                    flexShrink: 0,
                  }}
                >
                  {e.tool}
                </span>
                <span
                  style={{
                    fontSize: 11.5,
                    color: DIM,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {e.text}
                </span>
              </div>
              {showSub ? (
                <div
                  style={{
                    marginLeft: 21,
                    marginTop: 4,
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: GREEN,
                    background: "rgba(22,163,74,0.08)",
                    borderRadius: 7,
                    padding: "4px 9px",
                    display: "inline-block",
                  }}
                >
                  {e.sub}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ================= right column form ================= */

export function RightHeader({ step }: { step: string }) {
  return (
    <div
      style={{
        position: "absolute",
        left: RIGHT_X,
        top: HEAD_Y,
        width: RIGHT_W,
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
      }}
    >
      <span style={{ fontSize: 18, fontWeight: 800, color: INK }}>New listing</span>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: FAINT }}>{step}</span>
    </div>
  );
}

export function FieldLabel({ y, text }: { y: number; text: string }) {
  return (
    <div
      style={{
        position: "absolute",
        left: RIGHT_X,
        top: y,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 1.2,
        color: FAINT,
      }}
    >
      {text}
    </div>
  );
}

export function TitleField({
  text,
  typeStart,
  typeDuration,
}: {
  text: string;
  typeStart: number;
  typeDuration: number;
}) {
  const frame = useCurrentFrame();
  const n = typeProgress(text, frame, typeStart, typeDuration);
  const typing = frame >= typeStart && frame <= typeStart + typeDuration + 18;
  return (
    <>
      <FieldLabel y={TITLE_LABEL_Y} text="TITLE" />
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
          fontSize: 14,
          fontWeight: 600,
          color: INK,
        }}
      >
        <span style={{ whiteSpace: "nowrap", overflow: "hidden" }}>{text.slice(0, n)}</span>
        <Caret visible={typing && n > 0} />
      </div>
    </>
  );
}

export function ChipsRow({ chips, startAt }: { chips: string[]; startAt: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        position: "absolute",
        left: RIGHT_X,
        top: CHIPS_Y,
        width: RIGHT_W,
        display: "flex",
        gap: 8,
      }}
    >
      {chips.map((chip, i) => {
        const s = spring({
          frame: frame - (startAt + i * 6),
          fps,
          config: { damping: 13, stiffness: 150 },
          durationInFrames: 24,
        });
        return (
          <div
            key={chip}
            style={{
              opacity: s,
              transform: `translateY(${(1 - s) * 10}px) scale(${0.8 + s * 0.2})`,
              border: "1px solid rgba(0,128,96,0.3)",
              background: "rgba(0,128,96,0.08)",
              color: VIOLET,
              borderRadius: 99,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {chip}
          </div>
        );
      })}
    </div>
  );
}

export function DescriptionField({
  text,
  typeStart,
  typeDuration,
}: {
  text: string;
  typeStart: number;
  typeDuration: number;
}) {
  const frame = useCurrentFrame();
  const n = typeProgress(text, frame, typeStart, typeDuration);
  const typing = frame >= typeStart && frame <= typeStart + typeDuration + 18;
  return (
    <>
      <FieldLabel y={DESC_LABEL_Y} text="DESCRIPTION" />
      <div
        style={{
          position: "absolute",
          left: DESC_FIELD.x,
          top: DESC_FIELD.y,
          width: DESC_FIELD.w,
          height: DESC_FIELD.h,
          borderRadius: 10,
          border: `1px solid ${typing ? "rgba(0,128,96,0.45)" : LINE}`,
          boxShadow: typing ? "0 0 0 3px rgba(0,128,96,0.1)" : undefined,
          background: SLAB,
          padding: "12px 14px",
          fontSize: 13,
          lineHeight: 1.55,
          color: DIM,
        }}
      >
        {text.slice(0, n)}
        <Caret visible={typing} height={13} />
      </div>
    </>
  );
}

/* ================= price module ================= */

export function PriceModule({
  appearAt,
  suggested,
  rangeLow,
  rangeHigh,
  confidence,
  tier,
  comps,
  /** seller price edit (Act 3): when set, the input shows override behavior */
  edit,
}: {
  appearAt: number;
  suggested: number;
  rangeLow: number;
  rangeHigh: number;
  confidence: number;
  tier: string;
  comps: string;
  edit?: {
    focusAt: number; // click frame — focus ring + select highlight
    typedValue: string; // e.g. "92"
    typeStart: number;
    typeDuration: number;
    noteAt: number;
  };
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const moduleIn = spring({
    frame: frame - appearAt,
    fps,
    config: { damping: 16 },
    durationInFrames: 24,
  });
  const value = Math.round(
    interpolate(frame, [appearAt + 4, appearAt + 36], [0, suggested], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }),
  );
  const confFill = interpolate(
    frame,
    [appearAt + 10, appearAt + 46],
    [0, confidence / 100],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    },
  );

  const focused = edit !== undefined && frame >= edit.focusAt;
  const selected =
    edit !== undefined && frame >= edit.focusAt && frame < edit.typeStart;
  let display = `$${value}`;
  let caret = false;
  if (edit && frame >= edit.typeStart) {
    const n = typeProgress(edit.typedValue, frame, edit.typeStart, edit.typeDuration);
    display = `$${edit.typedValue.slice(0, n)}`;
    caret = frame <= edit.typeStart + edit.typeDuration + 20;
  }
  const overrideNote = edit !== undefined && frame >= edit.noteAt;

  return (
    <div
      style={{
        position: "absolute",
        left: PRICE_MODULE.x,
        top: PRICE_MODULE.y,
        width: PRICE_MODULE.w,
        height: PRICE_MODULE.h,
        borderRadius: 12,
        background: SLAB,
        border: `1px solid ${LINE}`,
        padding: "16px 18px",
        opacity: moduleIn,
        transform: `translateY(${(1 - moduleIn) * 16}px)`,
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
          SUGGESTED PRICE
        </span>
        <span style={{ fontSize: 11.5, color: FAINT }}>
          {comps} · range ${rangeLow}–${rangeHigh}
        </span>
      </div>

      {/* price input — geometry comes from PRICE_INPUT so the Act 3 cursor lands on it */}
      <div
        style={{
          position: "absolute",
          left: PRICE_INPUT.x - PRICE_MODULE.x,
          top: PRICE_INPUT.y - PRICE_MODULE.y,
          width: PRICE_INPUT.w,
          height: PRICE_INPUT.h,
          borderRadius: 10,
          border: `1px solid ${focused ? "rgba(0,128,96,0.55)" : LINE}`,
          boxShadow: focused ? "0 0 0 3px rgba(0,128,96,0.12)" : undefined,
          background: SURFACE,
          display: "flex",
          alignItems: "center",
          padding: "0 13px",
          boxSizing: "border-box",
        }}
      >
        <span
          style={{
            fontSize: 24,
            fontWeight: 800,
            color: INK,
            fontVariantNumeric: "tabular-nums",
            background: selected ? "rgba(0,128,96,0.22)" : "transparent",
            borderRadius: 3,
          }}
        >
          {display}
        </span>
        <Caret visible={caret} height={22} />
      </div>
      {overrideNote ? (
        <div
          style={{
            position: "absolute",
            left: PRICE_INPUT.x - PRICE_MODULE.x,
            top: PRICE_INPUT.y - PRICE_MODULE.y + PRICE_INPUT.h + 7,
            fontSize: 10.5,
            fontWeight: 700,
            color: VIOLET,
          }}
        >
          seller override
        </div>
      ) : null}

      {/* confidence */}
      <div style={{ position: "absolute", right: 18, top: 48, width: 230 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
            CONFIDENCE
          </span>
          <span
            style={{
              fontSize: 17,
              fontWeight: 800,
              color: INK,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {Math.round(confFill * 100)}%
          </span>
        </div>
        <div
          style={{
            marginTop: 7,
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
              width: `${confFill * 100}%`,
              background: "linear-gradient(90deg, #006e52, #008060)",
            }}
          />
        </div>
        <div style={{ marginTop: 9, display: "flex", justifyContent: "flex-end" }}>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              color: VIOLET,
              background: "rgba(0,128,96,0.1)",
              borderRadius: 99,
              padding: "3px 10px",
            }}
          >
            {tier}
          </span>
        </div>
      </div>

      {/* range bar */}
      <div
        style={{
          position: "absolute",
          left: 18,
          right: 18,
          bottom: 18,
        }}
      >
        <div
          style={{
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
              width: `${confFill * 88}%`,
              background: "linear-gradient(90deg, rgba(0,128,96,0.35), #008060)",
            }}
          />
        </div>
        <div
          style={{
            marginTop: 5,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10.5,
            color: FAINT,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span>${rangeLow}</span>
          <span>${rangeHigh}</span>
        </div>
      </div>
    </div>
  );
}

/* ================= publish CTA ================= */

export function PublishArea({
  appearAt,
  pressFrame,
  liveAt,
  listingId,
  idAt,
  autopilot,
  postingFrom,
}: {
  appearAt: number;
  /** frame of the cursor click (omit for autopilot) */
  pressFrame?: number;
  liveAt: number;
  listingId: string;
  idAt: number;
  /** autopilot chip frame (Act 2) */
  autopilot?: { at: number; label: string };
  /** button shows a "Posting…" state from this frame until liveAt */
  postingFrom?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const appear = spring({
    frame: frame - appearAt,
    fps,
    config: { damping: 16 },
    durationInFrames: 22,
  });
  const pressed = pressFrame !== undefined ? pressAt(frame, pressFrame) : 0;
  const liveIn = spring({
    frame: frame - liveAt,
    fps,
    config: { damping: 10, stiffness: 170 },
    durationInFrames: 26,
  });
  const posting =
    postingFrom !== undefined && frame >= postingFrom && frame < liveAt;

  return (
    <>
      {autopilot && frame >= autopilot.at ? (
        <div
          style={{
            position: "absolute",
            left: PUBLISH_BTN.x,
            top: PUBLISH_BTN.y - 32,
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "rgba(0,128,96,0.1)",
            border: "1px solid rgba(0,128,96,0.3)",
            borderRadius: 99,
            padding: "4px 11px",
            opacity: spring({
              frame: frame - autopilot.at,
              fps,
              config: { damping: 13 },
              durationInFrames: 20,
            }),
          }}
        >
          <svg viewBox="0 0 24 24" width="11" fill={VIOLET}>
            <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
          </svg>
          <span style={{ fontSize: 11, fontWeight: 700, color: VIOLET }}>
            {autopilot.label}
          </span>
        </div>
      ) : null}

      <div
        style={{
          position: "absolute",
          left: PUBLISH_BTN.x,
          top: PUBLISH_BTN.y,
          width: PUBLISH_BTN.w,
          height: PUBLISH_BTN.h,
          opacity: frame < liveAt ? appear : 1,
        }}
      >
        {frame < liveAt ? (
          <div
            style={{
              width: "100%",
              height: "100%",
              background: VIOLET,
              color: "white",
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 9,
              fontSize: 14.5,
              fontWeight: 700,
              transform: `scale(${1 - pressed * 0.04})`,
              boxShadow: `0 ${8 - pressed * 6}px ${20 - pressed * 12}px -8px rgba(0,128,96,0.55)`,
              boxSizing: "border-box",
            }}
          >
            {posting ? (
              <>
                <div
                  style={{
                    width: 13,
                    height: 13,
                    borderRadius: 99,
                    border: "2px solid rgba(255,255,255,0.35)",
                    borderTopColor: "white",
                    transform: `rotate(${frame * 14}deg)`,
                  }}
                />
                Posting to eBay…
              </>
            ) : (
              "Publish to eBay"
            )}
          </div>
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              background: "rgba(22,163,74,0.1)",
              border: "1px solid rgba(22,163,74,0.35)",
              color: GREEN,
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 9,
              fontSize: 14.5,
              fontWeight: 800,
              transform: `scale(${0.92 + liveIn * 0.08})`,
              opacity: liveIn,
              boxSizing: "border-box",
            }}
          >
            <span style={{ position: "relative", width: 9, height: 9 }}>
              <span
                style={{ position: "absolute", inset: 0, borderRadius: 99, background: GREEN }}
              />
              <span
                style={{
                  position: "absolute",
                  inset: -4,
                  borderRadius: 99,
                  border: `2px solid rgba(22,163,74,${Math.max(0, 0.5 - ((frame - liveAt) % 40) / 80)})`,
                  transform: `scale(${1 + ((frame - liveAt) % 40) / 28})`,
                }}
              />
            </span>
            Live on eBay
          </div>
        )}
      </div>

      {frame >= idAt ? (
        <div
          style={{
            position: "absolute",
            left: PUBLISH_BTN.x,
            top: PUBLISH_BTN.y + PUBLISH_BTN.h + 12,
            width: PUBLISH_BTN.w,
            textAlign: "center",
            fontSize: 11.5,
            fontWeight: 600,
            color: FAINT,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {listingId}
        </div>
      ) : null}
    </>
  );
}
