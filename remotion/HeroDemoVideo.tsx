import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";

/**
 * Hero demo video v2 (issue #49 round 4) — a realistic recording of the
 * SnapList app: an animated cursor uploads a real photo (Canon EOS 80D,
 * Unsplash), the pipeline analyzes it, prices it with sources, and publishes
 * it to eBay. Prism-light styling matches the live app tokens exactly.
 * Render: `npx remotion render remotion/index.ts hero-demo public/hero-demo.mp4`
 */

const INK = "#131e3a";
const DIM = "#3d4a68";
const FAINT = "#5f6b88";
const LINE = "#dfe4ee";
const SLAB = "#f4f6fb";
const VIOLET = "#6d4aff";
const GREEN = "#16a34a";

const font =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

const CHIPS = ["Canon EOS 80D", "DSLR camera", "Good condition", "EF-S lens"];

/** macOS-style cursor */
function Cursor({ x, y, press }: { x: number; y: number; press: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        zIndex: 50,
        transform: `scale(${1 - press * 0.18})`,
        transformOrigin: "6px 4px",
        filter: "drop-shadow(0 2px 4px rgba(19,30,58,0.35))",
      }}
    >
      <svg width="22" height="26" viewBox="0 0 22 26">
        <path
          d="M3 2 L3 20 L7.6 16 L10.4 23 L13.6 21.6 L10.8 14.8 L17 14.4 Z"
          fill="white"
          stroke={INK}
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      {/* click ripple */}
      {press > 0.05 ? (
        <div
          style={{
            position: "absolute",
            left: -9,
            top: -11,
            width: 40,
            height: 40,
            borderRadius: 99,
            border: `2px solid rgba(109,74,255,${0.55 * (1 - press)})`,
            transform: `scale(${0.5 + press * 1.1})`,
          }}
        />
      ) : null}
    </div>
  );
}

function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size}>
      <defs>
        <linearGradient id="lg" x1="6" y1="4" x2="44" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7a73ff" />
          <stop offset="0.55" stopColor="#6d4aff" />
          <stop offset="1" stopColor="#a960ee" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#lg)" />
      <g stroke="#fff" strokeWidth="3.2" strokeLinecap="round" fill="none">
        <circle cx="24" cy="24" r="14.5" opacity="0.4" />
        <path d="M26.9 18.4 30.8 31" />
        <path d="M19.7 18.4h14.4" />
        <path d="m17.1 24 4.5-12.1" />
        <path d="M21.1 29.6 14.9 15.9" />
        <path d="M28.3 29.6H12.4" />
        <path d="m30.9 24-5.1 13.9" />
      </g>
      <circle cx="24" cy="24" r="2.1" fill="#fff" />
    </svg>
  );
}

/** piecewise-linear motion through waypoints, eased per segment */
function path(
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
function pressAt(frame: number, at: number): number {
  return interpolate(frame, [at - 2, at + 2, at + 9], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

export const HeroDemoVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // ---------- choreography (30fps) ----------
  const CLICK_UPLOAD = 55; // click "Add photos"
  const PHOTO_IN = 64; // photo lands
  const ANALYZE = 100; // scan starts (auto)
  const CHIPS_AT = 150; // chips cascade
  const PRICE_AT = 195; // price counts
  const CLICK_PUBLISH = 300; // click publish
  const LIVE_AT = 316; // success state

  const cursor = path(frame, [
    [16, 760, 700],
    [CLICK_UPLOAD - 6, 248, 386],
    [CLICK_UPLOAD + 18, 248, 386],
    [90, 560, 560],
    [240, 560, 560],
    [CLICK_PUBLISH - 8, 866, 636],
    [CLICK_PUBLISH + 20, 866, 636],
    [350, 920, 730],
  ]);
  const press = pressAt(frame, CLICK_UPLOAD) + pressAt(frame, CLICK_PUBLISH);

  const photoIn = spring({
    frame: frame - PHOTO_IN,
    fps,
    config: { damping: 16, stiffness: 120 },
    durationInFrames: 28,
  });
  const scanT = interpolate(frame, [ANALYZE, ANALYZE + 42], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.ease),
  });
  const scanVisible = frame >= ANALYZE && frame <= ANALYZE + 46;
  const priceVal = Math.round(
    interpolate(frame, [PRICE_AT, PRICE_AT + 40], [0, 589], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }),
  );
  const priceIn = spring({
    frame: frame - PRICE_AT + 6,
    fps,
    config: { damping: 16 },
    durationInFrames: 26,
  });
  const rangeFill = interpolate(frame, [PRICE_AT + 8, PRICE_AT + 46], [0, 0.68], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const publishPressed = interpolate(
    frame,
    [CLICK_PUBLISH - 1, CLICK_PUBLISH + 3, CLICK_PUBLISH + 10],
    [0, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const liveIn = spring({
    frame: frame - LIVE_AT,
    fps,
    config: { damping: 10, stiffness: 170 },
    durationInFrames: 26,
  });
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 16, durationInFrames - 2],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const chipSprings = CHIPS.map((_, i) =>
    spring({
      frame: frame - (CHIPS_AT + i * 7),
      fps,
      config: { damping: 13, stiffness: 150 },
      durationInFrames: 26,
    }),
  );

  const analyzing = frame >= ANALYZE - 6 && frame < CHIPS_AT;

  return (
    <AbsoluteFill style={{ backgroundColor: SLAB, fontFamily: font, opacity: fadeOut }}>
      {/* ---------- app window ---------- */}
      <div
        style={{
          position: "absolute",
          inset: 28,
          background: "white",
          borderRadius: 16,
          border: `1px solid ${LINE}`,
          boxShadow: "0 18px 40px -12px rgba(19,30,58,0.18)",
          overflow: "hidden",
        }}
      >
        {/* top bar */}
        <div
          style={{
            height: 58,
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
                    background: i === 1 ? "rgba(109,74,255,0.1)" : "transparent",
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
              background: `linear-gradient(135deg, #7a73ff, #a960ee)`,
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

        {/* content: two columns */}
        <div style={{ display: "flex", gap: 22, padding: 22, height: "calc(100% - 58px)" }}>
          {/* left — photos */}
          <div style={{ width: 440 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: INK }}>New listing</div>
            <div style={{ fontSize: 12.5, color: FAINT, marginTop: 3 }}>
              Add 1–4 photos — we do the rest
            </div>

            {/* dropzone / photo */}
            <div
              style={{
                marginTop: 16,
                height: 296,
                borderRadius: 14,
                border: photoIn > 0.05 ? `1px solid ${LINE}` : `2px dashed ${LINE}`,
                background: photoIn > 0.05 ? "white" : SLAB,
                overflow: "hidden",
                position: "relative",
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
                      background: "rgba(109,74,255,0.1)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      margin: "0 auto",
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="22" fill="none" stroke={VIOLET} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                    src={staticFile("demo/camera.jpg")}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      transform: `scale(${1.06 - photoIn * 0.06})`,
                      opacity: photoIn,
                    }}
                  />
                  {/* scan shimmer */}
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
                          "linear-gradient(180deg, transparent, rgba(109,74,255,0.22), rgba(255,255,255,0.32), rgba(109,74,255,0.22), transparent)",
                      }}
                    />
                  ) : null}
                  {/* viewfinder corners during analysis */}
                  {analyzing
                    ? [
                        { left: 10, top: 10, bl: false, bt: true, ll: true, lr: false },
                        { right: 10, top: 10, bl: false, bt: true, ll: false, lr: true },
                        { left: 10, bottom: 10, bl: true, bt: false, ll: true, lr: false },
                        { right: 10, bottom: 10, bl: true, bt: false, ll: false, lr: true },
                      ].map((c, i) => (
                        <div
                          key={i}
                          style={{
                            position: "absolute",
                            width: 22,
                            height: 22,
                            left: c.left,
                            right: c.right,
                            top: c.top,
                            bottom: c.bottom,
                            borderTop: c.bt ? "3px solid white" : undefined,
                            borderBottom: c.bl ? "3px solid white" : undefined,
                            borderLeft: c.ll ? "3px solid white" : undefined,
                            borderRight: c.lr ? "3px solid white" : undefined,
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
                    IMG_4032.jpg
                  </div>
                </>
              )}
            </div>

            {/* analyzing pill */}
            <div style={{ marginTop: 12, height: 34 }}>
              {analyzing ? (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    background: "rgba(109,74,255,0.1)",
                    borderRadius: 99,
                    padding: "7px 14px",
                  }}
                >
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 99,
                      border: `2px solid rgba(109,74,255,0.25)`,
                      borderTopColor: VIOLET,
                      transform: `rotate(${frame * 14}deg)`,
                    }}
                  />
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: VIOLET }}>
                    Identifying your item…
                  </span>
                </div>
              ) : frame >= CHIPS_AT ? (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    background: "rgba(22,163,74,0.1)",
                    borderRadius: 99,
                    padding: "7px 14px",
                  }}
                >
                  <svg viewBox="0 0 24 24" width="13" fill="none" stroke={GREEN} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: GREEN }}>
                    Identified with 92% confidence
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {/* right — details panel */}
          <div
            style={{
              flex: 1,
              borderRadius: 14,
              border: `1px solid ${LINE}`,
              background: "white",
              padding: 20,
              position: "relative",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
              ITEM DETAILS
            </div>

            {/* chips */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12, minHeight: 70 }}>
              {CHIPS.map((chip, i) => (
                <div
                  key={chip}
                  style={{
                    opacity: chipSprings[i],
                    transform: `translateY(${(1 - chipSprings[i]) * 10}px) scale(${0.8 + chipSprings[i] * 0.2})`,
                    border: "1px solid rgba(109,74,255,0.3)",
                    background: "rgba(109,74,255,0.08)",
                    color: VIOLET,
                    borderRadius: 99,
                    padding: "7px 13px",
                    fontSize: 12.5,
                    fontWeight: 600,
                    height: "fit-content",
                  }}
                >
                  {chip}
                </div>
              ))}
            </div>

            {/* price block */}
            <div
              style={{
                marginTop: 10,
                borderRadius: 12,
                background: SLAB,
                border: `1px solid ${LINE}`,
                padding: 16,
                opacity: priceIn,
                transform: `translateY(${(1 - priceIn) * 16}px)`,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, color: FAINT }}>
                    SUGGESTED PRICE
                  </div>
                  <div style={{ fontSize: 30, fontWeight: 800, color: INK, fontVariantNumeric: "tabular-nums" }}>
                    ${priceVal}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div
                    style={{
                      display: "inline-block",
                      background: "rgba(109,74,255,0.12)",
                      color: VIOLET,
                      borderRadius: 99,
                      padding: "4px 10px",
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  >
                    6 sources cited
                  </div>
                  <div style={{ fontSize: 11.5, color: FAINT, marginTop: 5 }}>range $520–$680</div>
                </div>
              </div>
              <div style={{ marginTop: 10, height: 6, borderRadius: 99, background: "white", overflow: "hidden", border: `1px solid ${LINE}` }}>
                <div
                  style={{
                    height: "100%",
                    width: `${rangeFill * 100}%`,
                    background: `linear-gradient(90deg, #5a36f0, ${VIOLET})`,
                  }}
                />
              </div>
              {/* sources */}
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                {[
                  ["eBay sold — EOS 80D body + lens", "$575"],
                  ["MPB used, good condition", "$604"],
                  ["KEH grade EX", "$612"],
                ].map(([s, p], i) => {
                  const o = interpolate(frame, [PRICE_AT + 16 + i * 6, PRICE_AT + 30 + i * 6], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  });
                  return (
                    <div
                      key={s}
                      style={{
                        opacity: o,
                        display: "flex",
                        justifyContent: "space-between",
                        background: "white",
                        border: `1px solid ${LINE}`,
                        borderRadius: 8,
                        padding: "7px 11px",
                        fontSize: 11.5,
                      }}
                    >
                      <span style={{ color: DIM }}>{s}</span>
                      <span style={{ color: INK, fontWeight: 700 }}>{p}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* publish button / live state */}
            <div style={{ position: "absolute", left: 20, right: 20, bottom: 18 }}>
              {frame < LIVE_AT ? (
                <div
                  style={{
                    background: VIOLET,
                    opacity: priceIn,
                    color: "white",
                    borderRadius: 12,
                    padding: "13px 0",
                    textAlign: "center",
                    fontSize: 14.5,
                    fontWeight: 700,
                    transform: `scale(${1 - publishPressed * 0.04})`,
                    boxShadow: `0 ${8 - publishPressed * 6}px ${20 - publishPressed * 12}px -8px rgba(109,74,255,0.55)`,
                  }}
                >
                  Publish to eBay
                </div>
              ) : (
                <div
                  style={{
                    background: "rgba(22,163,74,0.1)",
                    border: "1px solid rgba(22,163,74,0.35)",
                    color: GREEN,
                    borderRadius: 12,
                    padding: "13px 0",
                    textAlign: "center",
                    fontSize: 14.5,
                    fontWeight: 800,
                    transform: `scale(${0.92 + liveIn * 0.08})`,
                    opacity: liveIn,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 9,
                  }}
                >
                  <span style={{ position: "relative", width: 9, height: 9 }}>
                    <span
                      style={{
                        position: "absolute",
                        inset: 0,
                        borderRadius: 99,
                        background: GREEN,
                      }}
                    />
                    <span
                      style={{
                        position: "absolute",
                        inset: -4,
                        borderRadius: 99,
                        border: `2px solid rgba(22,163,74,${Math.max(0, 0.5 - ((frame - LIVE_AT) % 40) / 80)})`,
                        transform: `scale(${1 + ((frame - LIVE_AT) % 40) / 28})`,
                      }}
                    />
                  </span>
                  Live on eBay — view listing
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <Cursor x={cursor.x} y={cursor.y} press={Math.min(1, press)} />
    </AbsoluteFill>
  );
};
