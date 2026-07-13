import React from "react";
import { Composition } from "remotion";
import { HERO_DEMO_LEN, HeroDemoVideo } from "./HeroDemoVideo";
import { StageIdentify } from "./StageIdentify";
import { StagePrice } from "./StagePrice";
import { StagePublish } from "./StagePublish";
import {
  REAL_UI_CAPTURE_LEN,
  RealUiCapture,
  type RealUiCaptureProps,
  type RealUiSurface,
} from "./real-ui/RealUiCapture";
import { HERO_VISION_LEN, HeroVision } from "./suite/HeroVision";

const STAGE_SIZE = { fps: 30, width: 800, height: 600 } as const;
const SUITE_SIZE = { fps: 30, width: 1920, height: 1080 } as const;
/** Portrait (4:5) renders of the how-it-works steps for phones. */
const MOBILE_SIZE = { fps: 30, width: 1080, height: 1350 } as const;

const realUiDefaults = (
  surface: RealUiSurface,
  formFactor: RealUiCaptureProps["formFactor"],
): RealUiCaptureProps => ({ surface, formFactor, theme: "light" });

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* ---- 1080p demo-video suite (remotion/suite) ---- */}
      <Composition
        id="hero-demo"
        component={HeroVision}
        durationInFrames={HERO_VISION_LEN}
        {...SUITE_SIZE}
      />
      <Composition
        id="step-snap"
        component={RealUiCapture}
        defaultProps={realUiDefaults("snap", "desktop")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...SUITE_SIZE}
      />
      <Composition
        id="step-identify"
        component={RealUiCapture}
        defaultProps={realUiDefaults("identify", "desktop")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...SUITE_SIZE}
      />
      <Composition
        id="step-price"
        component={RealUiCapture}
        defaultProps={realUiDefaults("price", "desktop")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...SUITE_SIZE}
      />
      <Composition
        id="step-write"
        component={RealUiCapture}
        defaultProps={realUiDefaults("write", "desktop")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...SUITE_SIZE}
      />
      <Composition
        id="step-publish"
        component={RealUiCapture}
        defaultProps={realUiDefaults("publish", "desktop")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...SUITE_SIZE}
      />
      <Composition
        id="buyer-qa"
        component={RealUiCapture}
        defaultProps={realUiDefaults("buyer-qa", "desktop")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...SUITE_SIZE}
      />
      {/* In-app empty-state teaser: the same real inbox component, captured
          across list → drafted reply → sent-thread states. */}
      <Composition
        id="inbox-qa"
        component={RealUiCapture}
        defaultProps={realUiDefaults("inbox-qa", "desktop")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...SUITE_SIZE}
      />

      {/* ---- portrait mobile renders (ui-r7-mobile): /tour swaps to these
              under 768px so the in-clip UI is legible on phones ---- */}
      <Composition
        id="step-snap-mobile"
        component={RealUiCapture}
        defaultProps={realUiDefaults("snap", "mobile")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...MOBILE_SIZE}
      />
      <Composition
        id="step-identify-mobile"
        component={RealUiCapture}
        defaultProps={realUiDefaults("identify", "mobile")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...MOBILE_SIZE}
      />
      <Composition
        id="step-price-mobile"
        component={RealUiCapture}
        defaultProps={realUiDefaults("price", "mobile")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...MOBILE_SIZE}
      />
      <Composition
        id="step-write-mobile"
        component={RealUiCapture}
        defaultProps={realUiDefaults("write", "mobile")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...MOBILE_SIZE}
      />
      <Composition
        id="step-publish-mobile"
        component={RealUiCapture}
        defaultProps={realUiDefaults("publish", "mobile")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...MOBILE_SIZE}
      />
      <Composition
        id="buyer-qa-mobile"
        component={RealUiCapture}
        defaultProps={realUiDefaults("buyer-qa", "mobile")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...MOBILE_SIZE}
      />
      <Composition
        id="inbox-qa-mobile"
        component={RealUiCapture}
        defaultProps={realUiDefaults("inbox-qa", "mobile")}
        durationInFrames={REAL_UI_CAPTURE_LEN}
        {...MOBILE_SIZE}
      />

      {/* ---- legacy builds (kept for reference; superseded by the suite) ---- */}
      <Composition
        id="hero-demo-v3"
        component={HeroDemoVideo}
        durationInFrames={HERO_DEMO_LEN}
        fps={30}
        width={1120}
        height={840}
      />
      <Composition
        id="stage-identify"
        component={StageIdentify}
        durationInFrames={165}
        {...STAGE_SIZE}
      />
      <Composition
        id="stage-price"
        component={StagePrice}
        durationInFrames={170}
        {...STAGE_SIZE}
      />
      <Composition
        id="stage-publish"
        component={StagePublish}
        durationInFrames={160}
        {...STAGE_SIZE}
      />
    </>
  );
};
