import React from "react";
import { Composition } from "remotion";
import { HERO_DEMO_LEN, HeroDemoVideo } from "./HeroDemoVideo";
import { StageIdentify } from "./StageIdentify";
import { StagePrice } from "./StagePrice";
import { StagePublish } from "./StagePublish";
import { BUYER_QA_LEN, BuyerQA } from "./suite/BuyerQA";
import { HERO_VISION_LEN, HeroVision } from "./suite/HeroVision";
import { STEP_IDENTIFY_LEN, StepIdentify } from "./suite/StepIdentify";
import { STEP_PRICE_LEN, StepPrice } from "./suite/StepPrice";
import { STEP_PUBLISH_LEN, StepPublish } from "./suite/StepPublish";
import { STEP_SNAP_LEN, StepSnap } from "./suite/StepSnap";
import { STEP_WRITE_LEN, StepWrite } from "./suite/StepWrite";

const STAGE_SIZE = { fps: 30, width: 800, height: 600 } as const;
const SUITE_SIZE = { fps: 30, width: 1920, height: 1080 } as const;

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
        component={StepSnap}
        durationInFrames={STEP_SNAP_LEN}
        {...SUITE_SIZE}
      />
      <Composition
        id="step-identify"
        component={StepIdentify}
        durationInFrames={STEP_IDENTIFY_LEN}
        {...SUITE_SIZE}
      />
      <Composition
        id="step-price"
        component={StepPrice}
        durationInFrames={STEP_PRICE_LEN}
        {...SUITE_SIZE}
      />
      <Composition
        id="step-write"
        component={StepWrite}
        durationInFrames={STEP_WRITE_LEN}
        {...SUITE_SIZE}
      />
      <Composition
        id="step-publish"
        component={StepPublish}
        durationInFrames={STEP_PUBLISH_LEN}
        {...SUITE_SIZE}
      />
      <Composition
        id="buyer-qa"
        component={BuyerQA}
        durationInFrames={BUYER_QA_LEN}
        {...SUITE_SIZE}
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
