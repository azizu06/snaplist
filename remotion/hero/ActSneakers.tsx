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
  Cursor,
  DescriptionField,
  FeedPanel,
  PhotoPanel,
  PriceModule,
  PublishArea,
  RightHeader,
  StatusPill,
  TitleField,
  arriveAndDwell,
  path,
  pressAt,
  type FeedEvent,
} from "./primitives";
import { PRICE_INPUT, PUBLISH_BTN, center } from "./theme";

/**
 * Act 3 — Sneakers (web comps + seller edit). Shows breadth and control: the
 * agent prices the shoes, then the cursor clicks *into* the price field —
 * pixel-accurately — nudges the price, and publishes.
 */

export const ACT_SNEAKERS_LEN = 460;

const PRICE_FIELD = center(PRICE_INPUT);
const PUBLISH = center(PUBLISH_BTN);

const PHOTO_IN = 12;
const SCAN_START = 36;
const SCAN_END = 84;
const CHIPS_AT = 92;
const TITLE_AT = 96;
const PRICE_AT = 300;
const ARRIVE_PRICE = 338;
const CLICK_PRICE = 350; // arrive + 12-frame dwell
const TYPE_START = 358;
const ARRIVE_PUBLISH = 404;
const CLICK_PUBLISH = 416; // arrive + 12-frame dwell
const LIVE_AT = 424;
const ID_AT = 432;

const FEED: FeedEvent[] = [
  { at: 40, done: 86, tool: "vision.extract", text: "identifying item from photo…" },
  {
    at: 102,
    done: 178,
    tool: "search.comps",
    text: "sold comps · “nike free rn flyknit sz 10”",
    sub: "8 comps found · $74 – $110",
    subAt: 182,
  },
  { at: 196, done: 290, tool: "listing.write", text: "writing description…" },
  { at: 302, tool: "price.match", text: "suggested $88 · confidence 81%" },
];

const TITLE = "Nike Free RN Flyknit Running Shoes — Men's US 10";
const DESC =
  "Nike Free RN Flyknit running shoes, men's US 10 in university red. Very good condition with minimal sole wear. No box — from a smoke-free home.";

export const ActSneakers: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cursor = path(frame, [
    [0, 962, 724],
    [90, 760, 455],
    [316, 760, 455],
    ...arriveAndDwell(ARRIVE_PRICE, ARRIVE_PRICE + 38, PRICE_FIELD.x, PRICE_FIELD.y),
    ...arriveAndDwell(ARRIVE_PUBLISH, ARRIVE_PUBLISH + 40, PUBLISH.x, PUBLISH.y),
  ]);
  const press = Math.min(1, pressAt(frame, CLICK_PRICE) + pressAt(frame, CLICK_PUBLISH));

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
  const fadeOut = interpolate(frame, [ACT_SNEAKERS_LEN - 9, ACT_SNEAKERS_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOut) }}>
      <AppShell>
        <PhotoPanel
          src={staticFile("demo/sneakers.jpg")}
          fileName="IMG_4188.jpg"
          photoIn={photoIn}
          scanStart={SCAN_START}
          scanEnd={SCAN_END}
          objectPosition="50% 55%"
        />
        <StatusPill
          analyzeStart={SCAN_START - 4}
          doneAt={CHIPS_AT - 2}
          doneText="Identified · 89% ID confidence"
        />
        <FeedPanel events={FEED} agent="pricing agent · web comps" />

        <RightHeader step="3 of 3 · footwear" />
        <TitleField text={TITLE} typeStart={TITLE_AT} typeDuration={24} />
        <ChipsRow
          chips={["Nike Free RN Flyknit", "Running shoes", "Men's US 10", "Very good"]}
          startAt={CHIPS_AT}
        />
        <DescriptionField text={DESC} typeStart={204} typeDuration={86} />
        <PriceModule
          appearAt={PRICE_AT}
          suggested={88}
          rangeLow={74}
          rangeHigh={110}
          confidence={81}
          tier="Web comps tier"
          comps="8 comps"
          edit={{
            focusAt: CLICK_PRICE,
            typedValue: "92",
            typeStart: TYPE_START,
            typeDuration: 14,
            noteAt: TYPE_START + 22,
          }}
        />
        <PublishArea
          appearAt={PRICE_AT + 8}
          pressFrame={CLICK_PUBLISH}
          liveAt={LIVE_AT}
          listingId="eBay item #110554736102"
          idAt={ID_AT}
        />
      </AppShell>
      <Cursor x={cursor.x} y={cursor.y} press={press} />
    </AbsoluteFill>
  );
};
