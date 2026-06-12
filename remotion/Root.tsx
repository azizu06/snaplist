import React from "react";
import { Composition } from "remotion";
import { HeroDemoVideo } from "./HeroDemoVideo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="hero-demo"
      component={HeroDemoVideo}
      durationInFrames={390}
      fps={30}
      width={1120}
      height={840}
    />
  );
};
