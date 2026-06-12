import React from "react";
import { AbsoluteFill, Freeze, Sequence } from "remotion";
import { ACT_CAMERA_LEN, ActCamera } from "./hero/ActCamera";
import { ACT_SNEAKERS_LEN, ActSneakers } from "./hero/ActSneakers";
import { ACT_TEXTBOOK_LEN, ActTextbook } from "./hero/ActTextbook";
import { END_CARD_LEN, EndCard } from "./hero/EndCard";
import { SLAB, font } from "./hero/theme";

/**
 * Hero demo video v3 — a multi-act, loopable recording of the SnapList app
 * demoing three different products through three pipeline paths:
 *
 *   Act 1 · Camera   — manual flow: upload click → attribute chips → agent
 *                      feed prices from sold comps and types the description
 *                      → price module → cursor-accurate Publish click → LIVE.
 *   Act 2 · Textbook — ISBN tier: barcode detected → Open Library exact match
 *                      → 96% confidence clears the autopilot gate → posts
 *                      itself, no cursor.
 *   Act 3 · Sneakers — breadth + control: comps pricing, then the seller
 *                      clicks into the price field, nudges $88 → $92, and
 *                      publishes.
 *   End card         — three LIVE listings + tagline, crossfading back to the
 *                      Act 1 opening frame for a seamless loop.
 *
 * Cursor accuracy: every click target is a rect constant in hero/theme.ts;
 * cursor waypoints arrive at `center(rect)`, dwell 12–14 frames, and the
 * click ripple + button press key off the same frame constant — clicks can
 * never render away from the pointer.
 *
 * Render: `npx remotion render remotion/index.ts hero-demo public/hero-demo.mp4 --crf 27 --muted`
 * (--muted matters: the landing-page <video> is muted anyway and a silent AAC
 * track would triple the file size.)
 */

export const HERO_DEMO_LEN =
  ACT_CAMERA_LEN + ACT_TEXTBOOK_LEN + ACT_SNEAKERS_LEN + END_CARD_LEN;

export const HeroDemoVideo: React.FC = () => {
  const act2From = ACT_CAMERA_LEN;
  const act3From = act2From + ACT_TEXTBOOK_LEN;
  const endFrom = act3From + ACT_SNEAKERS_LEN;

  return (
    <AbsoluteFill style={{ backgroundColor: SLAB, fontFamily: font }}>
      <Sequence from={0} durationInFrames={ACT_CAMERA_LEN}>
        <ActCamera />
      </Sequence>
      <Sequence from={act2From} durationInFrames={ACT_TEXTBOOK_LEN}>
        <ActTextbook />
      </Sequence>
      <Sequence from={act3From} durationInFrames={ACT_SNEAKERS_LEN}>
        <ActSneakers />
      </Sequence>
      {/* loop seam: the end card fades out over the frozen Act 1 opening frame */}
      <Sequence from={HERO_DEMO_LEN - 18} durationInFrames={18}>
        <Freeze frame={0}>
          <ActCamera />
        </Freeze>
      </Sequence>
      <Sequence from={endFrom} durationInFrames={END_CARD_LEN}>
        <EndCard />
      </Sequence>
    </AbsoluteFill>
  );
};
