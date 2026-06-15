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
import {
  FAINT,
  GREEN,
  INK,
  LINE,
  SLAB,
  SURFACE,
  VIOLET,
  VIOLET_SOFT,
  center,
  type Rect,
} from "../theme";
import { M_LOGICAL_W, MobileScene } from "./StepSnapMobile";

/**
 * Step 6 · Answer / Buyer Q&A (portrait mobile) — the trust story. A buyer
 * question lands, SnapList drafts a reply from the item's real details and
 * STOPS before the shutter-timing claim (a hands-on check no photo verifies);
 * the seller fills that part in, then approves & sends. Same copy + honest
 * grounding as the desktop BuyerQA (Acer Predator). See
 * [[snaplist-honest-grounded-copy]] and [[snaplist-mobile-polish-pr70]].
 *
 * Render:
 *   npx remotion render remotion/index.ts buyer-qa-mobile public/demo/buyer-qa-mobile.mp4 --crf 26 --muted
 *   ... buyer-qa-mobile-dark.mp4 ... --props '{"theme":"dark"}'
 */

export const ANSWER_MOBILE_LEN = 400;
const SEAM = 16;
const PAD = 28;
const INNER = M_LOGICAL_W - PAD * 2;

const BUYER_MSG = "Hi! Does it come with the charger, and how's the battery life?";
const DRAFT_TEXT =
  "The photos show it powering on with the RGB keyboard lit, and cosmetically it's in good shape with light wear. It's the Core i7 / RTX / 144Hz Helios 300. On the charger and how long the battery lasts:";
const EDIT_TEXT = " Yes, the original charger is included, and it holds about 4–5 hours on lighter use.";

const BUYER_AT = 20;
const DRAFT_AT = 80;
const EDIT_AT = 176;
const SEND: Rect = { x: PAD, y: 540, w: INNER, h: 66 };
const TAP_SEND = 270;
const SENT_AT = 300;

function AnswerMobileAct() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const buyerIn = spring({ frame: frame - BUYER_AT, fps, config: { damping: 16, stiffness: 160 }, durationInFrames: 18 });
  const drafting = frame >= DRAFT_AT - 30 && frame < DRAFT_AT;
  const draftIn = spring({ frame: frame - DRAFT_AT, fps, config: { damping: 18, stiffness: 140 }, durationInFrames: 20 });
  const editIn = spring({ frame: frame - EDIT_AT, fps, config: { damping: 16, stiffness: 150 }, durationInFrames: 20 });

  const cursor = path(frame, [
    [0, 470, 650],
    ...arriveAndDwell(TAP_SEND - 28, TAP_SEND + 8, center(SEND).x, center(SEND).y),
    [340, center(SEND).x, center(SEND).y],
  ]);
  const press = pressAt(frame, TAP_SEND);
  const sent = frame >= SENT_AT;
  const sentIn = spring({ frame: frame - SENT_AT, fps, config: { damping: 16 }, durationInFrames: 18 });

  const fadeOut = interpolate(frame, [ANSWER_MOBILE_LEN - SEAM, ANSWER_MOBILE_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <div style={{ position: "absolute", inset: 0, background: SURFACE }}>
        {/* header */}
        <div style={{ position: "absolute", left: PAD, top: 30, right: PAD, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.4, color: INK }}>Answer</span>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, color: VIOLET, background: VIOLET_SOFT, borderRadius: 99, padding: "6px 12px" }}>
            STEP 6 · ANSWER
          </span>
        </div>

        {/* item context */}
        <div style={{ position: "absolute", left: PAD, top: 78, fontSize: 13.5, fontWeight: 700, color: FAINT }}>
          Buyer question · Acer Predator · $550
        </div>

        {/* buyer bubble */}
        {frame >= BUYER_AT ? (
          <div style={{ position: "absolute", left: PAD, top: 110, maxWidth: 400, background: SLAB, border: `1px solid ${LINE}`, borderRadius: "16px 16px 16px 4px", padding: "13px 16px", opacity: buyerIn, transform: `translateY(${(1 - buyerIn) * 8}px)` }}>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.6, color: FAINT, marginBottom: 4 }}>BUYER</div>
            <div style={{ fontSize: 16.5, fontWeight: 600, color: INK, lineHeight: 1.5 }}>{BUYER_MSG}</div>
          </div>
        ) : null}

        {/* drafted reply card */}
        {frame >= DRAFT_AT - 30 ? (
          <div style={{ position: "absolute", left: PAD, top: 228, width: INNER, borderRadius: "16px 16px 4px 16px", border: `1px solid var(--sl-violet-border, rgba(99,91,255,0.3))`, background: VIOLET_SOFT, boxSizing: "border-box", padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.6, color: VIOLET }}>✦ DRAFTED FROM YOUR LISTING</span>
            </div>
            {drafting ? (
              <div style={{ fontSize: 15.5, fontWeight: 600, color: FAINT }}>Drafting a reply…</div>
            ) : (
              <div style={{ fontSize: 16, lineHeight: 1.6, color: INK, opacity: draftIn }}>
                {DRAFT_TEXT}
                {frame >= EDIT_AT ? (
                  <span style={{ color: VIOLET, fontWeight: 700, background: "var(--sl-violet-soft, rgba(99,91,255,0.18))", borderRadius: 4, opacity: editIn }}>
                    {EDIT_TEXT}
                  </span>
                ) : null}
              </div>
            )}
            {frame >= EDIT_AT ? (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10, fontSize: 12.5, fontWeight: 800, color: VIOLET, opacity: editIn }}>
                <CheckIcon size={13} color="var(--sl-violet, #635bff)" /> your answer added
              </div>
            ) : null}
          </div>
        ) : null}

        {/* honest-grounding footer */}
        <div style={{ position: "absolute", left: PAD, top: 488, right: PAD, fontSize: 13.5, fontWeight: 600, color: FAINT, lineHeight: 1.4 }}>
          SnapList states only what it can see — you confirm the rest.
        </div>

        {/* approve & send → sent */}
        {sent ? (
          <div style={{ position: "absolute", left: SEND.x, top: SEND.y, width: SEND.w, height: SEND.h, borderRadius: 18, background: "var(--sl-green-soft, rgba(22,163,74,0.1))", border: `1.5px solid var(--sl-green-soft, rgba(22,163,74,0.3))`, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, opacity: sentIn }}>
            <CheckIcon size={18} />
            <span style={{ fontSize: 19, fontWeight: 800, color: GREEN }}>Sent · approved reply</span>
          </div>
        ) : (
          <div style={{ position: "absolute", left: SEND.x, top: SEND.y, width: SEND.w, height: SEND.h, borderRadius: 18, background: VIOLET, color: "white", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontSize: 20, fontWeight: 800, transform: `scale(${1 - press * 0.03})`, boxShadow: "0 12px 26px -10px rgba(99,91,255,0.6)" }}>
            Approve &amp; send <span aria-hidden>→</span>
          </div>
        )}
      </div>

      <Cursor x={cursor.x} y={cursor.y} press={press} />
    </AbsoluteFill>
  );
}

export const StepAnswerMobile: React.FC = () => (
  <MobileScene>
    <Sequence from={ANSWER_MOBILE_LEN - SEAM} durationInFrames={SEAM}>
      <Freeze frame={0}>
        <AnswerMobileAct />
      </Freeze>
    </Sequence>
    <AnswerMobileAct />
  </MobileScene>
);
