import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import {
  Caret,
  CheckIcon,
  LogoMark,
  Spinner,
  typeProgress,
  type FeedEvent,
} from "../hero/primitives";
import {
  DIM,
  FAINT,
  GREEN,
  GREEN_SOFT,
  INK,
  LINE,
  LOGICAL_H,
  LOGICAL_W,
  SCALE,
  SLAB,
  TOPBAR_H,
  VIOLET,
  VIOLET_BORDER,
  VIOLET_SOFT,
  WIN,
  font,
  type Rect,
} from "./theme";

export { type FeedEvent };

/* ================= scene scale wrapper ================= */

/**
 * 1920x1080 composition root: paints the backdrop and scales the 1280x720
 * logical canvas by 1.5. Uniform scaling keeps every cursor/click assertion
 * valid in logical coordinates.
 */
export function Scene({ children }: { children: React.ReactNode }) {
  return (
    <AbsoluteFill style={{ background: SLAB, fontFamily: font }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: LOGICAL_W,
          height: LOGICAL_H,
          transform: `scale(${SCALE})`,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
}

/* ================= app chrome ================= */

const NAV = ["Listings", "New listing", "Inbox", "Settings"];

/** white app window + top bar on the logical grid */
export function Shell({
  win = WIN,
  active = 1,
  badge,
  children,
}: {
  win?: Rect;
  active?: number;
  /** small step-identity pill in the top bar (keeps the clip set consistent) */
  badge?: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: win.x,
          top: win.y,
          width: win.w,
          height: win.h,
          background: "white",
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
            <div style={{ display: "flex", gap: 4, marginLeft: 20 }}>
              {NAV.map((t, i) => (
                <span
                  key={t}
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    padding: "7px 13px",
                    borderRadius: 99,
                    color: i === active ? VIOLET : FAINT,
                    background: i === active ? VIOLET_SOFT : "transparent",
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {badge ? (
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 800,
                  letterSpacing: 1.1,
                  color: VIOLET,
                  background: VIOLET_SOFT,
                  border: `1px solid ${VIOLET_BORDER}`,
                  borderRadius: 99,
                  padding: "4px 11px",
                }}
              >
                {badge}
              </span>
            ) : null}
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 99,
                background: "linear-gradient(135deg, #7a73ff, #635bff)",
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
      </div>
      {children}
    </>
  );
}

/** plain white card on the grid */
export function Panel({
  rect,
  children,
  style,
}: {
  rect: Rect;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: "white",
        boxSizing: "border-box",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function SectionLabel({
  x,
  y,
  text,
  color = FAINT,
}: {
  x: number;
  y: number;
  text: string;
  color?: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        fontSize: 10.5,
        fontWeight: 800,
        letterSpacing: 1.2,
        color,
      }}
    >
      {text}
    </div>
  );
}

/* ================= agent activity feed (rect-parameterized) ================= */

export function Feed({
  rect,
  events,
  agent,
  title = "AGENT ACTIVITY",
}: {
  rect: Rect;
  events: FeedEvent[];
  agent: string;
  title?: string;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Panel rect={rect} style={{ padding: "13px 16px", overflow: "hidden" }}>
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
          {title}
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
            <div key={i} style={{ opacity: enter, transform: `translateY(${(1 - enter) * 8}px)` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {running ? <Spinner deg={frame * 14} /> : <CheckIcon />}
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: VIOLET,
                    background: "rgba(99,91,255,0.08)",
                    border: `1px solid ${VIOLET_BORDER}`,
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
    </Panel>
  );
}

/* ================= photo frame with scan ================= */

/**
 * Rect-parameterized photo panel: dashed dropzone before `photoIn`, then the
 * photo with a scan sweep between scanStart/scanEnd plus corner brackets.
 * Children render over the photo (OCR boxes etc.).
 */
export function PhotoFrame({
  rect,
  src,
  fileName,
  photoIn,
  scanStart,
  scanEnd,
  objectPosition = "50% 50%",
  emptyLabel = "Add photos",
  emptySub = "drag & drop or click to browse",
  children,
}: {
  rect: Rect;
  src: string;
  fileName?: string;
  photoIn: number;
  scanStart?: number;
  scanEnd?: number;
  objectPosition?: string;
  emptyLabel?: string;
  emptySub?: string;
  children?: React.ReactNode;
}) {
  const frame = useCurrentFrame();
  const hasScan = scanStart !== undefined && scanEnd !== undefined;
  const scanT = hasScan
    ? interpolate(frame, [scanStart, scanEnd], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.inOut(Easing.ease),
      })
    : 0;
  const scanVisible = hasScan && frame >= scanStart && frame <= scanEnd + 4;
  const analyzing = hasScan && frame >= scanStart - 4 && frame <= scanEnd + 4;

  return (
    <div
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        borderRadius: 14,
        border: photoIn > 0.05 ? `1px solid ${LINE}` : `2px dashed ${LINE}`,
        background: photoIn > 0.05 ? "white" : SLAB,
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
              background: VIOLET_SOFT,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto",
            }}
          >
            <CameraIcon />
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: INK, marginTop: 10 }}>
            {emptyLabel}
          </div>
          <div style={{ fontSize: 11.5, color: FAINT, marginTop: 3 }}>{emptySub}</div>
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
                  "linear-gradient(180deg, transparent, rgba(99,91,255,0.22), rgba(255,255,255,0.32), rgba(99,91,255,0.22), transparent)",
              }}
            />
          ) : null}
          {analyzing ? <CornerBrackets /> : null}
          {fileName ? (
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
          ) : null}
          {children}
        </>
      )}
    </div>
  );
}

export function CameraIcon({ size = 22, color = VIOLET }: { size?: number; color?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

function CornerBrackets() {
  const corners = [
    { left: 10, top: 10, b: "t l" },
    { right: 10, top: 10, b: "t r" },
    { left: 10, bottom: 10, b: "b l" },
    { right: 10, bottom: 10, b: "b r" },
  ] as Array<Record<string, number | string>>;
  return (
    <>
      {corners.map((c, i) => (
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
      ))}
    </>
  );
}

/**
 * OCR / detection box drawn over the photo (coords are local to the photo
 * frame). Springs in at `at`; the label callout sits below the box.
 */
export function OcrBox({
  at,
  box,
  label,
  labelSide = "below",
}: {
  at: number;
  box: Rect;
  label: string;
  labelSide?: "below" | "above";
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at) return null;
  const s = spring({
    frame: frame - at,
    fps,
    config: { damping: 12, stiffness: 160 },
    durationInFrames: 20,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        opacity: s,
        transform: `scale(${0.85 + s * 0.15})`,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          border: "2px solid #4ade80",
          borderRadius: 6,
          boxShadow: "0 0 0 2px rgba(74,222,128,0.25), 0 2px 10px rgba(0,0,0,0.35)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: labelSide === "below" ? "100%" : undefined,
          bottom: labelSide === "above" ? "100%" : undefined,
          transform: `translate(-50%, ${labelSide === "below" ? "7px" : "-7px"})`,
          background: "rgba(19,30,58,0.85)",
          color: "#4ade80",
          borderRadius: 7,
          padding: "3.5px 9px",
          fontSize: 10.5,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
    </div>
  );
}

/* ================= structured attribute field ================= */

/**
 * One extracted attribute card: label, value fading/typing in at `at`, and a
 * confidence chip that counts up. The vision-showcase workhorse.
 */
export function AttrField({
  rect,
  label,
  value,
  conf,
  at,
}: {
  rect: Rect;
  label: string;
  value: string;
  conf?: number;
  at: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame: frame - at,
    fps,
    config: { damping: 14, stiffness: 140 },
    durationInFrames: 22,
  });
  const n = typeProgress(value, frame, at + 6, 14);
  const confShown = conf !== undefined && frame >= at + 14;
  const confValue =
    conf !== undefined
      ? interpolate(frame, [at + 14, at + 34], [Math.max(0, conf - 0.25), conf], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        })
      : 0;
  if (frame < at - 4) {
    // ghost slot before the field exists
    return (
      <div
        style={{
          position: "absolute",
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          borderRadius: 10,
          border: `1.5px dashed ${LINE}`,
          boxSizing: "border-box",
        }}
      />
    );
  }
  return (
    <div
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        borderRadius: 10,
        border: `1px solid ${enter < 0.7 ? VIOLET_BORDER : LINE}`,
        background: SLAB,
        padding: "8px 12px",
        boxSizing: "border-box",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 8}px)`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 1.1, color: FAINT }}>
          {label}
        </span>
        {confShown ? (
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 800,
              color: confValue >= 0.9 ? GREEN : VIOLET,
              background: confValue >= 0.9 ? GREEN_SOFT : VIOLET_SOFT,
              borderRadius: 99,
              padding: "1.5px 7px",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {confValue.toFixed(2)}
          </span>
        ) : null}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 13.5,
          fontWeight: 700,
          color: INK,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {value.slice(0, n)}
        <Caret visible={frame >= at + 6 && n < value.length} height={13} />
      </div>
    </div>
  );
}

/* ================= chips / pills / toasts ================= */

export function Chip({
  text,
  at,
  index = 0,
  tone = "violet",
}: {
  text: string;
  at: number;
  index?: number;
  tone?: "violet" | "green" | "plain";
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({
    frame: frame - (at + index * 6),
    fps,
    config: { damping: 13, stiffness: 150 },
    durationInFrames: 24,
  });
  const palette =
    tone === "green"
      ? { color: GREEN, background: GREEN_SOFT, border: "1px solid rgba(22,163,74,0.3)" }
      : tone === "plain"
        ? { color: DIM, background: SLAB, border: `1px solid ${LINE}` }
        : { color: VIOLET, background: "rgba(99,91,255,0.08)", border: `1px solid ${VIOLET_BORDER}` };
  return (
    <div
      style={{
        opacity: s,
        transform: `translateY(${(1 - s) * 10}px) scale(${0.8 + s * 0.2})`,
        borderRadius: 99,
        padding: "5px 11px",
        fontSize: 11.5,
        fontWeight: 600,
        whiteSpace: "nowrap",
        ...palette,
      }}
    >
      {text}
    </div>
  );
}

/** analyzing → done status pill */
export function StatusLine({
  x,
  y,
  startAt,
  doneAt,
  busyText,
  doneText,
}: {
  x: number;
  y: number;
  startAt: number;
  doneAt: number;
  busyText: string;
  doneText: string;
}) {
  const frame = useCurrentFrame();
  if (frame < startAt) return null;
  const busy = frame < doneAt;
  return (
    <div style={{ position: "absolute", left: x, top: y }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          background: busy ? VIOLET_SOFT : GREEN_SOFT,
          borderRadius: 99,
          padding: "7px 14px",
        }}
      >
        {busy ? <Spinner deg={frame * 14} /> : <CheckIcon />}
        <span style={{ fontSize: 12.5, fontWeight: 700, color: busy ? VIOLET : GREEN }}>
          {busy ? busyText : doneText}
        </span>
      </div>
    </div>
  );
}

/** transient toast (slides up, holds, fades) */
export function Toast({
  x,
  y,
  at,
  hold = 60,
  icon = "check",
  text,
}: {
  x: number;
  y: number;
  at: number;
  hold?: number;
  icon?: "check" | "phone";
  text: string;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at || frame > at + hold + 14) return null;
  const enter = spring({
    frame: frame - at,
    fps,
    config: { damping: 13, stiffness: 160 },
    durationInFrames: 20,
  });
  const exit = interpolate(frame, [at + hold, at + hold + 12], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "white",
        border: `1px solid ${LINE}`,
        borderRadius: 12,
        padding: "9px 14px",
        boxShadow: "0 10px 26px -10px rgba(19,30,58,0.25)",
        opacity: Math.min(enter, exit),
        transform: `translateY(${(1 - enter) * 12}px)`,
      }}
    >
      {icon === "phone" ? (
        <svg viewBox="0 0 24 24" width={14} fill="none" stroke={VIOLET} strokeWidth="2">
          <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
          <path d="M11 18.5h2" strokeLinecap="round" />
        </svg>
      ) : (
        <CheckIcon />
      )}
      <span style={{ fontSize: 12, fontWeight: 700, color: INK }}>{text}</span>
    </div>
  );
}

/* ================= buttons ================= */

/**
 * Primary CTA bound to a rect (the click target). `pressFrame` drives the
 * press squash via the same constant asserted by assert-clicks.ts.
 */
export function PrimaryButton({
  rect,
  label,
  appearAt = 0,
  pressFrame,
  pressed,
  busyFrom,
  busyLabel,
  doneFrom,
  doneLabel,
}: {
  rect: Rect;
  label: string;
  appearAt?: number;
  pressFrame?: number;
  /** externally computed press amount 0..1 (falls back to pressFrame pulse) */
  pressed?: number;
  busyFrom?: number;
  busyLabel?: string;
  doneFrom?: number;
  doneLabel?: string;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const appear = spring({
    frame: frame - appearAt,
    fps,
    config: { damping: 16 },
    durationInFrames: 22,
  });
  const press =
    pressed ??
    (pressFrame !== undefined
      ? interpolate(frame, [pressFrame - 2, pressFrame + 2, pressFrame + 9], [0, 1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0);
  const done = doneFrom !== undefined && frame >= doneFrom;
  const busy = !done && busyFrom !== undefined && frame >= busyFrom;
  const doneIn = spring({
    frame: frame - (doneFrom ?? 0),
    fps,
    config: { damping: 10, stiffness: 170 },
    durationInFrames: 26,
  });

  return (
    <div
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        opacity: done ? 1 : appear,
      }}
    >
      {done ? (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: GREEN_SOFT,
            border: "1px solid rgba(22,163,74,0.35)",
            color: GREEN,
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            fontSize: 13.5,
            fontWeight: 800,
            transform: `scale(${0.92 + doneIn * 0.08})`,
            opacity: doneIn,
            boxSizing: "border-box",
          }}
        >
          <LivePulse since={doneFrom ?? 0} />
          {doneLabel ?? label}
        </div>
      ) : (
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
            fontSize: 13.5,
            fontWeight: 700,
            transform: `scale(${1 - press * 0.04})`,
            boxShadow: `0 ${8 - press * 6}px ${20 - press * 12}px -8px rgba(99,91,255,0.55)`,
            boxSizing: "border-box",
          }}
        >
          {busy ? (
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
              {busyLabel ?? label}
            </>
          ) : (
            label
          )}
        </div>
      )}
    </div>
  );
}

export function LivePulse({ since }: { since: number }) {
  const frame = useCurrentFrame();
  return (
    <span style={{ position: "relative", width: 9, height: 9, flexShrink: 0 }}>
      <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: GREEN }} />
      <span
        style={{
          position: "absolute",
          inset: -4,
          borderRadius: 99,
          border: `2px solid rgba(22,163,74,${Math.max(0, 0.5 - ((frame - since) % 40) / 80)})`,
          transform: `scale(${1 + ((frame - since) % 40) / 28})`,
        }}
      />
    </span>
  );
}

/* ================= token streaming ================= */

const tokenPseudo = (i: number): number => {
  const v = Math.sin((i + 1) * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * Word-chunk streaming (LLM token feel): returns how many characters of
 * `text` are visible at `frame`, revealing whole words with a jittery
 * cadence, finishing exactly at `start + duration`.
 */
export function streamProgress(
  text: string,
  frame: number,
  start: number,
  duration: number,
): number {
  if (frame < start) return 0;
  const words = text.split(/(?<=\s)/);
  const times: number[] = [];
  let t = 0;
  for (let i = 0; i < words.length; i++) {
    t += 0.6 + tokenPseudo(i) * 1.6 + (words[i].length > 8 ? 0.5 : 0);
    times.push(t);
  }
  const scale = duration / t;
  const elapsed = frame - start;
  let chars = 0;
  for (let i = 0; i < words.length; i++) {
    if (elapsed >= times[i] * scale) chars += words[i].length;
    else break;
  }
  return Math.min(chars, text.length);
}
