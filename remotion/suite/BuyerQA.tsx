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
import { Caret, CheckIcon, Cursor, Spinner, arriveAndDwell, path, pressAt, typeProgress } from "../hero/primitives";
import { Scene, Shell, streamProgress } from "./primitives";
import {
  DIM,
  FAINT,
  GREEN,
  GREEN_SOFT,
  INK,
  LINE,
  SLAB,
  VIOLET,
  VIOLET_BORDER,
  VIOLET_SOFT,
  center,
  type ClickSpec,
  type Rect,
  SURFACE,
} from "./theme";

/**
 * Step 6 · Answer (Buyer Q&A) — the trust story: a buyer question lands in
 * the inbox, a reply is drafted from the item's real details (streamed in),
 * the seller reviews, makes one edit, and approves before anything sends.
 * Three cursor-accurate clicks: open the conversation, focus the draft,
 * approve & send. Joined the how-it-works pipeline as step 6 (ui-r6).
 * Product: Vintage brass figural chess set on wooden board (demo/chess.jpg).
 *
 * Render: npx remotion render remotion/index.ts buyer-qa public/demo/buyer-qa.mp4 --crf 26 --muted
 */

export const BUYER_QA_LEN = 660;
const SEAM = 16;

/* ---------- layout ---------- */

const LIST: Rect = { x: 64, y: 112, w: 372, h: 550 };
const ROW1: Rect = { x: 76, y: 158, w: 348, h: 76 };
const THREAD_HEAD: Rect = { x: 468, y: 112, w: 740, h: 64 };
const COMPOSER: Rect = { x: 468, y: 492, w: 740, h: 170 };
const TEXTBOX: Rect = { x: 484, y: 530, w: 708, h: 78 };
const APPROVE: Rect = { x: 1010, y: 616, w: 198, h: 40 };

/* ---------- choreography ---------- */

const ROW_IN = 28;
const ARRIVE_ROW = 64;
const CLICK_ROW = 78;
const THREAD_AT = 86;
const BUYER_MSG_AT = 96;
const GROUND_AT = 128;
const CHIP_AT = [140, 150, 160];
const DRAFT_AT = 176;
const DRAFT_DUR = 150;

const ARRIVE_BOX = 372;
const CLICK_BOX = 386;
const EDIT_AT = 398;
const EDIT_DUR = 34;
const EDITED_CHIP_AT = 442;

const ARRIVE_APPROVE = 470;
const CLICK_APPROVE = 484;
const SENT_AT = 496;
const SENT_NOTE_AT = 520;

const BUYER_MSG = "Hi! Are all 32 pieces included, and is there any damage I should know about?";
const DRAFT_TEXT =
  "Yes, all 32 brass pieces are included, along with the wooden board. Condition is fair: the pieces show honest tarnish and patina from age, but nothing is cracked or missing. Happy to send close-up photos!";
const EDIT_TEXT = " Local pickup works too.";

const ROW_C = center(ROW1);
const BOX_C = center(TEXTBOX);
const APPROVE_C = center(APPROVE);

export const QA_WAYPOINTS: Array<[number, number, number]> = [
  [0, 1240, 706],
  ...arriveAndDwell(ARRIVE_ROW, CLICK_ROW + 8, ROW_C.x, ROW_C.y),
  [150, 700, 430],
  [340, 700, 430],
  ...arriveAndDwell(ARRIVE_BOX, CLICK_BOX + 8, BOX_C.x, BOX_C.y),
  [440, 920, 580],
  ...arriveAndDwell(ARRIVE_APPROVE, CLICK_APPROVE + 8, APPROVE_C.x, APPROVE_C.y),
  [540, 1150, 700],
];

export const qaCursorAt = (frame: number) => path(frame, QA_WAYPOINTS);

export const QA_CLICKS: ClickSpec[] = [
  {
    label: "buyer-qa: click the new conversation row",
    frame: CLICK_ROW,
    target: ROW1,
    arrive: ARRIVE_ROW,
    until: CLICK_ROW + 8,
  },
  {
    label: "buyer-qa: click into the draft to edit",
    frame: CLICK_BOX,
    target: TEXTBOX,
    arrive: ARRIVE_BOX,
    until: CLICK_BOX + 8,
  },
  {
    label: "buyer-qa: click Approve & send",
    frame: CLICK_APPROVE,
    target: APPROVE,
    arrive: ARRIVE_APPROVE,
    until: CLICK_APPROVE + 8,
  },
];

/* ---------- pieces ---------- */

function InboxList() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rowIn = spring({
    frame: frame - ROW_IN,
    fps,
    config: { damping: 14, stiffness: 140 },
    durationInFrames: 24,
  });
  const selected = frame >= THREAD_AT;
  const answered = frame >= SENT_AT + 10;
  return (
    <div
      style={{
        position: "absolute",
        left: LIST.x,
        top: LIST.y,
        width: LIST.w,
        height: LIST.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: SURFACE,
        boxSizing: "border-box",
        padding: "14px 0",
      }}
    >
      <div
        style={{
          padding: "0 16px",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: 16.5, fontWeight: 800, color: INK }}>Inbox</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: FAINT }}>buyer messages · live</span>
      </div>

      {/* the new conversation */}
      {frame >= ROW_IN ? (
        <div
          style={{
            position: "absolute",
            left: ROW1.x - LIST.x,
            top: ROW1.y - LIST.y,
            width: ROW1.w,
            height: ROW1.h,
            borderRadius: 12,
            background: selected ? VIOLET_SOFT : SLAB,
            border: `1px solid ${selected ? VIOLET_BORDER : LINE}`,
            boxSizing: "border-box",
            padding: "11px 13px",
            display: "flex",
            gap: 11,
            opacity: rowIn,
            transform: `translateY(${(1 - rowIn) * 12}px)`,
          }}
        >
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 99,
              background: "linear-gradient(135deg, #f59e0b, #d97706)",
              color: "white",
              fontSize: 12,
              fontWeight: 800,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            MC
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 13.5, fontWeight: 800, color: INK }}>M. Carter</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: FAINT }}>now</span>
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: VIOLET, marginTop: 2 }}>
              Brass chess set · $75
            </div>
            <div
              style={{
                fontSize: 12,
                color: DIM,
                marginTop: 3,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              Are all 32 pieces included, and is…
            </div>
          </div>
          {answered ? (
            <CheckIcon size={13} />
          ) : (
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 99,
                background: VIOLET,
                flexShrink: 0,
                marginTop: 4,
              }}
            />
          )}
        </div>
      ) : null}

      {/* a quiet older row */}
      <div
        style={{
          position: "absolute",
          left: 12,
          top: 144,
          width: ROW1.w,
          borderRadius: 12,
          boxSizing: "border-box",
          padding: "11px 13px",
          display: "flex",
          gap: 11,
          opacity: 0.6,
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 99,
            background: SLAB,
            border: `1px solid ${LINE}`,
            color: FAINT,
            fontSize: 12,
            fontWeight: 800,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          SL
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: DIM }}>SnapList tips</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: FAINT }}>Mon</span>
          </div>
          <div style={{ fontSize: 12, color: FAINT, marginTop: 3 }}>
            Welcome to your live inbox. Replies you approve send through eBay.
          </div>
        </div>
      </div>
    </div>
  );
}

function ThreadHeader() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < THREAD_AT) return null;
  const enter = spring({
    frame: frame - THREAD_AT,
    fps,
    config: { damping: 15, stiffness: 140 },
    durationInFrames: 20,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: THREAD_HEAD.x,
        top: THREAD_HEAD.y,
        width: THREAD_HEAD.w,
        height: THREAD_HEAD.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: SURFACE,
        display: "flex",
        alignItems: "center",
        gap: 13,
        padding: "0 14px",
        boxSizing: "border-box",
        opacity: enter,
      }}
    >
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 9,
          overflow: "hidden",
          flexShrink: 0,
          border: `1px solid ${LINE}`,
        }}
      >
        <Img
          src={staticFile("demo/chess.jpg")}
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "38% 50%" }}
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
          Vintage brass figural chess set on wooden board
        </div>
        <div style={{ fontSize: 12.5, color: FAINT, marginTop: 3 }}>
          $75 · Fair condition · live on eBay
        </div>
      </div>
      <span
        style={{
          fontSize: 11.5,
          fontWeight: 800,
          color: GREEN,
          background: GREEN_SOFT,
          borderRadius: 99,
          padding: "4px 12px",
          flexShrink: 0,
        }}
      >
        LIVE LISTING
      </span>
    </div>
  );
}

function ThreadBody() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < THREAD_AT) {
    return (
      <div
        style={{
          position: "absolute",
          left: 468,
          top: 112,
          width: 740,
          height: 550,
          borderRadius: 14,
          border: `1.5px dashed ${LINE}`,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 600, color: FAINT }}>
          Select a conversation
        </span>
      </div>
    );
  }
  const buyerIn = spring({
    frame: frame - BUYER_MSG_AT,
    fps,
    config: { damping: 13, stiffness: 150 },
    durationInFrames: 22,
  });
  const sentIn = spring({
    frame: frame - SENT_AT,
    fps,
    config: { damping: 13, stiffness: 140 },
    durationInFrames: 24,
  });
  const fullReply = DRAFT_TEXT + EDIT_TEXT;
  return (
    <div
      style={{
        position: "absolute",
        left: 468,
        top: 188,
        width: 740,
        height: 292,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: SURFACE,
        boxSizing: "border-box",
        padding: "16px 18px",
        overflow: "hidden",
      }}
    >
      {frame >= BUYER_MSG_AT ? (
        <div style={{ opacity: buyerIn, transform: `translateY(${(1 - buyerIn) * 10}px)` }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: FAINT, marginBottom: 5 }}>
            M. Carter · buyer
          </div>
          <div
            style={{
              maxWidth: 500,
              background: SLAB,
              border: `1px solid ${LINE}`,
              borderRadius: "4px 14px 14px 14px",
              padding: "11px 14px",
              fontSize: 14.5,
              lineHeight: 1.55,
              color: INK,
            }}
          >
            {BUYER_MSG}
          </div>
        </div>
      ) : null}

      {frame >= SENT_AT ? (
        <div
          style={{
            marginTop: 16,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            opacity: sentIn,
            transform: `translateY(${(1 - sentIn) * 12}px)`,
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 700, color: FAINT, marginBottom: 5 }}>
            You · approved reply
          </div>
          <div
            style={{
              maxWidth: 560,
              background: VIOLET,
              borderRadius: "14px 4px 14px 14px",
              padding: "11px 14px",
              fontSize: 13.5,
              lineHeight: 1.55,
              color: "white",
            }}
          >
            {fullReply}
          </div>
          {frame >= SENT_NOTE_AT ? (
            <div
              style={{
                marginTop: 6,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11.5,
                fontWeight: 700,
                color: GREEN,
              }}
            >
              <CheckIcon size={12} /> Sent to the buyer through eBay messages
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Composer() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < THREAD_AT) return null;
  const enter = spring({
    frame: frame - (THREAD_AT + 6),
    fps,
    config: { damping: 15, stiffness: 130 },
    durationInFrames: 22,
  });

  const draftN = streamProgress(DRAFT_TEXT, frame, DRAFT_AT, DRAFT_DUR);
  const editN = typeProgress(EDIT_TEXT, frame, EDIT_AT, EDIT_DUR);
  const drafting = frame >= DRAFT_AT - 8 && frame < DRAFT_AT + DRAFT_DUR + 4;
  const focused = frame >= CLICK_BOX && frame < SENT_AT;
  const editing = frame >= EDIT_AT && frame <= EDIT_AT + EDIT_DUR + 16;
  const sent = frame >= SENT_AT;
  const grounded = frame >= GROUND_AT;

  const text = DRAFT_TEXT.slice(0, draftN) + (frame >= EDIT_AT ? EDIT_TEXT.slice(0, editN) : "");

  return (
    <div
      style={{
        position: "absolute",
        left: COMPOSER.x,
        top: COMPOSER.y,
        width: COMPOSER.w,
        height: COMPOSER.h,
        borderRadius: 14,
        border: `1px solid ${LINE}`,
        background: SURFACE,
        boxSizing: "border-box",
        padding: "12px 16px",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 12}px)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {sent ? (
          <>
            <CheckIcon size={13} />
            <span style={{ fontSize: 12.5, fontWeight: 800, color: GREEN }}>
              Reply sent · saved with the listing
            </span>
          </>
        ) : (
          <>
            {drafting ? <Spinner deg={frame * 14} /> : grounded ? <CheckIcon size={13} /> : null}
            <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.8, color: FAINT }}>
              REPLY DRAFTED FOR YOU
            </span>
            {grounded ? (
              <div style={{ display: "flex", gap: 6 }}>
                {["uses: the item's details", "your listing", "condition · Fair"].map((c, i) => {
                  if (frame < CHIP_AT[i]) return null;
                  const s = spring({
                    frame: frame - CHIP_AT[i],
                    fps,
                    config: { damping: 13, stiffness: 150 },
                    durationInFrames: 18,
                  });
                  return (
                    <span
                      key={c}
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: VIOLET,
                        background: VIOLET_SOFT,
                        border: `1px solid ${VIOLET_BORDER}`,
                        borderRadius: 99,
                        padding: "2.5px 9px",
                        opacity: s,
                        transform: `scale(${0.85 + s * 0.15})`,
                      }}
                    >
                      {c}
                    </span>
                  );
                })}
              </div>
            ) : null}
            {frame >= EDITED_CHIP_AT ? (
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 11,
                  fontWeight: 800,
                  color: INK,
                  background: SLAB,
                  border: `1px solid ${LINE}`,
                  borderRadius: 99,
                  padding: "2.5px 9px",
                }}
              >
                edited by you
              </span>
            ) : null}
          </>
        )}
      </div>

      {/* draft textarea — geometry from TEXTBOX so the cursor click lands on it */}
      <div
        style={{
          position: "absolute",
          left: TEXTBOX.x - COMPOSER.x,
          top: TEXTBOX.y - COMPOSER.y,
          width: TEXTBOX.w,
          height: TEXTBOX.h,
          borderRadius: 10,
          border: `1px solid ${focused ? "rgba(99,91,255,0.55)" : LINE}`,
          boxShadow: focused ? "0 0 0 3px rgba(99,91,255,0.12)" : undefined,
          background: sent ? SLAB : SURFACE,
          padding: "9px 12px",
          fontSize: 13.5,
          lineHeight: 1.5,
          color: sent ? FAINT : DIM,
          boxSizing: "border-box",
          overflow: "hidden",
        }}
      >
        {sent ? "Reply delivered. New buyer messages will appear here." : text}
        <Caret visible={!sent && (drafting || editing || (focused && frame < EDIT_AT))} height={13} />
      </div>

      {/* approval row */}
      {!sent ? (
        <div
          style={{
            position: "absolute",
            left: 16,
            top: APPROVE.y - COMPOSER.y,
            height: APPROVE.h,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <ShieldIcon />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: FAINT }}>
            Nothing sends without your approval.
          </span>
        </div>
      ) : null}
      {!sent ? (
        <div
          style={{
            position: "absolute",
            left: APPROVE.x - COMPOSER.x,
            top: APPROVE.y - COMPOSER.y,
            width: APPROVE.w,
            height: APPROVE.h,
            borderRadius: 11,
            background: draftN >= DRAFT_TEXT.length ? VIOLET : "rgba(99,91,255,0.4)",
            color: "white",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13.5,
            fontWeight: 700,
            transform: `scale(${1 - pressAt(frame, CLICK_APPROVE) * 0.05})`,
            boxShadow: "0 8px 18px -8px rgba(99,91,255,0.55)",
          }}
        >
          Approve & send
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            left: APPROVE.x - COMPOSER.x,
            top: APPROVE.y - COMPOSER.y,
            width: APPROVE.w,
            height: APPROVE.h,
            borderRadius: 11,
            background: GREEN_SOFT,
            border: "1px solid rgba(22,163,74,0.35)",
            color: GREEN,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            fontSize: 13.5,
            fontWeight: 800,
            boxSizing: "border-box",
          }}
        >
          <CheckIcon size={12} /> Sent
        </div>
      )}
    </div>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" width={13} fill="none" stroke={FAINT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 4 5.5V11c0 5 3.4 9.2 8 10.5 4.6-1.3 8-5.5 8-10.5V5.5L12 2z" />
    </svg>
  );
}

/* ---------- the act ---------- */

function QaAct() {
  const frame = useCurrentFrame();
  const cursor = qaCursorAt(frame);
  const press = Math.min(
    1,
    pressAt(frame, CLICK_ROW) + pressAt(frame, CLICK_BOX) + pressAt(frame, CLICK_APPROVE),
  );
  const fadeOut = interpolate(frame, [BUYER_QA_LEN - SEAM, BUYER_QA_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <Shell active={2} badge="STEP 6 · ANSWER BUYERS">
        <InboxList />
        <ThreadBody />
        <ThreadHeader />
        <Composer />
      </Shell>
      <Cursor x={cursor.x} y={cursor.y} press={press} />
    </AbsoluteFill>
  );
}

export const BuyerQA: React.FC = () => (
  <Scene>
    <Sequence from={BUYER_QA_LEN - SEAM} durationInFrames={SEAM}>
      <Freeze frame={0}>
        <QaAct />
      </Freeze>
    </Sequence>
    <QaAct />
  </Scene>
);
