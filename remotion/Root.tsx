import React from "react";
import { Composition } from "remotion";
import {
  REAL_UI_CAPTURE_LEN,
  RealUiCapture,
  type RealUiCaptureProps,
  type RealUiSurface,
} from "./real-ui/RealUiCapture";

const SUITE_SIZE = { fps: 30, width: 1920, height: 1080 } as const;
/** Action-focused 6:5 crops from full 390×844 real-app captures for phones. */
const MOBILE_SIZE = { fps: 30, width: 1080, height: 900 } as const;

const realUiDefaults = (
  surface: RealUiSurface,
  formFactor: RealUiCaptureProps["formFactor"],
): RealUiCaptureProps => ({ surface, formFactor, theme: "light" });

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* ---- real-UI demo-video suite ---- */}
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

      {/* ---- phone-first action crops: /tour swaps to these under 768px. ---- */}
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

    </>
  );
};
