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
import { PHOTO_BOX, PUBLISH_BTN, center } from "./theme";

/**
 * Act 1 — Camera (web-comps tier). The full manual flow: upload click,
 * attribute extraction, the agent feed pricing + writing the description in
 * real time, then a cursor-accurate Publish click.
 */

export const ACT_CAMERA_LEN = 510;

// choreography (act-local frames)
const DROP = center(PHOTO_BOX); // "Add photos" target
const PUBLISH = center(PUBLISH_BTN); // "Publish to eBay" target
const ARRIVE_DROP = 44;
const CLICK_DROP = 58; // arrive + 14-frame dwell
const PHOTO_IN = 64;
const SCAN_START = 82;
const SCAN_END = 132;
const CHIPS_AT = 140;
const TITLE_AT = 144;
const PRICE_AT = 428;
const ARRIVE_PUBLISH = 464;
const CLICK_PUBLISH = 478; // arrive + 14-frame dwell
const LIVE_AT = 486;
const ID_AT = 494;

const FEED: FeedEvent[] = [
  { at: 86, done: 134, tool: "vision.extract", text: "identifying item from photo…" },
  {
    at: 156,
    done: 232,
    tool: "search.comps",
    text: "sold comps · “canon eos 80d used price”",
    sub: "6 comps found · $380 – $465",
    subAt: 236,
  },
  { at: 252, done: 420, tool: "listing.write", text: "writing description…" },
  { at: 432, tool: "price.match", text: "suggested $418 · confidence 87%" },
];

const TITLE = "Canon EOS 80D DSLR Camera Body";
const DESC =
  "Canon EOS 80D DSLR body in good condition. Shutter count ~12k, minor wear on the grip. Includes battery and charger, tested and fully working.";

export const ActCamera: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cursor = path(frame, [
    [0, 962, 724],
    ...arriveAndDwell(ARRIVE_DROP, ARRIVE_DROP + 30, DROP.x, DROP.y),
    [112, 760, 455],
    [438, 760, 455],
    ...arriveAndDwell(ARRIVE_PUBLISH, ARRIVE_PUBLISH + 42, PUBLISH.x, PUBLISH.y),
  ]);
  const press = Math.min(1, pressAt(frame, CLICK_DROP) + pressAt(frame, CLICK_PUBLISH));

  const photoIn = spring({
    frame: frame - PHOTO_IN,
    fps,
    config: { damping: 16, stiffness: 120 },
    durationInFrames: 28,
  });

  const fadeOut = interpolate(frame, [ACT_CAMERA_LEN - 9, ACT_CAMERA_LEN - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <AppShell>
        <PhotoPanel
          src={staticFile("demo/camera.jpg")}
          fileName="IMG_4032.jpg"
          photoIn={photoIn}
          scanStart={SCAN_START}
          scanEnd={SCAN_END}
        />
        <StatusPill
          analyzeStart={SCAN_START - 4}
          doneAt={CHIPS_AT - 2}
          doneText="Identified · 92% ID confidence"
        />
        <FeedPanel events={FEED} agent="pricing agent · web comps" />

        <RightHeader step="1 of 3 · electronics" />
        <TitleField text={TITLE} typeStart={TITLE_AT} typeDuration={22} />
        <ChipsRow
          chips={["Canon EOS 80D", "DSLR camera", "Good condition", "EF-S mount"]}
          startAt={CHIPS_AT}
        />
        <DescriptionField text={DESC} typeStart={262} typeDuration={152} />
        <PriceModule
          appearAt={PRICE_AT}
          suggested={418}
          rangeLow={380}
          rangeHigh={465}
          confidence={87}
          tier="Web comps tier"
          comps="6 comps"
        />
        <PublishArea
          appearAt={PRICE_AT + 8}
          pressFrame={CLICK_PUBLISH}
          liveAt={LIVE_AT}
          listingId="eBay item #110554729018"
          idAt={ID_AT}
        />
      </AppShell>
      <Cursor x={cursor.x} y={cursor.y} press={press} />
    </AbsoluteFill>
  );
};
