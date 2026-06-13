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
import { CheckIcon, Cursor, arriveAndDwell, path, pressAt } from "../hero/primitives";
import { PhotoFrame, Scene, Shell, Toast } from "./primitives";
import { FAINT, GREEN, INK, LINE, VIOLET, center, type ClickSpec, type Rect } from "./theme";

/**
 * Step 1 · Snap — the whole photo-adding process, unrushed:
 *   1. a phone-frame capture moment (shutter → flash → the photo flies into
 *      the rail, “Imported from iPhone”),
 *   2. a real OS drag-drop: the cursor picks up a Finder-style file card on
 *      the desk and drops it on the dropzone (press + release both asserted),
 *   3. a click on the “+ Add” tile for a third angle.
 * Ends on “3 photos · ready to identify”. Product: Taylor koa
 * acoustic-electric guitar (demo/guitar.jpg) — three crops play as angles.
 *
 * Render: npx remotion render remotion/index.ts step-snap public/demo/steps/snap.mp4 --crf 26 --muted
 */

export const STEP_SNAP_LEN = 480;
const SEAM = 16;

/* ---------- layout ---------- */

const WIN_SNAP: Rect = { x: 40, y: 30, w: 840, h: 660 };
const DROP: Rect = { x: 64, y: 104, w: 752, h: 330 };
const SLOT_W = 160;
const SLOT_H = 120;
const SLOT_Y = 458;
const slotRect = (i: number): Rect => ({ x: 64 + i * 176, y: SLOT_Y, w: SLOT_W, h: SLOT_H });

const PHONE: Rect = { x: 940, y: 56, w: 230, h: 470 };
const FILE: Rect = { x: 952, y: 566, w: 206, h: 64 };

const IMG = "demo/guitar.jpg";
/** three crops of the verified guitar photo standing in for angles: body, headstock, bridge */
const ANGLES = ["50% 68%", "50% 16%", "50% 92%"];
/** rail-thumbnail zoom framing so the guitar fills each tile */
const THUMB_VIEW = [
  { origin: "55% 62%", zoom: 1.9 },
  { origin: "40% 22%", zoom: 2.1 },
  { origin: "56% 80%", zoom: 1.9 },
];

/* ---------- choreography ---------- */

const SHUTTER_AT = 56;
const FLY_START = 70;
const FLY_END = 100;
const SLOT1_AT = 102;
const MAIN_IN = 104;

const ARRIVE_FILE = 140;
const PRESS_FILE = 154;
const DRAG_START = 158;
const ARRIVE_DROP = 214;
const RELEASE_DROP = 228;
const SLOT2_AT = 236;

const ARRIVE_ADD = 296;
const CLICK_ADD = 310;
const SLOT3_AT = 322;

const READY_AT = 346;
const HINT_AT = 362;

const FILE_C = center(FILE);
const DROP_C = center(DROP);
const ADD3_C = center(slotRect(2)); // the “+ Add” tile sits at rail position 3 when clicked

export const SNAP_WAYPOINTS: Array<[number, number, number]> = [
  [0, 1190, 680],
  ...arriveAndDwell(ARRIVE_FILE, DRAG_START, FILE_C.x, FILE_C.y),
  [186, 740, 430],
  ...arriveAndDwell(ARRIVE_DROP, RELEASE_DROP + 4, DROP_C.x, DROP_C.y),
  [264, 580, 420],
  ...arriveAndDwell(ARRIVE_ADD, CLICK_ADD + 8, ADD3_C.x, ADD3_C.y),
  [364, 812, 686],
];

export const snapCursorAt = (frame: number) => path(frame, SNAP_WAYPOINTS);

export const SNAP_CLICKS: ClickSpec[] = [
  {
    label: "snap: press on the desktop file card (drag start)",
    frame: PRESS_FILE,
    target: FILE,
    arrive: ARRIVE_FILE,
    until: DRAG_START,
  },
  {
    label: "snap: release the dragged file over the dropzone",
    frame: RELEASE_DROP,
    target: DROP,
    arrive: ARRIVE_DROP,
    until: RELEASE_DROP + 4,
  },
  {
    label: "snap: click the “+ Add” tile for the third angle",
    frame: CLICK_ADD,
    target: slotRect(2),
    arrive: ARRIVE_ADD,
    until: CLICK_ADD + 8,
  },
];

/* ---------- pieces ---------- */

function PhoneFrame() {
  const frame = useCurrentFrame();
  const shutterPress = interpolate(frame, [SHUTTER_AT - 3, SHUTTER_AT, SHUTTER_AT + 6], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const flash = interpolate(frame, [SHUTTER_AT + 1, SHUTTER_AT + 4, SHUTTER_AT + 12], [0, 0.9, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: PHONE.x,
        top: PHONE.y,
        width: PHONE.w,
        height: PHONE.h,
        borderRadius: 34,
        background: INK,
        boxShadow: "0 24px 50px -18px rgba(19,30,58,0.45)",
        padding: 10,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          borderRadius: 26,
          overflow: "hidden",
          background: "#000",
        }}
      >
        <Img
          src={staticFile(IMG)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "50% 30%",
            opacity: 0.94,
          }}
        />
        {/* viewfinder chrome */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 10,
            transform: "translateX(-50%)",
            width: 64,
            height: 18,
            borderRadius: 99,
            background: "rgba(0,0,0,0.85)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 14,
            top: 40,
            fontSize: 9.5,
            fontWeight: 800,
            letterSpacing: 1.2,
            color: "rgba(255,255,255,0.85)",
            background: "rgba(0,0,0,0.45)",
            borderRadius: 6,
            padding: "3px 7px",
          }}
        >
          PHOTO
        </div>
        {/* shutter */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 16,
            transform: `translateX(-50%) scale(${1 - shutterPress * 0.18})`,
            width: 52,
            height: 52,
            borderRadius: 99,
            border: "4px solid rgba(255,255,255,0.9)",
            background: shutterPress > 0.4 ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.25)",
          }}
        />
        {flash > 0.01 ? (
          <div style={{ position: "absolute", inset: 0, background: "white", opacity: flash }} />
        ) : null}
      </div>
    </div>
  );
}

/** the captured photo flying from the phone into rail slot 1 */
function FlyingCapture() {
  const frame = useCurrentFrame();
  if (frame < FLY_START || frame > FLY_END + 2) return null;
  const pos = path(frame, [
    [FLY_START, 1055, 270],
    [FLY_START + 14, 600, 220],
    [FLY_END, 144, SLOT_Y + SLOT_H / 2],
  ]);
  const size = interpolate(frame, [FLY_START, FLY_END], [190, SLOT_W], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: pos.x - size / 2,
        top: pos.y - (size * 0.75) / 2,
        width: size,
        height: size * 0.75,
        borderRadius: 12,
        overflow: "hidden",
        border: "2px solid white",
        boxShadow: "0 16px 34px -10px rgba(19,30,58,0.45)",
        zIndex: 55,
      }}
    >
      <Img
        src={staticFile(IMG)}
        style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: ANGLES[0] }}
      />
    </div>
  );
}

function RailSlot({ index, at }: { index: number; at: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const r = slotRect(index);
  if (frame < at) return null;
  const s = spring({
    frame: frame - at,
    fps,
    config: { damping: 12, stiffness: 150 },
    durationInFrames: 22,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        borderRadius: 12,
        overflow: "hidden",
        border: `1px solid ${LINE}`,
        opacity: s,
        transform: `scale(${0.86 + s * 0.14})`,
      }}
    >
      <Img
        src={staticFile(IMG)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: ANGLES[index],
          transform: `scale(${THUMB_VIEW[index].zoom})`,
          transformOrigin: THUMB_VIEW[index].origin,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 7,
          top: 7,
          width: 18,
          height: 18,
          borderRadius: 99,
          background: "rgba(19,30,58,0.72)",
          color: "white",
          fontSize: 10,
          fontWeight: 800,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {index + 1}
      </div>
    </div>
  );
}

/** the “+ Add” tile, sitting after the last landed photo */
function AddTile({ count }: { count: number }) {
  const r = slotRect(Math.min(count, 3));
  return (
    <div
      style={{
        position: "absolute",
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        borderRadius: 12,
        border: `2px dashed ${LINE}`,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        color: FAINT,
      }}
    >
      <span style={{ fontSize: 22, fontWeight: 400, lineHeight: 1, color: VIOLET }}>+</span>
      <span style={{ fontSize: 12, fontWeight: 700 }}>Add photo</span>
    </div>
  );
}

/** Finder-style file card on the desk; becomes the drag ghost */
function FileCard({ x, y, ghost }: { x: number; y: number; ghost?: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: FILE.w,
        height: FILE.h,
        borderRadius: 12,
        background: "white",
        border: `1px solid ${LINE}`,
        boxShadow: ghost
          ? "0 22px 40px -12px rgba(19,30,58,0.45)"
          : "0 10px 24px -10px rgba(19,30,58,0.22)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 12px",
        boxSizing: "border-box",
        transform: ghost ? "rotate(-2.5deg) scale(0.96)" : undefined,
        opacity: ghost ? 0.92 : 1,
        zIndex: ghost ? 55 : undefined,
      }}
    >
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 8,
          overflow: "hidden",
          flexShrink: 0,
          border: `1px solid ${LINE}`,
        }}
      >
        <Img
          src={staticFile(IMG)}
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: ANGLES[1] }}
        />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>IMG_5714.jpg</div>
        <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2 }}>2.4 MB · photo file</div>
      </div>
    </div>
  );
}

/* ---------- the act ---------- */

function SnapAct() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cursor = snapCursorAt(frame);
  const dragging = frame >= PRESS_FILE && frame <= RELEASE_DROP;
  const dragHold = interpolate(
    frame,
    [PRESS_FILE - 2, PRESS_FILE + 2, RELEASE_DROP, RELEASE_DROP + 9],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const press = Math.min(1, Math.max(dragHold, pressAt(frame, CLICK_ADD)));

  const mainIn = spring({
    frame: frame - MAIN_IN,
    fps,
    config: { damping: 16, stiffness: 120 },
    durationInFrames: 26,
  });

  const photoCount = frame >= SLOT3_AT ? 3 : frame >= SLOT2_AT ? 2 : frame >= SLOT1_AT ? 1 : 0;
  const hoverDrop = dragging && frame >= ARRIVE_DROP - 10;

  const fadeOut = interpolate(frame, [STEP_SNAP_LEN - SEAM, STEP_SNAP_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const hintIn = spring({
    frame: frame - HINT_AT,
    fps,
    config: { damping: 15 },
    durationInFrames: 22,
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <Shell win={WIN_SNAP} badge="STEP 1 · SNAP">
        <PhotoFrame
          rect={DROP}
          src={staticFile(IMG)}
          fileName="IMG_5712.jpg"
          photoIn={mainIn}
          objectPosition={ANGLES[0]}
          emptyLabel="Add photos"
          emptySub="drag & drop, browse, or capture on your phone"
        />
        {/* drag-over highlight */}
        {hoverDrop ? (
          <div
            style={{
              position: "absolute",
              left: DROP.x,
              top: DROP.y,
              width: DROP.w,
              height: DROP.h,
              borderRadius: 14,
              border: `2.5px dashed ${VIOLET}`,
              background: "rgba(99,91,255,0.08)",
              boxSizing: "border-box",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              paddingBottom: 16,
            }}
          >
            <span
              style={{
                fontSize: 13.5,
                fontWeight: 800,
                color: VIOLET,
                background: "white",
                borderRadius: 99,
                padding: "7px 15px",
                boxShadow: "0 6px 18px -6px rgba(19,30,58,0.25)",
              }}
            >
              Release to add photo
            </span>
          </div>
        ) : null}

        {/* thumbnail rail */}
        <RailSlot index={0} at={SLOT1_AT} />
        <RailSlot index={1} at={SLOT2_AT} />
        <RailSlot index={2} at={SLOT3_AT} />
        <AddTile count={photoCount} />

        {/* counter / ready line */}
        <div
          style={{
            position: "absolute",
            left: 64,
            top: 602,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {frame >= READY_AT ? (
            <>
              <CheckIcon />
              <span style={{ fontSize: 14, fontWeight: 700, color: GREEN }}>
                3 photos · ready to identify
              </span>
            </>
          ) : photoCount > 0 ? (
            <span style={{ fontSize: 14, fontWeight: 600, color: FAINT }}>
              {photoCount} photo{photoCount > 1 ? "s" : ""} · more angles help judge condition
            </span>
          ) : (
            <span style={{ fontSize: 14, fontWeight: 600, color: FAINT }}>
              1–4 photos · the first sets the cover
            </span>
          )}
        </div>
        {frame >= HINT_AT ? (
          <div
            style={{
              position: "absolute",
              left: 648,
              top: 592,
              width: 168,
              height: 44,
              borderRadius: 12,
              background: VIOLET,
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14.5,
              fontWeight: 700,
              opacity: hintIn,
              transform: `translateY(${(1 - hintIn) * 10}px)`,
              boxShadow: "0 8px 20px -8px rgba(99,91,255,0.55)",
            }}
          >
            Identify item →
          </div>
        ) : null}

        <Toast x={DROP.x + 18} y={DROP.y + 14} at={SLOT1_AT + 6} hold={48} icon="phone" text="Imported from iPhone" />
        <Toast x={DROP.x + 18} y={DROP.y + 14} at={SLOT2_AT + 8} hold={44} text="Photo added — 2 angles" />
      </Shell>

      {/* desk: phone + file card */}
      <PhoneFrame />
      {frame < PRESS_FILE ? <FileCard x={FILE.x} y={FILE.y} /> : null}
      <FlyingCapture />

      {/* drag ghost rides with the cursor */}
      {dragging ? <FileCard ghost x={cursor.x - FILE.w / 2 + 14} y={cursor.y + 12} /> : null}

      <Cursor x={cursor.x} y={cursor.y} press={press} />

      {/* desk caption */}
      <div
        style={{
          position: "absolute",
          left: PHONE.x,
          top: PHONE.y + PHONE.h + 8,
          width: PHONE.w,
          textAlign: "center",
          fontSize: 11.5,
          fontWeight: 700,
          letterSpacing: 1,
          color: FAINT,
        }}
      >
        OR SNAP IT ON YOUR PHONE
      </div>
    </AbsoluteFill>
  );
}

export const StepSnap: React.FC = () => (
  <Scene>
    <Sequence from={STEP_SNAP_LEN - SEAM} durationInFrames={SEAM}>
      <Freeze frame={0}>
        <SnapAct />
      </Freeze>
    </Sequence>
    <SnapAct />
  </Scene>
);
