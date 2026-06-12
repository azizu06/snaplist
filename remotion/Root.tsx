import React from "react";
import { Composition } from "remotion";
import { HeroDemoVideo } from "./HeroDemoVideo";
import { StageIdentify } from "./StageIdentify";
import { StagePrice } from "./StagePrice";
import { StagePublish } from "./StagePublish";

const STAGE_SIZE = { fps: 30, width: 800, height: 600 } as const;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="hero-demo"
        component={HeroDemoVideo}
        durationInFrames={390}
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
