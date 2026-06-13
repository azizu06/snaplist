import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  AppShell,
  ChipsRow,
  DescriptionField,
  FeedPanel,
  PhotoPanel,
  PriceModule,
  PublishArea,
  RightHeader,
  StatusPill,
  TitleField,
  type FeedEvent,
} from "./primitives";

/**
 * Act 2 — Textbook (ISBN tier → autopilot). No cursor on purpose: the barcode
 * resolves to an exact edition, confidence clears the autopilot gate, and the
 * listing posts itself.
 */

export const ACT_TEXTBOOK_LEN = 300;

const PHOTO_IN = 12;
const SCAN_START = 36;
const SCAN_END = 78;
const ISBN_BOX_AT = 62;
const CHIPS_AT = 140;
const TITLE_AT = 132;
const PRICE_AT = 208;
const AUTOPILOT_AT = 226;
const POSTING_AT = 244;
const LIVE_AT = 264;
const ID_AT = 272;

const FEED: FeedEvent[] = [
  { at: 40, done: 76, tool: "vision.extract", text: "reading cover & barcode…" },
  {
    at: 84,
    done: 122,
    tool: "isbn.lookup",
    text: "ISBN 978-0596515829 → Open Library",
    sub: "exact match · Python for Unix and Linux System Admin.",
    subAt: 126,
  },
  { at: 152, done: 198, tool: "listing.write", text: "description from edition metadata…" },
  { at: 206, tool: "autopilot.gate", text: "confidence 96% ≥ threshold, posting" },
];

const TITLE = "Python for Unix and Linux System Administration (O'Reilly)";
const DESC =
  "Python for Unix and Linux System Administration. O'Reilly, 1st edition (2008). Paperback in good condition: clean pages, light shelf wear.";

/** ISBN detection overlay drawn over the book photo */
function IsbnDetection() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < ISBN_BOX_AT) return null;
  const s = spring({
    frame: frame - ISBN_BOX_AT,
    fps,
    config: { damping: 12, stiffness: 160 },
    durationInFrames: 20,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 196,
        top: 168,
        width: 138,
        height: 64,
        opacity: s,
        transform: `scale(${0.85 + s * 0.15})`,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          border: "2px solid #4ade80",
          borderRadius: 8,
          boxShadow: "0 0 0 2px rgba(74,222,128,0.25), 0 2px 10px rgba(0,0,0,0.35)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "100%",
          transform: "translate(-50%, 8px)",
          background: "rgba(19,30,58,0.85)",
          color: "#4ade80",
          borderRadius: 7,
          padding: "4px 10px",
          fontSize: 11,
          fontWeight: 700,
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        ISBN 978-0596515829
      </div>
    </div>
  );
}

export const ActTextbook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const photoIn = spring({
    frame: frame - PHOTO_IN,
    fps,
    config: { damping: 16, stiffness: 120 },
    durationInFrames: 28,
  });

  const fadeIn = interpolate(frame, [0, 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(frame, [ACT_TEXTBOOK_LEN - 9, ACT_TEXTBOOK_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOut) }}>
      <AppShell>
        <PhotoPanel
          src={staticFile("demo/book.jpg")}
          fileName="IMG_4107.jpg"
          photoIn={photoIn}
          scanStart={SCAN_START}
          scanEnd={SCAN_END}
          objectPosition="62% 45%"
        >
          <IsbnDetection />
        </PhotoPanel>
        <StatusPill
          analyzeStart={SCAN_START - 4}
          doneAt={128}
          doneText="Exact match · ISBN tier"
        />
        <FeedPanel events={FEED} agent="pricing agent · ISBN" />

        <RightHeader step="2 of 3 · books & media" />
        <TitleField text={TITLE} typeStart={TITLE_AT} typeDuration={20} />
        <ChipsRow
          chips={["O'Reilly Media", "Paperback · 2008", "1st edition", "Good condition"]}
          startAt={CHIPS_AT}
        />
        <DescriptionField text={DESC} typeStart={158} typeDuration={44} />
        <PriceModule
          appearAt={PRICE_AT}
          suggested={24}
          rangeLow={18}
          rangeHigh={32}
          confidence={96}
          tier="ISBN tier"
          comps="exact edition"
        />
        <PublishArea
          appearAt={PRICE_AT + 6}
          liveAt={LIVE_AT}
          listingId="eBay item #110554731544 · posted by Autopilot"
          idAt={ID_AT}
          autopilot={{ at: AUTOPILOT_AT, label: "High confidence: Autopilot posts this one" }}
          postingFrom={POSTING_AT}
        />
      </AppShell>
      {/* no cursor — that's the autopilot story */}
    </AbsoluteFill>
  );
};
